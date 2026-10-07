# git.next demo video: shot list (target 8:40)

**Approach: big thing first.** The dashboard is the product on screen. Beat 1 is the rules in force for an existing
project, beat 2 is rules for a new project, and beat 3 is cost and overspend. Terminal work appears only as small
insets that *feed* the dashboard (an agent pushes → the dashboard updates). It's never the subject of a shot.

Screen layout: the browser full screen on the dashboard (the deployed URL behind Cloudflare Access, or
`http://localhost:5173`), about 1440 px wide, dark theme. A small terminal window sits bottom-right for insets and stays
hidden otherwise. Timings are cumulative; narration is written to be read aloud.

## Pre-recording checklist

1. **Sign-in and secrets.** `npx cf auth whoami` shows the right account. `.dev.vars` has `CF_ACCOUNT_ID` and
   `AIG_LOGS_TOKEN`. Never show `.dev.vars` or `cat` it on screen.
2. **Fresh numbers.** With `npm run dev` running:
   - `node scripts/demo-agents.ts` (three agents on the forks; it reuses existing forks and adds commits on top).
   - `node scripts/demo-planner.ts --keep` (Fable 5.1 plans, three Sonnet 5.5 workers; local pushes).
   - `node scripts/demo-new-repo.ts --keep` (plain repo vs `git next new`).
   - Then refresh the recorded data the dashboard loads: the live-cost and insights samples (commands under
     "Command reference" below).
   - About $0.40 in all. Don't delete forks. If you want a clean history, create fresh forks under new names and
     point `scripts/agent-specs.ts` at them.
3. **Dashboard.** Reload and check that each hero panel shows data: 1 Rules in force, 2 New repositories, 3 Cost and
   overspend (both tabs).
4. **Terminal inset prep.** Have a scratch clone of cloudflare/agents with the pre-push hook installed and a local
   bare remote (see "Command reference"), plus `npm link` so `git next` works.
5. **Screen hygiene.** Use a large font, close notifications, keep account IDs off screen (the dashboard and samples
   mask them).

## Shot list

### 0. Cold open: 0:00–0:20
- **Screen:** the dashboard at the top: the "1 Rules in force" panel with its big numbers (13 layers, 2 conflicts
  to settle, 1 policy warning, 6 overridden).
- **Narration:** "This is git.next: Git that versions the context and infrastructure around code, not just the
  code. Three questions every team running agents should be able to answer: what rules are they following, are new
  projects set up right, and what is it all costing."

### 1. Rules in force, for an existing project: 0:20–2:50
*The big thing. Stay on panel 1 the whole time.*
- **0:20 The stack.** Point down the left column: org (rank 1) › contract (2) › the project's nine AGENTS.md files
  (3.0–3.5, deeper folders win) › tool (4) › personal (5). Point at each layer's rule count and "wins N at root".
  **Narration:** "An agent in cloudflare/agents takes orders from thirteen places: the org's standards, a client
  contract, nine AGENTS.md files at different depths, the coding tool, and the developer's own preferences. git.next
  turns all of it into one stack with a clear order."
- **0:50 What wins, and why.** On the right, "What wins in `.`": pnpm and oxfmt from the project, *beating* the
  personal npm and Prettier (point at "beats personal …"); never-in-source and approved-providers-only from the org;
  ticket-ID commits from the contract. Switch the selector to `packages/agents`, then to `examples`, and show the
  changeset rule flip between "required" and "not-required".
  **Narration:** "For any folder you can see exactly which rule wins and why. The developer prefers npm, but the
  project says pnpm and the project outranks personal. In packages/ a changeset is required; in examples/ it isn't."
- **1:30 Conflicts a person has to settle.** Point at the two red cards: contract "skip changesets for internal
  fixes" versus the project's "changes need a changeset", with file and line on both sides.
  **Narration:** "When two hard rules disagree, rank isn't enough. Someone has to decide. git.next shows both sides
  with the exact file and line, instead of an agent silently picking one."
- **1:55 Policy.** Point at the amber card: agent-think is configured for gpt-5.6-sol, but the org only approves
  Workers AI and Anthropic.
  **Narration:** "It also catches policy: one agent here is set up for a model from a provider the org hasn't
  approved."
