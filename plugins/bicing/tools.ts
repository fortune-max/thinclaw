import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

const API_URL = "https://www.bicing.barcelona/es/get-stations";

interface Station {
  id: string;
  streetName: string;
  slots: number; // free charging/docking spots
  mechanical_bikes: number;
  electrical_bikes: number;
  bikes: number; // total bikes
  status: number; // 1 = active
  latitude: number;
  longitude: number;
  disponibilidad: number; // availability percentage
}

// Cache all stations for 2 minutes (avoid hitting the API every call)
let stationsCache: Station[] = [];
let cacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000;

async function fetchStations(): Promise<Station[]> {
  if (stationsCache.length > 0 && Date.now() - cacheTime < CACHE_TTL) {
    return stationsCache;
  }

  const res = await fetch(API_URL, { method: "POST" });
  if (!res.ok) throw new Error(`Bicing API ${res.status}`);

  const data = await res.json();
  stationsCache = data.stations || [];
  cacheTime = Date.now();
  return stationsCache;
}

async function fetchStation(stationId: string): Promise<Station | undefined> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `station%5B%5D=text&station%5B%5D=${encodeURIComponent(stationId)}&station%5B%5D=station`,
  });

  if (!res.ok) throw new Error(`Bicing API ${res.status}`);
  const data = await res.json();
  const stations = data.stations || [];
  return stations[0];
}

function formatStation(s: Station): string {
  const status = s.status === 1 ? "" : " [CLOSED]";
  return (
    `Station ${s.id} — ${s.streetName}${status}\n` +
    `  Mechanical bikes: ${s.mechanical_bikes}\n` +
    `  Electric bikes: ${s.electrical_bikes}\n` +
    `  Free spots: ${s.slots}\n` +
    `  Availability: ${s.disponibilidad}%`
  );
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "bicing_station",
      description:
        "Check availability at a specific Bicing station by station number. Shows mechanical bikes, electric bikes, and free charging/docking spots.",
      input_schema: {
        type: "object" as const,
        properties: {
          station_id: {
            type: "string",
            description: "Bicing station number (e.g., '400', '124', '423')",
          },
        },
        required: ["station_id"],
      },
    },
    {
      name: "bicing_nearby",
      description:
        "Find Bicing stations near a location. Provide either coordinates or a street name to search. Returns the closest stations with availability.",
      input_schema: {
        type: "object" as const,
        properties: {
          latitude: { type: "number", description: "Latitude coordinate" },
          longitude: { type: "number", description: "Longitude coordinate" },
          street: {
            type: "string",
            description: "Street name to search for (partial match, e.g., 'Barceloneta', 'Paral·lel')",
          },
          limit: {
            type: "number",
            description: "Number of stations to return (default 5)",
          },
        },
      },
    },
    {
      name: "bicing_search",
      description:
        "Search for Bicing stations by street name. Useful when you don't know the station number.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Street name or area to search (e.g., 'Honduras', 'Barceloneta', 'Paral·lel')",
          },
        },
        required: ["query"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async bicing_station(input) {
      const { station_id } = input as { station_id: string };
      const station = await fetchStation(station_id);
      if (!station) return `Station ${station_id} not found.`;
      return formatStation(station);
    },

    async bicing_nearby(input) {
      const { latitude, longitude, street, limit = 5 } = input as {
        latitude?: number;
        longitude?: number;
        street?: string;
        limit?: number;
      };

      const stations = await fetchStations();
      let results: (Station & { distance?: number })[];

      if (latitude && longitude) {
        // Sort by distance
        results = stations
          .filter((s) => s.status === 1)
          .map((s) => ({
            ...s,
            distance: haversineKm(latitude, longitude, s.latitude, s.longitude),
          }))
          .sort((a, b) => a.distance! - b.distance!)
          .slice(0, limit);
      } else if (street) {
        const q = street.toLowerCase();
        results = stations
          .filter((s) => s.status === 1 && s.streetName.toLowerCase().includes(q))
          .slice(0, limit);
      } else {
        return "Provide either coordinates (latitude/longitude) or a street name.";
      }

      if (results.length === 0) return "No stations found nearby.";

      return results
        .map((s) => {
          const dist = s.distance ? ` (${(s.distance * 1000).toFixed(0)}m)` : "";
          return `Station ${s.id} — ${s.streetName}${dist}\n  Mech: ${s.mechanical_bikes} | Elec: ${s.electrical_bikes} | Free: ${s.slots}`;
        })
        .join("\n\n");
    },

    async bicing_search(input) {
      const { query } = input as { query: string };
      const stations = await fetchStations();
      const q = query.toLowerCase();

      const matches = stations.filter(
        (s) =>
          s.streetName.toLowerCase().includes(q) ||
          s.id === query,
      );

      if (matches.length === 0) return `No stations found for "${query}".`;

      return matches
        .slice(0, 10)
        .map(
          (s) =>
            `${s.id} — ${s.streetName} (Mech: ${s.mechanical_bikes}, Elec: ${s.electrical_bikes}, Free: ${s.slots})${s.status !== 1 ? " [CLOSED]" : ""}`,
        )
        .join("\n");
    },
  };

  return { tools, handlers };
}
