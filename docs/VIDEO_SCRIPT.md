# git.next demo video: shot list (target 9:50)

**Approach: big thing first, with a point of view.** The dashboard is the product on screen. It opens on the **Org
tab**: every repo's classification, spend against budget, what waits for a person, and what's at risk, across the
whole org, from live data. Then it zooms into one project. Beat 1 is the rules in force for an existing project, traced down to the line of source. Beat 2 is rules for a new project. Beat 3 is cost
and overspend. Beat 4 answers the question the Artifacts launch post asks outright: when many agents work on one
codebase at once, which change ships? (Compare attempts, pick one, a person reviews what's sensitive, then merge.)
Beat 5 is an agent asking git.next itself, over MCP. Beat 6 is the repo shape the agentic era is producing: plugins
and skills. Terminal work shows up only as small insets that *feed* the dashboard (an agent pushes, the dashboard
updates). It's never the subject of a shot, except the short MCP beat, where the agent is the point.

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
3. **Org tab.** Open `#org`, check **Org scale** is selected (the toggle is remembered per browser), and press Refresh once (the first load reads every repo and about 800 gateway records;
   later loads are cached for 30 seconds). Check the four reviews show under "Waiting for a person", the uploads
   repos show as PII-regulated with red controls, and the two mock-up badges (forecast, review SLA) are visible.
   **Dashboard.** Reload and check that each hero panel shows data: 1 Rules in force, 2 New repositories, 3 Cost and
   overspend (both tabs). Open the Code tab once on `agents-demo-full` and on `packages/agents/AGENTS.md` so the file list and file are cached (first load takes
   about 7 seconds, then under one). Pick **claude-plugins (live)** in a second tab and leave it there for beat 6, so its live analysis never runs on
   camera.
   In "4 · Agents in parallel", check that both attempt cards show and that the attempt-haiku and attempt-sonnet push
   reviews say **needs human review**. Don't approve or reject them before recording (decisions and reasons are under
   "Review decisions"): the approval is a shot, and it's one take
   per commit. For a retake, push a fresh commit to the attempt branch (see "Command reference").
6. **MCP inset prep.** In a scratch clone of cloudflare/agents, connect Claude Code to git.next once (`claude mcp add`
   from the README's "MCP server" section, with the service token from `.dev.vars` in environment variables; never on
   screen). Check `/mcp` lists git-next with five tools.
4. **Terminal inset prep.** Have a scratch clone of cloudflare/agents with the pre-push hook installed and a local
   bare remote (see "Command reference"), plus `npm link` so `git next` works.
5. **Screen hygiene.** Use a large font, close notifications, keep account IDs off screen (the dashboard and samples
   mask them).

## Shot list

### 0. Cold open on the Org tab: 0:00–1:05
*Open on `#org` (the **Org** link in the header). Everything on it is live: Artifacts repos and their
`.gitnext/app.json`, stored push results, review records from the Workflow and the AI Gateway logs, plus, in the
default **Org scale** view, a synthetic production-scale dataset (about $19.7k over 30 days) added to spend and cost
per change. Its numbers carry an asterisk and the footnote under the top row says what's in them; leave the footnote
on screen, and don't describe the spend as ours. Two figures are mock-ups and say so: the forecast and the review
SLA targets.*
- **0:00 The top row.** AI spend over the last 30 days (about $19.7k*) against the org's budget, teams or projects over budget, changes waiting
  for a person (with the oldest), PII repos missing controls, unresolved rule conflicts.
  **Narration:** "You already have agents writing code. What you don't have is visibility into how that code gets
  made: which instructions they followed, what they cost, and what's waiting on a person. And soon it won't be one
  agent. It'll be dozens, on the same codebase, at the same time. This is git.next, from the top of the org."
