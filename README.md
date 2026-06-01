# hedwig

tracking this stack in [邮件-digest-overview](https://linear.app/chachas/project/%E9%82%AE%E4%BB%B6-digest-11a75b83e5fb/overview)

## first slice: Gmail daily digest -> Discord

This repo now contains the first runnable Hedwig slice:

- reads one or more configured Gmail account inboxes for the past 24 hours
- ignores read messages by default (`GMAIL_UNREAD_ONLY=true`)
- excludes Spam and Trash
- creates only the allowed Gmail labels: `AUTO/action`, `AUTO/fyi`, `AUTO/course`, `AUTO/admin`, `AUTO/junk`, `AUTO/digest`
- classifies each message conservatively, with Junk requiring unsubscribe or marketing evidence
- applies one `AUTO/*` label to each message
- sends the digest to Discord through the Hedwig bot instead of emailing it back to Gmail
- marks digested messages as read after the Discord digest is sent
- never replies, archives, deletes, trashes, or touches Drive

## repo layout

```text
apps/
  backend/
    prompts/              # LLM prompts
    scripts/              # one-off auth/setup scripts
    src/                  # digest, Discord, database, classifier providers
      gateway/            # personal data access boundaries and adapters
  frontend/
    README.md             # reserved for a future admin UI
```

The current product surface is backend-only. `apps/frontend` exists so the repo shape is clear before adding UI.

## architecture boundary

Hedwig owns the email digest product workflow: classification, reporting, Discord delivery, and local SQLite run/message records. Direct personal data access sits behind gateway interfaces under `apps/backend/src/gateway/`.

The current `MailGateway` implementation is Gmail-backed and still reuses this repo's OAuth, token, and Gmail API helpers. Digest code depends on the gateway interface, not Gmail API helpers directly, so a future `personal-gateway` service can replace the adapter without rewriting digest, classifier, Discord, or database logic.

### setup

```bash
cp .env.example .env
npm install
```

Fill `.env` with Gmail OAuth client refresh token values, the Hedwig Discord bot token/channel, and optionally DeepSeek:

```text
CLASSIFIER_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-pro
```

Use `CLASSIFIER_PROVIDER=rule` to run without DeepSeek.
DeepSeek is called via the OpenAI-compatible endpoint at `https://api.deepseek.com`.

Discord content preview buttons are optional. To enable them, expose the daemon's interaction endpoint to Discord and set:

```text
DISCORD_PUBLIC_KEY=
DISCORD_INTERACTIONS_PORT=3001
```

When enabled, digest/realtime messages include `查看内容` buttons. Clicking one returns an ephemeral preview from Hedwig's local SQLite body cache: classifier summary, rough body text, important links, and a fallback Gmail link. Cached bodies are retained for 7 days and expired rows are deleted automatically.

Required Gmail OAuth scope:

```text
https://www.googleapis.com/auth/gmail.modify
```

`gmail.modify` is needed because Hedwig creates and applies labels, then marks digested messages as read. The code does not call reply, send, archive, delete, trash, or Drive APIs.

To get a Gmail refresh token, first fill these values in `.env`:

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost
```

Then run:

```bash
npm run google:auth
```

Open the printed URL, approve access, copy the `code` query parameter from the redirected URL, and paste it back into the terminal. The script prints the `GOOGLE_REFRESH_TOKEN` line for `.env`.

The preferred multi-account setup is JSON plus local token files. Authorize each account once:

```bash
npm run google:auth -- main "Main Gmail"
npm run google:auth -- school "School Gmail"
```

Each run opens a Google consent URL, then writes:

```text
config/gmail-accounts.json
config/google-tokens/<account_id>.json
```

Both paths are ignored by git. The resulting JSON looks like:

```json
{
  "accounts": [
    {
      "id": "main",
      "displayName": "Main Gmail",
      "refreshTokenFile": "config/google-tokens/main.json"
    }
  ]
}
```

Single-account mode can still use `GOOGLE_REFRESH_TOKEN` directly. Legacy env multi-account mode also works with `GMAIL_ACCOUNTS`, where each entry points to the env var that stores that account's refresh token:

```text
GMAIL_ACCOUNTS=main:Main Gmail:GOOGLE_REFRESH_TOKEN_MAIN,school:School Gmail:GOOGLE_REFRESH_TOKEN_SCHOOL
GOOGLE_REFRESH_TOKEN_MAIN=
GOOGLE_REFRESH_TOKEN_SCHOOL=
```

Account ids must be stable because they are stored in SQLite and used for per-account deduping.

### run once

```bash
npm run digest:once
```

### run daily at Sydney 19:00

```bash
npm run digest:daemon
```

Default schedule:

```text
DIGEST_TIMEZONE=Australia/Sydney
DIGEST_CRON=0 19 * * *
```

By default Hedwig only scans unread inbox messages. Set `GMAIL_UNREAD_ONLY=false` only for backfills or debugging.

The cron path (`digest:daemon` and `digest:once`) only considers unread mail inside the `GMAIL_LOOKBACK_HOURS` window. Older unread mail is left alone — drain it explicitly with `backfill:unread`.

### backfill older unread mail

```bash
npm run backfill:unread        # 30 most-recent unread per account
npm run backfill:unread 1      # smoke test: 1 message per account
```

`backfill:unread` ignores `GMAIL_LOOKBACK_HOURS` and reuses the same pipeline as the daemon (classify, Discord push, SQLite, mark read, Inbox cleanup). Run `backfill:unread 1` after changing the classifier provider or model to verify the DeepSeek end-to-end path against real Gmail with minimal side effects.

### probe scripts

```bash
npm run probe:deepseek   # synthetic email through the DeepSeek classifier
npm run probe:unread     # per-account unread counts in/out of the lookback window
```

### run in the background with systemd

Install the user service:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/hedwig-digest.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hedwig-digest.service
```

Check status and logs:

```bash
systemctl --user status hedwig-digest.service
journalctl --user -u hedwig-digest.service -f
```

Keep the user service alive after logout:

```bash
loginctl enable-linger "$USER"
```

## discord channel settings
- 📅-email-pending
- 📊-email-digest-daily
🎓-email-school
💰-email-finance
🔧-workflow-debug
