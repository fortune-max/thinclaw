import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { resolveSecrets, getMissingSecrets } from "./secrets.js";
import { getUserPlugins, getUserRole, setUserSecret } from "../db/queries.js";
import type { ToolHandler } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPluginsDir = join(__dirname, "..", "..", "plugins");

export interface PluginInfo {
  name: string;
  description: string;
  alwaysLoaded?: boolean;
  adminOnly?: boolean;
  dir: string;
  secretsSpec: Record<string, any>;
}

export interface PluginRegistry {
  available: PluginInfo[];
  tools: Anthropic.Tool[];
  handlers: Map<string, { handler: ToolHandler; pluginName: string }>;
  loadedPlugins: Set<string>;
  chatId: number;
  execute: (toolName: string, input: Record<string, unknown>) => Promise<string>;
  loadPlugin: (name: string) => Promise<string>;
  reminderSource?: boolean;  // set true when executing a reminder-triggered agent run
}

/** Scan plugin directories and read plugin.json manifests */
function discoverPlugins(): PluginInfo[] {
  const pluginsDir = config.PLUGINS_DIR;
  if (!existsSync(pluginsDir)) return [];

  const dirs = readdirSync(pluginsDir, { withFileTypes: true }).filter(
    (d) => d.isDirectory(),
  );

  const plugins: PluginInfo[] = [];

  for (const dir of dirs) {
    const pluginPath = join(pluginsDir, dir.name);
    const manifestPath = join(pluginPath, "plugin.json");

    let name = dir.name;
    let description = "No description";
    let alwaysLoaded = false;
    let adminOnly = false;

    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        name = manifest.name || dir.name;
        description = manifest.description || description;
        alwaysLoaded = manifest.alwaysLoaded || false;
        adminOnly = manifest.adminOnly || false;
      } catch (err) {
        logger.warn({ err, plugin: dir.name }, "Failed to parse plugin.json");
      }
    }

    // Read secrets spec
    const secretsPath = join(pluginPath, "secrets.json");
    let secretsSpec: Record<string, any> = {};
    if (existsSync(secretsPath)) {
      try {
        secretsSpec = JSON.parse(readFileSync(secretsPath, "utf-8"));
      } catch {}
    }

    plugins.push({ name, description, alwaysLoaded, adminOnly, dir: pluginPath, secretsSpec });
  }

  return plugins;
}

/** Load a single plugin's tools and handlers for a specific user */
async function loadSinglePlugin(
  info: PluginInfo,
  registry: PluginRegistry,
): Promise<Anthropic.Tool[]> {
  if (registry.loadedPlugins.has(info.name)) return [];

  // Resolve secrets for this user
  const secrets = resolveSecrets(registry.chatId, info.name, info.secretsSpec);

  // Check for missing required secrets
  const missing = getMissingSecrets(registry.chatId, info.name, info.secretsSpec);
  if (missing.length > 0) {
    const missingList = missing
      .map((m) => `• ${m.key}: ${m.description}`)
      .join("\n");
    throw new Error(
      `Missing secrets for plugin "${info.name}":\n${missingList}\n\nAsk the user to provide these using: set_secret("${info.name}", "KEY", "VALUE")`,
    );
  }

  // Find the tools module
  const distToolsPath = join(distPluginsDir, info.name, "tools.js");
  const sourceToolsJs = join(info.dir, "tools.js");
  const sourceToolsTs = join(info.dir, "tools.ts");

  const modulePath = existsSync(distToolsPath)
    ? distToolsPath
    : existsSync(sourceToolsJs)
      ? sourceToolsJs
      : existsSync(sourceToolsTs)
        ? sourceToolsTs
        : null;

  if (!modulePath) throw new Error(`No tools module found for plugin "${info.name}"`);

  const mod = await import(modulePath);
  if (typeof mod.createTools !== "function") {
    throw new Error(`Plugin "${info.name}" does not export createTools()`);
  }

  const { tools, handlers } = mod.createTools(secrets);

  for (const tool of tools) {
    registry.tools.push(tool);
  }
  for (const [toolName, handler] of Object.entries(handlers)) {
    registry.handlers.set(toolName, {
      handler: handler as ToolHandler,
      pluginName: info.name,
    });
  }

  registry.loadedPlugins.add(info.name);
  logger.info({ plugin: info.name, toolCount: tools.length, chatId: registry.chatId }, "Plugin loaded");
  return tools;
}

