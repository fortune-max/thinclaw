import "dotenv/config";
import express from "express";
import { webhookCallback } from "grammy";
import crypto from "crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createBot } from "./bot/bot.js";
import { registerHandlers } from "./bot/handlers.js";
import { setBotInstance } from "./bot/telegram.js";
import { initDb } from "./db/client.js";
import { startTonMonitor, stopTonMonitor } from "./payments/ton-monitor.js";
import { startReminderMonitor, stopReminderMonitor } from "./reminders/monitor.js";

async function main(): Promise<void> {
  // Initialize database (creates tables if needed)
  initDb();

  const bot = createBot();
  setBotInstance(bot);
  registerHandlers(bot);

  // Register slash commands with Telegram
  await bot.api.setMyCommands([
    { command: "usage", description: "Token usage and cost breakdown" },
    { command: "model", description: "Switch AI model (haiku, sonnet, opus)" },
    { command: "upgrade", description: "Upgrade to User plan ($15/month via TON)" },
    { command: "donate", description: "Support the project" },
  ]);

  // Start background monitors
  startTonMonitor();
  startReminderMonitor();

  const isLocal = config.WEBHOOK_URL.includes("localhost");

  if (isLocal) {
    // Local dev: use long polling (no public URL needed)
    await bot.api.deleteWebhook();
    bot.start({
      onStart: () => logger.info("Bot started in polling mode (local dev)"),
    });

    process.on("SIGINT", () => { stopReminderMonitor(); bot.stop(); });
    process.on("SIGTERM", () => { stopReminderMonitor(); bot.stop(); });
  } else {
    // Production: use webhook
    const app = express();

    app.get("/health", (_req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    const secretToken = crypto.randomUUID();
    app.use(
      "/webhook",
      express.json(),
      webhookCallback(bot, "express", { secretToken }),
    );

    const server = app.listen(config.PORT, () => {
      logger.info({ port: config.PORT }, "Server started");
    });

    const webhookUrl = `${config.WEBHOOK_URL}/webhook`;
    await bot.api.setWebhook(webhookUrl, { secret_token: secretToken });
    logger.info({ webhookUrl }, "Webhook set");

    const shutdown = (signal: string) => {
      logger.info({ signal }, "Shutting down");
      stopTonMonitor();
      stopReminderMonitor();
      server.close(() => {
        logger.info("Server closed");
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
}

// Catch unhandled errors
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
