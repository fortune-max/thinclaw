import { desc, eq, and, gte, lte, like, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import {
  messages,
  toolCalls,
  confirmations,
  userMemories,
  userSecrets,
  userPlugins,
  userNotes,
  pendingUpgrades,
  users,
  reminders,
} from "./schema.js";
import { encrypt, decrypt } from "../security/crypto.js";

// ─── Secret Redaction ────────────────────────────────────────

/**
 * Find the most recent user message containing a secret value,
 * redact it, and return the Telegram message ID for deletion.
 */
export function redactSecretFromHistory(
  chatId: number,
  secretValue: string,
): { telegramMessageId: number | null } {
  const db = getDb();

  // Find recent user messages that contain the secret (last 5)
  const recentMsgs = db
    .select({
      id: messages.id,
      content: messages.content,
      telegramMessageId: messages.telegramMessageId,
    })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt))
    .limit(5)
    .all();

  for (const msg of recentMsgs) {
    if (msg.content.includes(secretValue)) {
      // Redact the secret value from the stored message
      const redacted = msg.content.replace(new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***");
      db.update(messages)
        .set({ content: redacted })
        .where(eq(messages.id, msg.id))
        .run();

      return { telegramMessageId: msg.telegramMessageId || null };
    }
  }

  return { telegramMessageId: null };
}

// ─── Messages ───────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export function insertMessage(
  chatId: number,
  role: "user" | "assistant",
  content: string,
  telegramMessageId?: number,
  usage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number },
): number {
  const db = getDb();
  const result = db
    .insert(messages)
    .values({
      chatId,
      role,
      content,
      telegramMessageId,
      model: usage?.model,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      costUsd: usage?.costUsd,
    })
    .returning({ id: messages.id })
    .get();
  return result.id;
}

export function searchMessages(
  chatId: number,
  query: string,
  limit: number = 10,
): { role: string; content: string; createdAt: number }[] {
  const db = getDb();
  return db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        sql`${messages.content} LIKE ${'%' + query + '%'}`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();
}

export function getRecentMessages(
  chatId: number,
  limit: number = 5,
): ConversationMessage[] {
  const db = getDb();
  const rows = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();
  return rows.reverse();
}

// ─── Tool Calls ─────────────────────────────────────────────

export function insertToolCall(params: {
  messageId?: number;
  chatId: number;
  toolName: string;
  toolInput: unknown;
  toolResult: string;
  durationMs?: number;
  isError?: boolean;
}): void {
  const db = getDb();
  db.insert(toolCalls)
    .values({
      messageId: params.messageId,
      chatId: params.chatId,
      toolName: params.toolName,
      toolInput: JSON.stringify(params.toolInput),
      toolResult: params.toolResult,
      durationMs: params.durationMs,
      isError: params.isError ? 1 : 0,
    })
    .run();
}

// ─── Confirmations ──────────────────────────────────────────

export function createConfirmation(
  chatId: number,
  toolName: string,
  toolInput: unknown,
  callbackData: string,
): void {
  const db = getDb();
  db.insert(confirmations)
    .values({
      chatId,
      toolName,
      toolInput: JSON.stringify(toolInput),
      callbackData,
    })
    .run();
}

export function resolveConfirmation(
  callbackData: string,
  status: "approved" | "denied",
): void {
  const db = getDb();
  db.update(confirmations)
    .set({ status, resolvedAt: Math.floor(Date.now() / 1000) })
    .where(
      and(
        eq(confirmations.callbackData, callbackData),
        eq(confirmations.status, "pending"),
      ),
    )
    .run();
}

// ─── User Memories ──────────────────────────────────────────

export function addMemory(
  chatId: number,
  category: string,
  content: string,
): void {
  const db = getDb();
  db.insert(userMemories).values({ chatId, category, content }).run();
}

export function getMemories(
  chatId: number,
  category?: string,
): { category: string; content: string; createdAt: number }[] {
  const db = getDb();
  if (category) {
    return db
      .select({
        category: userMemories.category,
        content: userMemories.content,
        createdAt: userMemories.createdAt,
      })
      .from(userMemories)
      .where(
        and(eq(userMemories.chatId, chatId), eq(userMemories.category, category)),
      )
      .orderBy(desc(userMemories.createdAt))
      .all();
  }
  return db
    .select({
      category: userMemories.category,
      content: userMemories.content,
      createdAt: userMemories.createdAt,
    })
    .from(userMemories)
    .where(eq(userMemories.chatId, chatId))
    .orderBy(userMemories.category, desc(userMemories.createdAt))
    .all();
}

