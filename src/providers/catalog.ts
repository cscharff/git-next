import type { RepoContext, TreeFile } from "../core/repo-context.ts";
import { isCloud, isResourceKind, type Cloud, type Insight, type InsightProvider, type ResourceKind } from "../core/types.ts";
import { parseJsonc } from "../parse/jsonc.ts";
import { isWranglerConfig, parseWranglerConfig, type BindingType } from "./resource-map.ts";

// Checks a repo against its org's catalog of approved models, resources, tools and checks, and scans for
// inline secrets. Catalog and layer text is data: it is parsed and compared, never executed or interpolated.

export const CATALOG_FILE = ".gitnext/catalog.json";

export interface CatalogShared {
	name: string;
	binding?: string;
	owner?: string;
	how?: string;
}
export interface CatalogBinding {
	/** Wrangler binding type on Cloudflare; a short service id elsewhere (e.g. "s3", "gcs", "minio"). */
	type: BindingType | (string & {});
	/** Default "cloudflare". Entries for other clouds only take part in equivalence checks. */
	cloud?: Cloud;
	/** Equivalence class: R2 (cloudflare), GCS (gcp), S3 (aws) and MinIO (private) are all "object-store". */
	class?: ResourceKind;
	/** Display name of the service (S3, Cloud SQL, MinIO...). */
	service?: string;
	owner?: string;
	/** Glob for resource names (e.g. "acme-*"); shared resources are always allowed. */
	naming?: string;
	shared?: CatalogShared[];
	how?: string;
	rule?: string;
	keywords?: string[];
}
export interface CatalogModel {
	id: string;
	/** Default "cloudflare" (Workers AI or unified billing through the org gateway). */
	cloud?: Cloud;
	/** Equivalence class: the same model served by different clouds (e.g. "claude-sonnet-5"). */
	class?: string;
	jobs?: string[];
	owner?: string;
	rule?: string;
	keywords?: string[];
}
export interface Catalog {
	version: string;
	owner?: string;
	gateway?: { id: string; owner?: string; how?: string; rule?: string };
	models: CatalogModel[];
	bindings: CatalogBinding[];
	tools?: { mcpServers?: { name: string; url?: string; owner?: string }[]; skills?: { name: string; owner?: string }[] };
	checks?: { name: string; command?: string; rule?: string }[];
}

/** Parses and shape-checks a catalog; throws with a readable message rather than trusting the file. */
export function parseCatalog(text: string): Catalog {
	const c = parseJsonc(text) as Partial<Catalog>;
	if (!c || typeof c !== "object") throw new Error("catalog must be a JSON object");
	if (typeof c.version !== "string" || !c.version) throw new Error("catalog.version must be a non-empty string");
	if (!Array.isArray(c.models) || !c.models.every((m) => m && typeof m.id === "string")) throw new Error("catalog.models must be a list of { id }");
	if (!Array.isArray(c.bindings) || !c.bindings.every((b) => b && typeof b.type === "string")) throw new Error("catalog.bindings must be a list of { type }");
	for (const e of [...c.models, ...c.bindings] as { cloud?: unknown }[]) if (e.cloud !== undefined && !isCloud(e.cloud)) throw new Error(`catalog cloud must be one of cloudflare, gcp, aws, private (got ${JSON.stringify(e.cloud)})`);
	for (const b of c.bindings) if (b.class !== undefined && !isResourceKind(b.class)) throw new Error(`catalog binding class ${JSON.stringify(b.class)} is not a resource kind`);
	return c as Catalog;
}

export const cloudOf = (e: { cloud?: Cloud }): Cloud => e.cloud ?? "cloudflare";
/** Cloudflare entries only: what Cloudflare repos are checked against and what agents are told. */
const cf = <T extends { cloud?: Cloud }>(xs: T[]) => xs.filter((x) => cloudOf(x) === "cloudflare");

/** Display name of a catalog binding entry (its service, or the binding type on Cloudflare). */
const serviceName = (b: CatalogBinding) => b.service ?? b.type;

export interface EquivalentApproval {
	approved: boolean;
	reason?: string;
	alternative?: string;
	/** Every approved service in the same class, per cloud. */
	equivalents: { cloud: Cloud; service: string }[];
}