- **0:15 Apps and classification.** The three profile cards: Public, Internal, **PII-regulated** (its own rules
  layer, two approved models, guardrails, EU data, a person on every data-path change). In the table, uploads-smart
  and uploads-bare are PII-regulated (org registry); hover a red ✗ on uploads-bare to show its evidence ("no
  dataLocation in .gitnext/app.json", "no catalog: models in code aren't checked").
  **Narration:** "Every repo has a class. A repo declares it, and it can raise it but never lower it. The class is
  real policy, not a label: a PII repo gets an extra rules layer, a narrower model catalog, and a person on every
  change to its data paths. And you can see at a glance which controls a repo is missing, with the evidence."
- **0:35 Spend.** Click through "Top spend by": Project, Model, Developer. Point at the red team bar (over its
  monthly budget), the overspend lines, cost per merged change (about $15–35 per change), and the forecast card with
  its **mock-up** label. Optional: click **Live only** for a second to show the real gateway spend underneath, then
  back to **Org scale**.
  **Narration:** "Spend rolls up from every model call to project, team and cost centre, against budget. Not at
  month end. Now. And per change that actually cleared review, which is the number that matters."
- **0:50 Review, flow and risk.** The waiting list (attempt-haiku, attempt-sonnet, uploads-bare, uploads-smart),
  average and oldest wait, reviewer load. Then the risk cards: PII repos missing controls, the catalog card
  ("gateway calls to claude-sonnet-5 outside its class's catalog" on both uploads repos), unresolved conflicts, repos
  without AGENTS.md. Click **1 · Rules in force** in the header to zoom in.
  **Narration:** "What's waiting on a person and for how long. And what needs attention: a PII repo using a model its
  class doesn't allow, rules that conflict, repos where agents get no project rules at all. Let's go one level down,
  into a single project."

### 1. Rules in force, for an existing project: 1:05–3:35
*The big thing. Stay on panel 1, then follow one rule all the way to its source.*
- **1:05 The stack.** Point down the left column: org (rank 1) › contract (2) › the project's nine AGENTS.md files
  (3.0–3.5, deeper folders win) › tool (4) › personal (5). Point at each layer's rule count and "wins N at root".
  **Narration:** "Here's an uncomfortable fact. An agent in cloudflare/agents takes orders from thirteen places: the
  org's standards, a client contract, nine AGENTS.md files at different depths, the coding tool, and the developer's
  own preferences. Nobody wrote that list down. Nobody decided the order. git.next does both."
- **1:35 What wins, and why.** On the right, "What wins in `.`": pnpm and oxfmt from the project, *beating* the
  personal npm and Prettier (point at "beats personal …"); never-in-source and approved-providers-only from the org;
  ticket-ID commits from the contract. Switch the selector to `packages/agents`, then to `examples`, and show the
  changeset rule flip between "required" and "not-required".
  **Narration:** "For any folder, you can see which rule wins and why. The developer prefers npm; the project says
  pnpm, and the project outranks personal taste. That's not a judgment call your agent should be making on its own
  every session."
- **2:15 Conflicts a person has to settle.** Point at the two red cards: contract "skip changesets for internal
  fixes" versus the project's "changes need a changeset", with file and line on both sides.
  **Narration:** "And when two hard rules disagree, rank isn't enough. Today, your agent quietly picks one and moves
  on, and you find out in review, if you find out at all. git.next stops and shows both sides, with the exact file and
  line, so a person decides."
- **2:40 From the rule to the source (Code tab).** Click `packages/agents/AGENTS.md:7` on the project side of the
  conflict card. The Code tab opens on that file with line 7 highlighted and the other rule lines marked in orange.
  The right-hand panel shows "Rules in force here" for `packages/agents`. Hover a marked line to show its tooltip
  (topic and value). Don't open a second file on camera (each first load waits on Artifacts); the file must already
  be cached from prep.
  **Narration:** "Every rule on this dashboard is one click from the line that created it. Not a summary. Not a
  guess. The actual line, in the repo, with every other rule in that file marked and what wins in
  this folder alongside. If you can't trace an instruction to its source, you can't own it."
- **3:00 Policy.** Back on the dashboard (browser back), point at the amber card: agent-think is configured for
  gpt-5.6-sol, but the org only approves Workers AI and Anthropic.
  **Narration:** "It catches policy too. One agent here is configured for a model from a provider the org never
  approved. That's not a style issue. That's your data going somewhere you didn't sign off on."
- **Optional: an admin changes precedence (+20s; cut if over time).** In the Precedence card, tick "Let contract outrank org",
  type the reason ("SOW-1234: the client contract governs this engagement") and Save. The stack re-ranks (the contract
  moves to rank 1), "skip changesets" becomes the winning changeset rule, and the card shows who, when and why. The two
  conflicts stay red, because two hard rules still need a person. Open "Audit trail", then "Reset to default".
  **Narration:** "Org outranks contract by default. If an engagement really needs it the other way, an admin can
  flip it, with a reason, on the record. Changing the rules is fine. Changing them silently isn't."

### 2. Rules for a new project, smart by default: 3:35–4:50
*Panel 2.*
- **3:35 The setup.** Read the task line: "build a small Worker endpoint that stores uploaded files…". Same agent,
  same model (Claude Sonnet 5), same prompt. Two real repos in Artifacts: **uploads-bare**, a plain repo with no
  git.next hook (like any plain repo today), and **uploads-smart**, made with
  `git next new --template worker-api --artifacts`. Both are subscribed to git.next's push review.
- **3:50 The payoff.** Left column: **4** findings, "live · pushed to Artifacts, no git.next hook · git.next review:
  needs human review". It called two unapproved models (`@cf/llava-hf/llava-1.5-7b-hf`,
  `@cf/meta/llama-3-8b-instruct`), called them directly instead of through the org gateway, and invented a bucket
  the catalog doesn't list (`uploads-bare-files`), each with the fix in green ("Use the shared UPLOADS →
  acme-shared-uploads…"). Under them, point at **0.34 hours** of "developer hours for remediation" (labelled
  mock-up) next to the $0.05 model call. Right column: **0** findings, pushed through its own hook, 1,168 context tokens from
  git.next (477 pinned), the pinned "shared r2_buckets: UPLOADS → acme-shared-uploads · ai: approved", and a
  `SOW-1234:` commit. Its review is held for one reason only: it adds a binding (to the approved shared bucket).
  **Narration:** "Most new repos start empty and learn the org's rules the slow way: from review comments, after the
  code is written. That's backwards. A repo made with git next starts already knowing them: the org's layers, its
  catalog of approved models and resources, secure defaults and the hook. Same agent, same prompt, both real repos.
  The plain repo had nothing to stop it, so its first push went straight in, and git.next caught four problems on
  arrival and held it for a person. The model call cost five cents. Cleaning up after it costs a developer's
  time, and that's the real bill. The smart repo's first push is clean, because its agent was handed the right
  bucket and the right model before it wrote a line."
