import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import { sendConfirmationKeyboard, editTelegramMessage } from "../bot/telegram.js";
import { createConfirmation, resolveConfirmation as dbResolve } from "../db/queries.js";
import { logger } from "../logger.js";

const confirmationEmitter = new EventEmitter();

// Only truly destructive bash patterns
const DANGEROUS_BASH_PATTERNS =
  /\b(rm\s+-rf|rm\s+-r\b|sudo|chmod\s+[0-7]|chown|kill\s+-9|reboot|shutdown|dd\s+if=|mkfs|curl.*\|\s*(bash|sh)|wget.*\|\s*(bash|sh))\b/i;

// System paths that should never be written to
const SENSITIVE_PATHS = ["/etc/", "/usr/", "/var/", "/boot/", "/sys/", "/proc/"];

// Paths the bot is allowed to write to without confirmation
const SAFE_WRITE_PATHS = ["/data/", "/app/data/", "./data/"];

export function isDangerousToolCall(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === "bash") {
    const command = String(input.command || "");
    return DANGEROUS_BASH_PATTERNS.test(command);
  }

  if (toolName === "write_file" || toolName === "append_file") {
    const filePath = String(input.file_path || input.path || "");

    // Allow writes to safe paths (data dir, etc.)
    if (SAFE_WRITE_PATHS.some((p) => filePath.startsWith(p))) return false;

    return SENSITIVE_PATHS.some((p) => filePath.startsWith(p));
  }

  // Financial operations — always require confirmation
  if (toolName === "flw_transfer" || toolName === "flw_buy_airtime" || toolName === "ton_send") {
    return true;
  }

  // Broadcast to users — always require confirmation
  if (toolName === "notify_users") {
    return true;
  }

  return false;
}

export async function requestConfirmation(
  chatId: number,
  toolName: string,
  toolInput: Record<string, unknown>,
  timeoutMs: number = 120000,
): Promise<boolean> {
  const callbackId = uuid();

  // Store in DB for audit trail
  createConfirmation(chatId, toolName, toolInput, callbackId);

  // Send inline keyboard to Telegram
  const confirmMsgId = await sendConfirmationKeyboard(chatId, toolName, toolInput, callbackId);

  logger.info({ chatId, toolName, callbackId }, "Confirmation requested");

  // Wait for user response via EventEmitter
  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      confirmationEmitter.removeAllListeners(callbackId);
      dbResolve(callbackId, "denied");
      logger.info({ callbackId }, "Confirmation timed out — denied");
      resolve(false);
    }, timeoutMs);

    confirmationEmitter.once(callbackId, (result: boolean) => {
      clearTimeout(timer);
      dbResolve(callbackId, result ? "approved" : "denied");
      resolve(result);
    });
  });

  // Update the confirmation message — remove buttons and show result
  const statusText = approved ? "Approved" : "Denied";
  try {
    const { getBotInstance } = await import("../bot/telegram.js");
    const bot = getBotInstance();
    await bot.api.editMessageText(chatId, confirmMsgId, `${statusText}: ${toolName}`, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    await editTelegramMessage(chatId, confirmMsgId, `${statusText}: ${toolName}`).catch(() => {});
  }

  return approved;
}

export function handleConfirmationCallback(
  callbackId: string,
  approved: boolean,
): void {
  confirmationEmitter.emit(callbackId, approved);
}
