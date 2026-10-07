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

## `git next` CLI

The same providers as a git subcommand, for people and for agents (`--json`). Requires Node 23.6+.

```bash
npm link                         # puts git-next on PATH; git runs it as `git next`
git next rules [paths...]        # layers, winning rules, conflicts/drift with file:line; exit 1 on conflict
git next rules --layers ~/acme/.gitnext/stack.json packages/api/src/index.ts
git next resources --base origin/main --strict   # Workers + bindings, diff from local git objects; exit 1 if bindings added
git next context "fix the reconnect loop" src/mcp/client.ts --budget 4000 [--print]
git next cost [--fork chris/mcp-reconnect] [--verbose]   # gateway logs via .dev.vars, else the fixture
git next rules --remote agents-demo-full --layers demo   # ask the local Worker about an Artifacts repo instead
```

By default it reads the working tree (tracked and untracked files, minus ignored ones); `--ref` reads a commit from
local git objects. `--layers <stack.json>` adds layers whose `path`s are resolved from the stack file's project folder
(the folder holding `.gitnext/`). Exit codes: 0 clean, 1 blocking findings, 2 usage or runtime error.
`examples/hooks/pre-push` runs `git next rules --quiet` before every push (and optionally `resources --strict`).

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
  mechanical tasks on cheaper tiers (`FIT_RULES`). Reads the `git-next` AI Gateway's logs API when `CF_ACCOUNT_ID` and
  `AIG_LOGS_TOKEN` (AI Gateway Read) are set in `.dev.vars` (see `.dev.vars.example`); otherwise `fixtures/ai-gateway-logs.json`.
- `POST /dev/gateway-smoke` (localhost only): one tiny call each to `anthropic/claude-haiku-4.5` (unified billing) and
  `@cf/zai-org/glm-5.3-flash` through the gateway, max 50 output tokens, tagged with the cost metadata keys.
- `public/index.html`: the dashboard, served as a static asset by the same Worker.
- `src/cli`: the `git next` CLI (`bin/git-next.ts`); `git-source.ts` reads the working tree or local git objects.

## Samples

- `samples/insights-agents-demo-full-main.json`: live run against `agents-demo-full@main`.
- `samples/resource-map-diff-agents-demo-full.json`: `main` diffed against a commit 300 first-parent commits back.
- `samples/insights-demo.json`: live `/insights?...&layers=demo` (demo layers overlaid, cost fixture); identical to the
  offline `node scripts/demo-insights.ts <checkout> <base-sha>`. The dashboard's default data.
- `samples/context-agents-demo-full.json`: live `/context` for three example tasks; identical to `node scripts/demo-context.ts <checkout>`.

`layers=demo` (query param on `/insights`, body field on `/context`) only works on localhost: it serves
`fixtures/demo-layers` as the `git-next-demo-layers` repo and overlays its `stack.json`, so nothing is pushed to the analysed repo.
- `samples/instruction-stack-demo-layers.json`: offline run over the repo's real instruction and config files plus the
  hypothetical layers in `fixtures/demo-layers` (`node scripts/demo-stack.ts <checkout>`).
