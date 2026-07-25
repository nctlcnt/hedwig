# Coding Conventions

## Core Sections (Required)

### 1) Naming Rules

| Item | Rule | Example | Evidence |
|------|------|---------|----------|
| Files | Lowercase kebab-case for multiword files; `*.test.ts` for checks | `gmail-mail-gateway.ts`, `classifier.test.ts` | `apps/backend/src/` |
| Functions/methods | Descriptive camelCase, verbs for operations | `processUnreadMail`, `saveClassification` | `apps/backend/src/digest.ts`, `apps/backend/src/db.ts` |
| Types/interfaces | PascalCase named types; capability interfaces are structural `type` aliases | `MailGateway`, `DigestReport` | `apps/backend/src/gateway/mail-gateway.ts`, `apps/backend/src/types.ts` |
| Constants/env vars | `UPPER_SNAKE_CASE`; constants are module-local unless shared | `DISCORD_API`, `CLASSIFIER_MAX_RETRIES` | `apps/backend/src/discord.ts`, `.env.example` |

### 2) Formatting and Linting

- Formatter: none configured. Tracked source consistently uses two spaces,
  single quotes and semicolons as documented in `AGENTS.md`.
- Linter: none configured.
- Compiler-enforced rules: `strict`, `noUncheckedIndexedAccess`,
  `forceConsistentCasingInFileNames`.
- Run commands: `npm run check` and `npm test`.

### 3) Import and Module Conventions

- Node built-ins and external packages generally precede relative imports, with
  type-only imports using `import type`.
- Local imports are relative and end in `.js` for NodeNext compatibility.
- There are no path aliases or barrel exports; shared helpers/types are named
  exports from their owning module.
- Modules keep most implementation helpers private by omitting `export`.

### 4) Error and Logging Conventions

- Configuration rejects missing/invalid values by throwing early.
- Account processing catches failures at the account boundary, marks the DB run
  failed and sends a best-effort debug alert.
- LLM classification catches provider failures and degrades through the
  configured fallback chain; section narration catches and returns blank leads.
- External REST helpers throw status plus response body on non-2xx responses.
- Logging uses `console.log/info/warn/error` with free-form text; there is no
  structured logger or standard context schema.
- Operational alert signatures are truncated and cooldown-deduplicated.
- Explicit sensitive-data redaction rules are not implemented. Code generally
  logs IDs, provider errors and summaries rather than OAuth tokens, but probe
  and maintenance commands can print message metadata or classification output.

### 5) Testing Conventions

- Tests are co-located in `apps/backend/src/` and named `*.test.ts`.
- Tests use Node `assert/strict` and local in-memory/fake objects rather than a
  mocking framework.
- External Gmail behavior is tested with a hand-built fake client; DB tests use
  in-memory SQLite.
- Coverage expectation: `[TODO]` no threshold or coverage report is configured.

### 6) Repository Workflow

- Branch, commit, PR and Linear title/body conventions are documented in
  `AGENTS.md`.
- The read-only ingestion work is being prepared on
  `refactor/LT-152-read-only-gmail`.
- Active Linear issues should carry repo/area/type labels according to the
  Linear Operating Manual. Several existing Hedwig backlog issues still use the
  misspelled legacy label `hegwig` or no repo label.

### 7) Evidence

- `AGENTS.md`
- `tsconfig.json`
- `apps/backend/src/config.ts`
- `apps/backend/src/digest.ts`
- `apps/backend/src/classifier.test.ts`
- `apps/backend/src/digest.test.ts`
- `apps/backend/src/followup-config.test.ts`
- `apps/backend/src/gmail.test.ts`
