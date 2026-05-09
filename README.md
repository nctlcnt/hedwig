# hedwig

tracking this stack in [邮件-digest-overview](https://linear.app/chachas/project/%E9%82%AE%E4%BB%B6-digest-11a75b83e5fb/overview)

## first slice: Gmail daily digest -> Discord

This repo now contains the first runnable Hedwig slice:

- reads the current Gmail account inbox for the past 24 hours
- excludes Spam and Trash
- creates only the allowed Gmail labels: `AUTO/action`, `AUTO/fyi`, `AUTO/course`, `AUTO/admin`, `AUTO/junk`, `AUTO/digest`
- classifies each message conservatively, with Junk requiring unsubscribe or marketing evidence
- applies one `AUTO/*` label to each message
- sends the digest to Discord through the Hedwig bot instead of emailing it back to Gmail
- never replies, archives, deletes, marks read, or touches Drive

## repo layout

```text
apps/
  backend/
    prompts/              # LLM prompts
    scripts/              # one-off auth/setup scripts
    src/                  # Gmail, Discord, digest, classifier providers
  frontend/
    README.md             # reserved for a future admin UI
```

The current product surface is backend-only. `apps/frontend` exists so the repo shape is clear before adding UI.

### setup

```bash
cp .env.example .env
npm install
```

Fill `.env` with a Gmail OAuth client refresh token, the Hedwig Discord bot token/channel, and optionally Gemini:

```text
CLASSIFIER_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
```

Use `CLASSIFIER_PROVIDER=rule` to run without Gemini.
If Gemini returns `SERVICE_DISABLED`, enable `generativelanguage.googleapis.com` for the Google Cloud project that owns the API key.

Required Gmail OAuth scope:

```text
https://www.googleapis.com/auth/gmail.modify
```

`gmail.modify` is needed because Hedwig creates and applies labels. The code does not call reply, send, archive, delete, trash, read-state, or Drive APIs.

To get `GOOGLE_REFRESH_TOKEN`, first fill these values in `.env`:

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

## discord channel settings
- 📅-email-pending
- 📊-email-digest-daily
🎓-email-school
💰-email-finance
🔧-workflow-debug
