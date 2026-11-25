# Hedwig

A personal Gmail digest assistant delivered through a private Telegram bot chat.

Hedwig reads new inbox mail, classifies it, stores workflow state in SQLite, and
delivers realtime alerts and daily digests to the owner's Telegram chat. Gmail access is
read-only: mailbox state is never used as Hedwig's workflow state.

## Features

- Multiple Gmail accounts with independent History API cursors
- SQLite-backed deduplication, classifications, summaries, and sync state
- Realtime Telegram alerts for high-priority messages
- A daily Telegram overview with category, message, and body pages on demand
- A SQLite outbox that retries deliveries after network errors and rate limits
- One-sentence summaries, attention points, and suggested actions
- Seven-day local body cache with automatic expiry
- Rule-based classification with optional OpenAI-compatible LLM support
- Configurable summary language through `/summary_language`

## Safety

Hedwig uses the following Gmail OAuth scope:

```text
https://www.googleapis.com/auth/gmail.readonly
```

It reads inbox history, metadata, and message bodies. It does not mark messages
read, star, label, archive, trash, reply, send, or permanently delete them.
Suppressed junk and one-time codes remain unchanged in Gmail.

## Requirements

- Node.js 20 or newer
- Google OAuth credentials with Gmail API access
- A Telegram bot and the owner's private chat with it

## Quick start

> **Before you start:** Make sure you have your own Google OAuth credentials
> with Gmail API access. This project does not generate them for you.

```bash
cp .env.example .env
npm install
```

Set the Google OAuth and Telegram values in `.env`, then authorize a Gmail
account:

```bash
npm run google:auth -- main "Main Gmail"
```

The authorization script creates the local account and token files used by the
default multi-account configuration. Refresh tokens are read only at startup, so
restart a running daemon after re-authorizing an account. Run one processing
cycle:

```bash
npm run digest:once
```

Start the scheduled daemon:

```bash
npm run digest:daemon
```

Classification falls back to local rules when no model is configured. Optional
classifier settings are listed in `.env.example`.

## Configuration

The main settings are:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_ACCOUNTS_JSON` | Local multi-account configuration file |
| `TELEGRAM_BOT_TOKEN` | Token for the Telegram bot |
| `TELEGRAM_OWNER_USER_ID` | Allowed numeric Telegram user ID |
| `TELEGRAM_CHAT_ID` | Allowed private chat ID |
| `TELEGRAM_DEBUG_CHAT_ID` | Private group for operational alerts; recommended |
| `DIGEST_TIMEZONE` | Digest schedule timezone |
| `DIGEST_CRON` | Daily digest cron expression |
| `DIGEST_PROCESS_CRON` | Gmail History polling cron expression |
| `SQLITE_PATH` | SQLite database path |

Account IDs must remain stable because they are part of the SQLite
deduplication keys.

Telegram uses long polling. Create a bot in BotFather, enter its token and the
owner/private chat IDs in `.env`, then send `/start` from that private chat with
the daemon running. An existing Telegram webhook blocks daemon startup. Use a
separate bot token and SQLite database for a test instance.
Run `npm run messaging:check` to validate settings, including Telegram bot
credentials and webhook status, without syncing Gmail or sending messages.

Without `TELEGRAM_DEBUG_CHAT_ID`, operational problems such as a failing Gmail
account are not pushed anywhere; each one is only written to the service log as
`Operational alert not sent (no alert destination configured)`.

### Natural-language classification rules

Copy `config/classifier-rules.example.md` to `config/classifier-rules.md`, or set
`CLASSIFIER_RULES_FILE` to another path. With the LLM classifier, you can write
plain-language rules for categories, importance, summaries, and routing.

These rules become part of the classifier prompt. Their quality is not
automatically validated, so test them with representative emails and your
configured model before relying on the results.

## Telegram behavior

The daily overview shows the account names and four category counts. Open a
category to browse messages and open a message to read its details or cached
body. The buttons edit the same Telegram message and return to the previous
list page. Urgent alerts also offer a details button and a Gmail link.

- `/today` opens today's saved overview or builds a view from mail already
  classified in SQLite.
- `/status` shows the latest sync and successful delivery times, plus the
  number of queued deliveries.
- `/summary_language English` sets the language for newly generated summaries.

Digest views and buttons expire after seven days. When a body cache entry has
expired, the message can still be opened in Gmail.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run google:auth` | Authorize a Gmail account |
| `npm run digest:once` | Process mail, queue today's digest, and attempt due deliveries |
| `npm run digest:daemon` | Run History polling and digest schedules |
| `npm run cleanup` | Delete expired local email body cache rows |
| `npm run messaging:check` | Validate Telegram settings without sending messages |
| `npm run check` | Run TypeScript checks |
| `npm test` | Run the backend test suite |

## Run with systemd

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/hedwig-digest.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hedwig-digest.service
```

Check the service:

```bash
systemctl --user status hedwig-digest.service
journalctl --user -u hedwig-digest.service -f
```

Restart the daemon after changing its configuration or re-authorizing a Gmail
account:

```bash
systemctl --user restart hedwig-digest.service
```

## Repository layout

```text
apps/backend/
  prompts/       Classifier prompts
  scripts/       OAuth, cleanup, probe, and messaging-check scripts
  src/           Gmail, Telegram, database, digest, and classifier code
    gateway/     Personal-data access interfaces and adapters
apps/frontend/   Reserved for a future admin UI
config/          Local account and classifier configuration
data/            Local SQLite data
```
