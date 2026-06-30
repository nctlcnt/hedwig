# Hedwig backend

Node service for multi-account Gmail digest, Gmail labels, Discord delivery, and classifier providers.

Hedwig's mail flow depends on the internal `MailGateway` boundary instead of importing Gmail API helpers directly. The current gateway implementation is still Gmail-backed and uses the same OAuth/config/token files, but the product layer now treats personal mail access as a replaceable adapter.

New inbox mail is discovered through the Gmail History API: a per-account `historyId` cursor is stored in SQLite (`sync_state`) and each run pulls only the messages added since that cursor, independent of read/star/label state. The first run (or an expired cursor) bootstraps from the recent `GMAIL_LOOKBACK_HOURS` window. Which messages have already been handled is tracked in SQLite (`message_classifications`), not by the Gmail read flag, so processed mail can be left unread/in-inbox without being reprocessed, and the cursor only advances after a run finishes cleanly. Scheduled digests read today's stored handling results from SQLite rather than doing a fresh inbox classification pass.

Gmail state is intentionally minimal:

- by default Hedwig leaves processed mail unread and in the Inbox for the user to triage by hand; processed/unprocessed is tracked in SQLite
- junk (including disposable one-time codes) is removed from the Inbox so it does not pile up
- starred means the message needs follow-up and always remains in Inbox
- `Hedwig/Followup` is the only Hedwig-managed Gmail label, reserved for explicit follow-up tracking/history

Current providers:

- `rule`: local conservative rules
- `openai-compatible`: JSON-mode classification against any OpenAI-compatible endpoint (DeepSeek, GLM, …). On failure it tries the optional backup LLM (`CLASSIFIER_FALLBACK_*`) before falling back to the rule classifier, and Hedwig posts a Discord alert listing any messages that fell back.

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```

`digest:daemon` processes unread mail every `DIGEST_PROCESS_CRON` interval, defaulting to `*/5 * * * *`, and sends the daily digest at `DIGEST_CRON`. Action-classified messages are pushed immediately to `DISCORD_REALTIME_CHANNEL_ID`; if that variable is unset the push is skipped and the message only surfaces in the next digest (no fallback to the digest channel, to avoid duplicate posts). Processed mail is left unread and in the Inbox (dedup is tracked in SQLite); only junk/one-time-code mail is removed from the Inbox, and starred mail always stays.

The cron path (`digest:daemon` and `digest:once`) only looks at unread mail inside the `GMAIL_LOOKBACK_HOURS` window, so older unread backlog is intentionally ignored.

## Backfill and probes

```bash
npm run backfill:unread        # 30 most-recent unread per account
npm run backfill:unread 1      # smoke test: 1 message per account
npm run probe:deepseek         # synthetic classification, asserts provider=deepseek
npm run probe:unread           # per-account unread counts in/out of the lookback window
```

`backfill:unread` ignores `GMAIL_LOOKBACK_HOURS` and reuses the same classify + Discord + SQLite pipeline as the daemon. Unlike the daemon it does mark handled mail read, so repeated runs can page past the backlog it already drained (it still leaves mail in the Inbox). Use `backfill:unread 1` to verify the end-to-end LLM path against real Gmail with minimal side effects.

For multiple Gmail accounts, prefer JSON token files:

```bash
npm run google:auth -- main "Main Gmail"
npm run google:auth -- school "School Gmail"
```

This updates `config/gmail-accounts.json` and writes tokens under `config/google-tokens/`. Each account keeps independent processing state in SQLite.