- **4:35 Where it comes from (inset, 15s).** `git next new uploads-api --template worker-api --artifacts` shows its
  summary (layers pinned, catalog version, hook installed, "rules ✓", and the Artifacts repo it created), then
  `git next context "add an endpoint that stores uploaded files" src/index.ts` shows "Pinned (always loaded)".
  **Narration:** "One command creates it, in Artifacts, already watched by git.next. Every context request after that
  pins the org's rules and the catalog entries that matter for the task."

### 3. Cost and overspend: 4:50–6:05
*Panel 3. Start on "This demo · live gateway logs".*
- **4:50 Live spend.** Big numbers: total spend, model calls, estimated saving. "By fork" chips, then "Planner vs
  workers": the Fable 5.1 planner (about $0.16 per plan) versus the worker agents.
  **Narration:** "Agent spend shouldn't be a line item you discover at the end of the month. Every model call here
  goes through our AI Gateway, tagged with developer, repo, fork, agent and task, so spend rolls up from one call to
  the whole project. This is today's demo: a Fable 5.1 planner approved for planning only, and the Sonnet workers it
  directed."
- **5:15 Right-size the model.** The green card: docs-agent used Claude Opus 4.8 for a one-line docs fix →
  kimi-k2.7-code, with the saving. The amber flag beside it: Opus 4.8 isn't in the org catalog.
  **Narration:** "A frontier model fixing a typo is money on fire. git.next suggests the right size, shows the
  saving, and flags models the catalog doesn't allow."
- **5:30 Overspend at team scale.** Click "Team view · sample data". By developer: devon at **4.4× median**, with a
  red bar. Flags: agent-think spending 4.4× the median, and the unapproved OpenAI model on two agents. "Right-size
  the model": $16.88 of estimated savings.
  **Narration:** "Across a team, the same data finds the overspend: one developer's agent at four times the median,
  on a provider the org hasn't approved, doing triage a small model could handle. About seventeen dollars of savings
  on sixty calls. Multiply that by a real team, and by a quarter."
- **5:50 Gateway controls (15s).** Back on "This demo · live gateway logs", scroll to **AI Gateway controls**: caching
  (live: 0 cached, caching is off), guardrails and DLP (mocked), and the **dynamic routing** suggestion: "route
  feature#* tasks to claude-haiku-4.5, fall back to claude-sonnet-5.5", from the attempt comparison in the next beat.
  **Narration:** "And the gateway can act on what it learns: cache what repeats, stop secrets before they reach a
  model, and route a class of task to the model that's proven good enough."

### 4. Agents in parallel: which change ships? 6:05–7:40
*Panel 4. This is the Artifacts post's own question, answered on one screen.*
- **6:05 Work in flight.** Point at the big numbers (forks and branches in flight, tasks with competing attempts,
  "attempt-haiku recommended to merge"), then the **Work in flight** table: every fork and branch of the project, its
  agent, its task, what it changes, and who else touches the same files.
  **Narration:** "When agents work in parallel, the first question is who's touching what. Every fork and branch of
  the project, what it changes, and where two of them collide, before they collide. Each agent gets the same answer
  when it asks for context."
