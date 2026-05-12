# Hedwig backend

Node service for multi-account Gmail digest, Gmail labels, Discord delivery, and classifier providers.

Hedwig's mail flow depends on the internal `MailGateway` boundary instead of importing Gmail API helpers directly. The current gateway implementation is still Gmail-backed and uses the same OAuth/config/token files, but the product layer now treats personal mail access as a replaceable adapter.

Unread inbox mail is the processing queue. Each run classifies unread messages, persists the handling result in SQLite, applies the Inbox/read state transition, and marks successfully handled messages read. Scheduled digests read today's stored handling results from SQLite rather than doing a fresh inbox classification pass.

Gmail state is intentionally minimal:

- unread means Hedwig has not processed the message yet
- read means Hedwig processed the message
- starred means the message needs follow-up and may remain in Inbox
- unstarred processed mail is removed from Inbox
- `Hedwig/Followup` is the only Hedwig-managed Gmail label, reserved for explicit follow-up tracking/history

Current providers:

- `rule`: local conservative rules
- `deepseek`: DeepSeek JSON-mode classification (OpenAI-compatible endpoint) with rule fallback

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```

`digest:daemon` processes unread mail every `DIGEST_PROCESS_CRON` interval, defaulting to `*/5 * * * *`, and sends the daily digest at `DIGEST_CRON`. Action-classified messages are pushed immediately to `DISCORD_REALTIME_CHANNEL_ID`; if that variable is unset the push is skipped and the message only surfaces in the next digest (no fallback to the digest channel, to avoid duplicate posts). All processed messages that are not starred are marked read and removed from Inbox.

The cron path (`digest:daemon` and `digest:once`) only looks at unread mail inside the `GMAIL_LOOKBACK_HOURS` window, so older unread backlog is intentionally ignored.

## Backfill and probes

```bash
npm run backfill:unread        # 30 most-recent unread per account
npm run backfill:unread 1      # smoke test: 1 message per account
npm run probe:deepseek         # synthetic classification, asserts provider=deepseek
npm run probe:unread           # per-account unread counts in/out of the lookback window
```

`backfill:unread` ignores `GMAIL_LOOKBACK_HOURS` and reuses the same classify + Discord + SQLite + mark-read pipeline as the daemon. Use `backfill:unread 1` to verify the DeepSeek end-to-end path against real Gmail with minimal side effects.

For multiple Gmail accounts, prefer JSON token files:

```bash
npm run google:auth -- main "Main Gmail"
npm run google:auth -- school "School Gmail"
```

This updates `config/gmail-accounts.json` and writes tokens under `config/google-tokens/`. Each account keeps independent processing state in SQLite.
