import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

const APP_ID = process.env.TMB_APP_ID || "";
const APP_KEY = process.env.TMB_APP_KEY || "";
const BASE_URL = "https://api.tmb.cat/v1";

async function tmbFetch(path: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${sep}app_id=${APP_ID}&app_key=${APP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMB API ${res.status}: ${await res.text()}`);
  return res.json();
}

function formatArrivalTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = timestamp - now;
  const diffMin = Math.round(diffMs / 60000);

  const time = new Date(timestamp).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });

  if (diffMin <= 0) return `${time} (arriving now)`;
  if (diffMin === 1) return `${time} (1 min)`;
  return `${time} (${diffMin} min)`;
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "tmb_next_bus",
      description:
        "Get real-time next bus arrivals at a stop. Returns upcoming buses with estimated arrival times. Optionally filter by line name (e.g., 'D20', 'V11', 'H14').",
      input_schema: {
        type: "object" as const,
        properties: {
          stop_code: {
            type: "number",
            description: "Bus stop code number (e.g., 770 for Paral·lel - Margarit)",
          },
          line_name: {
            type: "string",
            description: "Optional: filter by bus line name (e.g., 'D20', 'V11')",
          },
        },
        required: ["stop_code"],
      },
    },
    {
      name: "tmb_search",
      description:
        "Search for bus lines or stops by name/number. Use to find a line code or stop code when you don't know it.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g., 'D20', 'Paral·lel', '770')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "tmb_stop_lines",
      description:
        "List all bus lines that pass through a given stop, with their destinations.",
      input_schema: {
        type: "object" as const,
        properties: {
          stop_code: {
            type: "number",
            description: "Bus stop code number",
          },
        },
        required: ["stop_code"],
      },
    },
    {
      name: "tmb_next_metro",
      description:
        "Get real-time next metro/train arrivals at a station. Optionally filter by line (e.g., 'L2', 'L4') and direction.",
      input_schema: {
        type: "object" as const,
        properties: {
          station_code: {
            type: "number",
            description: "Metro station code (e.g., 222 for Tetuan)",
          },
          line_name: {
            type: "string",
            description: "Optional: filter by metro line (e.g., 'L2', 'L4')",
          },
          direction: {
            type: "string",
            description: "Optional: filter by destination direction (e.g., 'Paral·lel', 'Badalona Pompeu Fabra')",
          },
        },
        required: ["station_code"],
      },
    },
    {
      name: "tmb_search_metro",
      description:
        "Search for metro stations by name. Returns station codes and lines.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Station name (e.g., 'Tetuan', 'Paral·lel', 'Sagrada Familia')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "tmb_nearby",
      description:
        "Find bus and metro stops near GPS coordinates. Use when the user shares their location or you know coordinates.",
      input_schema: {
        type: "object" as const,
        properties: {
          latitude: { type: "number", description: "Latitude coordinate" },
          longitude: { type: "number", description: "Longitude coordinate" },
          radius: {
            type: "number",
            description: "Search radius in meters (default 300, max 500)",
          },
        },
        required: ["latitude", "longitude"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async tmb_next_bus(input) {
      const { stop_code, line_name } = input as {
        stop_code: number;
        line_name?: string;
      };

      const data = await tmbFetch(
        `/itransit/bus/parades/${stop_code}?temps_teoric=true`,
      );

      const stop = data.parades?.[0];
      if (!stop) throw new Error(`Stop ${stop_code} not found`);

      let lines = stop.linies_trajectes || [];

      // Filter by line name if specified
      if (line_name) {
        const normalized = line_name.toUpperCase();
        lines = lines.filter(
          (l: any) => l.nom_linia.toUpperCase() === normalized,
        );
        if (lines.length === 0) {
          return `No buses for line ${line_name} found at stop ${stop_code} (${stop.nom_parada})`;
        }
      }

      const results: string[] = [`🚏 ${stop.nom_parada} (stop ${stop_code})\n`];

      for (const line of lines) {
        const buses = line.propers_busos || [];
        if (buses.length === 0) continue;

        const arrivals = buses
          .slice(0, 3)
          .map((b: any) => formatArrivalTime(b.temps_arribada))
          .join(", ");

        results.push(
          `${line.nom_linia} → ${line.desti_trajecte}: ${arrivals}`,
        );
      }

      if (results.length === 1) {
        return `No upcoming buses at stop ${stop_code} (${stop.nom_parada})`;
      }

      return results.join("\n");
    },

    async tmb_search(input) {
      const { query } = input as { query: string };
      const data = await tmbFetch(`/search/bus?q=${encodeURIComponent(query)}`);

      const docs = data.response?.docs || [];
      if (docs.length === 0) return `No results for "${query}"`;

      return docs
        .slice(0, 10)
        .map(
          (d: any) =>
            `[${d.entitat}] ${d.nom} — ${d.etiqueta || d.nom}${d.codi ? ` (code: ${d.codi})` : ""}`,
        )
        .join("\n");
    },

    async tmb_stop_lines(input) {
      const { stop_code } = input as { stop_code: number };

      // Get stop info
      const stopData = await tmbFetch(
        `/transit/parades/${stop_code}?propertyName=CODI_PARADA,NOM_PARADA,DESC_PARADA`,
      );
      const stopInfo = stopData.features?.[0]?.properties;
      if (!stopInfo) throw new Error(`Stop ${stop_code} not found`);

      // Get real-time data which includes all lines at the stop
      const rtData = await tmbFetch(
        `/itransit/bus/parades/${stop_code}?temps_teoric=true`,
      );
      const stop = rtData.parades?.[0];
      if (!stop) return `Stop ${stop_code}: ${stopInfo.NOM_PARADA} — no line data available`;

      const lines = (stop.linies_trajectes || [])
        .map(
          (l: any) => `${l.nom_linia} → ${l.desti_trajecte}`,
        )
        .join("\n");

      return `🚏 ${stopInfo.NOM_PARADA} (${stopInfo.DESC_PARADA})\n\nLines:\n${lines}`;
    },

    async tmb_next_metro(input) {
      const { station_code, line_name, direction } = input as {
        station_code: number;
        line_name?: string;
        direction?: string;
      };

      const data = await tmbFetch(
        `/itransit/metro/estacions/${station_code}?temps_teoric=true`,
      );

      if (!data.linies || data.linies.length === 0) {
        throw new Error(`Metro station ${station_code} not found`);
      }

      const results: string[] = [];

      for (const line of data.linies) {
        // Filter by line name if specified
        if (line_name) {
          const normalized = line_name.toUpperCase();
          if (line.nom_linia.toUpperCase() !== normalized) continue;
        }

        for (const station of line.estacions) {
          for (const route of station.linies_trajectes || []) {
            // Filter by direction if specified
            if (direction) {
              const normDir = direction.toLowerCase();
              if (!route.desti_trajecte.toLowerCase().includes(normDir)) continue;
            }

            const trains = route.propers_trens || [];
            if (trains.length === 0) continue;

            const arrivals = trains
              .slice(0, 3)
              .map((t: any) => formatArrivalTime(t.temps_arribada))
              .join(", ");

            results.push(`${line.nom_linia} → ${route.desti_trajecte}: ${arrivals}`);
          }
        }
      }

      if (results.length === 0) {
        return `No upcoming trains at metro station ${station_code}`;
      }

      return `🚇 Metro station ${station_code}\n\n${results.join("\n")}`;
    },

    async tmb_search_metro(input) {
      const { query } = input as { query: string };

      // Get all metro lines and their stations
      const data = await tmbFetch(
        `/transit/linies/metro/estacions?cql_filter=NOM_ESTACIO ILIKE '%25${encodeURIComponent(query)}%25'&sortBy=NOM_ESTACIO`,
      );

      const features = data.features || [];
      if (features.length === 0) return `No metro stations found for "${query}"`;

      // Group by station
      const stations = new Map<number, { name: string; lines: string[] }>();
      for (const f of features) {
        const p = f.properties;
        const code = p.CODI_ESTACIO;
        if (!stations.has(code)) {
          stations.set(code, { name: p.NOM_ESTACIO, lines: [] });
        }
        stations.get(code)!.lines.push(p.NOM_LINIA || `L${p.CODI_LINIA}`);
      }

      return Array.from(stations.entries())
        .slice(0, 10)
        .map(([code, s]) => `${s.name} (code: ${code}) — ${[...new Set(s.lines)].join(", ")}`)
        .join("\n");
    },

    async tmb_nearby(input) {
      const { latitude, longitude, radius = 300 } = input as {
        latitude: number;
        longitude: number;
        radius?: number;
      };

      const dist = Math.min(radius, 500);
      const data = await tmbFetch(
        `/itransit/nearby/radius?lon=${longitude}&lat=${latitude}&distancia=${dist}`,
      );

      const features = data.features || [];
      if (features.length === 0) return `No stops found within ${dist}m.`;

      const stops = features.map((f: any) => {
        const p = f.properties;
        const type = p.MODE_TRANSPORT === "METRO" ? "M" : "B";
        return `[${type}] ${p.NOM_ELEMENT} (${p.CODI_ELEMENT})`;
      });

      return `Stops within ${dist}m:\n\n${stops.join("\n")}`;
    },
  };

  return { tools, handlers };
}