/**
 * Approval of a resource on any cloud by its equivalence class: S3 on aws is approved when the catalog lists an
 * object-store entry for aws naming S3. Cloudflare resources match by binding type, others by service name.
 */
export function equivalentApproval(catalog: Catalog, r: { cloud: Cloud; kind: ResourceKind; service: string; type?: string }): EquivalentApproval {
	const inClass = catalog.bindings.filter((b) => b.class === r.kind);
	const equivalents = inClass.map((b) => ({ cloud: cloudOf(b), service: serviceName(b) }));
	const here = inClass.filter((b) => cloudOf(b) === r.cloud);
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (here.some((b) => (r.type && b.type === r.type) || norm(serviceName(b)) === norm(r.service) || norm(b.type) === norm(r.service))) return { approved: true, equivalents };
	const elsewhere = equivalents.filter((e) => e.cloud !== r.cloud).map((e) => `${e.service} (${e.cloud})`);
	return {
		approved: false,
		reason: here.length ? `${r.service} is not an approved ${r.kind} on ${r.cloud}` : `the catalog approves no ${r.kind} on ${r.cloud}`,
		alternative: here.length ? `approved on ${r.cloud}: ${here.map(serviceName).join(", ")}` : elsewhere.length ? `approved elsewhere: ${elsewhere.join(", ")}` : undefined,
		equivalents,
	};
}

/** Approved models in the same equivalence class on other clouds (planning-only entries excluded). */
export function equivalentModels(catalog: Catalog, model: string): CatalogModel[] {
	const entry = catalogModel(catalog, model);
	if (!entry?.class) return [];
	return catalog.models.filter((m) => m !== entry && m.class === entry.class && cloudOf(m) !== cloudOf(entry) && !planningOnly(m));
}

/** Orders dotted/dashed versions numerically ("2026.10.2" > "2026.9.10"). */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
	const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return a.localeCompare(b);
}

const globToRegExp = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

