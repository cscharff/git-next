# Demo instruction layers

Hypothetical layers for demoing the instruction stack on top of a real repo's own AGENTS.md files.
`.gitnext/stack.json` wires them in; each layer's `repo` is `git-next-demo-layers` (this folder),
so they can be served from one Artifacts repo or from these files offline.

| Layer | Rank | What it adds |
| --- | --- | --- |
| org | 1 | Only approved model providers; models only through the org AI Gateway (must) |
| contract | 2 | SOW ticket ID in commit messages (must); skip changesets for internal fixes (must) |
| project | 3 | The repo's own AGENTS.md / CLAUDE.md files (deeper directories win within this rank) |
| tool | 4 | Run a security scan before opening a PR |
| personal | 5 | Prefers npm and Prettier |
| private | 1, `env: private` | No data leaves the network: models run on-prem (used by `fixtures/demo-environments/stack.json`; the private environment is mocked) |
