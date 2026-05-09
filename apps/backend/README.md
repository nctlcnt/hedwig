# Hedwig backend

Node service for Gmail digest, Gmail labels, Discord delivery, and classifier providers.

Current providers:

- `rule`: local conservative rules
- `gemini`: Gemini structured JSON classification with rule fallback

Run from the repo root:

```bash
npm run digest:once
npm run digest:daemon
npm run google:auth
```
