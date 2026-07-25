# Testing Patterns

## Core Sections (Required)

### 1) Test Stack and Commands

- Primary test framework: no dedicated framework; TypeScript scripts run through
  `tsx`.
- Assertion/mocking tools: Node `assert/strict`, in-memory SQLite and hand-built
  fake objects.
- Verified on 2026-07-25: all six test scripts passed and `tsc --noEmit`
  completed successfully.

```bash
npm test
npm run check
```

There are no separate unit, integration, E2E or coverage commands.

### 2) Test Layout

- Tests are co-located with backend source:
  - `apps/backend/src/db.test.ts`;
  - `apps/backend/src/classifier.test.ts`;
  - `apps/backend/src/digest.test.ts`;
  - `apps/backend/src/gmail.test.ts`;
  - `apps/backend/src/summary-language.test.ts`;
  - `apps/backend/src/followup-config.test.ts`.
- The root `test` script executes these files sequentially in a fixed list.
- There are no global setup/teardown files or fixture directories.

### 3) Test Scope Matrix

| Scope | Covered? | Typical target | Notes |
|-------|----------|----------------|-------|
| Unit | Partial | Rule classifier guards, verification codes, outcome normalization and link scoring | Assertions are direct scripts |
| Integration | Partial/local | SQLite migrations/queries with `:memory:`; Gmail History pagination with a fake client | No real network calls |
| E2E | No | Gmail → classifier → SQLite → Discord workflow | Probe scripts exist but are not automated tests |

Current assertions cover:

- useful-link extraction and legacy cached-link parsing;
- legacy `archive` to DB-only `suppress` migration;
- account-scoped classification dedup;
- read-only digest orchestration, cursor replay dedup and junk suppression;
- sync-cursor get/upsert behavior;
- alert cooldown behavior;
- one-time-code and conservative junk classification;
- structured attention/action normalization, limits and SQLite round-trip;
- multi-page Gmail History aggregation;
- Unicode-safe summary-language validation, prompt hardening and SQLite setting
  persistence;
- disabled/enabled follow-up configuration and Discord Forum validation.

### 4) Mocking and Isolation Strategy

- DB tests open isolated in-memory `better-sqlite3` instances.
- Gmail History tests cast a minimal fake object to `GmailClient`.
- Classifier tests construct plain `EmailMessage` values.
- No module/network mocking library is used.
- Common failure mode: because tests are top-level scripts in one process per
  file, an early assertion stops the remainder and there is no per-test case
  name or granular report.

### 5) Coverage and Quality Signals

- Coverage tool + threshold: `[TODO]` none configured.
- Current reported coverage: `[TODO]` unavailable.
- CI: none detected.
- Major gaps:
  - cursor failure recovery and overlap handling beyond the happy-path replay;
  - concurrent/overlapping processing;
  - Discord rendering, chunking, REST failures and rate limits;
  - Discord button authorization/interaction failures;
  - OpenAI-compatible primary/fallback behavior;
  - configuration parsing and account-file validation;
  - systemd deployment behavior.

### 6) Evidence

- `package.json`
- `apps/backend/src/db.test.ts`
- `apps/backend/src/classifier.test.ts`
- `apps/backend/src/digest.test.ts`
- `apps/backend/src/followup-config.test.ts`
- `apps/backend/src/gmail.test.ts`
- `apps/backend/src/summary-language.test.ts`
- `tsconfig.json`