export function deleteMemory(chatId: number, memoryId: number): void {
  const db = getDb();
  db.delete(userMemories)
    .where(and(eq(userMemories.id, memoryId), eq(userMemories.chatId, chatId)))
    .run();
}

// ─── User Secrets (encrypted) ───────────────────────────────

export function setUserSecret(
  chatId: number,
  plugin: string,
  key: string,
  value: string,
): void {
  const db = getDb();
  const encrypted = encrypt(value);
  db.insert(userSecrets)
    .values({
      chatId,
      plugin,
      key,
      value: encrypted,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: [userSecrets.chatId, userSecrets.plugin, userSecrets.key],
      set: { value: encrypted, updatedAt: Math.floor(Date.now() / 1000) },
    })
    .run();
}

export function getUserSecrets(
  chatId: number,
  plugin: string,
): Record<string, string> {
  const db = getDb();
  const rows = db
    .select({ key: userSecrets.key, value: userSecrets.value })
    .from(userSecrets)
    .where(
      and(eq(userSecrets.chatId, chatId), eq(userSecrets.plugin, plugin)),
    )
    .all();

  const result: Record<string, string> = {};
  for (const row of rows) {
    try {
      result[row.key] = decrypt(row.value);
    } catch {
      // Skip corrupted secrets
    }
  }
  return result;
}

export function deleteUserSecret(
  chatId: number,
  plugin: string,
  key: string,
): void {
  const db = getDb();
  db.delete(userSecrets)
    .where(
      and(
        eq(userSecrets.chatId, chatId),
        eq(userSecrets.plugin, plugin),
        eq(userSecrets.key, key),
      ),
    )
    .run();
}

// ─── User Plugins ───────────────────────────────────────────

export function enablePlugin(chatId: number, plugin: string): void {
  const db = getDb();
  db.insert(userPlugins)
    .values({ chatId, plugin, enabled: 1 })
    .onConflictDoUpdate({
      target: [userPlugins.chatId, userPlugins.plugin],
      set: { enabled: 1 },
    })
    .run();
}

export function disablePlugin(chatId: number, plugin: string): void {
  const db = getDb();
  db.update(userPlugins)
    .set({ enabled: 0 })
    .where(
      and(eq(userPlugins.chatId, chatId), eq(userPlugins.plugin, plugin)),
    )
    .run();
}

export function getUserPlugins(chatId: number): string[] {
  const db = getDb();
  return db
    .select({ plugin: userPlugins.plugin })
    .from(userPlugins)
    .where(and(eq(userPlugins.chatId, chatId), eq(userPlugins.enabled, 1)))
    .all()
    .map((r) => r.plugin);
}

// ─── Users ──────────────────────────────────────────────────

export function ensureUser(
  chatId: number,
  name?: string,
): { chatId: number; role: string; name: string | null; isNew: boolean } {
  const db = getDb();
  const existing = db
    .select()
    .from(users)
    .where(eq(users.chatId, chatId))
    .get();

  if (existing) return { ...existing, isNew: false };

  const adminIds = (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map(Number)
    .filter(Boolean);
  const isAdmin = adminIds.includes(chatId);

  db.insert(users)
    .values({
      chatId,
      name: name || null,
      role: isAdmin ? "admin" : "guest",
    })
    .run();

  const user = db.select().from(users).where(eq(users.chatId, chatId)).get()!;
  return { ...user, isNew: true };
}

export type UserRole = "admin" | "user" | "guest" | "banned";

export function getUserRole(chatId: number): UserRole {
  const db = getDb();
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.chatId, chatId))
    .get();
  return (user?.role as UserRole) || "guest";
}

export function setUserRole(chatId: number, role: UserRole): void {
  const db = getDb();
  db.update(users).set({ role }).where(eq(users.chatId, chatId)).run();
}

export function setUserName(chatId: number, name: string): void {
  const db = getDb();
  db.update(users).set({ name }).where(eq(users.chatId, chatId)).run();
}

