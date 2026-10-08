# PII-regulated profile

Applies to every repo whose `.gitnext/app.json` (or the org registry) says `"class": "pii-regulated"`.
It sits at org rank, alongside the org layer.

## Models

- Only use approved models for this class: anthropic/claude-sonnet-5.5 for code and review, @cf/zai-org/glm-5.3-flash for summaries and extraction. No other model may see this repo's code or data.
- Every model call must go through the org AI Gateway with guardrails on (prompt and response DLP).

## Data

- Personal data must stay in the EU: R2 buckets and D1 databases use the `eu` jurisdiction.
- Never log request bodies, uploaded file contents, email addresses or names.
- Never write personal data into fixtures, tests or examples; use generated fake data.

## Review

- Any change to migrations, schemas, storage, upload handling or wrangler bindings needs a human reviewer before merge.
- Always run security-scan before every push.