/** Build meta-tools: load_plugin + set_secret + memory tools */
function buildMetaTools(isAdmin: boolean): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "load_plugin",
      description:
        "Load a plugin to get its tools. Check available plugins in the system prompt.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Plugin name to load" },
        },
        required: ["name"],
      },
    },
    {
      name: "set_secret",
      description:
        "Store a secret for a plugin (e.g., API key, password). Secrets are encrypted. Use when a plugin requires credentials the user provides.",
      input_schema: {
        type: "object" as const,
        properties: {
          plugin: { type: "string", description: "Plugin name" },
          key: { type: "string", description: "Secret key (e.g., READWISE_ACCESS_TOKEN)" },
          value: { type: "string", description: "Secret value" },
        },
        required: ["plugin", "key", "value"],
      },
    },
    {
      name: "memory_write",
      description:
        "Save a learned fact about the user to improve future responses. Use for preferences ('I'm vegetarian'), corrections ('my name is spelled X'), personal context ('I live in Barcelona'). NOT for content the user wants to save — use the notes plugin for that.",
      input_schema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            enum: ["preferences", "corrections", "facts"],
            description: "Memory category",
          },
          content: { type: "string", description: "What to remember" },
        },
        required: ["category", "content"],
      },
    },
    {
      name: "memory_delete",
      description: "Delete a learned fact about the user by its ID. Use when a memory is wrong or outdated.",
      input_schema: {
        type: "object" as const,
        properties: {
          memory_id: { type: "number", description: "Memory ID to delete" },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "search_history",
      description:
        "Search the user's past conversation messages by keyword. Use when the user asks about something they said or asked before, or wants to recall a past conversation.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Keyword or phrase to search for" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "notify_admin",
      description:
        "Send a message to the admin(s). Use when: (1) a user explicitly asks to contact admin or request an upgrade — tell them the admin will be informed, (2) you detect suspicious or malicious behavior — notify silently without telling the user they are being reported, (3) you notice useful feedback, feature requests, pain points, or areas to improve — relay these to admin proactively. Never reveal to the user that you are reporting them in case 2.",
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message to send to the admin. The sender's identity is automatically attached." },
        },
        required: ["message"],
      },
    },
    {
      name: "create_reminder",
      description:
        "Schedule a one-shot reminder. When it fires, you (the agent) will receive the note as a prompt and act on it. Use this to schedule future tasks for yourself, or simple reminders for the user. Time is UTC.",
      input_schema: {
        type: "object" as const,
        properties: {
          note: {
            type: "string",
            description: "What to do when the reminder fires. Be specific — your future self reads this and acts on it.",
          },
          trigger_at: {
            type: "string",
            description: "When to trigger (ISO 8601 datetime in UTC, e.g. '2026-03-24T14:00:00Z')",
          },
        },
        required: ["note", "trigger_at"],
      },
    },
    {
      name: "list_reminders",
      description: "List the user's active (pending) reminders.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "delete_reminder",
      description: "Delete a reminder by ID.",
      input_schema: {
        type: "object" as const,
        properties: {
          reminder_id: { type: "number", description: "Reminder ID to delete" },
        },
        required: ["reminder_id"],
      },
    },
  ];

  // Admin-only tools
  if (isAdmin) {
    tools.push({
      name: "list_users",
      description:
        "List all users or search by name. Shows chat ID, name, and role. Admin only.",
      input_schema: {
        type: "object" as const,
        properties: {
          search: { type: "string", description: "Optional: search by name" },
          role: { type: "string", enum: ["admin", "user", "guest", "banned"], description: "Optional: filter by role" },
        },
      },
    });
    tools.push({
      name: "notify_users",
      description:
        "Send a message to users. Can target by role, specific chat IDs, or both. Admin only. Use for announcements, updates, replies to users, or maintenance notices.",
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message to send" },
          roles: {
            type: "array",
            items: { type: "string", enum: ["guest", "user", "admin"] },
            description: "Target roles (e.g., ['guest', 'user']). Optional if chat_ids is provided.",
          },
          chat_ids: {
            type: "array",
            items: { type: "number" },
            description: "Specific chat IDs to message. Optional if roles is provided.",
          },
        },
        required: ["message"],
      },
    });
  }

  return tools;
}

