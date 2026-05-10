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

## Security & Configuration Tips

Copy `.env.example` to `.env` and keep secrets out of git. Required integrations include Gmail OAuth credentials and Discord bot/channel values; Gemini is optional when `CLASSIFIER_PROVIDER=rule`. The Gmail scope should remain `https://www.googleapis.com/auth/gmail.modify`; the service labels messages and marks digested messages read, but must not reply, delete, archive, trash, or access Drive.

## Linear connection
本项目的 issue 跟踪在 Linear 上
每次get issue时，使用两个步骤：
1. Linear:get_issue(id="LIN-123")          # 拿 issue 主体
2. Linear:list_comments(issueId="LIN-123") # 再拿评论列表
评论列表里面是需求变更记录，和一些讨论，甚至有时会有新的需求冒出来，比description更活跃，所以需要单独拿，并且评估和implement。
先看 Linear Operating Manual，或者在 Linear 里搜索这个标题，依据里面的规范来管理 issue 和 comment。