import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

async function getAccessToken(secrets: Record<string, string>): Promise<string> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${secrets.SPOTIFY_CLIENT_ID}:${secrets.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: secrets.SPOTIFY_REFRESH_TOKEN,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Spotify auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function spotifyFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<any> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });

  // Some endpoints return no content
  if (res.status === 204 || res.status === 202) return { success: true };

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Spotify API ${res.status}: ${text}`);
  }

  // Some endpoints return empty body on success
  if (!text || text.trim().length === 0) return { success: true };

  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON response — return as-is
    return { success: true, raw: text };
  }
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "spotify_search",
      description:
        "Search for songs, albums, or artists on Spotify. Returns track names, artists, and URIs for queueing.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query (e.g., 'Bohemian Rhapsody', 'Drake God's Plan')" },
          type: { type: "string", enum: ["track", "album", "artist"], description: "What to search for (default: track)" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "spotify_queue",
      description:
        "Add a song to the Spotify playback queue. Requires the track URI from spotify_search. Spotify must be active on a device.",
      input_schema: {
        type: "object" as const,
        properties: {
          uri: { type: "string", description: "Spotify track URI (e.g., 'spotify:track:4uLU6hMCjMI75M1A2tKUQC')" },
        },
        required: ["uri"],
      },
    },
    {
      name: "spotify_now_playing",
      description: "Get the currently playing track on Spotify.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "spotify_play",
      description: "Resume Spotify playback.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "spotify_pause",
      description: "Pause Spotify playback.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "spotify_skip",
      description: "Skip to the next track on Spotify.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async spotify_search(input, secrets) {
      const { query, type = "track", limit = 5 } = input as { query: string; type?: string; limit?: number };
      const token = await getAccessToken(secrets);

      const data = await spotifyFetch(
        `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
        token,
      );

      if (type === "track") {
        const tracks = data.tracks?.items || [];
        if (tracks.length === 0) return `No tracks found for "${query}"`;
        return JSON.stringify(
          tracks.map((t: any) => ({
            name: t.name,
            artist: t.artists.map((a: any) => a.name).join(", "),
            album: t.album.name,
            uri: t.uri,
            duration_ms: t.duration_ms,
          })),
          null,
          2,
        );
      }

      if (type === "artist") {
        const artists = data.artists?.items || [];
        if (artists.length === 0) return `No artists found for "${query}"`;
        return JSON.stringify(
          artists.map((a: any) => ({
            name: a.name,
            genres: a.genres,
            followers: a.followers.total,
            uri: a.uri,
          })),
          null,
          2,
        );
      }

      if (type === "album") {
        const albums = data.albums?.items || [];
        if (albums.length === 0) return `No albums found for "${query}"`;
        return JSON.stringify(
          albums.map((a: any) => ({
            name: a.name,
            artist: a.artists.map((ar: any) => ar.name).join(", "),
            total_tracks: a.total_tracks,
            uri: a.uri,
          })),
          null,
          2,
        );
      }

      return JSON.stringify(data, null, 2);
    },

    async spotify_queue(input, secrets) {
      const { uri } = input as { uri: string };
      const token = await getAccessToken(secrets);

      await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, token, {
        method: "POST",
      });

      return `Added to queue: ${uri}`;
    },

    async spotify_now_playing(_input, secrets) {
      const token = await getAccessToken(secrets);

      const data = await spotifyFetch("/me/player/currently-playing", token);

      if (!data || !data.item) return "Nothing is currently playing.";

      const track = data.item;
      return [
        `${track.name} — ${track.artists.map((a: any) => a.name).join(", ")}`,
        `Album: ${track.album.name}`,
        `Progress: ${Math.floor(data.progress_ms / 1000)}s / ${Math.floor(track.duration_ms / 1000)}s`,
        data.is_playing ? "▶ Playing" : "⏸ Paused",
      ].join("\n");
    },

    async spotify_play(_input, secrets) {
      const token = await getAccessToken(secrets);
      await spotifyFetch("/me/player/play", token, { method: "PUT" });
      return "Playback resumed.";
    },

    async spotify_pause(_input, secrets) {
      const token = await getAccessToken(secrets);
      await spotifyFetch("/me/player/pause", token, { method: "PUT" });
      return "Playback paused.";
    },

    async spotify_skip(_input, secrets) {
      const token = await getAccessToken(secrets);
      await spotifyFetch("/me/player/next", token, { method: "POST" });
      return "Skipped to next track.";
    },
  };

  return { tools, handlers };
}
