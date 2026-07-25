# Hedwig backend

Node service for a read-only multi-account Gmail digest, Discord delivery, and classifier providers.

Hedwig's mail flow depends on the internal `MailGateway` boundary instead of importing Gmail API helpers directly. The current gateway implementation is still Gmail-backed and uses the same OAuth/config/token files, but the product layer now treats personal mail access as a replaceable adapter.

New inbox mail is discovered through the Gmail History API: a per-account `historyId` cursor is stored in SQLite (`sync_state`) and each run pulls only the messages added since that cursor, independent of read/star/label state. The first run (or an expired cursor) bootstraps from the recent `GMAIL_LOOKBACK_HOURS` window. Which messages have already been handled is tracked in SQLite (`message_classifications`), not by the Gmail read flag, so processed mail can be left unread/in-inbox without being reprocessed, and the cursor only advances after a run finishes cleanly. Scheduled digests read today's stored handling results from SQLite rather than doing a fresh inbox classification pass.

Gmail is intentionally read-only:

- History cursor discovers new Inbox messages.
- SQLite tracks processing, suppression and future follow-up state.
- Junk and disposable codes receive the DB-only `suppress` outcome and are
  omitted from Discord output.
- Hedwig never changes Gmail read, star, label, Inbox or Trash state.

Current providers:

- `rule`: local conservative rules
- `openai-compatible`: JSON-mode classification against any OpenAI-compatible endpoint (DeepSeek, GLM, …). Each call retries with exponential backoff (`CLASSIFIER_MAX_RETRIES`, `CLASSIFIER_TIMEOUT_MS`), which honors `Retry-After` so a 429 rate limit self-throttles rather than failing. Only once retries are exhausted does it try the optional backup LLM (`CLASSIFIER_FALLBACK_*`), then the rule classifier, and Hedwig posts a Discord alert listing any messages that fell back.

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```

`digest:daemon` processes Gmail History updates every `DIGEST_PROCESS_CRON` interval, defaulting to `*/5 * * * *`, and sends the daily digest at `DIGEST_CRON`. Action-classified messages are pushed immediately to `DISCORD_REALTIME_CHANNEL_ID`; if that variable is unset the push is skipped and the message only surfaces in the next digest (no fallback to the digest channel, to avoid duplicate posts). Gmail mailbox state is never changed.

Server managers can use `/summary-language language:<language>` in Discord to set
the language for future LLM-generated message summaries, attention points,
suggested actions, and daily section leads. The free-text value is limited to
12 characters, persists in SQLite, and does not rewrite historical
classifications. Each LLM classification emits exactly one summary sentence
plus zero to three attention points and suggested actions; these structured
details are shown in the ephemeral content preview.

Operational problems — cron exceptions, per-account processing failures, Discord send failures, and classifier rule-fallbacks — are posted to `DISCORD_DEBUG_CHANNEL_ID` when set. They are deduped by signature: the same problem is silenced for `DISCORD_DEBUG_COOLDOWN_MINUTES` (default 60) after it fires, so a persistent error pings once per window rather than every run. Leave the channel unset to disable.

Follow-up support is disabled by default. With `FOLLOWUP_ENABLED=false`, the
daemon does not require or validate `DISCORD_FOLLOWUP_FORUM_CHANNEL_ID`. With
`FOLLOWUP_ENABLED=true`, that ID is required and the daemon checks after Discord
login that the bot can access a `GuildForum` channel there. A missing,
inaccessible, or non-Forum channel stops daemon startup before cron jobs are
scheduled.

The cron path (`digest:daemon` and `digest:once`) discovers new inbox mail incrementally via the Gmail History API cursor; only the bootstrap/recovery scan is bounded by `GMAIL_LOOKBACK_HOURS`.

## Maintenance and probes

```bash
npm run probe:deepseek         # synthetic classification, asserts provider=deepseek
npm run dry-run:preview        # synthetic Discord preview backed by SQLite
npm run cleanup                # delete expired SQLite body/link cache rows
```

There is no unread-state backfill or Gmail cleanup path. Bootstrap and
cursor-expiry recovery use the bounded `GMAIL_LOOKBACK_HOURS` window without
modifying the mailbox.

For multiple Gmail accounts, prefer JSON token files:

```bash
npm run google:auth -- main "Main Gmail"
npm run google:auth -- school "School Gmail"
```

This updates `config/gmail-accounts.json` and writes tokens under `config/google-tokens/`. Each account keeps independent processing state in SQLite.
