# Hedwig backend

Node service for multi-account Gmail digest, Gmail labels, Discord delivery, and classifier providers.

Hedwig's digest flow depends on the internal `MailGateway` boundary instead of importing Gmail API helpers directly. The current gateway implementation is still Gmail-backed and uses the same OAuth/config/token files, but the product layer now treats personal mail access as a replaceable adapter.

Current providers:

- `rule`: local conservative rules
- `gemini`: Gemini structured JSON classification with rule fallback

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```

For multiple Gmail accounts, prefer JSON token files:

```bash
npm run google:auth -- main "Main Gmail"
npm run google:auth -- school "School Gmail"
```

This updates `config/gmail-accounts.json` and writes tokens under `config/google-tokens/`. Each account keeps independent processing state in SQLite.
