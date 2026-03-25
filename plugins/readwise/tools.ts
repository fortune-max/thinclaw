import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "readwise_save",
      description: "Save a URL or article to Readwise Reader. Use when the user wants to save something to read later or bookmark an article.",
      input_schema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "URL of the article or page to save" },
          title: { type: "string", description: "Optional title override" },
          summary: { type: "string", description: "Optional summary or note about why it's saved" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags to categorize" },
          location: {
            type: "string",
            enum: ["new", "later", "archive"],
            description: "Where to place it (default: later)",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "readwise_list",
      description: "List articles in the user's Readwise Reader library. Use when the user asks what's in their reading list.",
      input_schema: {
        type: "object" as const,
        properties: {
          location: {
            type: "string",
            enum: ["new", "later", "archive", "feed"],
            description: "Filter by location (default: later)",
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async readwise_save(input, secrets) {
      const { url, title, summary, tags, location = "new" } = input as {
        url: string;
        title?: string;
        summary?: string;
        tags?: string[];
        location?: string;
      };

      const body: Record<string, unknown> = { url, location };
      if (title) body.title = title;
      if (summary) body.summary = summary;
      if (tags && tags.length > 0) body.tags = tags;

      const res = await fetch("https://readwise.io/api/v3/save/", {
        method: "POST",
        headers: {
          Authorization: `Token ${secrets.READWISE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Readwise API ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      return `Saved to Readwise Reader: ${data.url || url}`;
    },

    async readwise_list(input, secrets) {
      const { location = "new", limit = 10 } = input as {
        location?: string;
        limit?: number;
      };

      const params = new URLSearchParams({ location, page_size: String(limit) });
      const res = await fetch(`https://readwise.io/api/v3/list/?${params}`, {
        headers: {
          Authorization: `Token ${secrets.READWISE_ACCESS_TOKEN}`,
        },
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Readwise API ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      const items = (data.results || []).map((item: any) => ({
        title: item.title,
        url: item.source_url || item.url,
        author: item.author,
        saved_at: item.created_at,
        reading_progress: item.reading_progress,
      }));

      if (items.length === 0) return "Reading list is empty.";
      return JSON.stringify(items, null, 2);
    },
  };

  return { tools, handlers };
}
