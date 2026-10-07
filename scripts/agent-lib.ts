// Shared helpers for the demo agent scripts (demo-agents.ts, demo-new-repo.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readDevVars } from "../src/cli/main.ts";
import { gatewayLogsSource } from "../src/providers/cost/logs.ts";
import { MODELS } from "../src/providers/cost/model-fit.ts";

export type Edit = { path: string; find: string; replace: string } | { path: string; content: string };

export async function workerPost<T>(worker: string, path: string, body: unknown): Promise<T> {
	const res = await fetch(`${worker}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const out = (await res.json()) as T & { error?: string };
	if (!res.ok || out.error) throw new Error(`${path}: ${out.error ?? res.status}`);
	return out;
}

/** AI Gateway logs for spend tracking; needs CF_ACCOUNT_ID + AIG_LOGS_TOKEN in git-next's .dev.vars. */
export function gatewaySource(root: string, gatewayId: string) {
	const vars = readDevVars(join(root, ".dev.vars"));
	if (!vars.CF_ACCOUNT_ID || !vars.AIG_LOGS_TOKEN) throw new Error(".dev.vars needs CF_ACCOUNT_ID and AIG_LOGS_TOKEN for spend tracking");
	return gatewayLogsSource({ accountId: vars.CF_ACCOUNT_ID, gatewayId, token: vars.AIG_LOGS_TOKEN });
}
export const gatewaySpend = async (root: string, gatewayId: string) => (await gatewaySource(root, gatewayId).records({})).reduce((n, r) => n + r.cost, 0);

/** Upper-bound cost estimate for a call, from the model table ($/M tokens). */
export const estimateUsd = (model: string, promptChars: number, maxTokens: number) => {
	const p = MODELS[model] ?? { in: 15, out: 75 };
	return ((promptChars / 3) * p.in + maxTokens * p.out) / 1e6;
};

export function parseEdits(text: string): { summary: string; edits: Edit[] } {
	// Strip only an outer code fence: file contents inside the JSON may contain their own ``` blocks.
	const trimmed = text.trim();
	const unfenced = /^```/.test(trimmed) ? trimmed.replace(/^```[a-z]*\s*\n?/, "").replace(/\n?```\s*$/, "") : trimmed;
	const json = unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1);
	const parsed = JSON.parse(json);
	if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.edits)) throw new Error("model output is not {summary, edits[]}");
	return parsed;
}

/** Applies model edits inside `dir`; `allowed` decides which paths may be touched. Returns a record of each edit. */
export function applyEdits(dir: string, edits: Edit[], allowed: (path: string) => boolean) {
	const done: { path: string; kind: "create" | "edit"; bytes: number }[] = [];
	for (const e of edits) {
		if (typeof e.path !== "string" || e.path.includes("..") || e.path.startsWith("/") || !allowed(e.path)) throw new Error(`edit outside allowed paths: ${e.path}`);
		const abs = join(dir, e.path);
		if ("content" in e) {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, e.content.endsWith("\n") ? e.content : `${e.content}\n`);
			done.push({ path: e.path, kind: "create", bytes: e.content.length });
		} else {
			const before = readFileSync(abs, "utf8");
			const count = before.split(e.find).length - 1;
			if (count !== 1) throw new Error(`find text matched ${count} times in ${e.path}`);
			writeFileSync(abs, before.replace(e.find, e.replace));
			done.push({ path: e.path, kind: "edit", bytes: e.replace.length });
		}
	}
	return done;
}
