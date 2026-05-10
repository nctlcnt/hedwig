# Hedwig backend

Node service for multi-account Gmail digest, Gmail labels, Discord delivery, and classifier providers.

Hedwig's mail flow depends on the internal `MailGateway` boundary instead of importing Gmail API helpers directly. The current gateway implementation is still Gmail-backed and uses the same OAuth/config/token files, but the product layer now treats personal mail access as a replaceable adapter.

Unread inbox mail is the processing queue. Each run classifies unread messages, applies the mapped Gmail action, persists the handling result in SQLite, and marks successfully handled messages read. Scheduled digests read today's stored handling results from SQLite rather than doing a fresh inbox classification pass.

Current providers:

- `rule`: local conservative rules
- `gemini`: Gemini structured JSON classification with rule fallback

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```

`digest:daemon` processes unread mail every `DIGEST_PROCESS_CRON` interval, defaulting to `*/5 * * * *`, and sends the daily digest at `DIGEST_CRON`. Action-classified messages are pushed immediately to `DISCORD_REALTIME_CHANNEL_ID` when set, otherwise the digest channel is used. Junk-classified messages are marked read and removed from Inbox; other processed messages are marked read and kept in Inbox.

For multiple Gmail accounts, prefer JSON token files:

```bash
npm run google:auth -- main "Main Gmail"
npm run google:auth -- school "School Gmail"
```

This updates `config/gmail-accounts.json` and writes tokens under `config/google-tokens/`. Each account keeps independent processing state in SQLite.
