# git.next demo video: shot list (target 9:20)

**Approach: big thing first, with a point of view.** The dashboard is the product on screen. Beat 1 is the rules in
force for an existing project, traced down to the line of source. Beat 2 is rules for a new project. Beat 3 is cost
and overspend. Beat 4 is the repo shape the agentic era is producing: plugins and skills. Terminal work shows up only
as small insets that *feed* the dashboard (an agent pushes, the dashboard updates). It's never the subject of a shot.

**Voice:** direct and opinionated. Name the problem plainly and say what should change. Confident, a little edgy;
never sarcastic, never mocking anyone's tools or teams. Short sentences. Let the screen make the point, then say it
once.

Screen layout: the browser full screen on the dashboard (the deployed URL behind Cloudflare Access, or
`http://localhost:5173`), about 1440 px wide, dark theme. A small terminal window sits bottom-right for insets and stays
hidden otherwise. Timings are cumulative; narration is written to be read aloud.

## Pre-recording checklist

1. **Sign-in and secrets.** `npx cf auth whoami` shows the right account. `.dev.vars` has `CF_ACCOUNT_ID` and
   `AIG_LOGS_TOKEN`, plus the Access service token (`CLOUDFLARE_ACCESS_CLIENT_ID`/`_SECRET`) so `npm run dev` gets
   past Access. Never show `.dev.vars` or `cat` it on screen.
2. **Fresh numbers.** With `npm run dev` running:
   - `node scripts/demo-agents.ts` (three agents on the forks; it reuses existing forks and adds commits on top).
   - `node scripts/demo-planner.ts --keep` (Fable 5.1 plans, three Sonnet 5.5 workers; local pushes).
   - `node scripts/demo-new-repo.ts --keep` (plain repo vs `git next new`).
   - Then refresh the recorded data the dashboard loads: the live-cost and insights samples (commands under
     "Command reference" below).
   - About $0.40 in all. Don't delete forks. If you want a clean history, create fresh forks under new names and
     point `scripts/agent-specs.ts` at them.
3. **Dashboard.** Reload and check that each hero panel shows data: 1 Rules in force, 2 New repositories, 3 Cost and
   overspend (both tabs). Open the Code tab once on `agents-demo-full` so its file list is cached (first load takes
   about 7 seconds, then under one). Pick **claude-plugins (live)** once to confirm its skills and plugins table load.
4. **Terminal inset prep.** Have a scratch clone of cloudflare/agents with the pre-push hook installed and a local
   bare remote (see "Command reference"), plus `npm link` so `git next` works.
5. **Screen hygiene.** Use a large font, close notifications, keep account IDs off screen (the dashboard and samples
   mask them).

## Shot list

### 0. Cold open: 0:00–0:25
- **Screen:** the dashboard at the top: the "1 Rules in force" panel with its big numbers (13 layers, 2 conflicts
  to settle, 1 policy warning, 6 overridden).
- **Narration:** "You already have agents writing code. What you don't have is visibility into how that code gets
  made: which instructions they followed, which ones they ignored, and what it cost you. git.next gives you that
  visibility, and turns it into something you can act on. Git versioned the code. This versions everything around
  it."

### 1. Rules in force, for an existing project: 0:25–3:30
*The big thing. Stay on panel 1, then follow one rule all the way to its source.*
- **0:25 The stack.** Point down the left column: org (rank 1) › contract (2) › the project's nine AGENTS.md files
  (3.0–3.5, deeper folders win) › tool (4) › personal (5). Point at each layer's rule count and "wins N at root".
  **Narration:** "Here's an uncomfortable fact. An agent in cloudflare/agents takes orders from thirteen places: the
  org's standards, a client contract, nine AGENTS.md files at different depths, the coding tool, and the developer's
  own preferences. Nobody wrote that list down. Nobody decided the order. git.next does both."
- **0:55 What wins, and why.** On the right, "What wins in `.`": pnpm and oxfmt from the project, *beating* the
  personal npm and Prettier (point at "beats personal …"); never-in-source and approved-providers-only from the org;
  ticket-ID commits from the contract. Switch the selector to `packages/agents`, then to `examples`, and show the
  changeset rule flip between "required" and "not-required".
  **Narration:** "For any folder, you can see which rule wins and why. The developer prefers npm; the project says
  pnpm, and the project outranks personal taste. That's not a judgment call your agent should be making on its own
  every session."
- **1:35 Conflicts a person has to settle.** Point at the two red cards: contract "skip changesets for internal
  fixes" versus the project's "changes need a changeset", with file and line on both sides.
  **Narration:** "And when two hard rules disagree, rank isn't enough. Today, your agent quietly picks one and moves
  on, and you find out in review, if you find out at all. git.next stops and shows both sides, with the exact file and
  line, so a person decides."
