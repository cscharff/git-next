export const COMMANDS = ["rules", "check", "resources", "context", "cost", "init", "new", "help"] as const;
export type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
	command: Command;
	positionals: string[];
	json: boolean;
	quiet: boolean;
	verbose: boolean;
	/** Call the Worker's /insights and /context for this Artifacts repo instead of reading the working tree. */
	remote?: string;
	workerUrl: string;
	ref?: string;
	base?: string;
	strict: boolean;
	layers?: string;
	budget: number;
	print: boolean;
	fork?: string;
	repo?: string;
	/** Catalog file to enforce when the repo has none (else the --layers project's catalog.json, if any). */
	catalog?: string;
	/** Fail open: report loading/extraction errors but do not block (rules/check). */
	allowOnError: boolean;
	/** Read NUL- or newline-separated paths from stdin (for hooks; avoids shell word splitting). */
	pathsFromStdin: boolean;
	hookJson: boolean;
	/** init/new: org baseline folder (default: GIT_NEXT_ORG or the bundled fixtures/org-baseline). */
	org?: string;
	template: string;
	name?: string;
	owner?: string;
	/** init/new --remote: show the Artifacts repo that would be created (dry run; not implemented yet). */
	initRemote: boolean;
	keep: boolean;
}

export class UsageError extends Error {}

type FlagSpec = { key: keyof ParsedArgs; type: "bool" | "string" | "number"; commands?: Command[] };
const FLAGS: Record<string, FlagSpec> = {
	"--json": { key: "json", type: "bool" },
	"--quiet": { key: "quiet", type: "bool" },
	"-q": { key: "quiet", type: "bool" },
	"--verbose": { key: "verbose", type: "bool" },
	"-v": { key: "verbose", type: "bool" },
	"--remote": { key: "remote", type: "string" },
	"--worker-url": { key: "workerUrl", type: "string" },
	"--ref": { key: "ref", type: "string" },
	"--base": { key: "base", type: "string", commands: ["resources"] },
	"--strict": { key: "strict", type: "bool", commands: ["resources"] },
	"--layers": { key: "layers", type: "string", commands: ["rules", "context"] },
	"--budget": { key: "budget", type: "number", commands: ["context"] },
	"--print": { key: "print", type: "bool", commands: ["context"] },
	"--fork": { key: "fork", type: "string", commands: ["cost"] },
	"--repo": { key: "repo", type: "string", commands: ["cost"] },
	"--catalog": { key: "catalog", type: "string", commands: ["rules", "check", "context"] },
	"--allow-on-error": { key: "allowOnError", type: "bool", commands: ["rules", "check"] },
	"--paths-from-stdin": { key: "pathsFromStdin", type: "bool", commands: ["rules", "check"] },
	"--hook-json": { key: "hookJson", type: "bool", commands: ["check"] },
	"--org": { key: "org", type: "string", commands: ["init", "new"] },
	"--template": { key: "template", type: "string", commands: ["init", "new"] },
	"--name": { key: "name", type: "string", commands: ["init", "new"] },
	"--owner": { key: "owner", type: "string", commands: ["init", "new"] },
	"--keep": { key: "keep", type: "bool", commands: ["init", "new"] },
};

/** Parses `git next <command> [args] [flags]`. Supports `--flag value` and `--flag=value`. */
export function parseArgs(argv: string[]): ParsedArgs {
	const [cmd, ...rest] = argv;
	const command = (cmd === undefined || cmd === "-h" || cmd === "--help" ? "help" : cmd) as Command;
	if (!COMMANDS.includes(command)) throw new UsageError(`unknown command "${cmd}" (expected ${COMMANDS.filter((c) => c !== "help").join(", ")})`);
	const out: ParsedArgs = {
		command,
		positionals: [],
		json: false,
		quiet: false,
		verbose: false,
		workerUrl: "http://localhost:5173",
		strict: false,
		budget: 4000,
		print: false,
		allowOnError: false,
		pathsFromStdin: false,
		hookJson: false,
		template: "worker-api",
		initRemote: false,
		keep: false,
	};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--") {
			out.positionals.push(...rest.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			out.positionals.push(arg);
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			out.command = "help";
			continue;
		}
		if (arg === "--remote" && (command === "init" || command === "new")) {
			out.initRemote = true;
			continue;
		}
		const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const spec = FLAGS[name];
		if (!spec) throw new UsageError(`unknown option ${name}`);
		if (spec.commands && !spec.commands.includes(command)) throw new UsageError(`${name} is not valid for "${command}"`);
		if (spec.type === "bool") {
			if (inline !== undefined) throw new UsageError(`${name} takes no value`);
			(out as any)[spec.key] = true;
			continue;
		}
		const value = inline ?? rest[++i];
		if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`${name} needs a value`);
		if (spec.type === "number") {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive integer`);
			(out as any)[spec.key] = n;
		} else (out as any)[spec.key] = value;
	}
	if ((out.command === "init" || out.command === "new") && out.positionals.length !== 1) throw new UsageError(`${out.command} needs exactly one directory/name, e.g. git next new uploads-api --template worker-api`);
	if ((out.command === "init" || out.command === "new") && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test((out.name ?? out.positionals[0]).split("/").pop()!)) throw new UsageError("project name may only contain letters, digits, '.', '_' and '-'");
	if (!/^[a-z0-9-]+$/.test(out.template)) throw new UsageError("--template must be a template name like worker-api");
	if (out.command === "context" && !out.positionals.length) throw new UsageError('context needs a task, e.g. git next context "fix the reconnect loop" src/mcp/client.ts');
	if (out.remote && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.remote)) throw new UsageError("--remote must be an Artifacts repo name");
	return out;
}

export const USAGE = `git next <command> [options]

Commands
  new <name> [--template worker-api] [--org <baseline>]   Create a repo that inherits org layers, catalog and hook
  init <dir> [--org <baseline>]   Same as new, for a directory path (--remote: dry run of the Artifacts repo)
  rules [paths...]             Instruction layers, winning rules, conflicts, drift and catalog violations (exit 1 on any)
  check [paths...] --hook-json  {"action":"allow"|"block","reason"} for agent tool hooks
  resources [--base <ref>]     Workers and bindings from wrangler configs; --strict exits 1 if bindings were added
  context "<task>" [paths...]  Task-sized context: rules for the paths + best doc sections within --budget tokens
  cost [--fork <name>]         AI Gateway spend by developer/fork/agent/task (gateway logs via .dev.vars, else fixture)

Options
  --json                 Machine-readable output for agents
  -q, --quiet            Only print problems (rules) or nothing (exit code only)
  -v, --verbose          Include overrides and full details
  --ref <ref>            Analyse a commit/branch instead of the working tree
  --layers <stack.json>  Add org/contract/tool/personal layers (paths relative to the stack file's project)
  --remote <repo>        Ask the git.next Worker about an Artifacts repo instead of the working tree
  --worker-url <url>     Worker for --remote (default http://localhost:5173)
  --catalog <file>       Enforce this catalog when the repo has none of its own
  --allow-on-error       rules/check: don't block on loading or extraction errors (default: fail closed)
  --paths-from-stdin     rules/check: read paths (NUL or newline separated) from stdin
  --budget <tokens>      context: token budget (default 4000)
  --print                context: print the selected sections' text
  --repo <name>          cost: repo name in gateway metadata (default: this directory's name)
`;
