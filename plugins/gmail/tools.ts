import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

async function getAccessToken(secrets: Record<string, string>): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: secrets.GMAIL_CLIENT_ID,
      client_secret: secrets.GMAIL_CLIENT_SECRET,
      refresh_token: secrets.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Gmail auth failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function gmailFetch(
  path: string,
  accessToken: string,
): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body}`);
  }
  return res.json();
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "gmail_search",
      description:
        "Search Gmail messages. Returns message IDs and snippets. Use Gmail search syntax (e.g., 'from:flutterwave subject:OTP newer_than:5m').",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Gmail search query (e.g., 'from:noreply@flutterwave.com newer_than:5m')",
          },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "gmail_read",
      description:
        "Read a specific Gmail message by ID. Returns subject, from, date, and body text. Use after gmail_search to read full message content.",
      input_schema: {
        type: "object" as const,
        properties: {
          message_id: {
            type: "string",
            description: "Message ID from gmail_search results",
          },
        },
        required: ["message_id"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async gmail_search(input, secrets) {
      const { query, limit = 5 } = input as { query: string; limit?: number };
      const accessToken = await getAccessToken(secrets);

      const data = await gmailFetch(
        `/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`,
        accessToken,
      );

      if (!data.messages || data.messages.length === 0) {
        return `No emails found for: ${query}`;
      }

      // Fetch snippet for each message
      const results = await Promise.all(
        data.messages.map(async (msg: any) => {
          const detail = await gmailFetch(`/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, accessToken);
          const headers = detail.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

          return {
            id: msg.id,
            subject: getHeader("Subject"),
            from: getHeader("From"),
            date: getHeader("Date"),
            snippet: detail.snippet,
          };
        }),
      );

      return JSON.stringify(results, null, 2);
    },

    async gmail_read(input, secrets) {
      const { message_id } = input as { message_id: string };
      const accessToken = await getAccessToken(secrets);

      const data = await gmailFetch(`/messages/${message_id}?format=full`, accessToken);

      const headers = data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      // Extract body text
      let body = "";

      function extractText(part: any): void {
        if (part.mimeType === "text/plain" && part.body?.data) {
          body += Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
        if (part.mimeType === "text/html" && !body && part.body?.data) {
          // Fallback to HTML stripped of tags if no plain text
          const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
          body += html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        }
        if (part.parts) {
          part.parts.forEach(extractText);
        }
      }

      extractText(data.payload);

      return JSON.stringify(
        {
          subject: getHeader("Subject"),
          from: getHeader("From"),
          date: getHeader("Date"),
          body: body.slice(0, 5000), // Limit body size
        },
        null,
        2,
      );
    },
  };

  return { tools, handlers };
}