- **2:00 Optional: an admin changes precedence (+20s).** In the Precedence card, tick "Let contract outrank org",
  type the reason ("SOW-1234: the client contract governs this engagement") and Save. The stack re-ranks (the contract
  moves to rank 1), "skip changesets" becomes the winning changeset rule, and the card shows who, when and why. The two
  conflicts stay red, because two hard rules still need a person. Open "Audit trail", then "Reset to default".
  **Narration:** "Org outranks contract by default. If an engagement needs it the other way, only an admin can flip
  it, with a reason, on the record. And two hard rules that disagree still need a person."
- **2:20 Where it comes from (inset, 10s).** The terminal inset slides in: `git next rules packages/agents/src/mcp/client.ts`
  ends with "✗ 2 conflict(s)". The inset slides out.
  **Narration:** "The same check runs in every developer's terminal and in the pre-push hook, so an agent hits it
  before its push lands."

### 2. Rules for a new project, smart by default: 2:50–4:20
*Panel 2.*
- **2:50 The setup.** Read the task line: "build a small Worker endpoint that stores uploaded files…". Same agent,
  same model (Claude Sonnet 5), same prompt; one plain repo, one made with `git next new --template worker-api`.
- **3:05 The payoff.** Left column: **3** findings, "push blocked by the hook". It called an unapproved Llama model
  (`@cf/meta/llama-3-8b-instruct`), called it directly instead of through the org gateway, and invented a bucket the
  catalog doesn't list (`uploads-bare-files`), each with the fix in green ("Use the shared UPLOADS →
  acme-shared-uploads…"). Right column: **0** findings, "push went through", 1,059 context tokens from git.next (432
  pinned), and the pinned items "shared r2_buckets: UPLOADS → acme-shared-uploads · ai: approved", plus a
  `SOW-1234:` commit.
  **Narration:** "Most repos start empty and learn the org's rules from review comments. A repo made with git next
  starts already knowing them: the org's layers, its catalog of approved models and resources, secure defaults and
  the hook. Same agent, same prompt: the plain repo's first push is blocked three times, each with the fix. The
  smart repo's first push is clean, because its agent was handed the right bucket and model before it wrote a line."
- **3:55 Where it comes from (inset, 15s).** `git next new uploads-api --template worker-api` shows its summary
  (layers pinned, catalog version, hook installed, "rules ✓"), then
  `git next context "add an endpoint that stores uploaded files" src/index.ts` shows "Pinned (always loaded)".
  **Narration:** "One command creates it. Every context request after that pins the org's rules and the relevant
  catalog entries."
- **4:10 Optional inset (10s):** `git next doctor` in that repo shows "✓ Up to date with the baseline". When the org
  changes a rule, the same command lists what updating would introduce and which winners would change.

### 3. Cost and overspend: 4:20–5:50
*Panel 3. Start on "This demo · live gateway logs".*
- **4:20 Live spend.** Big numbers: total spend, model calls, estimated saving. "By fork" chips, then "Planner vs
  workers": the Fable 5.1 planner (about $0.16 per plan) versus the worker agents.
  **Narration:** "Every model call goes through our AI Gateway, tagged with developer, repo, fork, agent and task,
  so spend rolls up from one call to the whole project. Here is today's demo: a Fable 5.1 planner that's approved
  for planning only, and the Sonnet workers it directed."
- **4:50 Right-size the model.** The green card: docs-agent used Claude Opus 4.8 for a one-line docs fix →
  kimi-k2.7-code, with the saving. The amber flag beside it: Opus 4.8 isn't in the org catalog.
  **Narration:** "When a frontier model fixes a typo, git.next suggests the right size and shows the saving, and
  flags models the catalog doesn't allow."
- **5:10 Overspend at team scale.** Click "Team view · sample data". By developer: devon at **4.4× median**, with a
  red bar. Flags: agent-think spending 4.4× the median, and the unapproved OpenAI model on two agents. "Right-size
  the model": $16.88 of estimated savings.
  **Narration:** "Across a team, the same data finds overspend: one developer's agent at four times the median, on
  a provider the org hasn't approved, doing triage a small model could handle. That's about seventeen dollars of
  savings on sixty calls."

