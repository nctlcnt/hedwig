# Hedwig

A personal Gmail digest and follow-up assistant for Discord.

Hedwig reads new inbox mail, classifies it, stores workflow state in SQLite, and
delivers realtime alerts and daily digests to Discord. Gmail access is
read-only: mailbox state is never used as Hedwig's workflow state.

## Features

- Multiple Gmail accounts with independent History API cursors
- SQLite-backed deduplication, classifications, summaries, and sync state
- Realtime Discord alerts for high-priority messages
- Daily Discord digests with detailed threads
- One-sentence summaries, attention points, and suggested actions
- Ephemeral email previews with useful links and Gmail navigation
- Seven-day local body cache with automatic expiry
- Rule-based classification with optional OpenAI-compatible LLM support
- Configurable summary language through `/summary-language`
- Optional Discord Forum validation for the follow-up workflow

The Track, Done, and reconcile parts of the follow-up workflow are still under
development.

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
- A Discord bot and digest channel

## Quick start

```bash
cp .env.example .env
npm install
```

Set the Google OAuth and Discord values in `.env`, then authorize a Gmail
account:

```bash
npm run google:auth -- main "Main Gmail"
```

The authorization script creates the local account and token files used by the
default multi-account configuration. Run one processing cycle:

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
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_DIGEST_CHANNEL_ID` | Daily digest destination |
| `DISCORD_REALTIME_CHANNEL_ID` | Optional realtime alert destination |
| `DISCORD_DEBUG_CHANNEL_ID` | Optional operational alert destination |
| `DIGEST_TIMEZONE` | Digest schedule timezone |
| `DIGEST_CRON` | Daily digest cron expression |
| `DIGEST_PROCESS_CRON` | Gmail History polling cron expression |
| `SQLITE_PATH` | SQLite database path |

Account IDs must remain stable because they are part of the SQLite
deduplication keys.

### Follow-up Forum

Follow-up support is opt-in:

```text
FOLLOWUP_ENABLED=false
DISCORD_FOLLOWUP_FORUM_CHANNEL_ID=
```

When disabled, Hedwig ignores the Forum channel setting. When enabled, startup
requires an accessible Discord Forum channel and validates it before scheduling
mail jobs.

## Discord behavior

The daily digest posts a compact overview and places full sections in a thread.
Realtime alerts are sent separately when a realtime channel is configured.

Email entries include a content-preview button. The ephemeral preview is served
from SQLite and includes the summary, attention points, suggested actions, body
text, useful links, and a Gmail link. Cached bodies expire after seven days.

Server managers can set the language for future summaries:

```text
/summary-language language:English
```

The value is free text with a maximum length of 12 characters. Existing
summaries are not rewritten.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run google:auth` | Authorize a Gmail account |
| `npm run digest:once` | Process mail and send one digest |
| `npm run digest:daemon` | Run History polling and digest schedules |
| `npm run cleanup` | Delete expired local email body cache rows |
| `npm run dry-run:preview` | Send a synthetic Discord preview |
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

## Repository layout

```text
apps/backend/
  prompts/       Classifier prompts
  scripts/       OAuth, cleanup, probe, and dry-run scripts
  src/           Gmail, Discord, database, digest, and classifier code
    gateway/     Personal-data access interfaces and adapters
apps/frontend/   Reserved for a future admin UI
config/          Local account and classifier configuration
data/            Local SQLite data
```
