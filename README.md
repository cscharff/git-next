# git.next

Insight providers over Git repos stored in Cloudflare Artifacts. A local TypeScript Worker reads trees,
blobs and commits through the `ARTIFACTS` binding and runs pluggable providers that return structured `Insight`s.

## Run

```bash
npm install
npm test        # vitest: parsers, extractor, resolver, providers
npm run dev     # cf dev on localhost:5173, reads real repos (remote binding, namespace "default")
```

- `GET /` — dashboard (instruction stack, resource map, cost per agent, sliced context); falls back to `samples/`
- `GET /insights?repo=<name>&ref=<branch|sha>[&base=<ref>][&providers=a,b]`
- `POST /context {"repo","ref","task","paths":[],"budgetTokens"}` — rules for those paths + best sections within budget
- `GET /providers`, `GET /samples/<name>.json`

The Worker has no caller authentication yet, so keep it to local dev.

## Layout

- `src/core`: `Insight`/`InsightProvider` types, `RepoContext` (per-ref tree cache plus blob-hash content cache),
  `artifactsSource` (ref → commit → tree walk over the binding) and `ProviderRegistry`.
- `src/providers/resource-map.ts`: finds every `wrangler.toml|json|jsonc`, lists the Worker name and bindings by type,
  and diffs bindings against `?base=` (added / removed / unchanged). No live account lookups yet.
- `src/providers/instruction-stack`: collects `AGENTS.md`/`CLAUDE.md` (project layer, rank 3) plus layers in
  `.gitnext/stack.json` (`{"layers":[{"name","kind","rank","repo","path"}]}`). Precedence is by layer rank:
  org 1 > contract 2 > project 3 > tool 4 > personal 5. Nesting depth only orders project files, deeper winning.
  Strength only matters for conflicts: two disagreeing "must" rules conflict regardless of rank. It extracts rules for fixed topics with a
  deterministic keyword extractor (`RuleExtractor`, which an LLM extractor can replace), then resolves them into
  overridden / conflict / drift findings. Drift compares instructions against config files (`package.json`
  `packageManager`, lockfiles, `.oxfmtrc.json`, `.prettierrc`, `biome.json`, `.editorconfig`).

- `src/providers/context`: splits markdown into heading sections and ranks them with BM25 behind a `Retriever`
  interface (`Embedder` + `VectorRetriever` ready for Workers AI EmbeddingGemma / Vectorize). Packs the best sections
  into the budget after the resolved rules, caps any one section at 35% of the budget, and returns a manifest of what
  was omitted plus `tokensServed` vs `tokensAllMarkdown` and vs the instruction files on the path.
- `src/providers/cost`: parses AI Gateway log records (metadata keys `developer`, `repo`, `fork`, `agent`, `task`), rolls
  spend up project → developer → fork → agent → task, flags developers/agents above 2× the median, and prices
  mechanical tasks on cheaper tiers (`FIT_RULES`). Reads `fixtures/ai-gateway-logs.json` for now; the logs API call is a TODO.
- `public/index.html`: the dashboard, served as a static asset by the same Worker.

## Samples

- `samples/insights-agents-demo-full-main.json`: live run against `agents-demo-full@main`.
- `samples/resource-map-diff-agents-demo-full.json`: `main` diffed against a commit 300 first-parent commits back.
- `samples/insights-demo.json`: every provider offline (`node scripts/demo-insights.ts <checkout> <base-sha>`), with the
  demo layers and the cost fixture. The dashboard's default data.
- `samples/context-agents-demo-full.json`: `/context` for three example tasks (`node scripts/demo-context.ts <checkout>`).
- `samples/instruction-stack-demo-layers.json`: offline run over the repo's real instruction and config files plus the
  hypothetical layers in `fixtures/demo-layers` (`node scripts/demo-stack.ts <checkout>`).
