# Codebase Structure

## Core Sections (Required)

### 1) Top-Level Map

| Path | Purpose | Evidence |
|------|---------|----------|
| `apps/backend/` | All current product code, prompts, setup/probe scripts and backend notes | `README.md`, `apps/backend/README.md` |
| `apps/frontend/` | Placeholder only; there is no implemented admin UI | `apps/frontend/README.md` |
| `config/` | Checked-in examples plus ignored local Gmail account/token and classifier-rule files | `.gitignore`, `config/*.example.*` |
| `data/` | Ignored local SQLite database and WAL files | `.gitignore`, `apps/backend/src/db.ts` |
| `deploy/systemd/` | User-service unit used to keep the daemon running | `deploy/systemd/hedwig-digest.service` |
| `docs/codebase/` | Verifiable codebase map produced on 2026-07-25 | these seven documents |
| `package.json` | Root scripts and dependency manifest | `package.json` |
| `tsconfig.json` | Backend TypeScript compilation boundary | `tsconfig.json` |

`packages/` exists locally but contains no tracked source and is not configured
as an npm workspace.

### 2) Entry Points

- Main runtime entry: `apps/backend/src/index.ts`.
- Runtime modes:
  - `npm run digest:once` selects `once`;
  - `npm run digest:daemon` selects `daemon`.
- Secondary CLI entry points:
  - `apps/backend/scripts/google-auth.ts`;
  - `apps/backend/scripts/cleanup.ts`;
  - `apps/backend/scripts/deepseek-probe.ts`;
  - `apps/backend/scripts/preview-dry-run.ts`.
- Test entry points are the six co-located `*.test.ts` scripts selected
  explicitly by the root `test` script.

### 3) Module Boundaries

| Boundary | What belongs here | What must not be here |
|----------|-------------------|------------------------|
| `src/index.ts` | Process startup and cron wiring | Email classification or Gmail request details |
| `src/digest.ts` | Product workflow orchestration and digest assembly | Raw Gmail client construction |
| `src/gateway/` | `MailGateway` port and Gmail adapter | Discord rendering or classification policy |
| `src/gmail.ts` | Gmail OAuth client and API primitives | Digest policy and SQLite queries |
| `src/classifier.ts`, `src/classifiers.ts`, `src/llm/` | Rule classification, provider selection, LLM normalization and section narration | Gmail mutation or Discord thread lifecycle |
| `src/db.ts` | SQLite schema, migrations and persistence/query helpers | External API calls |
| `src/discord.ts`, `src/discord-bot.ts`, `src/alerts.ts` | Discord REST output, Gateway interactions and deduplicated operational alerts | Gmail access |
| `scripts/` | Human-invoked setup, maintenance and probe commands | Long-running daemon scheduling |

### 4) Naming and Organization Rules

- Files use lowercase kebab-case for multiword names, for example
  `openai-compatible-classifier.ts` and `preview-dry-run.ts`.
- The source tree is organized mainly by technical responsibility, with
  `gateway/` and `llm/` as explicit sub-boundaries.
- Local ESM imports are relative and include `.js` extensions so compiled output
  remains NodeNext-compatible.
- Shared types are named exports from `src/types.ts`; there are no barrel files
  or TypeScript path aliases.

### 5) Backend Deep Map

```text
src/index.ts
  -> digest.ts
     -> gateway/mail-gateway.ts
        -> gateway/gmail-mail-gateway.ts -> gmail.ts
     -> classifiers.ts
        -> classifier.ts
        -> llm/openai-compatible-classifier.ts
     -> db.ts
     -> discord.ts
     -> llm/section-narrator.ts
  -> discord-bot.ts -> db.ts
  -> alerts.ts -> discord.ts + db.ts
```

### 6) Evidence

- `README.md`
- `package.json`
- `tsconfig.json`
- `apps/backend/src/index.ts`
- `apps/backend/src/gateway/mail-gateway.ts`
- `apps/backend/src/types.ts`
