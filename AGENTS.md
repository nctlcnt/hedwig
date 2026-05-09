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

## Commit & Pull Request Guidelines

Recent history uses short, imperative commit subjects such as `Build TypeScript Gmail digest backend` and `Resolve punycode deprecation source`. Keep commits focused and explain the reason in the body when context is not obvious. If work is tracked in Linear, reference the issue in the body, for example `Refs HED-123` or `Fixes HED-123`.

Pull requests should include a concise summary, linked Linear issue when applicable, verification steps, and screenshots only for future UI work.

## Security & Configuration Tips

Copy `.env.example` to `.env` and keep secrets out of git. Required integrations include Gmail OAuth credentials and Discord bot/channel values; Gemini is optional when `CLASSIFIER_PROVIDER=rule`. The Gmail scope should remain `https://www.googleapis.com/auth/gmail.modify`; the service labels messages and marks digested messages read, but must not reply, delete, archive, trash, or access Drive.
