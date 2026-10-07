#!/bin/sh
# Claude Code PreToolUse adapter: before Claude runs `git commit`, ask git.next about the staged files and deny
# the commit on instruction conflicts, catalog violations or check errors (fail-closed).
# .claude/settings.json: {"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"examples/hooks/claude-code-pretooluse.sh"}]}]}}
cmd=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).tool_input?.command??""))}catch{}})')
case "$cmd" in *"git commit"*) ;; *) exit 0 ;; esac
verdict=$(git diff --cached -z --name-only | git next check --hook-json --paths-from-stdin 2>/dev/null)
[ -n "$verdict" ] || verdict='{"action":"block","reason":"git next check could not run (fail-closed)"}'
printf '%s' "$verdict" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(v.action!=="allow")process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"git.next: "+v.reason}}))})'