- **2:00 From the rule to the source (Code tab).** Click `packages/agents/AGENTS.md:7` on the project side of the
  conflict card. The Code tab opens on that file with line 7 highlighted and the other rule lines marked in orange.
  The right-hand panel shows "Rules in force here" for `packages/agents`. Hover a marked line to show its tooltip
  (topic and value). Click the `contract/AGENTS.md:4` link in the panel to jump to the contract's side.
  **Narration:** "Every rule on this dashboard is one click from the line that created it. Not a summary. Not a
  guess. The actual line, in the repo, with every other rule in that file marked and what wins in
  this folder alongside. If you can't trace an instruction to its source, you can't own it."
- **2:30 Policy.** Back on the dashboard (browser back), point at the amber card: agent-think is configured for
  gpt-5.6-sol, but the org only approves Workers AI and Anthropic.
  **Narration:** "It catches policy too. One agent here is configured for a model from a provider the org never
  approved. That's not a style issue. That's your data going somewhere you didn't sign off on."
- **2:45 Optional: an admin changes precedence (+20s).** In the Precedence card, tick "Let contract outrank org",
  type the reason ("SOW-1234: the client contract governs this engagement") and Save. The stack re-ranks (the contract
  moves to rank 1), "skip changesets" becomes the winning changeset rule, and the card shows who, when and why. The two
  conflicts stay red, because two hard rules still need a person. Open "Audit trail", then "Reset to default".
  **Narration:** "Org outranks contract by default. If an engagement really needs it the other way, an admin can
  flip it, with a reason, on the record. Changing the rules is fine. Changing them silently isn't."
- **3:10 Where it comes from (inset, 10s).** The terminal inset slides in: `git next rules packages/agents/src/mcp/client.ts`
  ends with "✗ 2 conflict(s)". The inset slides out.
  **Narration:** "The same check runs in every developer's terminal and in the pre-push hook, so an agent hits it
  before its push lands, not after."

### 2. Rules for a new project, smart by default: 3:30–5:00
*Panel 2.*
- **3:30 The setup.** Read the task line: "build a small Worker endpoint that stores uploaded files…". Same agent,
  same model (Claude Sonnet 5), same prompt; one plain repo, one made with `git next new --template worker-api`.
- **3:45 The payoff.** Left column: **3** findings, "push blocked by the hook". It called an unapproved Llama model
  (`@cf/meta/llama-3-8b-instruct`), called it directly instead of through the org gateway, and invented a bucket the
  catalog doesn't list (`uploads-bare-files`), each with the fix in green ("Use the shared UPLOADS →
  acme-shared-uploads…"). Right column: **0** findings, "push went through", 1,059 context tokens from git.next (432
  pinned), and the pinned items "shared r2_buckets: UPLOADS → acme-shared-uploads · ai: approved", plus a
  `SOW-1234:` commit.
  **Narration:** "Most new repos start empty and learn the org's rules the slow way: from review comments, after the
  code is written. That's backwards. A repo made with git next starts already knowing them: the org's layers, its
  catalog of approved models and resources, secure defaults and the hook. Same agent, same prompt. The plain repo's
  first push is blocked three times. The smart repo's first push is clean, because its agent was handed the right
  bucket and the right model before it wrote a line."
- **4:35 Where it comes from (inset, 15s).** `git next new uploads-api --template worker-api` shows its summary
  (layers pinned, catalog version, hook installed, "rules ✓"), then
  `git next context "add an endpoint that stores uploaded files" src/index.ts` shows "Pinned (always loaded)".
  **Narration:** "One command creates it. Every context request after that pins the org's rules and the catalog
  entries that matter for the task."
- **4:50 Optional inset (10s):** `git next doctor` in that repo shows "✓ Up to date with the baseline". When the org
  changes a rule, the same command lists what updating would introduce and which winners would change.

### 3. Cost and overspend: 5:00–6:30
*Panel 3. Start on "This demo · live gateway logs".*
- **5:00 Live spend.** Big numbers: total spend, model calls, estimated saving. "By fork" chips, then "Planner vs
  workers": the Fable 5.1 planner (about $0.16 per plan) versus the worker agents.
  **Narration:** "Agent spend shouldn't be a line item you discover at the end of the month. Every model call here
  goes through our AI Gateway, tagged with developer, repo, fork, agent and task, so spend rolls up from one call to
  the whole project. This is today's demo: a Fable 5.1 planner approved for planning only, and the Sonnet workers it
  directed."
- **5:30 Right-size the model.** The green card: docs-agent used Claude Opus 4.8 for a one-line docs fix →
  kimi-k2.7-code, with the saving. The amber flag beside it: Opus 4.8 isn't in the org catalog.
  **Narration:** "A frontier model fixing a typo is money on fire. git.next suggests the right size, shows the
  saving, and flags models the catalog doesn't allow."
- **5:50 Overspend at team scale.** Click "Team view · sample data". By developer: devon at **4.4× median**, with a
  red bar. Flags: agent-think spending 4.4× the median, and the unapproved OpenAI model on two agents. "Right-size
  the model": $16.88 of estimated savings.
  **Narration:** "Across a team, the same data finds the overspend: one developer's agent at four times the median,
  on a provider the org hasn't approved, doing triage a small model could handle. About seventeen dollars of savings
  on sixty calls. Multiply that by a real team, and by a quarter."