- **6:25 Same task, two attempts.** The two attempt cards: same task (an R2 uploads Worker that describes each file
  with AI), same context with the org catalog pinned, two models. attempt-haiku: **+102** lines, **0** catalog
  findings, **$0.008**, **pick to merge**. attempt-sonnet: +142, 0 findings, $0.081 (its first try hit the output
  limit, and failed tries count). Point at the reasons line and the **Tests (Sandbox)** row (mocked).
  **Narration:** "Same task, two agents, two models. Both followed the org catalog: the shared bucket, an approved
  model, the gateway. So the pick comes down to the smallest change at a tenth of the cost. That's not a vibe. It's
  ranked: clean first, then least overlap, then smallest diff, then cheapest, and it says why."
- **6:55 A person reviews what's sensitive.** Point at the merge button: **Merge locked: review first**. Scroll to
  **Push reviews**: attempt-haiku's card shows the Workflow's steps (analyse → index embeddings → classify → request
  human review → *waiting for a person*) and why: "adds dependencies @cloudflare/workers-types, typescript, wrangler"
  and "adds bindings r2_buckets UPLOADS → acme-shared-uploads, ai AI". Then the docs fork's card: **nothing
  sensitive**, auto-approved.
  **Narration:** "Every push runs through a Workflow: analyse, index, classify. A docs fix sails through. A change
  that adds infrastructure or dependencies waits for a person. Agents move fast; a human signs off on what matters."
- **7:15 Approve the pick, reject the other attempt.** On attempt-haiku's card, type the reason ("Shared bucket and
  approved model; deps are standard Workers tooling.") and click **Approve**. A few seconds later the card reads
  "approved by …" with the reason, and the attempt card's button changes to **Merge into main** (mocked). Then, on
  attempt-sonnet's card (reason typed before the take), click **Reject**: "Superseded by attempt-haiku: same task,
  both clean; haiku is the smaller change (+102 vs +142 lines) at about a tenth of the cost ($0.008 vs $0.081)."
  The card reads "rejected by …" with the reason. See "Review decisions" below for why.
  **Narration:** "Approved, on the record, and now it can ship. The attempt that lost gets a decision too: it passed
  every check, it just wasn't the best one. Closed with a reason, not left open for someone to merge by mistake."

### 5. The agent asks git.next itself (MCP): 7:40–8:10
- **Screen:** the terminal, full width for this beat: Claude Code in the scratch clone with git.next connected over
  MCP. Prompt: "Add a delete endpoint to examples/uploads-ai. Check with git-next first." Claude Code calls
  **get_context**, and the result shows the winning rules with their `file:line` sources and **inFlight**: the two
  attempt branches already changing examples/uploads-ai. Then it calls **check_overlap**.
  **Narration:** "git.next is an MCP server, so the agent asks it directly: what are the rules here, who else is in
  these files, which attempt won. No wrapper scripts. Any agent that speaks MCP gets the same answers you see on the
  dashboard."

### 6. The repos agents are producing: plugins and skills: 8:10–8:40
- **8:10 Switch repos.** Cut straight to a second browser tab where **claude-plugins (live)** was already picked and
  analysed during prep (picking it on camera waits on a live analysis): a public Claude Code plugin marketplace
  imported into Artifacts. Panel 1 switches: **3** on-demand layers (session-metrics,
  audit-session-metrics, task-breakdown), each with "loads when: …" from its description. Scroll to the **Claude Code
  plugins** table: desktop-statusline 0.1.2 registers a code module (`./register.tsx`); session-metrics 1.90.3 ships
  the three skills; marketplace versions match.
  **Narration:** "More and more of what steers an agent doesn't live in AGENTS.md. It lives in plugins and skills
  that load on demand. If your tooling can't see them, it can't see the instructions. git.next reads them as layers:
  when each skill loads, what model it asks for, whether it contradicts the org, and which plugins run code in your
  tools without asking."

### 7. How the data gets there: agents push, the dashboard updates: 8:40–9:10
- **8:40 Agents at work.** Back on cloudflare/agents (repo picker), scroll to "More" → **Demo agents**: three agents
  on three forks, each with its context size, cost, pre-push result and commit.
  **Narration:** "Each agent works on its own fork. Before it calls a model, it asks git.next for a slice of
  context: the rules for the files it will touch and the docs that matter, within a budget. About 3,000 tokens
  instead of 890,000. Less to pay for, less to get confused by."
