# Codebase Concerns

## Core Sections (Required)

### 1) Top Risks (Prioritized)

| Severity | Concern | Evidence | Impact | Suggested action |
|----------|---------|----------|--------|------------------|
| High | Secret and personal-data file permissions are too broad | `.env` mode `664`; `data/hedwig.db` mode `644` on 2026-07-25 | Other local users/groups may read API secrets or cached email data | Restrict both to owner-only and document the expected modes |
| High | Cron passes can overlap without a lock | Two independent `cron.schedule` calls; no in-flight guard; dedup check precedes insert and no message uniqueness constraint exists | Duplicate classification/pushes and cursor races if a pass exceeds five minutes | Add a process-level mutex plus DB uniqueness/idempotent insert |
| Medium | Unfinished runs are never reconciled | A `dryrun` row from 2026-06-01 still has status `running` | Health reports and run statistics can show false in-progress work | Reconcile stale runs at startup and mark interrupted/abandoned runs explicitly |
| Medium | Polling creates very high run-row volume | 127,664 run rows total; 12,414 in seven days; only 88 classifications in seven days | DB growth and noisy operational history obscure useful runs | Avoid creating per-account runs when no work exists, or add retention/aggregation |
| Medium | Critical workflow coverage is still incomplete | Six assertion scripts cover digest orchestration and configuration, but there are no Discord rendering, live-provider, concurrency tests or CI | Regressions can reach a continuously running personal-data service | Add focused Discord/provider/concurrency tests and a CI check |
| Medium | Core persistence module is large and high-churn | `db.ts` is 842 lines; 7 changes in recent history | Migration, query and link-scoring changes share one fragile file | Split schema/migrations, repositories and preview-link extraction |
| Medium | External-call resilience is inconsistent | Classifier has retries/timeouts; Discord REST and section narrator do not consistently use them | A hung/rate-limited call can delay a whole sequential pass | Add explicit timeouts, bounded retry and 429 handling |
| Low | Repository and Linear documentation contains stale assumptions | `AGENTS.md` says Gemini/no test runner; frontend README says Gmail labels; several backlog tickets assume IMAP/Ollama/Haiku/Gemini | Future work may target superseded architecture | Refresh active docs/tickets and keep historical tickets clearly marked |

### 2) Technical Debt

| Debt item | Why it exists | Where | Risk if ignored | Suggested fix |
|-----------|---------------|-------|-----------------|---------------|
| No processing lock/lease | Single-process MVP cron wiring | `src/index.ts`, `src/digest.ts` | Duplicate side effects during slow runs | Mutex now; DB lease if multiple processes are ever allowed |
| Append-heavy `digest_runs` | A run is created before each per-account poll | `src/digest.ts`, `src/db.ts` | Unbounded growth and low signal | Create runs lazily or prune/roll up empty runs |
| Mixed DB responsibilities | MVP accumulated migrations, repositories, cache and link scoring together | `src/db.ts` | Unsafe edits and difficult testing | Split into schema, run/message repos, cache and link utilities |
| Manual test manifest | No runner was introduced initially | `package.json` | New test files can be silently omitted | Adopt `node:test` or a runner with glob discovery |
| Obsolete compatibility names | DeepSeek-named probe/script and one-line compatibility module remain after provider generalization | `scripts/deepseek-probe.ts`, `src/llm/deepseek-classifier.ts` | Provider model is harder to understand | Rename probe and remove compatibility shim when safe |

### 3) Security Concerns

| Risk | OWASP category | Evidence | Current mitigation | Gap |
|------|----------------|----------|--------------------|-----|
| World/group-readable secrets | A02 Cryptographic Failures | `.env` mode `664` | File is gitignored | OS permissions are not owner-only |
| World-readable email cache/database | A01 Broken Access Control | DB mode `644`; cache stores body text and links | Local file, gitignored, seven-day cache expiry | No filesystem access control beyond current mode; no encryption |
| Existing tokens may retain broad Gmail grants | N/A | Older refresh tokens were authorized with `gmail.modify` | Source now exposes only read operations; new auth requests `gmail.readonly`; orchestration test fails on mutation access | Reauthorize each account to narrow already-issued grants |
| Debug/error content may include provider/API response bodies | A09 Logging and Monitoring Failures | Discord REST errors include response text; free-form console logging | Alerts are cooldown-deduped | No central redaction function or structured sensitive-field policy |
| Button interaction authorization is implicit | A01 Broken Access Control | Any matching `email_preview:*` button interaction is answered | Replies are ephemeral and IDs originate from bot messages | No explicit user/guild/channel allowlist in handler |

