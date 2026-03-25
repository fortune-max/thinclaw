import type { Bot } from "grammy";
import { logger } from "../logger.js";

let botInstance: Bot;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

export function getBotInstance(): Bot {
  return botInstance;
}

export async function editTelegramMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  // Telegram limits message text to 4096 chars
  const truncated = text.length > 4096 ? text.slice(-4096) : text;

  try {
    await botInstance.api.editMessageText(chatId, messageId, truncated, {
      parse_mode: "Markdown",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("message is not modified")) return;

    // Markdown parsing failed — retry without parse_mode
    if (message.includes("can't parse entities")) {
      try {
        await botInstance.api.editMessageText(chatId, messageId, truncated);
        return;
      } catch {
        // Silent — display error, not a real failure
      }
    }

    // Rate limit or transient Telegram issue — log at debug, not error
    logger.debug({ chatId, messageId }, "Failed to edit Telegram message");
  }
}

export async function sendConfirmationKeyboard(
  chatId: number,
  toolName: string,
  toolInput: Record<string, unknown>,
  callbackId: string,
): Promise<number> {
  const inputPreview = JSON.stringify(toolInput, null, 2).slice(0, 500);
  const msg = await botInstance.api.sendMessage(
    chatId,
    `*Confirm action:* \`${toolName}\`\n\`\`\`\n${inputPreview}\n\`\`\``,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Deny", callback_data: `confirm:${callbackId}:no` },
            { text: "Approve", callback_data: `confirm:${callbackId}:yes` },
          ],
        ],
      },
    },
  );
  return msg.message_id;
}
