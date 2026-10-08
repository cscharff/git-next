import type { ChangedFile } from "./core/repo-context.ts";
import type { Catalog } from "./providers/catalog.ts";
import { isWranglerConfig, parseWranglerConfig } from "./providers/resource-map.ts";
import { checkChange } from "./work.ts";

// Push review: every push runs through the PushReview Workflow (analyse → index → classify → human review if
// sensitive → decision). This module holds the pure parts: what makes a change sensitive, and the review record the
// dashboard shows (status, timeline, reasons, decision).

export interface SensitiveReason {
	kind: "instructions" | "org-config" | "infrastructure" | "secrets" | "ci-hooks-plugins" | "dependencies" | "catalog";
	path: string;
	why: string;
}

const RULES: { kind: SensitiveReason["kind"]; test: (p: string) => boolean; why: string }[] = [
	{ kind: "instructions", test: (p) => /(^|\/)(AGENTS|CLAUDE|GEMINI|SKILL)\.md$|(^|\/)agent\.ya?ml$|(^|\/)\.(claude|agents)\//.test(p), why: "changes instructions agents follow" },
	{ kind: "org-config", test: (p) => /^\.gitnext\//.test(p), why: "changes git.next config (stack, catalog or memory)" },
	{ kind: "secrets", test: (p) => /(^|\/)\.env[^/]*$|(^|\/)\.dev\.vars[^/]*$|\.(pem|key|p12)$/.test(p) && !/\.example$/.test(p), why: "touches a secrets file" },
	{ kind: "ci-hooks-plugins", test: (p) => /^\.github\/workflows\/|^\.husky\/|(^|\/)hooks\/hooks\.json$|(^|\/)\.claude-plugin\/|(^|\/)\.mcp\.json$/.test(p), why: "changes CI, git hooks, plugins or MCP servers" },
];

const bindingKeys = (path: string, text: string | null) => (text == null ? new Set<string>() : new Set(parseWranglerConfig(path, text).bindings.map((b) => `${b.type}:${b.name}${b.resource ? `→${b.resource}` : ""}`)));
function dependencyNames(text: string | null): Set<string> {
	if (text == null) return new Set();
	try {
		const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
		return new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {})));
	} catch {
		return new Set();
	}
}

/**
 * Why a change needs a person to look at it before it can merge (empty: it doesn't). Reads the changed files only:
 * instruction and config paths, new bindings in wrangler configs, new dependencies, and catalog findings in the change.
 */
export async function classifyChange(changed: ChangedFile[], read: (path: string, side: "before" | "after") => Promise<string | null>, catalog: Catalog): Promise<SensitiveReason[]> {
	const reasons: SensitiveReason[] = [];
	const after: { path: string; text: string }[] = [];
	for (const f of changed.slice(0, 200)) {
		for (const r of RULES) if (r.test(f.path)) reasons.push({ kind: r.kind, path: f.path, why: `${f.status === "removed" ? "removes" : f.status === "added" ? "adds" : "modifies"} a file that ${r.why}` });
		const [before, now] = await Promise.all([f.status === "added" ? null : read(f.path, "before"), f.status === "removed" ? null : read(f.path, "after")]);
		if (now != null) after.push({ path: f.path, text: now });
		if (isWranglerConfig(f.path)) {
			const was = bindingKeys(f.path, before);
			const added = [...bindingKeys(f.path, now)].filter((b) => !was.has(b));
			if (added.length) reasons.push({ kind: "infrastructure", path: f.path, why: `adds binding${added.length > 1 ? "s" : ""} ${added.join(", ")}` });
		}
		if (/(^|\/)package\.json$/.test(f.path)) {
			const was = dependencyNames(before);
			const added = [...dependencyNames(now)].filter((d) => !was.has(d));
			if (added.length) reasons.push({ kind: "dependencies", path: f.path, why: `adds dependenc${added.length > 1 ? "ies" : "y"} ${added.slice(0, 5).join(", ")}${added.length > 5 ? "…" : ""}` });
		}
	}
	for (const finding of checkChange(after, catalog)) reasons.push({ kind: "catalog", path: finding.path, why: `${finding.title}${finding.line ? ` (line ${finding.line})` : ""}` });
	return reasons;
}

export type ReviewStatus = "running" | "needs-review" | "approved" | "rejected" | "auto-approved" | "expired" | "failed";

export interface ReviewStep {
	name: string;
	at: string;
	ms: number;
	detail?: string;
}

export interface ReviewRecord {
	repo: string;
	ref: string;
	after: string;
	before: string | null;
	instanceId: string;
	status: ReviewStatus;
	startedAt: string;
	updatedAt: string;
	commit: { message: string; author: string } | null;
	reasons: SensitiveReason[];
	steps: ReviewStep[];
	decision?: { by: string; at: string; decision: "approve" | "reject"; reason: string };
	summary?: { conflicts: number; catalogViolations: number; warnings: number; insights: number };
}

export const reviewKey = (repo: string, ref: string, after: string) => `review/${repo}/${ref}/${after}`;
/** Workflow instance ids: letters, digits, - and _ only, at most 100 characters. */
export const instanceIdFor = (repo: string, ref: string, after: string) => `${repo}-${ref}-${after.slice(0, 12)}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);

/** Merge gate: a change may merge once it's approved, or when nothing in it needed review. */
export const mergeAllowed = (r: Pick<ReviewRecord, "status"> | null | undefined) => r?.status === "approved" || r?.status === "auto-approved";

/** Validates a reviewer's decision; reasons go in the audit trail, so they must say something. */
export function parseDecision(body: unknown): { repo: string; ref: string; after: string; decision: "approve" | "reject"; reason: string } | string {
	const b = body as Record<string, unknown> | null;
	if (!b || typeof b !== "object") return "body must be JSON";
	const { repo, ref, after, decision, reason } = b as Record<string, string>;
	if (typeof repo !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) return "repo is required";
	if (typeof ref !== "string" || !/^[\w./-]{1,100}$/.test(ref)) return "ref is required";
	if (typeof after !== "string" || !/^[0-9a-f]{40}$/.test(after)) return "after must be a commit hash";
	if (decision !== "approve" && decision !== "reject") return "decision must be approve or reject";
	if (typeof reason !== "string" || reason.trim().length < 10) return "reason must be at least 10 characters";
	return { repo, ref, after, decision, reason: reason.trim().slice(0, 500) };
}
