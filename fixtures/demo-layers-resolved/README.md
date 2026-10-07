# Demo instruction layers (resolved)

Same as `../demo-layers`, except the contract layer's changeset rule now defers to the project instead of
saying "skip changesets for internal fixes". Used by `scripts/demo-agents.ts` to show how the mcp-agent's
blocked push is resolved: amend the contract layer, re-run the pre-push check, push.