### 4. How the data gets there: agents push, the dashboard updates: 5:50–7:10
- **5:50 Agents at work.** Scroll to "More" → **Demo agents**: three agents on three forks, each with its context
  size, cost, pre-push result and commit; then the "Planner run" section (Fable's plan notes, the cost split).
  **Narration:** "Each agent works on its own fork. Before it calls a model, it asks git.next for a slice of
  context: the rules for the files it will touch, and the docs that matter within a budget. About 3,000 tokens
  instead of 890,000."
- **6:20 A push is blocked, then resolved.** Expand "Why mcp-agent was blocked…". Terminal inset: the push prints
  "✗ 2 conflict(s)" and is refused; after the contract layer is amended, the same push goes through.
  **Narration:** "The MCP agent touched packages/, right where the contract and the project disagree, so the hook
  stopped it. A person amends the contract, and the same push goes through."
- **6:50 Live update.** With the dashboard on a fork (fork selector → agents-demo-r2), an agent pushes to that fork.
  Artifacts emits a `pushed` event, the queue delivers it to the resolver, and within about 20 seconds the live dot
  pulses, "Recent pushes" shows the new commit, and the panels refresh. Deployed: run `node scripts/demo-agents.ts
  --only r2-agent` during the shot. Locally (no real events reach `cf dev`): `curl -s -X POST
  localhost:5173/dev/enqueue -H 'content-type: application/json' -d '{"repo":"agents-demo-r2"}'` simulates the event.
  **Narration:** "Every push to Artifacts triggers the resolver, so the dashboard stays current while agents work."

### 5. Supporting views: 7:10–7:50
- **Resource map** (fork selector → agents-demo-r2, "changed only"): `r2-uploads` marked **new** with
  `r2_buckets: 1`.
  **Narration:** "Infrastructure changes show up in review too: this agent's change adds an R2 bucket."
- **Sliced context panel:** 4,000 tokens served versus 889,608 in all markdown (0.4%), retrieved by BM25 plus
  EmbeddingGemma vectors, with 184 tokens of pinned org and contract rules always included.

### 6. Built to extend, and close: 7:50–8:40
- **Screen:** `src/providers/owners.ts` beside the one-line `.register(ownersProvider)`, then back to the full
  dashboard.
  **Narration:** "Each view comes from a small provider behind one interface, so teams can add their own. git.next:
  every rule traced to a line, every new repo following the org from its first commit, and every model call costed.
  Built on Cloudflare Artifacts, Workers and AI Gateway."

## Command reference (insets and prep)

```bash
npm run dev
node scripts/demo-agents.ts
node scripts/demo-planner.ts --keep
node scripts/demo-new-repo.ts --keep
# refresh the recorded data the dashboard loads
curl -s 'localhost:5173/insights?repo=agents-demo-full&ref=main&providers=cost' > samples/cost-live.json
curl -s 'localhost:5173/insights?repo=agents-demo-full&ref=main&base=d1ce3cbd765cada8edfaedaf5ea1041095ece79c&layers=demo&cost=fixture' > samples/insights-demo.json
# inset clone (once): local push target so the hook runs without pushing anywhere real
git clone -q https://github.com/cloudflare/agents /tmp/gn/agents-demo-full && cd /tmp/gn/agents-demo-full
cp ~/code/gitnext/git-next/examples/hooks/pre-push .git/hooks/
git clone -q --bare --single-branch --branch main https://github.com/cloudflare/agents /tmp/gn/remote.git && git remote add demo /tmp/gn/remote.git
# insets
git next rules --layers ~/code/gitnext/git-next/fixtures/demo-layers/.gitnext/stack.json packages/agents/src/mcp/client.ts
git next new uploads-api --template worker-api
git next context "add an endpoint that stores uploaded files" src/index.ts --budget 1500
GIT_NEXT_LAYERS=~/code/gitnext/git-next/fixtures/demo-layers/.gitnext/stack.json git push --dry-run demo HEAD:main
GIT_NEXT_LAYERS=~/code/gitnext/git-next/fixtures/demo-layers-resolved/.gitnext/stack.json git push --dry-run demo HEAD:main
```
