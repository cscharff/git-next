# git.next

Insight providers over Git repos stored in Cloudflare Artifacts. A local TypeScript Worker reads trees,
blobs and commits through the `ARTIFACTS` binding and runs pluggable providers that return structured `Insight`s.

## Run

```bash
npm install
npm test        # vitest: parsers, extractor, resolver, providers
npm run dev     # cf dev on localhost:5173, reads real repos (remote binding, namespace "default")
```

- `GET /insights?repo=<name>&ref=<branch|sha>[&base=<ref>][&providers=a,b]`
- `GET /providers`

The Worker has no caller authentication yet, so keep it to local dev.

## Layout

- `src/core`: `Insight`/`InsightProvider` types, `RepoContext` (per-ref tree cache plus blob-hash content cache),
  `artifactsSource` (ref → commit → tree walk over the binding) and `ProviderRegistry`.
- `src/providers/resource-map.ts`: finds every `wrangler.toml|json|jsonc`, lists the Worker name and bindings by type,
  and diffs bindings against `?base=` (added / removed / unchanged). No live account lookups yet.
- `src/providers/instruction-stack`: collects `AGENTS.md`/`CLAUDE.md` (deeper = higher rank) plus layers in
  `.gitnext/stack.json` (`{"layers":[{"name","rank","repo","path"}]}`). It extracts rules for fixed topics with a
  deterministic keyword extractor (`RuleExtractor`, which an LLM extractor can replace), then resolves them into
  overridden / conflict / drift findings. Drift compares instructions against config files (`package.json`
  `packageManager`, lockfiles, `.oxfmtrc.json`, `.prettierrc`, `biome.json`, `.editorconfig`).

## Samples

- `samples/insights-agents-demo-full-main.json`: live run against `agents-demo-full@main`.
- `samples/resource-map-diff-agents-demo-full.json`: `main` diffed against a commit 300 first-parent commits back.
- `samples/instruction-stack-simulated-org.json`: offline run over the repo's real instruction/config files plus a
  hypothetical org layer (`scripts/simulate-org-layer.ts`), to show conflict output.