- **6:15 Per commit (Code tab, 15s).** Open the Code tab on `agents-demo-r2`, History. Point at a commit's chips:
  "2 conflicts · 0 catalog" from the push that brought it in, and its gateway cost from the `Agent-Task` trailer.
  Click it to show the changed files.
  **Narration:** "And it lands on the commit. What the agent changed, what git.next found when it pushed, and what
  that change cost."

### 4. The repos agents are producing: plugins and skills: 6:30–7:15
- **6:30 Switch repos.** In the fork picker, choose **claude-plugins (live)**: a public Claude Code plugin
  marketplace imported into Artifacts. Panel 1 switches: **3** on-demand layers (session-metrics,
  audit-session-metrics, task-breakdown), each with "loads when: …" from its description. Scroll to the **Claude Code
  plugins** table: desktop-statusline 0.1.2 registers a code module (`./register.tsx`); session-metrics 1.90.3 ships
  the three skills; marketplace versions match.
  **Narration:** "More and more of what steers an agent doesn't live in AGENTS.md. It lives in plugins and skills
  that load on demand. If your tooling can't see them, it can't see the instructions. git.next reads them as layers:
  when each skill loads, what model it asks for, whether it contradicts the org, and which plugins run code in your
  tools without asking."
- **7:00 Optional (10s):** open the Code tab on `plugins/session-metrics/skills/session-metrics/SKILL.md` and point at
  its "skill" badge in the tree.

### 5. How the data gets there: agents push, the dashboard updates: 7:15–8:20
- **7:15 Agents at work.** Back on cloudflare/agents (repo picker), scroll to "More" → **Demo agents**: three agents
  on three forks, each with its context size, cost, pre-push result and commit; then the "Planner run" section
  (Fable's plan notes, the cost split).
  **Narration:** "Each agent works on its own fork. Before it calls a model, it asks git.next for a slice of
  context: the rules for the files it will touch and the docs that matter, within a budget. About 3,000 tokens
  instead of 890,000. Less to pay for, less to get confused by."
- **7:40 A push is blocked, then resolved.** Expand "Why mcp-agent was blocked…". Terminal inset: the push prints
  "✗ 2 conflict(s)" and is refused; after the contract layer is amended, the same push goes through.
  **Narration:** "The MCP agent touched packages/, right where the contract and the project disagree, so the hook
  stopped it. A person amends the contract, and the same push goes through. That's the loop: the agent moves fast,
  a person makes the calls only a person should make."
- **8:00 Live update.** With the dashboard on a fork (fork selector → agents-demo-r2), an agent pushes to that fork.
  Artifacts emits a `pushed` event, the queue delivers it to the resolver, and the live dot pulses, "Recent pushes"
  shows the new commit, and the panels refresh. Analysis takes about 25 seconds; allow up to a few minutes for queue
  delivery, so start the push early or cut the wait. Deployed: run `node scripts/demo-agents.ts --only r2-agent`
  during the shot. Locally (no real events reach `cf dev`): `curl -s -X POST localhost:5173/dev/enqueue -H
  'content-type: application/json' -d '{"repo":"agents-demo-r2"}'` simulates the event.
  **Narration:** "Every push to Artifacts triggers the resolver, so the dashboard stays current while agents work.
  No nightly job. No one remembering to run a report."

### 6. Supporting views: 8:20–8:45
- **Resource map** (fork selector → agents-demo-r2, "changed only"): `r2-uploads` marked **new** with
  `r2_buckets: 1`.
  **Narration:** "Infrastructure changes show up in review too: this agent's change adds an R2 bucket."
- **Sliced context panel:** 4,000 tokens served versus 889,608 in all markdown (0.4%), retrieved by BM25 plus
  EmbeddingGemma vectors, with 184 tokens of pinned org and contract rules always included.

### 7. Built to extend, and close: 8:45–9:20
- **Screen:** `src/providers/owners.ts` beside the one-line `.register(ownersProvider)`, then back to the full
  dashboard.
  **Narration:** "Each view comes from a small provider behind one interface, so teams can add their own. Agents
  are already writing your code. The question is whether you can see how. git.next: every rule traced to a line,
  every new repo following the org from its first commit, every skill and plugin accounted for, and every model call
  costed. Built on Cloudflare Artifacts, Workers and AI Gateway."

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

Deep links used in the shots (append to the dashboard URL):

```text
#code?repo=agents-demo-full&ref=main&path=packages%2Fagents%2FAGENTS.md&line=7
#code?repo=agents-demo-r2&ref=main&tab=history
#code?repo=claude-plugins&ref=master&path=plugins%2Fsession-metrics%2Fskills%2Fsession-metrics%2FSKILL.md
```
