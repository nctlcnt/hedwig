# Architecture

## Core Sections (Required)

### 1) Architectural Style

- Primary style: workflow-oriented modular monolith with ports/adapters around
  personal mail access.
- Why this classification: one Node process owns scheduling, classification,
  persistence and Discord delivery, while product workflow code depends on a
  `MailGateway` interface rather than Gmail primitives directly.
- Primary constraints:
  - single-user, backend-only service with local SQLite;
  - Gmail is a read-only ingestion source; workflow state belongs in SQLite;
  - Discord is both the output surface and the current interaction surface;
  - no external queue or distributed lock exists.

### 2) System Flow

```text
node-cron / one-shot
  -> MailGateway incremental sync
  -> fetch + classify each new message
  -> SQLite records and body cache
  -> DB-only outcome + optional realtime Discord push
  -> query today's results
  -> Discord summary + detail thread
```

1. `index.ts` loads config, opens SQLite, constructs the Gmail-backed gateway
   and chooses one-shot or daemon mode.
2. Each processing pass reads a per-account Gmail History cursor, or bootstraps
   from a recent inbox window when no valid cursor exists.
3. Already-classified `(account_id, gmail_id)` values are removed through a
   SQLite dedup query; remaining messages are fetched and classified
   sequentially.
4. The pipeline persists message metadata, a seven-day body cache and the
   classification, including a one-sentence summary and optional attention
   points/suggested actions. Junk receives the DB-only `suppress` outcome;
   Action items can be pushed immediately. Gmail state is unchanged.
5. The cursor advances only when the account pass finishes without error.
6. The daily job queries classifications in the configured local-day window,
   optionally generates per-section leads, posts one Discord summary, creates a
   thread and chunks all details below Discord limits.

The maintenance command deletes only expired Hedwig-owned body/link cache rows
from SQLite and never connects to Gmail.

### 3) Layer/Module Responsibilities

| Layer or module | Owns | Must not own | Evidence |
|-----------------|------|--------------|----------|
| Startup/scheduler | Initialization and two cron triggers | Provider internals | `apps/backend/src/index.ts` |
| Digest workflow | Per-account orchestration, side-effect policy, report assembly | Gmail client creation | `apps/backend/src/digest.ts` |
| Mail gateway | Product-facing mail capabilities and adapter | Classification rules | `apps/backend/src/gateway/*.ts` |
| Classifier | Category policy, provider selection, fallback normalization | Persistence | `apps/backend/src/classifier.ts`, `apps/backend/src/llm/` |
| Persistence | Schema, migrations, dedup, cache and operational state | Network calls | `apps/backend/src/db.ts` |
| Discord | Rendering, REST posts, threads, buttons and previews | Mailbox access | `apps/backend/src/discord*.ts` |
| Maintenance | SQLite cache retention | Gmail mailbox cleanup | `apps/backend/scripts/cleanup.ts` |

### 4) Reused Patterns

| Pattern | Where found | Why it exists |
|---------|-------------|---------------|
| Port and adapter | `gateway/mail-gateway.ts`, `gateway/gmail-mail-gateway.ts` | Lets digest logic avoid direct Gmail coupling and supports a future Personal Gateway adapter |
| Strategy/factory | `classifiers.ts` | Selects rule or OpenAI-compatible classification from configuration |
| Fallback chain | `llm/openai-compatible-classifier.ts` | Primary LLM → optional backup LLM → rule classifier |
| Durable cursor + idempotency guard | `gmail.ts`, `db.ts`, `digest.ts` | Separates discovery from Gmail read/star/label state |
| Best-effort observer | `alerts.ts` | Debug-channel failures cannot recursively fail the mail pipeline |
| DB-only retention command | `scripts/cleanup.ts`, `db.ts` | Expires cached body/link data without mailbox side effects |

### 5) Known Architectural Risks

- The in-process cron has no overlap guard. A pass longer than its five-minute
  interval can overlap another pass; dedup is checked before insert and the
  classifications table has no uniqueness constraint for a message.
- All accounts and messages are processed sequentially, so latency grows with
  account/message count and makes overlap more likely.
- `db.ts` is an 842-line mixed persistence/migration/link-scoring module and is
  among the highest-churn files.
- Deployment depends on an explicit systemd restart because `tsx` loads modules
  only at process startup. A controlled restart on 2026-07-25 loaded the latest
  source and migrations; future deploys need the same verification discipline.

### 6) Current Implementation Status

| Capability | Source on `main` | Linear state | Observed runtime on 2026-07-25 |
|------------|------------------|--------------|--------------------------------|
| Multi-account Gmail API | Implemented | LT-61 Done | Active database contains historical runs from 8 account IDs |
| Gmail History incremental sync | Implemented with `sync_state` | Project current-state text says live | Live after the 2026-07-25 restart; six account cursors were populated and continued updating |
| Rule + OpenAI-compatible classification | Implemented, with retry/backup/rule fallback | Core MVP Done | GLM classifications and rule fallbacks observed |
| SQLite message/classification records | Implemented | Core MVP Done | 1,109 total classifications observed |
| Discord daily summary/detail threads | Implemented | LT-63/core MVP Done | Service is active; delivery itself was not externally mutated or re-tested |
| Action realtime push | Implemented | Core MVP Done | Source complete; channel delivery not re-tested in this audit |
| Seven-day email preview buttons | Implemented | LT-101 Done | Existing DB contains body-cache rows |
| Runtime summary-language setting | Implemented through `/summary-language` with a 12-character free-text value stored in `app_settings` | Added directly from user feedback | Applies to future LLM message summaries and daily section leads; historical summaries are unchanged |
| Structured preview guidance | Implemented with one-sentence summaries plus up to three attention points and suggested actions | Added directly from user feedback | Stored with each new classification; historical rows use empty lists |
| Debug-channel deduplicated alerts | Implemented with `alert_log` | Project says live | Schema is live after the restart; no alert rows or new processing failures were observed during verification |
| Read-only Gmail boundary | Implemented in source under LT-152 | LT-152 In Progress pending live verification | Mutation methods and mailbox cleanup/backfill paths removed; OAuth setup requests `gmail.readonly` |
| Full Track/forum follow-up lifecycle | Not implemented | LT-124 Backlog, next queue | Not active |
| Query interface | Not implemented | LT-69 Backlog | Not active |
| Calendar/event extraction and write | Not implemented | LT-54/LT-60 were rewritten to the current architecture and marked `paused`; LT-56/LT-62 remain deferred | Not active |
| Frontend/admin UI | Placeholder only | No active delivery | Not active |

### 7) Evidence

- `apps/backend/src/index.ts`
- `apps/backend/src/digest.ts`
- `apps/backend/src/gateway/mail-gateway.ts`
- `apps/backend/src/db.ts`
- `apps/backend/src/discord.ts`
- `apps/backend/scripts/cleanup.ts`
- `deploy/systemd/hedwig-digest.service`
- Controlled systemd restart plus read-only `systemctl`, `journalctl` and SQLite
  checks performed on 2026-07-25
- Linear project `Hedwig: Email Digest System` and open-issue comments read on
  2026-07-25
