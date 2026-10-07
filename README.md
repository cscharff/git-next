# git.next

**Git that versions the context and infrastructure around code, not just the code.**

In a real organization, an AI agent editing a repo is steered by a stack of instructions it never sees all at once:
org security standards, a client contract, the project's `AGENTS.md` files at several depths, the coding tool's
defaults and the developer's own preferences. Those layers disagree. The repo also declares cloud resources
(Workers, buckets, queues, Durable Objects) that change quietly in forks, and every agent run spends money on models
that may be oversized for the task. git.next runs on Cloudflare Artifacts (Git repos you can fork cheaply and read
from a Worker). It turns each of those into something you can query, diff and gate: which instruction wins for a
file and why, which instructions conflict, what a fork changed in its infrastructure, what each agent cost, and the
smallest slice of context an agent needs for a task. You get it as a JSON API, a dashboard, a `git next` command,
and a pre-push hook that blocks pushes governed by conflicting rules.

The demo uses [cloudflare/agents](https://github.com/cloudflare/agents) (MIT, 1,699 commits, 128 Worker configs,
9 `AGENTS.md` files) imported into Artifacts as `agents-demo-full`, plus three agent forks.

## Contents

- [Architecture](#architecture)
- [Setup from a clean machine](#setup-from-a-clean-machine)
- [Using it](#using-it)
- [Writing a provider](#writing-a-provider)
- [Secrets](#secrets)
- [Known limits](#known-limits)
- [Repository layout](#repository-layout)
- [License](#license)

## Architecture

```
            cloudflare/agents (GitHub)
                     │ import (create + git push for large repos)
                     ▼
   ┌──────── Cloudflare Artifacts (namespace "default") ────────┐
   │ agents-demo-full ──fork──► agents-demo-docs / -r2 / -mcp   │
   └──────────────┬─────────────────────────────────────────────┘
                  │ ARTIFACTS binding: log → readTree → readBlob
                  ▼
   ┌──────────── git.next Worker (resolver) ─────────────┐        ┌───────────────────┐
   │ RepoContext (tree cache + blob-hash content cache)  │◄──────►│ AI Gateway        │
   │ ProviderRegistry → InsightProvider[]                │  logs  │ "git-next"        │
   │   resource-map · instruction-stack · cost · owners  │  API   │ (auth + unified   │
   │ context slicer (BM25 now, embeddings later)         │        │  billing, metadata│
   │ GET /insights · POST /context · dashboard (assets)  │        │  per request)     │
   └──────────────┬──────────────────────────────────────┘        └────────▲──────────┘
                  │ same providers, local git objects                      │ tagged model calls
                  ▼                                                        │
   `git next` CLI · pre-push hook · scripts/demo-agents.ts ────────────────┘
```

- **Artifacts repos and forks.** Every repo, including forks for agents, is an Artifacts repo. The Worker reads it
  through the `ARTIFACTS` binding (ref → commit → tree walk → blobs). No checkout is needed, and nothing is written
  back except by the agents' own `git push`.
- **Resolver Worker.** `src/index.ts` builds a `RepoContext` per request. `GET /insights?repo=&ref=&base=` runs every
  registered provider, and `POST /context` builds a task-sized context. The dashboard (`public/index.html`) is served
  as a static asset by the same Worker.
- **`InsightProvider` interface** (`src/core/types.ts`): `{ id, title, needs, analyze(ctx) → Insight[] }`. An
  `Insight` has a severity (`info | warn | conflict`), a scope (repo, ref, path, agent), a title, detail,
  `evidence[]` as `{repo, path, line}`, and free-form metrics. The registry runs providers in parallel and isolates
  failures, so one failing provider doesn't fail the others.
- **The providers.**
  1. **Instruction stack** collects `AGENTS.md`/`CLAUDE.md` (the project layer) plus layers listed in
     `.gitnext/stack.json`. Precedence: org 1 > contract 2 > project 3 > tool 4 > personal 5, with deeper project
     files winning within rank 3. It extracts rules for fixed topics: package manager, formatter, indentation, test
     command, commit format, changeset policy, lint strictness, allowed models, secrets and security scans. It then
     reports **overridden** rules, **conflicts** (two disagreeing "musts", or peers that disagree), policy violations
     (for example a model from a provider that isn't approved), and **drift** between instructions and config files.
     The extractor is deterministic and sits behind a `RuleExtractor` interface, so an LLM extractor can replace it.
  2. **Resource map** parses every `wrangler.toml|json|jsonc` (with its own TOML and JSONC parsers). It lists each
     Worker's bindings across 13 types and, with `?base=`, diffs them (added, removed, unchanged, new or removed config).
  3. **Cost** parses AI Gateway logs, rolls spend up project → developer → fork → agent → task, flags anyone above
     2× the median, and suggests cheaper models for mechanical or well-scoped tasks with an estimated saving.
  4. **Owners** (the stub, see [Writing a provider](#writing-a-provider)) reports instruction files that no
     CODEOWNERS rule covers.
  - **Sliced context** (`src/providers/context`) is the resolved rules for the touched paths, plus the
    best-matching markdown sections within a token budget, plus a manifest of what was left out. It uses BM25 behind
    `Retriever`/`Embedder` interfaces, ready for Workers AI EmbeddingGemma + Vectorize. On cloudflare/agents it
    serves about 3,000–4,000 tokens out of 889,608 tokens of markdown.
- **Dashboard** has panels for the instruction stack, resource map with diff badges, cost per agent, sliced context
  and the demo agents. A fork selector switches between agents-demo-full and the forks. It loads bundled samples
  until you press "Run live".
- **`git next` CLI** (`bin/git-next.ts`) runs the same providers over your working tree or local git objects, or
  asks the Worker with `--remote`. `examples/hooks/pre-push` uses it to block pushes.

## Setup from a clean machine

You need Node 23.6 or later (it runs TypeScript directly), git, and a Cloudflare account with Artifacts and AI
Gateway. The `cf` CLI comes in as a dev dependency, so every command below works as `npx cf …`.

```bash
git clone <this repo> git-next && cd git-next
npm install
npx cf auth login            # browser sign-in
npx cf auth whoami           # check the account before creating anything
npm test                     # 64 unit tests; no network
```

### 1. Artifacts namespace and the demo repo

The Worker binds the `default` namespace (`cloudflare.config.ts`). Check it exists, and create it if it doesn't:

```bash
npx cf artifacts namespaces list
npx cf artifacts namespaces create --namespace default
```

Small repos can be imported directly:

```bash
npx cf artifacts namespaces repos import my-repo --namespace default --url https://github.com/owner/repo --branch main
```

For a large repo with full history, the import can fail ("upstream service is unavailable" for cloudflare/agents).
Create an empty repo and push to it instead. The write token goes only into environment variables, never into a
URL, git config or a file:

```bash
npx cf artifacts namespaces repos create default --name agents-demo-full --default-branch main
REMOTE=$(npx cf artifacts namespaces repos get agents-demo-full --namespace default | node -pe 'JSON.parse(require("fs").readFileSync(0)).remote')
git clone --single-branch --branch main https://github.com/cloudflare/agents /tmp/agents
TOKEN=$(npx cf artifacts namespaces tokens create default --repo agents-demo-full --scope write --ttl 900 | node -pe 'JSON.parse(require("fs").readFileSync(0)).plaintext')
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $TOKEN" \
  git -C /tmp/agents push "$REMOTE" main:main
unset TOKEN
```

### 2. AI Gateway (for real costs and the demo agents)

Create one gateway with logs on and **authentication on**. Unified billing requires authentication, and it also
stops anyone who knows the URL from spending your credits:

```bash
npx cf ai-gateway gateways create --body '{"id":"git-next","collect_logs":true,"authentication":true,"cache_invalidate_on_update":true,"cache_ttl":0,"rate_limiting_interval":0,"rate_limiting_limit":0,"rate_limiting_technique":"fixed"}'
```

Then, in the Cloudflare dashboard (these steps are manual):

1. **Unified billing credits.** Go to AI Gateway → Credits and top up if needed (a 5% fee applies). Claude calls
   through the gateway draw from these credits. The demo run cost about $0.11.
2. **Read-only logs token.** Go to My Profile → API Tokens → Create Token → Custom token. Set Permissions to
   **Account → AI Gateway → Read** and Account resources to your account; a short TTL is a good idea. Copy
   `.dev.vars.example` to `.dev.vars` (gitignored) and fill in `CF_ACCOUNT_ID` and `AIG_LOGS_TOKEN`. Without it,
   the cost provider uses `fixtures/ai-gateway-logs.json`.

### 3. Run it

```bash
npm run dev                  # cf dev on http://localhost:5173 with remote ARTIFACTS + AI bindings
open http://localhost:5173   # dashboard
npm link                     # optional: puts git-next on PATH so `git next` works
git next --help
node scripts/demo-agents.ts  # forks + three agents (needs the dev server and .dev.vars; capped at --budget-usd 10)
```

Nothing here deploys anything. The Worker is meant for local dev: `/insights` and `/context` have no caller
authentication yet, and the `/dev/*` routes (which mint repo tokens and spend model credits) only answer on localhost.

## Using it

**API** (local Worker):

```bash
curl 'localhost:5173/insights?repo=agents-demo-full&ref=main&layers=demo'
curl 'localhost:5173/insights?repo=agents-demo-r2&ref=main&base=000d076d535b8bf53ac66b2c86c4c83c5a95d8c7&providers=resource-map'
curl -X POST localhost:5173/context -H 'content-type: application/json' \
  -d '{"repo":"agents-demo-full","ref":"main","task":"Fix MCP client reconnect when the transport drops","paths":["packages/agents/src/mcp/client.ts"],"budgetTokens":4000,"layers":"demo"}'
```

`layers=demo` (localhost only) overlays the hypothetical org, contract, tool and personal layers from
`fixtures/demo-layers` without pushing anything to the repo being analysed.

**CLI.** Run inside any git checkout. Add `--json` for agents. Exit codes: 0 clean, 1 blocking findings, 2 error.

```bash
git next rules [paths...] [--layers <stack.json>]      # layers, winners, conflicts/drift with file:line; exit 1 on conflict
git next resources --base origin/main [--strict]       # Workers + bindings diff from local git objects; --strict exits 1 on additions
git next context "<task>" [paths...] [--budget 4000] [--print]
git next cost [--fork <name>] [--verbose]              # gateway logs via .dev.vars, else the fixture
git next rules --remote agents-demo-full --layers demo # ask the Worker about an Artifacts repo instead
```

**Pre-push hook.** Run `cp examples/hooks/pre-push .git/hooks/` in any repo. It runs `git next rules` on the files
the push changes (set `GIT_NEXT_LAYERS=<stack.json>` to include org layers). `GIT_NEXT_STRICT_RESOURCES=1` also
blocks pushes that add Cloudflare bindings.

**Demo agents.** `scripts/demo-agents.ts` forks `agents-demo-full` into `agents-demo-docs`, `agents-demo-r2` and
`agents-demo-mcp` (reusing them if they exist), then runs three agents in parallel. Each one gets a sliced context,
makes one Claude call through the gateway tagged `developer/repo/fork/agent/task`, applies the edits, commits
`SOW-1042: …` and pushes through the hook. mcp-agent is blocked by the contract-vs-project changeset conflict, then
retried with `fixtures/demo-layers-resolved`. Results go to `samples/demo-run/`. `--only <agent>` re-runs one agent,
and `--insights-only` refreshes the samples without model calls.

## Writing a provider

A provider is an object with an `id`, a `title`, the inputs it `needs`, and an `analyze` function that returns
`Insight[]`. `src/providers/owners.ts` is the worked example, a complete fifth provider in about 60 lines. It
reports `AGENTS.md`/`CLAUDE.md` files that no CODEOWNERS rule covers. Its core:

```ts
export const ownersProvider: InsightProvider = {
	id: "owners",
	title: "Instruction file owners",
	needs: ["tree", "files"],
	async analyze({ repo, ref, files }) {
		const [codeowners] = await files.find(repo, ref, (p) => /^(\.github\/|docs\/)?CODEOWNERS$/.test(p));
		const instructionFiles = await files.find(repo, ref, isInstructionFile);
		const rules = parseCodeowners((await files.readFile(repo, ref, codeowners.path)) ?? "");
		return instructionFiles
			.filter((f) => ownersOf(rules, f.path).length === 0)
			.map((f) => ({ provider: "owners", severity: "warn", scope: { repo, ref, path: f.path }, title: `Unowned instruction file: ${f.path}`, detail: "…", evidence: [{ repo, path: f.path }] }));
	},
};
```

Register it in one line in `src/registry.ts`:

```ts
new ProviderRegistry().register(resourceMapProvider).register(instructionStackProvider()).register(costProvider(cost)).register(ownersProvider);
```

It then appears in `GET /providers`, runs in every `/insights` call, and works offline. `RepoContext` handles reads
and caching for any source: Artifacts in the Worker, local git in the CLI, in-memory in tests (`memorySource`), so
`test/owners.test.ts` tests it with no network.

## Secrets

- **Never in source, git config, remote URLs or logs.** Repo tokens are short-lived (≤ 30 min), minted per use, and
  passed to git only through `GIT_CONFIG_COUNT/KEY_0/VALUE_0` (`http.extraHeader`). Scripts redact `Bearer …` from
  anything they record.
- **`.dev.vars` is gitignored** (so are `.env*` and `.cloudflare/`, which holds local trace data). Only
  `.dev.vars.example`, with empty values, is committed. The logs token is read-only, scoped to AI Gateway Read on
  one account.
- **The gateway requires authentication.** Model calls go through the Worker's AI binding, so no provider API keys
  exist anywhere.
- **Local-only routes.** `/dev/fork`, `/dev/token`, `/dev/llm` and `/dev/gateway-smoke` refuse non-localhost
  requests and must not be deployed as they are.

## Known limits

- **Instruction extraction is heuristic.** It looks for keywords on fixed topics. "Defer to the project" is
  understood, but rules about other topics, or phrased unusually, are missed. The `RuleExtractor` interface exists
  so an LLM extractor can replace it.
- **Area qualifiers** ("examples and guides don't need changesets") map words to top-level directories only.
- **Remote rules.** In `--remote` mode, winners for an arbitrary path use the nearest directory that has an
  instruction file.
- **Resource map** reads top-level config only (no `env.*` overrides), shows configs without `name` as
  "(unnamed)", and matches configs by path, so a moved config appears as one removal plus one addition. No live
  account lookups.
- **Context retrieval is BM25.** It re-indexes markdown on every request (about 10–15 s for 278 files over the
  binding). Embeddings and a persistent index (Vectorize) are the next step.
- **Cost.** Model-fit prices for Anthropic and OpenAI models in `MODELS` are illustrative; actual costs come from
  the gateway logs. The 2× median flag needs a few developers or agents to mean anything.
- **Artifacts.** Full-history import of large repos failed, hence create + push. Concurrent `fork()` calls returned
  internal errors, so the script forks sequentially. In `cf dev`, the remote bindings occasionally drop a request
  ("Network connection lost"); retry it. The demo script retries `/context` automatically.
- **Not deployed.** There's no auth on the API, and the dashboard and Worker are local-dev only.

## Repository layout

| Path | What |
| --- | --- |
| `src/core` | `Insight`/`InsightProvider`, `RepoContext`, `artifactsSource`, `ProviderRegistry` |
| `src/providers` | `instruction-stack/`, `resource-map.ts`, `cost/`, `context/`, `owners.ts` |
| `src/parse` | JSONC and minimal TOML parsers |
| `src/index.ts`, `src/dev-routes.ts` | Worker routes (`/insights`, `/context`, samples, localhost-only `/dev/*`) |
| `src/cli`, `bin/git-next.ts` | the `git next` CLI |
| `public/index.html` | dashboard |
| `scripts/` | `demo-agents.ts`, offline sample generators (`demo-insights.ts`, `demo-context.ts`, `demo-stack.ts`) |
| `fixtures/` | demo instruction layers (and the resolved variant), AI Gateway log fixture |
| `samples/` | live outputs the dashboard falls back to; `samples/demo-run/` is the last agent run |
| `examples/hooks/pre-push` | the git hook |
| `docs/VIDEO_SCRIPT.md` | demo video shot list |
| `test/` | vitest suites (parsers, providers, resolver, context, cost, CLI, owners) |

## License

MIT, see [LICENSE](LICENSE). The demo content is [cloudflare/agents](https://github.com/cloudflare/agents), also MIT.