### 4) Performance and Scaling Concerns

| Concern | Evidence | Current symptom | Scaling risk | Suggested improvement |
|---------|----------|-----------------|-------------|-----------------------|
| Sequential accounts/messages | Nested `for` loops in `digest.ts` | Predictable but potentially slow passes | More accounts/mail increase overlap likelihood | Bounded concurrency per account/message, respecting API limits |
| Poll-run write amplification | 12,414 runs versus 88 classifications in seven days | Most run records represent no classified mail | Storage and query noise | Lazy/no-op runs plus retention |
| Synchronous SQLite in event loop | `better-sqlite3` throughout `db.ts` | Acceptable at current ~15 MB DB | Large tables can delay Discord/Gateway events | Add retention/index review and measure query latency |
| No external-call timeout on Discord | Native `fetch` without AbortSignal | No failure observed in this audit | A stalled request can hold sequential work | AbortController timeout and retry budget |

### 5) Fragile/High-Churn Areas

| Area | Why fragile | Churn signal | Safe change strategy |
|------|-------------|-------------|----------------------|
| `README.md` | Product policy and safety boundary change frequently | 12 changes in recent history | Update with code and Linear project state in the same change |
| `gmail.ts` | External API semantics and destructive labels/Trash operations | 11 changes | Add adapter-level contract tests before mutation changes |
| `digest.ts` | Central workflow and all side-effect ordering | 11 changes | Characterization tests around success, partial failure and retries |
| `discord.ts` | Discord limits, message/thread rendering and REST calls | 10 changes | Fixture-test payload sizes and chunk boundaries |
| `types.ts`, `config.ts`, `index.ts`, `db.ts` | Cross-cutting schema/startup changes | 7-9 changes each | Make migrations backward-compatible and verify daemon restart behavior |

Churn counts come from tracked Git history over the last 90 days as inspected on
2026-07-25.

### 6) Intent vs. Reality Divergences

- The source/runtime divergence found during the audit was resolved on
  2026-07-25: the daemon was restarted, `sync_state`/`alert_log` were migrated,
  and six Gmail cursors populated without a new processing failure.
- `AGENTS.md` describes a Gemini-backed classifier and says no test runner is
  configured; current source uses a generic OpenAI-compatible provider and has
  six test scripts.
- LT-54, LT-57, LT-58, LT-60 and LT-74 were rewritten on 2026-07-25 to remove
  IMAP/Ollama/Haiku/Gemini and AUTO-label assumptions. Calendar-dependent
  LT-54/LT-60 remain explicitly paused.
- LT-124 is now in progress. Its feature flag and Forum validation foundation
  are implemented, while Track, Done and reconcile remain pending.

### 7) `[ASK USER]` Questions

1. [RESOLVED] LT-124 is the active follow-up workflow issue and is now in progress.
2. [ASK USER] Should expected permissions for `.env` and the SQLite database be
   restricted to owner-only and included in deployment checks?

### 8) Evidence

- `apps/backend/src/index.ts`
- `apps/backend/src/digest.ts`
- `apps/backend/src/db.ts`
- `apps/backend/src/discord.ts`
- `apps/backend/src/discord-bot.ts`
- `apps/backend/src/gmail.ts`
- `AGENTS.md`
- `apps/frontend/README.md`
- `deploy/systemd/hedwig-digest.service`
- Git churn, systemd/journal, file-mode and read-only SQLite checks performed on
  2026-07-25
- Linear project and issue/comment reads performed on 2026-07-25