/** Create a plugin registry for a specific user */
export async function initPluginRegistry(chatId: number): Promise<PluginRegistry> {
  const available = discoverPlugins();
  const userRole = getUserRole(chatId);
  const isAdmin = userRole === "admin";

  const registry: PluginRegistry = {
    available,
    tools: [...buildMetaTools(isAdmin)],
    handlers: new Map(),
    loadedPlugins: new Set(),
    chatId,
    execute: async () => "Not initialized",
    loadPlugin: async () => "",
  };

  // Wire up execute
  registry.execute = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    // Meta-tools
    if (toolName === "load_plugin") {
      return registry.loadPlugin(input.name as string);
    }
    if (toolName === "set_secret") {
      const secretValue = input.value as string;
      setUserSecret(
        chatId,
        input.plugin as string,
        input.key as string,
        secretValue,
      );

      // Redact the secret from conversation history and delete Telegram message
      try {
        const { redactSecretFromHistory } = await import("../db/queries.js");
        const { getBotInstance } = await import("../bot/telegram.js");
        const redacted = redactSecretFromHistory(chatId, secretValue);
        if (redacted.telegramMessageId) {
          const bot = getBotInstance();
          bot.api.deleteMessage(chatId, redacted.telegramMessageId).catch(() => {});
        }
      } catch {
        // Best effort — don't fail the set_secret call
      }

      return `Secret "${input.key}" saved for plugin "${input.plugin}". Your message containing the secret has been deleted for security.`;
    }
    if (toolName === "memory_write") {
      const { addMemory } = await import("../db/queries.js");
      addMemory(chatId, input.category as string, input.content as string);
      return `Remembered in ${input.category}: ${input.content}`;
    }
    if (toolName === "memory_delete") {
      const { deleteMemory } = await import("../db/queries.js");
      deleteMemory(chatId, input.memory_id as number);
      return "Memory deleted.";
    }
    if (toolName === "search_history") {
      const { searchMessages } = await import("../db/queries.js");
      const results = searchMessages(chatId, input.query as string, (input.limit as number) || 10);
      if (results.length === 0) return `No messages found matching "${input.query}"`;
      return results
        .map((r) => `[${r.role}] ${new Date(r.createdAt * 1000).toISOString().slice(0, 16)}: ${r.content.slice(0, 200)}`)
        .join("\n\n");
    }
    if (toolName === "list_users") {
      const { listAllUsers } = await import("../db/queries.js");
      const users = listAllUsers({
        search: input.search as string | undefined,
        role: input.role as any,
      });
      if (users.length === 0) return "No users found.";
      return users
        .map((u) => `${u.chatId} — ${u.name || "unnamed"} (${u.role})`)
        .join("\n");
    }
    if (toolName === "notify_users") {
      const { getBotInstance } = await import("../bot/telegram.js");
      const { getUsersByRoles } = await import("../db/queries.js");
      const bot = getBotInstance();
      const roles = (input.roles as string[]) || [];
      const chatIds = (input.chat_ids as number[]) || [];

      // Collect target chat IDs (deduplicated)
      const targets = new Set<number>(chatIds);
      if (roles.length > 0) {
        const roleUsers = getUsersByRoles(roles as any);
        roleUsers.forEach((u) => targets.add(u.chatId));
      }

      if (targets.size === 0) return "No targets specified. Provide roles or chat_ids.";

      let sent = 0;
      for (const id of targets) {
        try {
          await bot.api.sendMessage(id, input.message as string);
          sent++;
        } catch {
          // User may have blocked the bot
        }
      }

      const targetDesc = [
        roles.length ? roles.join("/") + " roles" : "",
        chatIds.length ? chatIds.length + " chat IDs" : "",
      ].filter(Boolean).join(" + ");

      return `Sent to ${sent}/${targets.size} users (${targetDesc}).`;
    }
    if (toolName === "notify_admin") {
      const { getBotInstance } = await import("../bot/telegram.js");
      const { config } = await import("../config.js");
      const { ensureUser } = await import("../db/queries.js");
      const bot = getBotInstance();
      const adminIds = config.ADMIN_USER_IDS;
      if (adminIds.length === 0) return "No admin configured.";

      // Always inject the actual caller's info
      const user = ensureUser(chatId);
      const displayName = user.name || `User ${chatId}`;
      const fullMsg = `From: ${displayName} (${chatId}, ${user.role})\n\n${input.message as string}`;

      for (const adminId of adminIds) {
        await bot.api.sendMessage(adminId, fullMsg).catch(() => {});
      }
      return `Admin${adminIds.length > 1 ? "s" : ""} notified.`;
    }

    if (toolName === "create_reminder") {
      const { createReminder } = await import("../db/queries.js");
      const triggerAt = Math.floor(new Date(input.trigger_at as string).getTime() / 1000);
      if (isNaN(triggerAt)) return "Invalid trigger_at datetime. Use ISO 8601 format (e.g. '2026-03-24T14:00:00Z').";

      // Recursion guard: if called during a reminder-triggered agent run, tag it
      const source = registry.reminderSource ? "reminder" : "user";
      const id = createReminder(chatId, input.note as string, triggerAt, source);

      const when = new Date(triggerAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      return `Reminder #${id} set for ${when}: ${input.note}`;
    }
    if (toolName === "list_reminders") {
      const { listReminders } = await import("../db/queries.js");
      const items = listReminders(chatId);
      if (items.length === 0) return "No active reminders.";
      return items
        .map((r) => {
          const when = new Date(r.triggerAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
          return `#${r.id} — ${when} — ${r.note}`;
        })
        .join("\n");
    }
    if (toolName === "delete_reminder") {
      const { deleteReminder } = await import("../db/queries.js");
      const ok = deleteReminder(chatId, input.reminder_id as number);
      return ok ? `Reminder #${input.reminder_id} deleted.` : "Reminder not found (wrong ID or not yours).";
    }

    // Plugin tools
    const entry = registry.handlers.get(toolName);
    if (!entry) throw new Error(`Unknown tool: ${toolName}`);

    // Re-resolve secrets per call (dynamic secrets)
    const pluginInfo = available.find((p) => p.name === entry.pluginName);
    const secrets = pluginInfo
      ? resolveSecrets(chatId, entry.pluginName, pluginInfo.secretsSpec)
      : {};

    return entry.handler(input, secrets, chatId);
  };

  // Wire up loadPlugin
  registry.loadPlugin = async (name: string): Promise<string> => {
    const plugin = available.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (!plugin) {
      const names = available.map((p) => p.name).join(", ");
      return `Plugin "${name}" not found. Available: ${names}`;
    }

    if (registry.loadedPlugins.has(plugin.name)) {
      return `Plugin "${plugin.name}" is already loaded.`;
    }

    // Admin-only plugins
    if (plugin.adminOnly && !isAdmin) {
      return `Plugin "${plugin.name}" is restricted to admin users.`;
    }

    // Check if non-admin user has access
    if (!isAdmin) {
      const userPluginList = getUserPlugins(chatId);
      if (userPluginList.length > 0 && !userPluginList.includes(plugin.name)) {
        return `You don't have access to plugin "${plugin.name}". Use /plugins to manage your plugins.`;
      }
    }

    try {
      const newTools = await loadSinglePlugin(plugin, registry);
      const toolNames = newTools.map((t) => t.name).join(", ");
      return `Plugin "${plugin.name}" loaded. New tools: ${toolNames}`;
    } catch (err) {
      return `Failed to load "${plugin.name}": ${(err as Error).message}`;
    }
  };

  // Auto-load alwaysLoaded plugins (core)
  for (const plugin of available.filter((p) => p.alwaysLoaded)) {
    // Non-admin users don't get core tools (bash, file access)
    if (!isAdmin && plugin.name === "core") continue;

    try {
      await loadSinglePlugin(plugin, registry);
    } catch (err) {
      logger.error({ err, plugin: plugin.name }, "Failed to load core plugin");
    }
  }

  logger.info(
    {
      chatId,
      role: userRole,
      available: available.map((p) => p.name),
      loaded: Array.from(registry.loadedPlugins),
    },
    "Plugin registry initialized",
  );

  return registry;
}

/** Get plugin descriptions for system prompt */
export function getPluginDescriptions(available: PluginInfo[]): string {
  return available
    .filter((p) => !p.alwaysLoaded)
    .map((p) => `- ${p.name}: ${p.description}`)
    .join("\n");
}
