# ThinClaw

A multi-user AI personal assistant that runs as a Telegram bot. Powered by Claude (Anthropic SDK), with a plugin system for integrating external services, per-user encrypted secrets, role-based access control, and TON blockchain payments for upgrades.

## Features

- **Agentic tool use** — the bot chains multiple tools autonomously (e.g., login to bank, fetch 2FA code, verify, transfer funds)
- **Plugin system** — 15 plugins for Spotify, banking, transit, groceries, email, notes, and more
- **Multi-user** — role-based access (admin/user/guest/banned) with per-role usage caps and model access
- **Streaming responses** — token-by-token streaming to Telegram via throttled message edits
- **Scheduled reminders** — one-shot reminders that trigger full agent runs (the agent reads its own note and acts on it)
- **Encrypted secrets** — per-user credentials stored with AES-256-GCM in SQLite
- **Confirmation gates** — financial operations and broadcasts require Telegram approve/deny
- **TON payments** — guest-to-user upgrades via on-chain TON transfers with automatic detection
- **Prompt caching** — static system prompt cached, dynamic per-user block uncached

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env  # then fill in required values

# Run locally (polling mode)
npm run dev

# Build for production
npm run build
npm start
```

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token from @BotFather |
| `WEBHOOK_URL` | Railway app URL, or `http://localhost:8080` for local dev |
| `ADMIN_USER_IDS` | Comma-separated Telegram user IDs with full access |
| `SECRETS_ENCRYPTION_KEY` | Master key for encrypting per-user secrets |

See `.env.example` for optional variables and full configuration reference.

## Architecture

```
src/
  index.ts              Express server (webhook) or grammY polling (local dev)
  ai/
    agent.ts             Streaming agentic loop with tool execution
    system-prompt.ts     Static (cached) + dynamic (per-user) prompt blocks
    context-window.ts    Conversation history loader
  bot/
    handlers.ts          Telegram message/command handlers
    telegram.ts          Bot instance + message editing helpers
  db/
    schema.ts            Drizzle ORM table definitions
    client.ts            SQLite init + numbered migrations
    queries.ts           All database queries
  plugins/
    loader.ts            Plugin discovery, registry, meta-tool dispatch
    secrets.ts           Per-user secret resolution + encryption
  payments/
    ton-monitor.ts       Background poller for TON upgrade payments
  reminders/
    monitor.ts           Background poller for scheduled reminders
  security/
    confirmation.ts      Telegram confirmation gates for dangerous operations

plugins/
  <name>/
    plugin.json          Manifest: name, description, adminOnly
    secrets.json         Required credentials schema
    tools.ts             Tool definitions + handlers
    README.md            Plugin documentation
```

## Plugins

| Plugin | Description |
|--------|-------------|
| core | Bash, file read/write, directory listing (admin only) |
| spotify | Search, queue, playback control, now playing |
| goodreads | Book search, shelving, tagging, private notes |
| flutterwave | Nigerian banking: login, 2FA, balance, transfers, airtime |
| mercadona | Spanish supermarket: product search, prices, ingredient photos |
| tmb | Barcelona bus/metro real-time arrivals |
| bicing | Barcelona bike-sharing: station availability, nearby search |
| gmail | Email search/read (used for auto-fetching OTP codes) |
| authenticator | TOTP 2FA code generation from stored secrets |
| edenred | Edenred Ticket Restaurant: balance, transactions |
| ton | TON wallet: balance, transactions, send |
| readwise | Save URLs to Readwise Reader |
| notes | Personal notes: CRUD (always loaded) |
| ngrok | Public tunnels for local services (admin only) |
| webfetch | Fetch public URLs with SSRF protection |

### Adding a Plugin

1. Create `plugins/<name>/plugin.json` with `name`, `description`, optionally `adminOnly: true`
2. Create `plugins/<name>/secrets.json` with required credentials schema
3. Create `plugins/<name>/tools.ts` exporting `createTools(secrets)` returning `{ tools, handlers }`
4. Tools are Anthropic `Tool` objects, handlers are `async (input, secrets, chatId) => string`

## User Roles

| Role | Model Access | Usage Cap | Capabilities |
|------|-------------|-----------|-------------|
| Admin | Haiku, Sonnet, Opus | Unlimited | All plugins, bash, file tools, `/role`, `/stats` |
| User | Haiku, Sonnet | $2/day | All non-admin plugins |
| Guest | Haiku | 10 msgs/day or $0.10 | All non-admin plugins |
| Banned | None | None | Gentle rejection message |

## Bot Commands

- `/model <haiku|sonnet|opus>` — switch model for next message
- `/usage` — token usage and cost breakdown
- `/stats` — admin dashboard
- `/upgrade` — TON payment flow for plan upgrade ($15/month)
- `/donate` — donation addresses
- `/role <chatId> <role>` — admin only, change user role
- `/reload` — re-init plugin registry

## Deployment

Deployed on Railway with Docker. SQLite database persisted on a mounted volume at `/data`.

```bash
# Build and run with Docker
docker build -t thinclaw .
docker run -v ./data:/data --env-file .env thinclaw
```

## Tech Stack

- **Runtime**: Node.js 20, TypeScript
- **AI**: Anthropic SDK (Claude Haiku/Sonnet/Opus)
- **Bot framework**: grammY
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Server**: Express (webhook mode) or grammY polling (local dev)
- **Payments**: TON blockchain via @ton-pay/api
- **Deployment**: Railway + Docker

## License

Private project.