export function getUsersByRoles(roles: UserRole[]): { chatId: number; name: string | null; role: string }[] {
  const db = getDb();
  return db
    .select({ chatId: users.chatId, name: users.name, role: users.role })
    .from(users)
    .all()
    .filter((u) => roles.includes(u.role as UserRole));
}

export function listAllUsers(filters?: { search?: string; role?: UserRole }): { chatId: number; name: string | null; role: string }[] {
  const db = getDb();
  let results = db
    .select({ chatId: users.chatId, name: users.name, role: users.role })
    .from(users)
    .all();

  if (filters?.role) {
    results = results.filter((u) => u.role === filters.role);
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    results = results.filter((u) => u.name?.toLowerCase().includes(q) || String(u.chatId).includes(q));
  }

  return results;
}

const CAPS: Record<string, { msgs: number; cost: number }> = {
  guest: { msgs: 10, cost: 0.10 },
  user: { msgs: 500, cost: 2.00 },
};

export function checkUsageCap(chatId: number, role: string): { allowed: boolean; reason?: string } {
  const cap = CAPS[role];
  if (!cap) return { allowed: true }; // admin has no cap

  const stats = getUsageStats(chatId, "today");
  const hoursLeft = getHoursUntilMidnightUTC();
  const timeStr = hoursLeft >= 1 ? `${Math.floor(hoursLeft)} hours` : `${Math.round(hoursLeft * 60)} minutes`;

  if (stats.messageCount >= cap.msgs || stats.totalCostUsd >= cap.cost) {
    const upgradeNote = role === "guest"
      ? `\n\n/upgrade for unlimited messaging and access to smarter models — or /donate to support the project!`
      : "";
    return {
      allowed: false,
      reason: `You've reached your daily limit. Try again in ${timeStr}.${upgradeNote}`,
    };
  }

  return { allowed: true };
}

function getHoursUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return (midnight.getTime() - now.getTime()) / 3600000;
}

// ─── Usage Tracking ─────────────────────────────────────────

interface UsageStats {
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; count: number }>;
}

export function getUsageStats(chatId: number, period: "today" | "7d" | "30d"): UsageStats {
  const db = getDb();
  const now = new Date();
  let since: number;

  if (period === "today") {
    // UTC midnight today
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    since = Math.floor(midnight.getTime() / 1000);
  } else if (period === "7d") {
    const midnight7 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7));
    since = Math.floor(midnight7.getTime() / 1000);
  } else {
    const midnight30 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
    since = Math.floor(midnight30.getTime() / 1000);
  }

  const rows = db
    .select({
      model: messages.model,
      inputTokens: messages.inputTokens,
      outputTokens: messages.outputTokens,
      costUsd: messages.costUsd,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.role, "assistant"),
        gte(messages.createdAt, since),
      ),
    )
    .all();

  const stats: UsageStats = {
    messageCount: rows.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    byModel: {},
  };

  for (const row of rows) {
    const input = row.inputTokens || 0;
    const output = row.outputTokens || 0;
    const cost = row.costUsd || 0;

    stats.totalInputTokens += input;
    stats.totalOutputTokens += output;
    stats.totalCostUsd += cost;

    const model = row.model || "unknown";
    if (!stats.byModel[model]) {
      stats.byModel[model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, count: 0 };
    }
    stats.byModel[model].inputTokens += input;
    stats.byModel[model].outputTokens += output;
    stats.byModel[model].costUsd += cost;
    stats.byModel[model].count += 1;
  }

  return stats;
}

// ─── Notes ───────────────────────────────────────────────────

export function createNote(chatId: number, title: string, content: string): number {
  const db = getDb();
  const result = db.insert(userNotes).values({ chatId, title, content }).run();
  return Number(result.lastInsertRowid);
}

export function listNotes(chatId: number): { id: number; title: string; pinned: number; updatedAt: number }[] {
  const db = getDb();
  return db
    .select({
      id: userNotes.id,
      title: userNotes.title,
      pinned: userNotes.pinned,
      updatedAt: userNotes.updatedAt,
    })
    .from(userNotes)
    .where(eq(userNotes.chatId, chatId))
    .orderBy(desc(userNotes.pinned), desc(userNotes.updatedAt))
    .all();
}

