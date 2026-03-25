import { getUserSecrets, getUserRole } from "../db/queries.js";

export interface SecretSchema {
  description: string;
  sensitive?: boolean;
}

/**
 * Resolve secrets for a plugin, checking:
 * 1. Per-user secrets from SQLite (encrypted)
 * 2. Fallback to environment variables (admin only)
 */
export function resolveSecrets(
  chatId: number,
  pluginName: string,
  secretsSpec: Record<string, SecretSchema | string>,
): Record<string, string> {
  const dbSecrets = getUserSecrets(chatId, pluginName);
  const isAdmin = getUserRole(chatId) === "admin";
  const resolved: Record<string, string> = {};

  for (const [key, spec] of Object.entries(secretsSpec)) {
    const isNewFormat = typeof spec === "object";

    // 1. Check user's DB secrets first
    if (dbSecrets[key]) {
      resolved[key] = dbSecrets[key];
      continue;
    }

    // 2. Check per-user env var (e.g., _6123456789_READWISE_ACCESS_TOKEN)
    const perUserEnv = process.env[`_${chatId}_${key}`];
    if (perUserEnv) {
      resolved[key] = perUserEnv;
      continue;
    }

    // 3. Fall back to global env var — admin only
    if (isAdmin) {
      const envVal = process.env[key];
      if (envVal) {
        resolved[key] = envVal;
        continue;
      }
    }

    // 3. Old format literal value (not "check_env")
    if (!isNewFormat && spec !== "check_env") {
      resolved[key] = spec;
      continue;
    }
  }

  return resolved;
}

/**
 * Check which secrets are missing for a plugin
 */
export function getMissingSecrets(
  chatId: number,
  pluginName: string,
  secretsSpec: Record<string, SecretSchema | string>,
): { key: string; description: string }[] {
  const resolved = resolveSecrets(chatId, pluginName, secretsSpec);
  const missing: { key: string; description: string }[] = [];

  for (const [key, spec] of Object.entries(secretsSpec)) {
    if (!resolved[key]) {
      const description =
        typeof spec === "object" ? spec.description : `Required: ${key}`;
      missing.push({ key, description });
    }
  }

  return missing;
}
