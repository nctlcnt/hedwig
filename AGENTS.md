# Repository Guidelines

## Project Structure & Module Organization

Hedwig is a Node 20 TypeScript workspace. The current product surface is backend-only.

- `apps/backend/src/`: Gmail, Discord, digest, database, config, and classifier code.
- `apps/backend/src/llm/`: Gemini-backed classifier implementation.
- `apps/backend/prompts/`: LLM prompt text, including `email-classifier.md`.
- `apps/backend/scripts/`: one-off setup scripts such as Google OAuth token generation.
- `apps/frontend/`: reserved for a future admin UI; currently documentation only.
- `data/`: local SQLite data, configured by `SQLITE_PATH`.

## Build, Test, and Development Commands

Run commands from the repository root.

```bash
npm install              # install dependencies
npm run check            # TypeScript typecheck with no emit
npm run google:auth      # generate a Gmail OAuth refresh token
npm run digest:once      # run one Gmail digest cycle
npm run digest:daemon    # run scheduled digest jobs
```

`digest:daemon` uses `DIGEST_TIMEZONE` and `DIGEST_CRON`; defaults are Sydney time and `0 19 * * *`.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules. Keep source files as `.ts`, import local modules with `.js` extensions for NodeNext compatibility, and prefer named exports for shared helpers. Follow the existing style: two-space indentation, single quotes, semicolons, explicit return types on exported functions, and small modules grouped by responsibility. Use kebab-case for prompt/script filenames and descriptive camelCase for variables and functions.

## Testing Guidelines

There is no dedicated test runner configured yet. For every change, run:

```bash
npm run check
```

When adding behavior with meaningful branching, add focused tests and a matching npm script in `package.json`. Prefer tests near the backend module they cover, using names like `digest.test.ts` or `classifier.test.ts`.

## Linear Issue Naming

Use project milestones, labels, parent issues, or descriptions to express phases.
Do not make `Phase 1`, `阶段 2`, or similar phase numbers the primary issue
title. Issue titles should describe the concrete deliverable so they remain clear
outside the project plan.

Prefer `verb + object + outcome` titles, for example:

- `Fetch unread Gmail messages for digesting`
- `Classify emails with Gemini provider`
- `Send daily digest to Discord`
- `Write confirmed email events to Google Calendar`

## Commit & Pull Request Guidelines

### Commits
- Imperative subject, ≤ 50 chars
- Blank line, then body explaining *why*
- Reference Linear only when needed:
  - `Fixes HED-123` on the final/merge commit (auto-closes the issue)
  - `Refs HED-456` when a commit touches an unrelated issue

### Branches
- Named `<type>/<issue-id>-<slug>`, e.g. `feat/HED-123-gmail-digest`
- Type: `feat` / `fix` / `chore` / `refactor`
- Issue ID in branch handles the linking — no need to repeat in every commit
- Delete after merge

## Pull Requests

### Title
- Imperative, ≤ 60 chars, mirrors the final commit subject
- Append issue ID in parens: `Build Gmail digest backend (HED-123)`
- Avoid vague verbs: no `Update`, `Improve`, `Refactor stuff`,
  `Implement changes`. Say *what* changed.

### Body
Use exactly these sections, in order:

**Summary**
1-3 sentences on what changed and why. No bullet lists of every
file touched. 

**Verification**
Concrete steps you ran, with results. Not `tested locally`.

**Notes** (optional)
Follow-ups, known issues, anything reviewers should know.

Then a `Linear:` line with the full issue URL.

End with `Fixes HED-123` on its own line.

### Don't
- Don't restate the diff (`Changed line 42 in x.ts to...`)
- Don't include screenshots unless UI changed
- Don't write `This PR does the following:` preambles

## Security & Configuration Tips

Copy `.env.example` to `.env` and keep secrets out of git. Required integrations include Gmail OAuth credentials and Discord bot/channel values; Gemini is optional when `CLASSIFIER_PROVIDER=rule`. The Gmail scope should remain `https://www.googleapis.com/auth/gmail.modify`; the service labels messages and marks digested messages read, but must not reply, delete, archive, trash, or access Drive.
