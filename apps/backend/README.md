# Hedwig backend

Node service for a read-only multi-account Gmail digest, Telegram delivery, and classifier providers.

Hedwig's mail flow depends on the internal `MailGateway` boundary instead of importing Gmail API helpers directly. The current gateway implementation is still Gmail-backed and uses the same OAuth/config/token files, but the product layer now treats personal mail access as a replaceable adapter.

New inbox mail is discovered through the Gmail History API: a per-account `historyId` cursor is stored in SQLite (`sync_state`) and each run pulls only the messages added since that cursor, independent of read/star/label state. The first run (or an expired cursor) bootstraps from the recent `GMAIL_LOOKBACK_HOURS` window. Which messages have already been handled is tracked in SQLite (`message_classifications`), not by the Gmail read flag, so processed mail can be left unread/in-inbox without being reprocessed, and the cursor only advances after a run finishes cleanly. Scheduled digests read today's stored handling results from SQLite rather than doing a fresh inbox classification pass.

Gmail is intentionally read-only:

- History cursor discovers new Inbox messages.
- SQLite tracks processing, suppression and delivery state.
- Junk and disposable codes receive the DB-only `suppress` outcome and are
  omitted from Telegram output.
- Hedwig never changes Gmail read, star, label, Inbox or Trash state.

Current providers:

- `rule`: local conservative rules
- `openai-compatible`: JSON-mode classification against any OpenAI-compatible endpoint (DeepSeek, GLM, …). Each call retries with exponential backoff (`CLASSIFIER_MAX_RETRIES`, `CLASSIFIER_TIMEOUT_MS`), which honors `Retry-After` so a 429 rate limit self-throttles rather than failing. Only once retries are exhausted does it try the optional backup LLM (`CLASSIFIER_FALLBACK_*`), then the rule classifier, and Hedwig sends an operational alert counting the messages that fell back.

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```

`digest:daemon` processes Gmail History updates every `DIGEST_PROCESS_CRON` interval, defaulting to `*/5 * * * *`, and sends the daily digest at `DIGEST_CRON`. Action-classified messages are pushed immediately to the owner's Telegram chat. Every digest and alert is first written to the SQLite outbox (`notification_outbox`) in the same transaction as the classification, then delivered by a worker that retries network errors, 5xx and 429 responses with backoff, so a failed send never causes mail to be reclassified. Gmail mailbox state is never changed.

The owner can use `/summary_language <language>` in the Telegram chat to set
the language for future LLM-generated message summaries, attention points, and
suggested actions. The free-text value is limited to 12 characters, persists in
SQLite, and does not rewrite historical classifications. Each LLM
classification emits exactly one summary sentence plus zero to three attention
points and suggested actions; these structured details are shown on the
message detail page.

Operational problems — cron exceptions, per-account processing failures, delivery failures, and classifier rule-fallbacks — are sent to the private group `TELEGRAM_DEBUG_CHAT_ID` when set. They are deduped by signature: the same problem is silenced for `TELEGRAM_DEBUG_COOLDOWN_MINUTES` (default 60) after it fires. Alert texts never include mail content. Without the group, every occurrence is only logged as `Operational alert not sent (no alert destination configured)`.

Gmail refresh tokens are read once at startup; restart the daemon after running `npm run google:auth` for an existing account.

The cron path (`digest:daemon` and `digest:once`) discovers new inbox mail incrementally via the Gmail History API cursor; only the bootstrap/recovery scan is bounded by `GMAIL_LOOKBACK_HOURS`.

## Maintenance and probes

```bash
npm run probe:deepseek         # synthetic classification, asserts provider=deepseek
npm run messaging:check        # validate Telegram credentials, polling mode and debug group
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
