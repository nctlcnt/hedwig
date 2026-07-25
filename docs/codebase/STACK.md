# Technology Stack

## Core Sections (Required)

### 1) Runtime Summary

| Area | Value | Evidence |
|------|-------|----------|
| Primary language | TypeScript 6, strict mode | `package.json`, `tsconfig.json` |
| Runtime + version | Node.js `>=20`; current host reports `v22.22.2` | `package.json`; `node --version` on 2026-07-25 |
| Package manager | npm 10; lockfile v3 | `package-lock.json`; `npm --version` on 2026-07-25 |
| Module/build system | Native ESM, NodeNext resolution, ES2022 target; development execution through `tsx` | `package.json`, `tsconfig.json` |

This is a single root npm package rather than a configured npm workspace. The
repository uses `apps/` for product layout, but `package.json` has no
`workspaces` field.

### 2) Production Frameworks and Dependencies

| Dependency | Manifest version | Role in system | Evidence |
|------------|------------------|----------------|----------|
| `better-sqlite3` | `^12.9.0` | Synchronous local persistence, schema migration, deduplication, body cache and alert logs | `package.json`, `apps/backend/src/db.ts` |
| `discord.js` | `^14.26.4` | Discord Gateway client for button interactions, ephemeral previews and guild slash commands | `package.json`, `apps/backend/src/discord-bot.ts` |
| `googleapis` | `^171.4.0` | Gmail OAuth and Gmail API access | `package.json`, `apps/backend/src/gmail.ts` |
| `openai` | `^6.37.0` | OpenAI-compatible classifier and digest-section narrator clients | `package.json`, `apps/backend/src/llm/openai-compatible-classifier.ts` |
| `node-cron` | `^3.0.3` | In-process processing and daily-digest schedules | `package.json`, `apps/backend/src/index.ts` |
| `luxon` | `^3.5.0` | Digest-day boundary calculations in the configured timezone | `package.json`, `apps/backend/src/digest.ts` |
| `dotenv` | `^16.4.5` | Loads local environment configuration | `package.json`, `apps/backend/src/config.ts` |

There is no HTTP server framework, ORM, queue, cache server, container image or
frontend framework in the tracked source.

### 3) Development Toolchain

| Tool | Purpose | Evidence |
|------|---------|----------|
| TypeScript compiler | Strict type checking with `noUncheckedIndexedAccess`; no emit in verification | `tsconfig.json`, `package.json` |
| `tsx` | Runs TypeScript entry points and assertion scripts directly | `package.json` |
| Node `assert/strict` | Assertions in the six checked-in test scripts | `apps/backend/src/*.test.ts` |

No ESLint, Prettier, coverage tool or dedicated test-runner configuration is
tracked.

### 4) Key Commands

```bash
npm install
npm run check
npm test
npm run digest:once
npm run digest:daemon
npm run cleanup
```

Supporting commands are `npm run google:auth`, `npm run probe:deepseek`,
and `npm run dry-run:preview`.

### 5) Environment and Config

- Config sources: `.env`, `.env.example`, `config/gmail-accounts.json`,
  `config/google-tokens/*.json`, `config/classifier-rules.md`.
- Core required values: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  Gmail account/token configuration, `DISCORD_BOT_TOKEN` and
  `DISCORD_DIGEST_CHANNEL_ID`.
- Optional surfaces: realtime/debug Discord channels, OpenAI-compatible primary
  and fallback classifier, and custom classifier rules.
- Schedule defaults: processing every five minutes
  (`DIGEST_PROCESS_CRON=*/5 * * * *`) and digest at Sydney 19:00
  (`DIGEST_CRON=0 19 * * *`).
- Persistence defaults to `data/hedwig.db` in WAL mode.
- Production runs as a user-level systemd service from this checkout. No network
  port is opened by Hedwig.

### 6) Evidence

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `.env.example`
- `apps/backend/src/config.ts`
- `deploy/systemd/hedwig-digest.service`
