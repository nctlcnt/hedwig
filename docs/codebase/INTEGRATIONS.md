# External Integrations

## Core Sections (Required)

### 1) Integration Inventory

| System | Type | Purpose | Auth model | Criticality | Evidence |
|--------|------|---------|------------|-------------|----------|
| Gmail API | External API | Read-only profile lookup, History/inbox discovery and message fetch | OAuth2 client ID/secret + per-account refresh token; new auth uses `gmail.readonly` | High | `apps/backend/src/gmail.ts`, `scripts/google-auth.ts` |
| Discord REST API v10 | External API | Digest/realtime/debug posts and message threads | Bot token in Authorization header | High | `apps/backend/src/discord.ts` |
| Discord Gateway | Persistent external connection | Handles preview-button interactions, ephemeral replies and the guild-scoped `/summary-language` command | Bot token via `discord.js` login | Medium | `apps/backend/src/discord-bot.ts` |
| OpenAI-compatible API | External API | Per-email classification and per-section daily lead generation | Bearer API key, configurable base URL/model/provider name | High when LLM mode is enabled | `apps/backend/src/llm/*.ts` |
| SQLite | Embedded DB | Durable workflow state, classifications, suppression outcomes, cache and alert state | Local filesystem permissions | High | `apps/backend/src/db.ts` |
| systemd user manager | Process supervisor | Starts/restarts the daemon and keeps it alive after logout | OS user session | High operationally | `deploy/systemd/hedwig-digest.service` |

There is no Google Calendar client, Anthropic client, IMAP client, queue,
webhook, metrics backend or HTTP ingress in the current source.

### 2) Data Stores

| Store | Role | Access layer | Key risk | Evidence |
|-------|------|--------------|----------|----------|
| `data/hedwig.db` | Runs, messages, classifications, seven-day bodies/links, sync cursors, alert cooldowns and runtime app settings | `apps/backend/src/db.ts` | Plaintext personal mail data; no retention for run rows | `db.ts`, `.env.example` |
| `config/google-tokens/*.json` | Per-account Gmail refresh tokens | `apps/backend/src/config.ts`, auth script | Long-lived OAuth secret files | `.gitignore`, `scripts/google-auth.ts` |
| `.env` | Google, Discord and classifier secrets/config | `dotenv` / `process.env` | Host file is mode `664` as of 2026-07-25 | `.gitignore`, `config.ts`; `stat` output |
| `config/classifier-rules.md` | Personal natural-language classifier policy | LLM prompt builder | Personal policy text is appended verbatim to prompts | `openai-compatible-classifier.ts` |

### 3) Secrets and Credentials Handling

- Credentials come from ignored `.env`, ignored account JSON and ignored token
  files. Examples contain no real secrets.
- Git checks confirm `.env`, real account config, token files, local classifier
  rules and `data/` are ignored and untracked.
- The OAuth setup script writes token and account files with mode `600`.
- On this host, token/account files are `600`, but `.env` is `664` and the
  SQLite DB is `644`; this is a permissions gap for a VPS containing personal
  email data and integration secrets.
- Rotation/revocation workflow: `[TODO]` not documented beyond rerunning the
  OAuth authorization script.

### 4) Reliability and Failure Behavior

- Classifier: OpenAI SDK retry/backoff with configurable retry count and timeout;
  optional secondary provider; final rule fallback.
- Gmail: no explicit retry wrapper or request timeout in Hedwig; relies on the
  Google client behavior. History cursor only advances after a clean batch.
- Discord REST: checks non-2xx responses, but has no explicit timeout, retry or
  rate-limit handling.
- Section narrator: catches failures and omits leads, but unlike the classifier
  does not pass configured retry/timeout options to its OpenAI client.
- Debug alerts: source code provides DB-backed signature cooldown and
  best-effort failure isolation.
- Circuit breaker: none.

### 5) Observability for Integrations

- Logs: console output is captured by systemd/journald.
- User-facing operational alerts: optional Discord debug channel in current
  source.
- Metrics/tracing: none.
- Missing visibility: no per-integration latency/error metrics, health command,
  delivery receipt, queue depth, run-retention policy or formal SLO.

### 6) Evidence

- `.env.example`
- `.gitignore`
- `apps/backend/src/config.ts`
- `apps/backend/src/gmail.ts`
- `apps/backend/src/discord.ts`
- `apps/backend/src/llm/openai-compatible-classifier.ts`
- `apps/backend/src/db.ts`