// ── scanners ──────────────────────────────────────────────────────────────────

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|json|jsonc|toml|ya?ml)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|\.wrangler)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|^\.gitnext\//;
const MODEL_ID = /@cf\/[a-z0-9-]+\/[a-z0-9._-]+|\b(?:anthropic|openai|google|mistral|deepseek)\/[a-z0-9._-]+|\bclaude-(?:opus|sonnet|haiku|fable|instant)[a-z0-9.-]*|\bgpt-\d[a-z0-9.-]*|\bgemini-[0-9][a-z0-9.-]*/gi;

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
	{ kind: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
	{ kind: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
	{ kind: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
	{ kind: "Cloudflare API token", re: /\b(?:cf|cloudflare)[_-]?(?:api[_-]?)?token["']?\s*[:=]\s*["'][A-Za-z0-9_-]{40}["']/i },
	{ kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ kind: "hard-coded credential", re: /\b[a-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)[a-z0-9_]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i },
];
// Values that look like placeholders, references or examples rather than real secrets.
const PLACEHOLDER = /^(?:x+|\*+|<.*>|\$\{.*\}|your[-_].*|example.*|changeme|replace[-_]?me.*|todo|test[-_].*|dummy.*|fake.*)$/i;

export interface SecretHit {
	path: string;
	line: number;
	kind: string;
	/** First and last characters only; the secret itself is never stored or printed. */
	masked: string;
}

export function scanSecrets(path: string, text: string): SecretHit[] {
	const hits: SecretHit[] = [];
	text.split(/\r?\n/).forEach((line, i) => {
		for (const { kind, re } of SECRET_PATTERNS) {
			const m = line.match(re);
			if (!m) continue;
			const value = m[1] ?? m[0];
			if (kind === "hard-coded credential" && (PLACEHOLDER.test(value) || /process\.env|env\.|import\.meta/.test(line))) continue;
			hits.push({ path, line: i + 1, kind, masked: value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-2)}` : "…" });
			break;
		}
	});
	return hits;
}

export function scanModels(path: string, text: string): { path: string; line: number; model: string }[] {
	const out: { path: string; line: number; model: string }[] = [];
	text.split(/\r?\n/).forEach((line, i) => {
		for (const m of line.matchAll(MODEL_ID)) out.push({ path, line: i + 1, model: m[0].replace(/[.,]+$/, "") });
	});
	return out;
}

const bareModel = (id: string) => id.toLowerCase().replace(/^(anthropic|openai|google|mistral|deepseek)\//, "");

/** The catalog entry for a model id; "claude-sonnet-5" matches "anthropic/claude-sonnet-5". */
export function catalogModel(catalog: Catalog, model: string): CatalogModel | undefined {
	return catalog.models.find((m) => m.id.toLowerCase() === model.toLowerCase() || bareModel(m.id) === bareModel(model));
}

/** Models approved only for planning/orchestration must not appear in application code. */
export const planningOnly = (m: CatalogModel) => !!m.jobs?.length && m.jobs.every((j) => j === "planning");

/** Whether a model id is approved for use in application code. */
export function modelApproved(catalog: Catalog, model: string): boolean {
	const entry = catalogModel(catalog, model);
	return !!entry && !planningOnly(entry);
}

/** Approval of one binding against the catalog, with the approved alternative when it fails. */
export function bindingApproval(catalog: Catalog, type: string, resource?: string): { approved: boolean; reason?: string; alternative?: string } {
	const entry = cf(catalog.bindings).find((b) => b.type === type);
	if (!entry) return { approved: false, reason: `binding type ${type} is not in the catalog`, alternative: `approved types: ${cf(catalog.bindings).map((b) => b.type).join(", ")}` };
	if (!resource || !["r2_buckets", "kv_namespaces", "d1_databases", "queues", "vectorize"].includes(type)) return { approved: true };
	const name = resource.replace(/^.*:/, "");
	if (entry.shared?.some((s) => s.name === name)) return { approved: true };
	if (entry.naming && globToRegExp(entry.naming).test(name)) return { approved: true };
	const shared = entry.shared?.map((s) => `${s.binding ?? "?"} → ${s.name}`).join(", ");
	return {
		approved: false,
		reason: `${type} resource "${name}" is not listed in the catalog${entry.naming ? ` and does not match ${entry.naming}` : ""}`,
		alternative: shared ? `use the shared ${shared}${entry.naming ? `, or name it ${entry.naming}` : ""}` : entry.naming ? `name it ${entry.naming}` : undefined,
	};
}

// ── provider ──────────────────────────────────────────────────────────────────

export interface CatalogFinding {
	kind: "model" | "binding" | "gateway" | "secret";
	title: string;
	detail: string;
	evidence: { path: string; line?: number }[];
}

export interface CatalogCheck {
	source: "repo" | "org" | "none";
	catalog?: Catalog;
	repoVersion?: string;
	baselineVersion?: string;
	behind: boolean;
	scannedFiles: number;
	totalFiles: number;
	findings: CatalogFinding[];
	errors: string[];
}

export interface CatalogOptions {
	/** The org's current catalog: used when the repo has none, and to tell whether the repo is behind. */
	baseline?: Catalog;
	/** Check repos without their own catalog against the baseline (org-wide enforcement). */
	enforceBaseline?: boolean;
	/** Cap on files read for model and secret scans (config files are always read). */
	maxFiles?: number;
	/** Without a catalog, scan only wrangler and env files for secrets (keeps big repos cheap in the Worker). */
	configOnlyWithoutCatalog?: boolean;
}

export async function checkCatalog(files: RepoContext, repo: string, ref: string, opts: CatalogOptions = {}): Promise<CatalogCheck> {
	const errors: string[] = [];
	let repoCatalog: Catalog | undefined;
	const raw = await files.readFile(repo, ref, CATALOG_FILE);
	if (raw != null) {
		try {
			repoCatalog = parseCatalog(raw);
		} catch (err) {
			errors.push(`${CATALOG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const catalog = repoCatalog ?? (opts.enforceBaseline ? opts.baseline : undefined);
	const source = repoCatalog ? "repo" : catalog ? "org" : "none";
	const tree = await files.readTree(repo, ref);
	const configs = tree.filter((f) => isWranglerConfig(f.path) && !SKIP_PATH.test(f.path));
	const scannable = tree.filter((f) => !SKIP_PATH.test(f.path) && (CODE_FILE.test(f.path) || /(^|\/)\.env[^/]*$|\.dev\.vars$/.test(f.path)));
	const max = opts.maxFiles ?? 2000;
	// Config files first so they are always covered, then the rest up to the cap.
	const envFiles = scannable.filter((f) => /(^|\/)\.env[^/]*$|\.dev\.vars$/.test(f.path));
	const toScan: TreeFile[] = !catalog && opts.configOnlyWithoutCatalog ? [...configs, ...envFiles] : [...configs, ...scannable.filter((f) => !isWranglerConfig(f.path))].slice(0, max);
	const findings: CatalogFinding[] = [];

	const texts = await Promise.all(toScan.map(async (f) => ({ path: f.path, text: (await files.readFile(repo, ref, f.path)) ?? "" })));
	for (const { path, text } of texts) {
		for (const s of scanSecrets(path, text)) findings.push({ kind: "secret", title: `Inline secret: ${s.kind}`, detail: `${s.kind} written into ${path}:${s.line} (${s.masked}). Use wrangler secret put / .dev.vars instead.`, evidence: [{ path, line: s.line }] });
	}
	if (catalog) {
		const unapproved = new Map<string, { path: string; line: number }[]>();
		for (const { path, text } of texts) {
			for (const m of scanModels(path, text)) if (!modelApproved(catalog, m.model)) unapproved.set(m.model, [...(unapproved.get(m.model) ?? []), { path, line: m.line }]);
			if (/\.AI\.run\s*\(/.test(text) && catalog.gateway && !text.includes(catalog.gateway.id)) {
				const line = text.split(/\r?\n/).findIndex((l) => /\.AI\.run\s*\(/.test(l)) + 1;
				findings.push({ kind: "gateway", title: "Model call bypasses the org gateway", detail: `${path}:${line} calls env.AI.run without gateway "${catalog.gateway.id}". ${catalog.gateway.how ? `Approved: ${catalog.gateway.how}` : ""}`.trim(), evidence: [{ path, line }] });
			}
		}
		for (const [model, where] of unapproved) {
			const approved = cf(catalog.models).filter((m) => !planningOnly(m)).map((m) => `${m.id}${m.jobs?.length ? ` (${m.jobs.join("/")})` : ""}`).join(", ");
			const entry = catalogModel(catalog, model);
			findings.push(
				entry
					? { kind: "model", title: `Planning-only model in code: ${model}`, detail: `${model} is approved for ${entry.jobs!.join("/")} only (${entry.rule ?? "catalog"}), not for application code. Approved for code: ${approved}.`, evidence: where.slice(0, 5) }
					: { kind: "model", title: `Unapproved model: ${model}`, detail: `${model} is not in catalog ${catalog.version}. Approved: ${approved}.`, evidence: where.slice(0, 5) },
			);
		}
		for (const f of configs) {
			const text = texts.find((t) => t.path === f.path)?.text ?? "";
			const worker = parseWranglerConfig(f.path, text);
			for (const b of worker.bindings) {
				const a = bindingApproval(catalog, b.type, b.resource);
				if (!a.approved) findings.push({ kind: "binding", title: `Unapproved binding: ${b.type} ${b.name}${b.resource ? ` → ${b.resource}` : ""}`, detail: `${worker.worker} (${f.path}): ${a.reason}.${a.alternative ? ` ${a.alternative[0].toUpperCase()}${a.alternative.slice(1)}.` : ""}`, evidence: [{ path: f.path }] });
			}
		}
	}
	const repoVersion = repoCatalog?.version;
	const baselineVersion = opts.baseline?.version;
	return {
		source,
		catalog,
		repoVersion,
		baselineVersion,
		behind: !!(repoVersion && baselineVersion && compareVersions(repoVersion, baselineVersion) < 0),
		scannedFiles: toScan.length,
		totalFiles: scannable.length,
		findings,
		errors,
	};
}

export function catalogProvider(opts: CatalogOptions = {}): InsightProvider {
	return {
		id: "catalog",
		title: "Catalog and secrets",
		needs: ["tree", "files"],
		async analyze({ repo, ref, files }) {
			const c = await checkCatalog(files, repo, ref, opts);
			const summary: Insight = {
				provider: "catalog",
				severity: c.errors.length ? "warn" : c.behind ? "warn" : "info",
				scope: { repo, ref },
				title:
					c.source === "none"
						? "No catalog (secrets scan only)"
						: `Catalog ${c.catalog!.version} (${c.source === "repo" ? "repo" : "org baseline"})${c.behind ? `: behind ${c.baselineVersion}` : ""}`,
				detail: `${c.findings.length} violation(s); scanned ${c.scannedFiles} of ${c.totalFiles} code/config files.${c.errors.length ? ` Errors: ${c.errors.join("; ")}` : ""}`,
				evidence: c.source === "repo" ? [{ repo, path: CATALOG_FILE }] : [],
				metrics: { source: c.source, version: c.catalog?.version ?? null, repoVersion: c.repoVersion ?? null, baselineVersion: c.baselineVersion ?? null, behind: c.behind, scannedFiles: c.scannedFiles, totalFiles: c.totalFiles, byKind: Object.fromEntries([...Map.groupBy(c.findings, (f) => f.kind)].map(([k, v]) => [k, v.length])) },
			};
			return [
				summary,
				...c.findings.map((f): Insight => ({ provider: "catalog", severity: "conflict", scope: { repo, ref, path: f.evidence[0]?.path }, title: f.title, detail: f.detail, evidence: f.evidence.map((e) => ({ repo, ...e })), metrics: { kind: f.kind } })),
			];
		},
	};
}

/** Catalog entries relevant to a task, by keyword: e.g. "uploads" → the approved R2 bucket and its naming rule. */
export function relevantCatalogEntries(catalog: Catalog, task: string): string[] {
	const words = new Set(task.toLowerCase().match(/[a-z0-9]+/g) ?? []);
	const hit = (kw?: string[]) => kw?.some((k) => words.has(k) || words.has(`${k}s`) || words.has(k.replace(/s$/, "")));
	const lines: string[] = [];
	for (const b of cf(catalog.bindings)) {
		if (!hit(b.keywords)) continue;
		lines.push(`${b.type}: approved${b.naming ? `; names must match ${b.naming}` : ""}${b.owner ? `; owner ${b.owner}` : ""}${b.how ? `; bind with ${b.how}` : ""}`);
		for (const s of b.shared ?? []) lines.push(`  shared ${b.type}: ${s.binding ?? ""} → ${s.name}${s.how ? `; ${s.how}` : ""}`);
	}
	for (const m of cf(catalog.models)) if (hit(m.keywords)) lines.push(`model for ${m.jobs?.join("/") ?? "this job"}: ${m.id}`);
	return lines;
}

/** One-paragraph catalog summary for agents' pinned context. */
export function catalogSummary(catalog: Catalog): string {
	const lines = [`Org catalog ${catalog.version}${catalog.owner ? ` (owner ${catalog.owner})` : ""}.`];
	if (catalog.gateway) lines.push(`AI only via gateway "${catalog.gateway.id}"${catalog.gateway.how ? `: ${catalog.gateway.how}` : ""}.`);
	lines.push(`Approved models: ${cf(catalog.models).map((m) => `${m.id}${m.jobs?.length ? ` (${m.jobs.join("/")})` : ""}`).join(", ")}.`);
	lines.push(`Approved binding types: ${cf(catalog.bindings).map((b) => `${b.type}${b.naming ? ` [${b.naming}]` : ""}`).join(", ")}.`);
	const shared = cf(catalog.bindings).flatMap((b) => (b.shared ?? []).map((s) => `${s.binding ?? b.type} → ${s.name}`));
	if (shared.length) lines.push(`Shared resources: ${shared.join(", ")}.`);
	if (catalog.checks?.length) lines.push(`Required checks: ${catalog.checks.map((c) => c.command ?? c.name).join(", ")}.`);
	lines.push("Secrets: never inline; use wrangler secret put or .dev.vars.");
	return lines.join("\n");
}
