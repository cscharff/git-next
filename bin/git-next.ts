#!/usr/bin/env node
// `git next <command>`: git runs any `git-next` executable on PATH as the `next` subcommand.
import { runCli } from "../src/cli/main.ts";

process.exitCode = await runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: { CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, AIG_LOGS_TOKEN: process.env.AIG_LOGS_TOKEN, GIT_NEXT_ORG: process.env.GIT_NEXT_ORG },
	stdin: async () => {
		let text = "";
		for await (const chunk of process.stdin) text += chunk;
		return text;
	},
});
