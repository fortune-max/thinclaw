import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import * as schema from "./schema.js";
import { mkdirSync } from "fs";
import { dirname } from "path";

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;

export function getDb() {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function getSqlite(): Database.Database {
  if (!sqlite) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return sqlite;
}

export function initDb(): void {
  mkdirSync(dirname(config.DB_PATH), { recursive: true });

  sqlite = new Database(config.DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  db = drizzle(sqlite, { schema });

  runMigrations();

  logger.info({ path: config.DB_PATH }, "Database initialized");
}

function runMigrations(): void {
  // Create migrations tracking table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r: any) => r.name),
  );

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.name)) {
      logger.info({ migration: migration.name }, "Running migration");
      sqlite.exec(migration.sql);
      sqlite
        .prepare("INSERT INTO _migrations (name) VALUES (?)")
        .run(migration.name);
    }
  }
}

const MIGRATIONS = [
  {
    name: "001_initial",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        telegram_message_id INTEGER,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER REFERENCES messages(id),
        chat_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_result TEXT NOT NULL,
        duration_ms INTEGER,
        is_error INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
        callback_data TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS user_secrets (
        chat_id INTEGER NOT NULL,
        plugin TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (chat_id, plugin, key)
      );

      CREATE TABLE IF NOT EXISTS user_plugins (
        chat_id INTEGER NOT NULL,
        plugin TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (chat_id, plugin)
      );

      CREATE TABLE IF NOT EXISTS users (
        chat_id INTEGER PRIMARY KEY,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
        system_prompt_override TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);
      CREATE INDEX IF NOT EXISTS idx_confirmations_callback ON confirmations(callback_data);
      CREATE INDEX IF NOT EXISTS idx_user_memories_chat ON user_memories(chat_id, category);
      CREATE INDEX IF NOT EXISTS idx_user_secrets_chat ON user_secrets(chat_id, plugin);
    `,
  },
  {
    name: "002_notes_and_roles",
    sql: `
      CREATE TABLE IF NOT EXISTS user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_user_notes_chat ON user_notes(chat_id);

      -- SQLite can't ALTER CHECK constraints, so recreate the users table
      CREATE TABLE IF NOT EXISTS users_new (
        chat_id INTEGER PRIMARY KEY,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'guest' CHECK(role IN ('admin', 'user', 'guest', 'banned')),
        system_prompt_override TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT OR IGNORE INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `,
  },
  {
    name: "003_pending_upgrades",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_upgrades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        amount_ton REAL NOT NULL,
        amount_usd REAL NOT NULL,
        reference TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'expired')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        paid_at INTEGER
      );
    `,
  },
  {
    name: "004_reminders",
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed')),
        source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user', 'reminder')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, trigger_at);
      CREATE INDEX IF NOT EXISTS idx_reminders_chat ON reminders(chat_id);
    `,
  },
];
