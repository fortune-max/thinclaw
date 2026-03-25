import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";
import { exec } from "child_process";
import { readFile, writeFile, readdir, appendFile } from "fs/promises";
import { promisify } from "util";

const execAsync = promisify(exec);

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "bash",
      description: "Execute a bash command. Use for system tasks, installing packages, git operations, etc.",
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          timeout_ms: { type: "number", description: "Timeout in ms (default 30000)" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read the contents of a file",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file (creates or overwrites)",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "append_file",
      description: "Append content to a file (creates if missing). Use for adding to memory files.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path to append to" },
          content: { type: "string", description: "Content to append" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_directory",
      description: "List files and directories at a path",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Directory path to list" },
        },
        required: ["path"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async bash(input) {
      const { command, timeout_ms = 30000 } = input as { command: string; timeout_ms?: number };
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: timeout_ms,
          maxBuffer: 1024 * 1024,
        });
        let result = "";
        if (stdout) result += stdout;
        if (stderr) result += (result ? "\n" : "") + `STDERR: ${stderr}`;
        return result || "(no output)";
      } catch (err: any) {
        return `Error (exit ${err.code ?? "?"}): ${err.stderr || err.message}`;
      }
    },

    async read_file(input) {
      const { path } = input as { path: string };
      return readFile(path, "utf-8");
    },

    async write_file(input) {
      const { path, content } = input as { path: string; content: string };
      await writeFile(path, content, "utf-8");
      return `Written ${content.length} bytes to ${path}`;
    },

    async append_file(input) {
      const { path, content } = input as { path: string; content: string };
      await appendFile(path, content, "utf-8");
      return `Appended ${content.length} bytes to ${path}`;
    },

    async list_directory(input) {
      const { path } = input as { path: string };
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
        .join("\n");
    },
  };

  return { tools, handlers };
}
