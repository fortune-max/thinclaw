import type Anthropic from "@anthropic-ai/sdk";

export type ToolHandler = (
  input: Record<string, unknown>,
  secrets: Record<string, string>,
  chatId?: number,
) => Promise<string>;

export interface PluginManifest {
  name: string;
  description: string;
  tools: Anthropic.Tool[];
  handlers: Map<string, ToolHandler>;
  secretsSpec: Record<string, string>;
}

export interface LoadedPlugins {
  manifests: PluginManifest[];
  allTools: Anthropic.Tool[];
  execute: (toolName: string, input: Record<string, unknown>) => Promise<string>;
}
