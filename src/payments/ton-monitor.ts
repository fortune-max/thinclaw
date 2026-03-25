import { getTonPayTransferByReference } from "@ton-pay/api";
import { config } from "../config.js";
import { getPendingUpgrades, markUpgradePaid, setUserRole } from "../db/queries.js";
import { getBotInstance } from "../bot/telegram.js";
import { logger } from "../logger.js";

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const UPGRADE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startTonMonitor(): void {
  if (!config.UPGRADE_TON_ADDRESS) {
    logger.info("TON monitor disabled — no UPGRADE_TON_ADDRESS configured");
    return;
  }

  logger.info("TON payment monitor started (TON Pay SDK)");

  monitorInterval = setInterval(async () => {
    try {
      await checkForPayments();
    } catch (err) {
      logger.debug({ err }, "TON monitor poll error");
    }
  }, POLL_INTERVAL_MS);
}

export function stopTonMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

async function checkForPayments(): Promise<void> {
  const pending = getPendingUpgrades();
  if (pending.length === 0) return;

  for (const upgrade of pending) {
    const age = Date.now() - upgrade.createdAt * 1000;
    if (age > UPGRADE_EXPIRY_MS) continue;

    try {
      const transfer = await getTonPayTransferByReference(upgrade.reference, {
        chain: "mainnet",
      });

      if (transfer && transfer.status === "completed") {
        const amountTon = parseFloat(transfer.amount);

        const chatId = markUpgradePaid(upgrade.reference);
        if (chatId) {
          setUserRole(chatId, "user");
          logger.info(
            { chatId, amountTon, reference: upgrade.reference, txHash: transfer.txHash },
            "TON upgrade payment received (TON Pay SDK)",
          );

          try {
            const bot = getBotInstance();
            await bot.api.sendMessage(
              chatId,
              `Payment received! ${amountTon.toFixed(2)} TON confirmed.\n\n` +
              `Your account has been upgraded to User. You now have:\n` +
              `- Unlimited messaging\n` +
              `- Access to smarter models (Sonnet)\n` +
              `- All plugins\n\n` +
              `Enjoy!`,
            );

            for (const adminId of config.ADMIN_USER_IDS) {
              bot.api.sendMessage(
                adminId,
                `TON upgrade payment received!\n` +
                `User: ${chatId}\n` +
                `Amount: ${amountTon.toFixed(4)} TON\n` +
                `Ref: ${upgrade.reference}\n` +
                `Tx: ${transfer.txHash}`,
              ).catch(() => {});
            }
          } catch (err) {
            logger.error({ err, chatId }, "Failed to notify user of upgrade");
          }
        }
      }
    } catch {
      // Transfer not found yet — normal, keep polling
    }
  }
}
