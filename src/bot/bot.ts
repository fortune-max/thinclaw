import { Bot } from "grammy";
import { config } from "../config.js";
import { isAllowed } from "../security/whitelist.js";
import { logger } from "../logger.js";

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Access control middleware — must be first
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowed(userId)) {
      logger.warn({ userId }, "Rejected message from unauthorized user");
      return;
    }
    await next();
  });

  return bot;
}
