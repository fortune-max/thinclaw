import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";
import ngrok from "@ngrok/ngrok";
import http from "http";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

// Track active tunnels and servers
const activeTunnels = new Map<string, ngrok.Listener>();
const activeServers = new Map<string, http.Server>();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
};

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "ngrok_serve",
      description:
        "PREFERRED: Serve a file or directory publicly via ngrok. Write your HTML file first, then call this tool with the path. It starts a persistent HTTP server and creates the tunnel. Always use this instead of bash+ngrok_tunnel — bash background servers die immediately.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Path to an HTML file or a directory to serve (e.g., '/tmp/mysite/index.html' or '/tmp/mysite')",
          },
          label: {
            type: "string",
            description: "Optional label to identify this server (default: 'default')",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "ngrok_tunnel",
      description:
        "Create a public ngrok tunnel to an already-running local port. WARNING: Do NOT use bash to start a server and then tunnel it — bash background processes die after the command returns. Use ngrok_serve instead, which has a built-in persistent HTTP server.",
      input_schema: {
        type: "object" as const,
        properties: {
          port: {
            type: "number",
            description: "Local port to tunnel",
          },
          label: {
            type: "string",
            description: "Optional label (default: 'default')",
          },
        },
        required: ["port"],
      },
    },
    {
      name: "ngrok_close",
      description:
        "Close an active ngrok tunnel and its server by label.",
      input_schema: {
        type: "object" as const,
        properties: {
          label: {
            type: "string",
            description: "Label of the tunnel to close (default: 'default')",
          },
        },
      },
    },
    {
      name: "ngrok_list",
      description:
        "List all active ngrok tunnels with their public URLs.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async ngrok_serve(input, secrets) {
      const { path, label = "default" } = input as { path: string; label?: string };

      if (!existsSync(path)) {
        throw new Error(`Path not found: ${path}`);
      }

      // Close existing server/tunnel with same label
      const existingServer = activeServers.get(label);
      if (existingServer) existingServer.close();
      const existingTunnel = activeTunnels.get(label);
      if (existingTunnel) await existingTunnel.close();

      const stat = statSync(path);
      const isFile = stat.isFile();
      const baseDir = isFile ? join(path, "..") : path;
      const indexFile = isFile ? path : null;

      const port = await findFreePort();

      // Start in-process HTTP server
      const server = http.createServer((req, res) => {
        let filePath: string;

        if (indexFile && (req.url === "/" || req.url === "")) {
          filePath = indexFile;
        } else {
          const urlPath = (req.url || "/").split("?")[0];
          filePath = join(baseDir, urlPath === "/" ? "index.html" : urlPath);
        }

        if (!existsSync(filePath)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        try {
          const content = readFileSync(filePath);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
        } catch {
          res.writeHead(500);
          res.end("Error reading file");
        }
      });

      await new Promise<void>((resolve) => server.listen(port, resolve));
      activeServers.set(label, server);

      // Create ngrok tunnel
      const listener = await ngrok.forward({
        addr: port,
        authtoken: secrets.NGROK_AUTHTOKEN,
      });

      const url = listener.url();
      activeTunnels.set(label, listener);

      return `Server + tunnel "${label}" created: ${url}\nServing: ${path} on port ${port}`;
    },

    async ngrok_tunnel(input, secrets) {
      const { port, label = "default" } = input as { port: number; label?: string };

      const existing = activeTunnels.get(label);
      if (existing) {
        await existing.close();
        activeTunnels.delete(label);
      }

      const listener = await ngrok.forward({
        addr: port,
        authtoken: secrets.NGROK_AUTHTOKEN,
      });

      const url = listener.url();
      activeTunnels.set(label, listener);

      return `Tunnel "${label}" created: ${url} → localhost:${port}`;
    },

    async ngrok_close(input) {
      const { label = "default" } = input as { label?: string };

      const tunnel = activeTunnels.get(label);
      const server = activeServers.get(label);

      if (!tunnel && !server) return `No tunnel found with label "${label}"`;

      if (server) {
        server.close();
        activeServers.delete(label);
      }
      if (tunnel) {
        await tunnel.close();
        activeTunnels.delete(label);
      }

      // If no more tunnels, disconnect the ngrok session entirely
      if (activeTunnels.size === 0) {
        await ngrok.disconnect();
      }

      return `Tunnel "${label}" closed.`;
    },

    async ngrok_list() {
      if (activeTunnels.size === 0) return "No active tunnels.";

      const entries: string[] = [];
      for (const [label, tunnel] of activeTunnels) {
        entries.push(`${label}: ${tunnel.url()}`);
      }
      return entries.join("\n");
    },
  };

  return { tools, handlers };
}