export function readNote(chatId: number, noteId: number): { id: number; title: string; content: string; pinned: number; updatedAt: number } | undefined {
  const db = getDb();
  return db
    .select({
      id: userNotes.id,
      title: userNotes.title,
      content: userNotes.content,
      pinned: userNotes.pinned,
      updatedAt: userNotes.updatedAt,
    })
    .from(userNotes)
    .where(and(eq(userNotes.chatId, chatId), eq(userNotes.id, noteId)))
    .get();
}

export function findNoteByTitle(chatId: number, title: string): { id: number; title: string; content: string; pinned: number } | undefined {
  const db = getDb();
  return db
    .select({
      id: userNotes.id,
      title: userNotes.title,
      content: userNotes.content,
      pinned: userNotes.pinned,
    })
    .from(userNotes)
    .where(and(eq(userNotes.chatId, chatId), like(userNotes.title, `%${title}%`)))
    .get();
}

export function updateNote(chatId: number, noteId: number, updates: { title?: string; content?: string; pinned?: number }): boolean {
  const db = getDb();
  const result = db
    .update(userNotes)
    .set({ ...updates, updatedAt: sql`(unixepoch())` })
    .where(and(eq(userNotes.chatId, chatId), eq(userNotes.id, noteId)))
    .run();
  return result.changes > 0;
}

export function deleteNote(chatId: number, noteId: number): boolean {
  const db = getDb();
  const result = db
    .delete(userNotes)
    .where(and(eq(userNotes.chatId, chatId), eq(userNotes.id, noteId)))
    .run();
  return result.changes > 0;
}

// ─── Upgrades ────────────────────────────────────────────────

export function createPendingUpgrade(
  chatId: number,
  amountTon: number,
  amountUsd: number,
  reference: string,
): void {
  const db = getDb();
  // Expire any old pending upgrades for this user
  db.update(pendingUpgrades)
    .set({ status: "expired" })
    .where(and(eq(pendingUpgrades.chatId, chatId), eq(pendingUpgrades.status, "pending")))
    .run();

  db.insert(pendingUpgrades)
    .values({ chatId, amountTon, amountUsd, reference, status: "pending" })
    .run();
}

export function getPendingUpgrades(): {
  id: number;
  chatId: number;
  amountTon: number;
  reference: string;
  createdAt: number;
}[] {
  const db = getDb();
  return db
    .select({
      id: pendingUpgrades.id,
      chatId: pendingUpgrades.chatId,
      amountTon: pendingUpgrades.amountTon,
      reference: pendingUpgrades.reference,
      createdAt: pendingUpgrades.createdAt,
    })
    .from(pendingUpgrades)
    .where(eq(pendingUpgrades.status, "pending"))
    .all();
}

export function markUpgradePaid(reference: string): number | null {
  const db = getDb();
  const upgrade = db
    .select({ chatId: pendingUpgrades.chatId })
    .from(pendingUpgrades)
    .where(and(eq(pendingUpgrades.reference, reference), eq(pendingUpgrades.status, "pending")))
    .get();

  if (!upgrade) return null;

  db.update(pendingUpgrades)
    .set({ status: "paid", paidAt: sql`(unixepoch())` })
    .where(eq(pendingUpgrades.reference, reference))
    .run();

  return upgrade.chatId;
}

// ─── Reminders ────────────────────────────────────────────────

export function createReminder(
  chatId: number,
  note: string,
  triggerAt: number,
  source: "user" | "reminder" = "user",
): number {
  const db = getDb();
  const result = db
    .insert(reminders)
    .values({ chatId, note, triggerAt, source })
    .run();
  return Number(result.lastInsertRowid);
}

export function getDueReminders(beforeTime: number) {
  const db = getDb();
  return db
    .select()
    .from(reminders)
    .where(and(eq(reminders.status, "active"), lte(reminders.triggerAt, beforeTime)))
    .all();
}

export function markReminderCompleted(reminderId: number): void {
  const db = getDb();
  db.update(reminders)
    .set({ status: "completed" })
    .where(eq(reminders.id, reminderId))
    .run();
}

