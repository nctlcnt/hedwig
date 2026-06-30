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
- leaves processed mail unread and in the Inbox to triage by hand (which messages were handled is tracked in SQLite, not the read flag); only junk and disposable one-time codes are removed from the Inbox
- never replies, sends, permanently deletes, or touches Drive (the opt-in `cleanup` command moves expired processed mail to Trash, recoverable for 30 days)

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

Fill `.env` with Gmail OAuth client refresh token values, the Hedwig Discord bot token/channel, and optionally an OpenAI-compatible classifier API:

```text
CLASSIFIER_PROVIDER=openai-compatible
CLASSIFIER_API_BASE_URL=https://api.deepseek.com
CLASSIFIER_API_KEY=
CLASSIFIER_MODEL=deepseek-v4-pro
CLASSIFIER_PROVIDER_NAME=deepseek
```

Use `CLASSIFIER_PROVIDER=rule` to run without an LLM. Legacy `CLASSIFIER_PROVIDER=deepseek`,
`DEEPSEEK_API_KEY`, and `DEEPSEEK_MODEL` are still accepted.

#### personal classifier rules

You can steer the LLM classifier with plain natural-language rules. Copy
`config/classifier-rules.example.md` to `config/classifier-rules.md` (or point
`CLASSIFIER_RULES_FILE` elsewhere) and write rules like “mail from my supervisor
is always action” or “promotions@\* is junk”. The file is appended to the
classifier prompt as the highest-priority instructions. Only the
`openai-compatible` provider reads it; the `rule` provider ignores it.

Note: the classifier keeps a guardrail (`hasJunkEvidence`) that downgrades a
`junk` verdict to `fyi` unless the message also looks like bulk/marketing mail
(unsubscribe header or promo language). So a rule that calls a non-marketing
sender “junk” lands as `fyi`; it is still cleaned up, just on the longer `fyi`
TTL rather than immediately.

For GLM, set:

```text
CLASSIFIER_PROVIDER=openai-compatible
CLASSIFIER_API_BASE_URL=https://open.bigmodel.cn/api/paas/v4
CLASSIFIER_API_KEY=...
CLASSIFIER_MODEL=glm-4.7
CLASSIFIER_PROVIDER_NAME=glm
```

The daily digest posts a glanceable summary message to `DISCORD_DIGEST_CHANNEL_ID` (counts plus a one-line lead per section), then opens a thread off that message and posts the per-section detail inside it. Splitting the detail across thread messages — chunked at 25 buttons / 4000 characters each — lets a busy day list every email without the single-message truncation or the 25-button ceiling.

In daemon mode, Hedwig also logs in to Discord Gateway with `DISCORD_BOT_TOKEN` to handle digest/realtime buttons. Digest entries include `查看内容` buttons; clicking one returns an ephemeral preview from Hedwig's local SQLite body cache: classifier summary, rough body text, important links, and a fallback Gmail link. Cached bodies are retained for 7 days and expired rows are deleted automatically.

Required Gmail OAuth scope:

```text
https://www.googleapis.com/auth/gmail.modify
```

`gmail.modify` is needed because Hedwig creates and applies labels, marks digested messages as read, and — only through the opt-in `cleanup` command — moves expired processed mail to Gmail Trash (recoverable for 30 days). The code does not call reply, send, permanent-delete, or Drive APIs.

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

`backfill:unread` ignores `GMAIL_LOOKBACK_HOURS` and reuses the same pipeline as the daemon (classify, Discord push, SQLite, mark read, Inbox cleanup). Run `backfill:unread 1` after changing the classifier provider, base URL, or model to verify the LLM end-to-end path against real Gmail with minimal side effects.

### clean up expired processed mail

When you have spare time, trash old processed mail that has aged out and never
needed follow-up:

```bash
npm run cleanup                # DRY-RUN: print the messages that would be trashed
npm run cleanup -- --apply     # move them to Gmail Trash (recoverable for 30 days)
```

`cleanup` only looks at mail Hedwig already processed (in SQLite). A message is
eligible when its category is past that category's TTL:

```text
CLEANUP_TTL_JUNK_DAYS=0        # junk is disposable as soon as it is processed
CLEANUP_TTL_FYI_DAYS=14
CLEANUP_TTL_ADMIN_DAYS=30
CLEANUP_TTL_COURSE_DAYS=never  # course is never auto-trashed (default)
CLEANUP_TTL_ACTION_DAYS=never  # action is never auto-trashed (default)
CLEANUP_MAX_PER_ACCOUNT=200    # cap candidates checked per account per run
```

Set any `CLEANUP_TTL_*_DAYS` to `never` (or omit it) to keep that category
forever. Before trashing, `cleanup` re-checks each candidate's live Gmail state
and **keeps** anything that is currently starred or carries the
`Hedwig/Followup` label — that is how a message is marked “needs follow-up”.
Trashed message ids are recorded in the `cleanup_log` table so later runs skip
them. Dry-run is the default; nothing is deleted without `--apply`.

### probe scripts

```bash
npm run probe:deepseek   # synthetic email through the configured LLM classifier
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
