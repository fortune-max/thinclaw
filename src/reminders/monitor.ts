import { logger } from "../logger.js";
import { getDueReminders, markReminderCompleted } from "../db/queries.js";
import { getBotInstance } from "../bot/telegram.js";

const POLL_INTERVAL_MS = 10_000;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startReminderMonitor(): void {
  logger.info("Reminder monitor started");
  monitorInterval = setInterval(async () => {
    try {
      await checkReminders();
    } catch (err) {
      logger.debug({ err }, "Reminder monitor poll error");
    }
  }, POLL_INTERVAL_MS);
}

export function stopReminderMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

async function checkReminders(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = getDueReminders(now);
  if (due.length === 0) return;

  for (const reminder of due) {
    try {
      if (reminder.source === "reminder") {
        // Recursion guard: just send a plain message
        const bot = getBotInstance();
        await bot.api.sendMessage(reminder.chatId, `🔔 Reminder: ${reminder.note}`);
      } else {
        // Trigger a full agent run
        const bot = getBotInstance();
        const thinkingMsg = await bot.api.sendMessage(
          reminder.chatId,
          "⏰ _Running scheduled task..._",
          { parse_mode: "Markdown" },
        );

        const { processReminderRun } = await import("../bot/handlers.js");
        await processReminderRun(reminder.chatId, reminder.note, thinkingMsg.message_id);
      }

      markReminderCompleted(reminder.id);
    } catch (err) {
      logger.error({ err, reminderId: reminder.id, chatId: reminder.chatId }, "Failed to fire reminder");
    }
  }
}