export function listReminders(chatId: number) {
  const db = getDb();
  return db
    .select()
    .from(reminders)
    .where(and(eq(reminders.chatId, chatId), eq(reminders.status, "active")))
    .orderBy(reminders.triggerAt)
    .all();
}

export function deleteReminder(chatId: number, reminderId: number): boolean {
  const db = getDb();
  const result = db
    .delete(reminders)
    .where(and(eq(reminders.id, reminderId), eq(reminders.chatId, chatId)))
    .run();
  return result.changes > 0;
}

// ─── Admin Stats ─────────────────────────────────────────────

export interface AdminStats {
  users: { total: number; byRole: Record<string, number> };
  newUsers: { last24h: number; last7d: number };
  activeUsers: { last30m: number; last8h: number; last24h: number };
  usage: Record<string, { messages: number; inputTokens: number; outputTokens: number; costUsd: number; byModel: Record<string, number> }>;
  topUsers: { chatId: number; name: string | null; messages: number; costUsd: number }[];
}

export function getAdminStats(): AdminStats {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Users by role
  const allUsers = db.select({ role: users.role }).from(users).all();
  const byRole: Record<string, number> = {};
  for (const u of allUsers) {
    byRole[u.role] = (byRole[u.role] || 0) + 1;
  }

  // New users
  const newUsers24h = db.select().from(users).where(gte(users.createdAt, now - 86400)).all().length;
  const newUsers7d = db.select().from(users).where(gte(users.createdAt, now - 7 * 86400)).all().length;

  // Active users (users who sent messages)
  const activeQuery = (since: number) =>
    new Set(
      db.select({ chatId: messages.chatId })
        .from(messages)
        .where(and(eq(messages.role, "user"), gte(messages.createdAt, since)))
        .all()
        .map((r) => r.chatId),
    ).size;

  // Usage stats for different periods
  const usagePeriods: Record<string, number> = {
    "8h": now - 8 * 3600,
    "24h": now - 86400,
    "7d": now - 7 * 86400,
  };

  const usage: AdminStats["usage"] = {};
  for (const [period, since] of Object.entries(usagePeriods)) {
    const rows = db
      .select({
        model: messages.model,
        inputTokens: messages.inputTokens,
        outputTokens: messages.outputTokens,
        costUsd: messages.costUsd,
      })
      .from(messages)
      .where(and(eq(messages.role, "assistant"), gte(messages.createdAt, since)))
      .all();

    const byModel: Record<string, number> = {};
    let totalIn = 0, totalOut = 0, totalCost = 0;
    for (const r of rows) {
      totalIn += r.inputTokens || 0;
      totalOut += r.outputTokens || 0;
      totalCost += r.costUsd || 0;
      const m = (r.model || "unknown").replace("claude-", "");
      byModel[m] = (byModel[m] || 0) + 1;
    }

    usage[period] = {
      messages: rows.length,
      inputTokens: totalIn,
      outputTokens: totalOut,
      costUsd: totalCost,
      byModel,
    };
  }

  // Top 3 active users (last 24h)
  const userMsgRows = db
    .select({ chatId: messages.chatId, costUsd: messages.costUsd })
    .from(messages)
    .where(and(eq(messages.role, "assistant"), gte(messages.createdAt, now - 86400)))
    .all();

  const userAgg: Record<number, { messages: number; costUsd: number }> = {};
  for (const r of userMsgRows) {
    if (!userAgg[r.chatId]) userAgg[r.chatId] = { messages: 0, costUsd: 0 };
    userAgg[r.chatId].messages++;
    userAgg[r.chatId].costUsd += r.costUsd || 0;
  }

  const topUsers = Object.entries(userAgg)
    .sort((a, b) => b[1].messages - a[1].messages)
    .slice(0, 3)
    .map(([id, stats]) => {
      const user = db.select({ name: users.name }).from(users).where(eq(users.chatId, Number(id))).get();
      return { chatId: Number(id), name: user?.name || null, ...stats };
    });

  return {
    users: { total: allUsers.length, byRole },
    newUsers: { last24h: newUsers24h, last7d: newUsers7d },
    activeUsers: {
      last30m: activeQuery(now - 1800),
      last8h: activeQuery(now - 8 * 3600),
      last24h: activeQuery(now - 86400),
    },
    usage,
    topUsers,
  };
}
