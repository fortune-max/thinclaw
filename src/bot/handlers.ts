import type { Bot } from "grammy";
import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import { insertMessage, ensureUser, getUsageStats, getUserRole, setUserRole, checkUsageCap, createPendingUpgrade, getAdminStats, type UserRole } from "../db/queries.js";
import { runAgent, type AgentResult } from "../ai/agent.js";
import { editTelegramMessage } from "./telegram.js";
import { initPluginRegistry, type PluginRegistry } from "../plugins/loader.js";
import { handleConfirmationCallback } from "../security/confirmation.js";
import { setModelOverride, MODEL_ALIASES } from "../ai/agent.js";

// Per-user plugin registries (keyed by chatId)
const registries = new Map<number, PluginRegistry>();

// Pending upgrade flows — waiting for sender address
const pendingUpgradeFlows = new Map<number, { amountTon: number; tonPrice: number; priceUsd: number }>();

async function getRegistry(chatId: number): Promise<PluginRegistry> {
  let reg = registries.get(chatId);
  if (!reg) {
    reg = await initPluginRegistry(chatId);
    registries.set(chatId, reg);
  }
  return reg;
}

export function registerHandlers(bot: Bot): void {
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const userName = ctx.from.first_name || ctx.from.username || undefined;

    // Ensure user exists in DB
    const user = ensureUser(chatId, userName);

    // Welcome message for new users + notify admins
    if (user.isNew) {
      if (user.role === "guest") {
        const reg = await getRegistry(chatId);
        const pluginNames = reg.available.map((p) => p.name).join(", ");
        await ctx.reply(
          `Welcome! You're on the free plan (10 messages/day).\n\n` +
          `Available plugins: ${pluginNames || "none"}\n\n` +
          `Commands:\n` +
          `/usage — check your usage\n` +
          `/model — switch AI model (haiku)\n\n` +
          `For full access, ask the admin for an upgrade.`
        );
      }

      // Notify admins of new user (no model invocation, direct Telegram API)
      const bot = (await import("./telegram.js")).getBotInstance();
      const displayName = userName || `User ${chatId}`;
      for (const adminId of (await import("../config.js")).config.ADMIN_USER_IDS) {
        bot.api.sendMessage(adminId, `New user joined: ${displayName} (${chatId}), role: ${user.role}`).catch(() => {});
      }
    }

    // Handle /model command
    if (text.startsWith("/model")) {
      const userRole = getUserRole(chatId);
      const alias = text.split(/\s+/)[1]?.toLowerCase();

      // Role-based model access
      const allowedModels: Record<string, string[]> = {
        admin: ["haiku", "sonnet", "opus"],
        user: ["haiku", "sonnet"],
        guest: ["haiku"],
      };
      const allowed = allowedModels[userRole] || allowedModels.guest;

      if (!alias || !MODEL_ALIASES[alias]) {
        await ctx.reply(`Usage: /model <${allowed!.join(", ")}>`);
        return;
      }
      if (!allowed!.includes(alias)) {
        await ctx.reply(`Your account only has access to: ${allowed!.join(", ")}. Ask for an upgrade for more models.`);
        return;
      }
      setModelOverride(chatId, MODEL_ALIASES[alias]);
      await ctx.reply(`Model switched to ${alias} (${MODEL_ALIASES[alias]}) for your next message.`);
      return;
    }

    // Handle /usage command
    if (text.startsWith("/usage")) {
      const todayStats = getUsageStats(chatId, "today");
      const weekStats = getUsageStats(chatId, "7d");
      const monthStats = getUsageStats(chatId, "30d");

      const formatStats = (label: string, s: typeof todayStats) => {
        let str = `*${label}:* ${s.messageCount} msgs, $${s.totalCostUsd.toFixed(4)}`;
        str += `\n  Tokens in: ${s.totalInputTokens.toLocaleString()} | Tokens out: ${s.totalOutputTokens.toLocaleString()}`;
        const models = Object.entries(s.byModel);
        if (models.length > 0) {
          str += "\n  " + models
            .map(([m, d]) => `${m.replace("claude-", "")}: ${d.count} msgs $${d.costUsd.toFixed(4)}`)
            .join(", ");
        }
        return str;
      };

      const role = getUserRole(chatId);
      const msg = [
        `*Role:* ${role}`,
        formatStats("Today (UTC)", todayStats),
        formatStats("7 days", weekStats),
        formatStats("30 days", monthStats),
      ].join("\n\n");

      await ctx.reply(msg, { parse_mode: "Markdown" });
      return;
    }

    // Handle /stats command (admin only)
    if (text.startsWith("/stats")) {
      if (getUserRole(chatId) !== "admin") {
        await ctx.reply("You don't have permission to use this command.");
        return;
      }

      const s = getAdminStats();

      const roleStr = Object.entries(s.users.byRole)
        .map(([r, c]) => `${c} ${r}`)
        .join(", ");

      const usageStr = Object.entries(s.usage)
        .map(([period, u]) => {
          const modelStr = Object.entries(u.byModel)
            .map(([m, c]) => `${m}: ${c}`)
            .join(", ");
          return `*${period}:* ${u.messages} msgs, ${u.inputTokens.toLocaleString()}/${u.outputTokens.toLocaleString()} tokens, $${u.costUsd.toFixed(4)}\n  ${modelStr}`;
        })
        .join("\n");

      const topStr = s.topUsers.length
        ? s.topUsers
            .map((u, i) => `${i + 1}. ${u.name || u.chatId} — ${u.messages} msgs, $${u.costUsd.toFixed(4)}`)
            .join("\n")
        : "No activity";

      const msg = [
        `*Users:* ${s.users.total} total (${roleStr})`,
        `*New:* ${s.newUsers.last24h} (24h), ${s.newUsers.last7d} (7d)`,
        `*Active:* ${s.activeUsers.last30m} (30m), ${s.activeUsers.last8h} (8h), ${s.activeUsers.last24h} (24h)`,
        ``,
        `*Usage:*\n${usageStr}`,
        ``,
        `*Top users (24h):*\n${topStr}`,
      ].join("\n");

      await ctx.reply(msg, { parse_mode: "Markdown" });
      return;
    }

    // Handle /upgrade command (step 1: ask for sender address)
    if (text.startsWith("/upgrade")) {
      const currentRole = getUserRole(chatId);
      if (currentRole === "user" || currentRole === "admin") {
        await ctx.reply("You're already on a paid plan!");
        return;
      }

      const { config: cfg } = await import("../config.js");
      if (!cfg.UPGRADE_TON_ADDRESS) {
        await ctx.reply("Upgrades are not available at this time.");
        return;
      }

      // Fetch TON/USD rate
      let tonPrice: number;
      try {
        const rateRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd");
        const rateData = await rateRes.json() as { "the-open-network": { usd: number } };
        tonPrice = rateData["the-open-network"].usd;
      } catch {
        await ctx.reply("Could not fetch TON price. Try again later.");
        return;
      }

      const amountTon = Math.ceil((cfg.UPGRADE_PRICE_USD / tonPrice) * 100) / 100;

      // Store pending state — waiting for sender address
      pendingUpgradeFlows.set(chatId, { amountTon, tonPrice, priceUsd: cfg.UPGRADE_PRICE_USD });

      await ctx.reply(
        `*Upgrade to User plan — $${cfg.UPGRADE_PRICE_USD}/month*\n` +
        `Amount: \`${amountTon}\` TON (1 TON ≈ $${tonPrice.toFixed(2)})\n\n` +
        `Reply with the TON wallet address you'll send from, or /cancel to go back.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // Handle /cancel for upgrade flow
    if (text === "/cancel" && pendingUpgradeFlows.has(chatId)) {
      pendingUpgradeFlows.delete(chatId);
      await ctx.reply("Upgrade cancelled.");
      return;
    }

    // Handle upgrade step 2: user provides sender address
    if (pendingUpgradeFlows.has(chatId)) {
      const flow = pendingUpgradeFlows.get(chatId)!;
      const senderAddr = text.trim();

      // Basic validation — TON addresses start with UQ/EQ/0: or are raw
      if (!senderAddr.match(/^(UQ|EQ|0:|kQ)[A-Za-z0-9_-]{20,}/)) {
        await ctx.reply("That doesn't look like a valid TON address. Please try again or type /cancel.");
        return;
      }

      pendingUpgradeFlows.delete(chatId);

      const { config: cfg } = await import("../config.js");
      const reference = `upgrade-${chatId}-${Date.now()}`;

      // Create transfer via TON Pay SDK
      let payToAddr = cfg.UPGRADE_TON_ADDRESS;
      try {
        const { createTonPayTransfer, TON } = await import("@ton-pay/api");
        const transferInfo = await createTonPayTransfer({
          amount: flow.amountTon,
          asset: TON,
          recipientAddr: cfg.UPGRADE_TON_ADDRESS,
          senderAddr,
          commentToRecipient: reference,
        }, { chain: "mainnet" });
        payToAddr = transferInfo.message.address || payToAddr;
      } catch (err) {
        logger.debug({ err }, "TON Pay createTransfer failed, using manual address");
      }

      createPendingUpgrade(chatId, flow.amountTon, flow.priceUsd, reference);

      // Notify admin
      const upgradeBot = (await import("./telegram.js")).getBotInstance();
      const upgradeDisplayName = userName || `User ${chatId}`;
      for (const adminId of cfg.ADMIN_USER_IDS) {
        upgradeBot.api.sendMessage(adminId, `${upgradeDisplayName} (${chatId}) requested /upgrade — ${flow.amountTon} TON from ${senderAddr}`).catch(() => {});
      }

      await ctx.reply(
        `*Send exactly \`${flow.amountTon}\` TON to:*\n\`${payToAddr}\`\n\n` +
        `Include this message in the transfer:\n\`${reference}\`\n\n` +
        `Valid for 30 minutes.\n\n` +
        `Powered by TON Pay — your account upgrades automatically once payment is confirmed on-chain.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // Handle /donate command
    if (text.startsWith("/donate")) {
      // Notify admin
      const donateBot = (await import("./telegram.js")).getBotInstance();
      const donateDisplayName = userName || `User ${chatId}`;
      for (const adminId of (await import("../config.js")).config.ADMIN_USER_IDS) {
        donateBot.api.sendMessage(adminId, `${donateDisplayName} (${chatId}) opened /donate`).catch(() => {});
      }

      await ctx.reply(
        `Thanks for considering a donation!\n\n` +
        `☕ Ko-fi: https://ko-fi.com/thinclaw\n\n` +
        `💎 TON (TON Network):\n\`UQD2BR26jNITn50bR-QEcLiJ09R8azE3GyHmgIKNSuRk8kAf\`\n\n` +
        `₿ BTC (Bitcoin Network):\n\`15nWB9uv45aS4dD2vJ2CVM7WQGmYNdmmSu\`\n\n` +
        `⟠ ETH (Ethereum Network):\n\`0x5956e6e3df89c591872985fe9fbf2fc9ea838c96\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // Handle /role command (admin only)
    if (text.startsWith("/role")) {
      const role = getUserRole(chatId);
      if (role !== "admin") {
        await ctx.reply("You don't have permission to use this command.");
        return;
      }
      const parts = text.split(/\s+/);
      const targetId = Number(parts[1]);
      const newRole = parts[2]?.toLowerCase() as UserRole | undefined;
      const validRoles: UserRole[] = ["admin", "user", "guest", "banned"];
      if (!targetId || !newRole || !validRoles.includes(newRole)) {
        await ctx.reply(`Usage: /role <chat_id> <${validRoles.join("|")}>`);
        return;
      }
      ensureUser(targetId);
      setUserRole(targetId, newRole);
      await ctx.reply(`User ${targetId} role set to ${newRole}.`);
      return;
    }

    // Handle /reload command (re-init plugin registry)
    if (text === "/reload") {
      registries.delete(chatId);
      await ctx.reply("Plugin registry reloaded.");
      return;
    }

    // Check role restrictions
    const role = getUserRole(chatId);

    if (role === "banned") {
      await ctx.reply("Sorry, this service is currently unavailable for your account.");
      return;
    }

    const cap = checkUsageCap(chatId, role);
    if (!cap.allowed) {
      await ctx.reply(cap.reason!);
      return;
    }

    logger.info({ chatId, userId: ctx.from.id, messageLength: text.length }, "Received text");
    insertMessage(chatId, "user", text, ctx.message.message_id);

    const thinkingMsg = await ctx.reply("Thinking...");
    processMessageInBackground(chatId, text, thinkingMsg.message_id, userName).catch((err) => {
      logger.error({ err, chatId }, "Background processing failed");
      editTelegramMessage(chatId, thinkingMsg.message_id, "Sorry, something went wrong.").catch(() => {});
    });
  });

  // Photo messages
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption || "What's in this image?";
    const userName = ctx.from.first_name || ctx.from.username || undefined;

    ensureUser(chatId, userName);

    const photoRole = getUserRole(chatId);
    if (photoRole === "banned") {
      await ctx.reply("Sorry, this service is currently unavailable for your account.");
      return;
    }
    const photoCap = checkUsageCap(chatId, photoRole);
    if (!photoCap.allowed) {
      await ctx.reply(photoCap.reason!);
      return;
    }

    logger.info({ chatId, userId: ctx.from.id, caption }, "Received photo");
    insertMessage(chatId, "user", `[Photo] ${caption}`, ctx.message.message_id);

    const thinkingMsg = await ctx.reply("Analyzing image...");

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    try {
      const file = await ctx.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");

      const ext = file.file_path?.split(".").pop()?.toLowerCase() || "jpg";
      const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";

      const content: Anthropic.MessageParam["content"] = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: base64,
          },
        },
        { type: "text", text: caption },
      ];

      processMessageInBackground(chatId, content, thinkingMsg.message_id, userName).catch((err) => {
        logger.error({ err, chatId }, "Background processing failed");
        editTelegramMessage(chatId, thinkingMsg.message_id, "Sorry, something went wrong.").catch(() => {});
      });
    } catch (err) {
      logger.error({ err, chatId }, "Failed to download photo");
      await editTelegramMessage(chatId, thinkingMsg.message_id, "Failed to process the image.");
    }
  });

  // Location messages
  bot.on("message:location", async (ctx) => {
    const chatId = ctx.chat.id;
    const userName = ctx.from.first_name || ctx.from.username || undefined;
    const { latitude, longitude } = ctx.message.location;

    ensureUser(chatId, userName);

    const locRole = getUserRole(chatId);
    if (locRole === "banned") {
      await ctx.reply("Sorry, this service is currently unavailable for your account.");
      return;
    }
    const locCap = checkUsageCap(chatId, locRole);
    if (!locCap.allowed) {
      await ctx.reply(locCap.reason!);
      return;
    }

    logger.info({ chatId, latitude, longitude }, "Received location");
    const locationText = `[Location] lat: ${latitude}, lon: ${longitude}. What transport options and bikes are near me?`;
    insertMessage(chatId, "user", locationText, ctx.message.message_id);

    const thinkingMsg = await ctx.reply("Checking what's nearby...");
    processMessageInBackground(chatId, locationText, thinkingMsg.message_id, userName).catch((err) => {
      logger.error({ err, chatId }, "Background processing failed");
      editTelegramMessage(chatId, thinkingMsg.message_id, "Sorry, something went wrong.").catch(() => {});
    });
  });

  // Confirmation callbacks
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("confirm:")) {
      const [, callbackId, action] = data.split(":");
      logger.info({ callbackId, action }, "Received confirmation callback");
      await ctx.answerCallbackQuery({ text: action === "yes" ? "Approved" : "Denied" });
      handleConfirmationCallback(callbackId!, action === "yes");
    }
  });
}

async function processMessageInBackground(
  chatId: number,
  userMessage: string | Anthropic.MessageParam["content"],
  placeholderMessageId: number,
  userName?: string | null,
): Promise<void> {
  const startTime = Date.now();
  const reg = await getRegistry(chatId);

  const result: AgentResult = await runAgent({
    chatId,
    userMessage,
    placeholderMessageId,
    tools: reg.tools,
    executeTool: reg.execute,
    availablePlugins: reg.available,
    userName,
  });

  // Store response with usage data
  insertMessage(chatId, "assistant", result.text, placeholderMessageId, {
    model: result.model,
    inputTokens: result.totalInputTokens,
    outputTokens: result.totalOutputTokens,
    costUsd: result.totalCostUsd,
  });

  const durationMs = Date.now() - startTime;
  logger.info(
    {
      chatId,
      durationMs,
      model: result.model,
      tokens: `${result.totalInputTokens}/${result.totalOutputTokens}`,
      cost: `$${result.totalCostUsd.toFixed(4)}`,
    },
    "Message processing complete",
  );
}

/** Called by the reminder monitor to trigger an agent run */
export async function processReminderRun(
  chatId: number,
  note: string,
  placeholderMessageId: number,
): Promise<void> {
  // If user is over their usage cap, just send the note as a plain message
  const role = getUserRole(chatId);
  const cap = checkUsageCap(chatId, role);
  if (!cap.allowed) {
    await editTelegramMessage(chatId, placeholderMessageId, `🔔 Reminder: ${note}`);
    return;
  }

  // Insert as a system-generated user message so it appears in history
  insertMessage(chatId, "user", `[Scheduled reminder] ${note}`);

  const reg = await getRegistry(chatId);
  reg.reminderSource = true;

  try {
    const result: AgentResult = await runAgent({
      chatId,
      userMessage: `This is a scheduled reminder you previously set for yourself. The task: ${note}\n\nPerform this task now.`,
      placeholderMessageId,
      tools: reg.tools,
      executeTool: reg.execute,
      availablePlugins: reg.available,
    });

    insertMessage(chatId, "assistant", result.text, placeholderMessageId, {
      model: result.model,
      inputTokens: result.totalInputTokens,
      outputTokens: result.totalOutputTokens,
      costUsd: result.totalCostUsd,
    });
  } catch (err) {
    logger.error({ err, chatId }, "Reminder agent run failed");
    editTelegramMessage(chatId, placeholderMessageId, "⚠️ Scheduled task failed.").catch(() => {});
  } finally {
    reg.reminderSource = false;
  }
}
