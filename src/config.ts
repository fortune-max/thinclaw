function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  PORT: parseInt(process.env.PORT || "8080"),
  TELEGRAM_BOT_TOKEN: requireEnv("TELEGRAM_BOT_TOKEN"),
  WEBHOOK_URL: requireEnv("WEBHOOK_URL"),
  ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
  ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map(Number)
    .filter(Boolean),
  ALLOW_GUESTS: process.env.ALLOW_GUESTS === "true",
  DB_PATH: process.env.DB_PATH || "./data/assistant.db",
  PLUGINS_DIR: process.env.PLUGINS_DIR || "./plugins",
  CONTEXT_WINDOW_SIZE: parseInt(process.env.CONTEXT_WINDOW_SIZE || "5"),
  UPGRADE_PRICE_USD: parseFloat(process.env.UPGRADE_PRICE_USD || "15"),
  UPGRADE_TON_ADDRESS: process.env.UPGRADE_TON_ADDRESS || "",
} as const;
