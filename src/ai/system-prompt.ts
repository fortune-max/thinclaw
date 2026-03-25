import { getMemories, getUserRole } from "../db/queries.js";
import type { PluginInfo } from "../plugins/loader.js";
import type Anthropic from "@anthropic-ai/sdk";

function loadMemories(chatId: number): string {
  const memories = getMemories(chatId);
  if (memories.length === 0) return "No memories yet.";

  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m.content);
  }

  return Object.entries(grouped)
    .map(([cat, items]) => `### ${cat}\n${items.map((i) => `- ${i}`).join("\n")}`)
    .join("\n\n");
}

/**
 * Build system prompt as an array of content blocks for prompt caching.
 * Static content (guidelines, plugins) comes first and is cached.
 * Dynamic content (memories) comes last.
 */
export function buildSystemPrompt(
  chatId: number,
  availablePlugins: PluginInfo[],
  userName?: string | null,
): Anthropic.TextBlockParam[] {
  const memory = loadMemories(chatId);
  const role = getUserRole(chatId);
  const isAdmin = role === "admin";

  const pluginList = availablePlugins
    .filter((p) => !p.alwaysLoaded)
    .filter((p) => !p.adminOnly || isAdmin)
    .map((p) => `- ${p.name}: ${p.description}`)
    .join("\n");

  const coreToolNote = isAdmin
    ? "You have core tools always available: bash, read_file, write_file, append_file, list_directory, notify_admin. Plus meta-tools: load_plugin, set_secret, memory_write, memory_delete, search_history, create_reminder, list_reminders, delete_reminder."
    : "You have meta-tools always available: load_plugin, set_secret, memory_write, memory_delete, search_history, notify_admin, create_reminder, list_reminders, delete_reminder. Use load_plugin to activate plugins for additional tools.";

  // Static block — same for all users with same role. Cached.
  const staticPrompt = `You are a personal AI assistant running as a Telegram bot.
${coreToolNote}

## Available Plugins
Load these on demand with load_plugin("name"):
${pluginList || "No plugins available."}

## Guidelines
- To use a plugin, first call load_plugin("name"), then use its tools.
- **Memories vs Notes**: Memories are things YOU learn about the user (preferences, corrections, facts) — use memory_write. Notes are content the USER wants to save (todo lists, shopping lists, ideas) — use the notes plugin. Don't mix them up.
- When the user corrects you or tells you a preference, use memory_write to save it.
- When the user wants to save, list, or manage their own content, load the notes plugin.
- If a plugin needs credentials, ask the user and save them with set_secret.
- Be concise — this is Telegram. Use markdown sparingly.
- You can chain plugins: e.g., load authenticator for a 2FA code, then load flutterwave to use it.
- When you encounter errors, try to fix them before asking the user.
${isAdmin ? "- You have admin access: bash, file read/write, and all plugins." : "- For safety, you do not have shell or file access. Use plugin tools only."}`;

  // Dynamic block — per-user. Not cached.
  const nameStr = userName || "this user";
  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const dynamicPrompt = `## Current Time
${now}

## User: ${nameStr}

## Your Memory
Things you've learned about ${nameStr}:
${memory}`;

  return [
    {
      type: "text",
      text: staticPrompt,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: dynamicPrompt,
    },
  ];
}
