import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  telegramMessageId: integer("telegram_message_id"),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const toolCalls = sqliteTable("tool_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: integer("message_id").references(() => messages.id),
  chatId: integer("chat_id").notNull(),
  toolName: text("tool_name").notNull(),
  toolInput: text("tool_input").notNull(),
  toolResult: text("tool_result").notNull(),
  durationMs: integer("duration_ms"),
  isError: integer("is_error").default(0),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const confirmations = sqliteTable("confirmations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  toolName: text("tool_name").notNull(),
  toolInput: text("tool_input").notNull(),
  status: text("status", { enum: ["pending", "approved", "denied"] })
    .notNull()
    .default("pending"),
  callbackData: text("callback_data").notNull().unique(),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  resolvedAt: integer("resolved_at"),
});

export const userMemories = sqliteTable("user_memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  category: text("category").notNull(), // preferences, corrections, facts
  content: text("content").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const userSecrets = sqliteTable(
  "user_secrets",
  {
    chatId: integer("chat_id").notNull(),
    plugin: text("plugin").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(), // encrypted
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.plugin, table.key] }),
  }),
);

export const userPlugins = sqliteTable(
  "user_plugins",
  {
    chatId: integer("chat_id").notNull(),
    plugin: text("plugin").notNull(),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.plugin] }),
  }),
);

export const userNotes = sqliteTable("user_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  pinned: integer("pinned").notNull().default(0),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const pendingUpgrades = sqliteTable("pending_upgrades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  amountTon: real("amount_ton").notNull(),
  amountUsd: real("amount_usd").notNull(),
  reference: text("reference").notNull().unique(),
  status: text("status", { enum: ["pending", "paid", "expired"] }).notNull().default("pending"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  paidAt: integer("paid_at"),
});

export const users = sqliteTable("users", {
  chatId: integer("chat_id").primaryKey(),
  name: text("name"),
  role: text("role", { enum: ["admin", "user", "guest", "banned"] }).notNull().default("guest"),
  systemPromptOverride: text("system_prompt_override"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const reminders = sqliteTable("reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  note: text("note").notNull(),               // what the agent reads and acts on
  triggerAt: integer("trigger_at").notNull(),  // unix epoch seconds, UTC
  status: text("status", { enum: ["active", "completed"] }).notNull().default("active"),
  source: text("source", { enum: ["user", "reminder"] }).notNull().default("user"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});
