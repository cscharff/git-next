# git.next demo video: shot list (target 9:25)

Format: screen recording with voice-over. Two windows: the dashboard at `http://localhost:5173` (browser, about
1440 px wide) and a terminal in `~/code/gitnext/git-next`, plus a second terminal tab for a scratch clone. Timings
are cumulative. Narration is written to be read aloud; trim to taste.

## Pre-recording checklist

1. **Sign-in and secrets.** `npx cf auth whoami` shows the right account. `.dev.vars` has `CF_ACCOUNT_ID` and
   `AIG_LOGS_TOKEN`. Never show `.dev.vars` on screen or `cat` it.
2. **Fresh forks (optional).** Re-runs add new commits on top of the existing forks. For a clean history, delete
   the three forks first. This is destructive and irreversible, so check the names before running:
   `npx cf artifacts namespaces repos delete agents-demo-docs --namespace default` (and the same for
   `agents-demo-r2` and `agents-demo-mcp`). The script recreates them.
3. **Clear dev state.** Stop any running `cf dev`, then `rm -rf .cloudflare/state` (local miniflare state only;
   it's gitignored) and `npm run dev`. Wait for "Local:" and open `http://localhost:5173`.
4. **Re-run the agents before recording** so every number on screen is fresh:
   `node scripts/demo-agents.ts --budget-usd 10`. Expect 3/3 pushed, mcp-agent "hook blocked, resolved", and about
   $0.11. Then reload the dashboard. (To record the run itself live, skip this and do it in shot 4.)
5. **Scratch clone for the CLI shots**, in a second terminal tab:
   `mkdir -p /tmp/gn && cd /tmp/gn && git clone -q https://github.com/cloudflare/agents agents-demo-full`. Then
   `cd agents-demo-full`. (This is the same content as the Artifacts repo; cloning from GitHub keeps tokens off screen.)
6. **`npm link`** once, then check that `git next --help` works in the scratch clone.
7. **Pre-push hook and a local push target in the scratch clone:**
   `cp ~/code/gitnext/git-next/examples/hooks/pre-push .git/hooks/`, then
   `git clone -q --bare --single-branch --branch main https://github.com/cloudflare/agents /tmp/gn/remote.git && git remote add demo /tmp/gn/remote.git`.
   Pushing to GitHub would fail on permissions before the hook runs; the local bare repo lets the hook run for real.
8. **New-repo demo.** Run `node scripts/demo-new-repo.ts --keep` once (about $0.08; capped at $0.50 across all runs)
   so both repos exist in `$TMPDIR/git-next-demo-new-repo/`. For the shot, `--recheck` repeats the pushes and checks
   without new model calls.
9. **Screen hygiene.** Use dark theme, a large terminal font, and close notifications. Account IDs appear in
   Artifacts remote URLs; blur them in post or keep them off screen.

## Shot list

### 1. The problem: 0:00–0:50
- **Screen:** an editor with five files side by side: `fixtures/demo-layers/org/AGENTS.md`,
  `fixtures/demo-layers/contract/AGENTS.md`, the repo's root `AGENTS.md`, `packages/agents/AGENTS.md`,
  `fixtures/demo-layers/personal/AGENTS.md`.
- **Narration:** "In a real company, an agent writing code takes orders from five places at once: org security
  standards, a client contract, the project's AGENTS.md files at different depths, the coding tool's defaults, and
  the developer's own preferences. They disagree, nobody sees the whole stack, and Git versions only the code. The
  instructions, the infrastructure and the spend around it go unversioned."

### 2. Import a real repo into Artifacts: 0:50–1:40
- **Terminal:** run `npx cf artifacts namespaces repos get agents-demo-full --namespace default` (blur the remote
  URL's account id). Then show the README's "Artifacts namespace and the demo repo" block with the create + push
  commands; don't re-run the push.
- **Narration:** "We imported cloudflare/agents into Cloudflare Artifacts: 1,699 commits, 128 Worker configs,
  nine AGENTS.md files. Artifacts repos are real Git remotes, and they fork in seconds, which matters once every
  agent gets its own fork. Tokens are short-lived and only ever passed in environment variables."
- **Dashboard:** the fork selector set to "agents-demo-full (sample)".

### 3. The instruction stack: 1:40–2:50
- **Dashboard → Instruction stack panel.** Expand "Layers": org 1, contract 2, project 3.0–3.5, tool 4,
  personal 5. In "Winning rules for", select `.` then `packages/agents`.
- **Narration:** "git.next resolves the stack. Lower rank wins; inside the project, deeper files win. Here pnpm and
  oxfmt come from the project, while the secrets rule and the approved-model rule come from the org layer, even
  though the developer prefers npm and Prettier."
- **Point at Findings:** two red "conflict: changesetPolicy" entries ("sow-1234 [contract] says not-required but
  root [project] AGENTS.md:144 says required; both are hard requirements") and the amber "policy overridden:
  allowedModels" (agent-think uses gpt-5.6-sol, which isn't an approved provider).
- **Narration:** "Two hard requirements that disagree are a conflict, whatever their rank. git.next shows the exact
  file and line on both sides. It also catches a policy violation: one agent is configured for a model from a
  provider the org hasn't approved."

### 4. Three agents on three forks: 2:50–4:00
- **Terminal** (live, if you skipped checklist step 4): `node scripts/demo-agents.ts`. Show the interleaved lines:
  "forked/reusing", "context: 3000 tokens served … of 889608", "model anthropic/claude-opus-4.8 …", "pushed …".
- **Dashboard:** reload. Show the **Demo agents** panel (full width): 3/3 pushed, the model per agent, context
  tokens (served / on path / all markdown), cost, pre-push result, commit message `SOW-1042: …`.
- **Narration:** "Three agents work in parallel, each on its own fork. Before calling a model, each one asks
  git.next for its context: the resolved rules for the files it will touch, and the best doc sections within a
  3,000-token budget. That's about a third of a percent of the repo's 890,000 tokens of markdown. Each model call
  goes through our AI Gateway, tagged with developer, fork, agent and task."
- **Optional cut-in:** `curl -s -X POST localhost:5173/context …` from the README "Using it" section, piped into
  `| jq '.stats'`.

### 5. Resource map diff: the new R2 bucket: 4:00–4:50
- **Dashboard:** fork selector → `agents-demo-r2 (r2-agent)`. In the **Resource map** panel, tick "changed only".
  Show `r2-uploads` with the badge **new** and `r2_buckets: 1` (hover for `UPLOADS → agents-demo-uploads`).
- **Narration:** "The r2-agent added an example, and with it a new R2 bucket binding. git.next reads every
  wrangler config in the fork and diffs it against where the fork started. You can see infrastructure change in
  review, before anyone deploys it. The bucket doesn't exist yet; the diff is what tells you someone will need it."

### 6. Cost and model fit: 4:50–5:40
- **Dashboard:** fork selector → `agents-demo-docs (docs-agent)`. **Cost per agent panel:** docs-agent about $0.05
  on claude-opus-4.8, and the "Model fit" line "docs: anthropic/claude-opus-4.8 → @cf/moonshotai/kimi-k2.7-code,
  save $0.04". Switch back to agents-demo-full to show "By fork".
- **Narration:** "Costs come straight from the gateway logs, rolled up by developer, fork, agent and task. The docs
  agent used Opus to fix one table cell. git.next notices and suggests a mid-tier coding model for well-scoped docs
  work. Across a team that's real money, and the same data flags anyone spending more than twice the median."

### 7. The pre-push hook blocks, then resolves: 5:40–6:40
- **Dashboard → Demo agents → "Why mcp-agent was blocked"** (expand). The conflict text, then the resolution line.
- **Terminal** (scratch clone): make a comment-only edit under `packages/agents/src/mcp/abort.ts`, then
  `git commit -qam "SOW-1042: tidy comment"` and
  `GIT_NEXT_LAYERS=~/code/gitnext/git-next/fixtures/demo-layers/.gitnext/stack.json git push --dry-run demo HEAD:main`.
  The hook prints "✗ 2 conflict(s)" and blocks (exit 1).
  (`--dry-run` still runs the pre-push hook, and the local `demo` remote is never changed.)
- Then `GIT_NEXT_LAYERS=~/code/gitnext/git-next/fixtures/demo-layers-resolved/.gitnext/stack.json git push --dry-run demo HEAD:main`,
  which passes (`000d076d..<sha>  HEAD -> main`). Show `diff fixtures/demo-layers/contract/AGENTS.md fixtures/demo-layers-resolved/contract/AGENTS.md`.
- **Narration:** "The hook checks only the files you're pushing. The docs and examples agents sailed through. The
  MCP agent touched packages/, where the contract says skip changesets and the project says always add one. The
  push is blocked with both sources cited. The fix is a human decision: amend the contract layer to defer to the
  project, and the same push goes through."

### 8. New repositories, smart by default: 6:40–8:10
- **Terminal** (`cd $TMPDIR`): `git next new uploads-api --template worker-api --remote`. Show the dry-run note
  (the Artifacts fork isn't created yet), then the summary: layers pinned at a content hash, catalog 2026.10.2,
  files, hook installed, "rules ✓".
- **Editor:** `uploads-api/AGENTS.md` (the "Project rules" blanks and the pinned inherited musts) and
  `.gitnext/catalog.json` (scroll to the R2 entry: naming `acme-*`, shared `UPLOADS → acme-shared-uploads`, owner,
  "how to bind").
- **Terminal:** `cd uploads-api && git next context "add an endpoint that stores uploaded files" src/index.ts --budget 1500`.
  Point at "Pinned (always loaded)" and "For this task: … UPLOADS → acme-shared-uploads".
- **Narration:** "Most repos start empty and learn the org's rules from review comments. `git next new` starts a
  repo already knowing them: the org, contract and tool layers pinned to a version, the org's catalog of approved
  models, resources and tools, secure defaults, and the hook. Ask for context about uploads and the approved bucket
  comes with it."
- **Terminal, the payoff** (from `samples/new-repo-demo/summary.json`, or the end of `node scripts/demo-new-repo.ts --recheck`):
  two agents, same model, same prompt. The plain repo: "3 finding(s) at first push; push BLOCKED". Unapproved
  model `@cf/meta/llama-3.1-8b-instruct`, a model call that bypasses the org gateway, and bucket `uploads-bare`,
  which isn't in the catalog, with the fix suggested ("use the shared UPLOADS → acme-shared-uploads"). The
  `git next new` repo: "0 finding(s); push went through", using glm-5.3-flash through the gateway, the shared bucket,
  `wrangler secret` for the key, and a `SOW-1234:` commit.
- **Narration:** "Same agent, same model, same prompt. In the plain repo it picks an unapproved model, calls it
  directly and invents a bucket, and the first push is blocked with the approved alternatives. In the repo made with
  git next, it gets about a thousand tokens of pinned rules and catalog, and its first push is clean."
- **Optional cut-in:** `cat $TMPDIR/git-next-demo-new-repo/uploads-bare/wrangler.toml` next to
  `.../uploads-smart/wrangler.jsonc`.

### 9. The `git next` CLI: 8:10–8:40
- **Terminal** (scratch clone):
  - `git next rules --layers ~/code/gitnext/git-next/fixtures/demo-layers/.gitnext/stack.json packages/agents/src/mcp/client.ts`
  - `git next context "Fix MCP client reconnect when the transport drops" packages/agents/src/mcp/client.ts --budget 2000`
  - `git next rules --layers … --json | jq '.conflicts[0]'`
- **Narration:** "Everything is also a git subcommand. Use it as a person, in a hook, or as an agent with --json.
  It reads your working tree and local history, or asks the Worker about any Artifacts repo with --remote."

### 10. Extensibility: a small provider in a few lines: 8:40–9:00
- **Editor:** `src/providers/owners.ts` (scroll the `analyze` function) and the one-line `.register(ownersProvider)`
  in `src/registry.ts`. **Terminal:** `curl -s localhost:5173/providers | jq '.[].id'` shows `owners`.
- **Narration:** "Each insight comes from a small provider with one interface. This one checks that every
  AGENTS.md has a code owner; cloudflare/agents doesn't have a CODEOWNERS file, so the rulebooks have no reviewers.
  Add a file, register it, and it's in the API, the dashboard data and the CLI."

### 11. Close: 9:00–9:25
- **Dashboard:** slow pan across all panels on agents-demo-full, ending on the Demo agents panel.
- **Narration:** "git.next: Git that versions the context and infrastructure around code. Built on Cloudflare
  Artifacts, Workers and AI Gateway. Three agents and three forks, every rule traced to a line, every binding
  diffed, every model call costed, and new repos that follow the org from their first line. MIT licensed."

## Command reference (copy-paste)

```bash
npm run dev
node scripts/demo-agents.ts --budget-usd 10
node scripts/demo-agents.ts --insights-only          # refresh dashboard data without model calls
curl -s localhost:5173/providers | jq '.[].id'
curl -s 'localhost:5173/insights?repo=agents-demo-r2&ref=main&base=000d076d535b8bf53ac66b2c86c4c83c5a95d8c7&providers=resource-map' | jq '[.insights[] | select(.severity=="warn") | .title]'
git next rules --layers ~/code/gitnext/git-next/fixtures/demo-layers/.gitnext/stack.json packages/agents/src/mcp/client.ts
git next resources --base HEAD~300 --strict; echo $?
git next cost --verbose
git next new uploads-api --template worker-api --remote
git next context "add an endpoint that stores uploaded files" src/index.ts --budget 1500
node scripts/demo-new-repo.ts --recheck              # re-run the plain-vs-smart pushes without model calls
```