- **9:00 Live update (10s, no waiting on camera).** With the dashboard on a fork (fork selector → agents-demo-r2),
  show the terminal inset starting the push, then cut to the moment the live dot pulses and "Recent pushes" shows the
  new commit. Artifacts emits a `pushed` event and the queue starts the push-review Workflow; analysis takes about 25
  seconds and queue delivery can take a few minutes, so start the push well before the shot and edit the wait out. Deployed: run `node scripts/demo-agents.ts --only r2-agent`
  during the shot. Locally (no real events reach `cf dev`): `curl -s -X POST localhost:5173/dev/enqueue -H
  'content-type: application/json' -d '{"repo":"agents-demo-r2"}'` simulates the event.
  **Narration:** "Every push to Artifacts starts that review Workflow, so the dashboard stays current while agents
  work. No nightly job. No one remembering to run a report."

### 8. Built to extend, and close: 9:10–9:50
- **Screen:** `src/providers/owners.ts` beside the one-line `.register(ownersProvider)`, then back to the full
  dashboard.
  **Narration:** "Each view comes from a small provider behind one interface, so teams can add their own. Agents
  are already writing your code. The question is whether you can see how. git.next: every rule traced to a line,
  every new repo following the org from its first commit, parallel attempts ranked and reviewed before they merge,
  every skill and plugin accounted for, every model call costed, and the whole org, classified and
  against budget, on one screen. Built on Cloudflare Artifacts, Workers, Workflows,
  AI Gateway and the Agents SDK."

## Review decisions

Four pushes are held for a person and saved for filming. One take per commit (a decision can't be undone), so these
are the decisions and the reasons to type, settled before recording:

| Review | Decision | When | Reason to type |
| --- | --- | --- | --- |
| agents-demo-full@attempt/haiku | **Approve** | On camera, 7:15 | Shared bucket and approved model; deps are standard Workers tooling. |
| agents-demo-full@attempt/sonnet | **Reject** | On camera, 7:15 | Superseded by attempt-haiku: same task, both clean; haiku is the smaller change (+102 vs +142 lines) at about a tenth of the cost ($0.008 vs $0.081). |
| uploads-bare@main | **Reject** | After the take | Unapproved models (llava-1.5-7b, llama-3-8b), model calls bypass the org gateway, and an unlisted bucket (uploads-bare-files). |
| uploads-smart@main | **Approve** | After the take | Only change is the approved shared bucket (UPLOADS → acme-shared-uploads); no catalog findings. |

Why reject attempt-sonnet rather than leave it open: it passed every check, so nothing else would stop it. Two
mergeable attempts at one task invite a second merge of the same feature, and an open review counts against the
review queue and SLA on the Org tab. Rejecting it with the comparison as the reason closes the loop on the record,
and shows the human gate saying no to a change that is fine but not the best. The ranking already picked haiku
(clean first, then least overlap, then smallest diff, then cheapest); the reviewer confirms it.

The two uploads decisions happen after the take so beat 2 keeps showing both as "needs human review" and beat 0's
Org tab shows four waiting. Decide them in the same session, after the last take that needs them.

## Cut for time

Trimmed from 10:25 to 9:45, loading waits first: the second file jump in the Code tab (another Artifacts read), the
live claude-plugins analysis (pre-loaded in a second tab instead), the wait for the live push to arrive (edited out),
and the optional "push blocked, then resolved" beat (below, for a longer cut).

- **A push is blocked, then resolved (about 10s, after "Agents at work").** Expand "Why mcp-agent was blocked…". Terminal inset: the push prints
  "✗ 2 conflict(s)" and is refused; after the contract layer is amended, the same push goes through.
  **Narration:** "The MCP agent touched packages/, right where the contract and the project disagree, so the hook
  stopped it. A person amends the contract, and the same push goes through. That's the loop: the agent moves fast,
  a person makes the calls only a person should make."

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
# attempts (already recorded; re-run only for fresh numbers, about $0.15)
node scripts/demo-attempts.ts
```

A review is one Workflow instance per commit (its id comes from repo, branch and commit), so replaying the same push
is ignored as a duplicate. To get a fresh "needs human review" for a retake, push a new commit to the attempt branch:
`node scripts/demo-attempts.ts --only attempt-haiku --compare-only` won't do it; run it without `--compare-only`
(about $0.01 for Haiku), which force-pushes a new commit to `attempt/haiku` and starts a new review.

Deep links used in the shots (append to the dashboard URL):

```text
#org
#code?repo=agents-demo-full&ref=main&path=packages%2Fagents%2FAGENTS.md&line=7
#code?repo=agents-demo-r2&ref=main&tab=history
#code?repo=claude-plugins&ref=master&path=plugins%2Fsession-metrics%2Fskills%2Fsession-metrics%2FSKILL.md
#parallel
```
