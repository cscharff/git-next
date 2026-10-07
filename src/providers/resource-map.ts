import { parseJsonc } from "../parse/jsonc.ts";
import { parseToml } from "../parse/toml.ts";
import type { Insight, InsightProvider } from "../core/types.ts";

export const BINDING_TYPES = [
	"durable_objects",
	"kv_namespaces",
	"r2_buckets",
	"d1_databases",
	"queues",
	"workflows",
	"ai",
	"vectorize",
	"hyperdrive",
	"services",
	"containers",
	"browser",
	"artifacts",
] as const;
export type BindingType = (typeof BINDING_TYPES)[number];

export interface Binding {
	type: BindingType;
	/** The env property name, or the container class for containers. */
	name: string;
	/** The underlying resource (bucket, class, database, queue, service...) when declared. */
	resource?: string;
}

export interface WorkerResources {
	path: string;
	worker: string;
	bindings: Binding[];
	error?: string;
}

export const isWranglerConfig = (path: string) => /(^|\/)wrangler\.(toml|json|jsonc)$/.test(path);

type Obj = Record<string, any>;
const asArray = (v: unknown): Obj[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v as Obj] : []);

/** Extracts the Worker name and bindings from a parsed wrangler config (top-level env only). */
export function extractBindings(config: Obj): Binding[] {
	const out: Binding[] = [];
	const add = (type: BindingType, name: unknown, resource?: unknown) => {
		if (typeof name === "string" && name) out.push({ type, name, ...(resource ? { resource: String(resource) } : {}) });
	};
	for (const b of asArray(config.durable_objects?.bindings)) add("durable_objects", b.name, b.script_name ? `${b.script_name}:${b.class_name}` : b.class_name);
	for (const b of asArray(config.kv_namespaces)) add("kv_namespaces", b.binding, b.id);
	for (const b of asArray(config.r2_buckets)) add("r2_buckets", b.binding, b.bucket_name);
	for (const b of asArray(config.d1_databases)) add("d1_databases", b.binding, b.database_name ?? b.database_id);
	for (const b of asArray(config.queues?.producers)) add("queues", b.binding, b.queue);
	for (const b of asArray(config.queues?.consumers)) add("queues", `consumer:${b.queue}`, b.queue);
	for (const b of asArray(config.workflows)) add("workflows", b.binding, b.class_name ?? b.name);
	if (config.ai) add("ai", config.ai.binding);
	for (const b of asArray(config.vectorize)) add("vectorize", b.binding, b.index_name);
	for (const b of asArray(config.hyperdrive)) add("hyperdrive", b.binding, b.id);
	for (const b of asArray(config.services)) add("services", b.binding, b.entrypoint ? `${b.service}#${b.entrypoint}` : b.service);
	for (const b of asArray(config.containers)) add("containers", b.class_name ?? b.name, b.image);
	if (config.browser) add("browser", config.browser.binding);
	for (const b of asArray(config.artifacts)) add("artifacts", b.binding, b.namespace);
	return out;
}

export function parseWranglerConfig(path: string, text: string): WorkerResources {
	try {
		const config = (path.endsWith(".toml") ? parseToml(text) : parseJsonc(text)) as Obj;
		return { path, worker: typeof config.name === "string" ? config.name : "(unnamed)", bindings: extractBindings(config) };
	} catch (err) {
		return { path, worker: "(unparseable)", bindings: [], error: String(err) };
	}
}

const key = (b: Binding) => `${b.type}:${b.name}:${b.resource ?? ""}`;

export interface BindingDiff {
	added: Binding[];
	removed: Binding[];
	unchanged: Binding[];
}

export function diffBindings(base: Binding[], head: Binding[]): BindingDiff {
	const baseKeys = new Set(base.map(key));
	const headKeys = new Set(head.map(key));
	return {
		added: head.filter((b) => !baseKeys.has(key(b))),
		removed: base.filter((b) => !headKeys.has(key(b))),
		unchanged: head.filter((b) => baseKeys.has(key(b))),
	};
}

function byType(bindings: Binding[]) {
	const out: Partial<Record<BindingType, Binding[]>> = {};
	for (const b of bindings) (out[b.type] ??= []).push(b);
	return out;
}

export const resourceMapProvider: InsightProvider = {
	id: "resource-map",
	title: "Resource map",
	needs: ["tree", "files"],
	async analyze({ repo, ref, base, files }) {
		const load = async (r: string) => {
			const configs = await files.find(repo, r, isWranglerConfig);
			return Promise.all(configs.map(async (f) => parseWranglerConfig(f.path, (await files.readFile(repo, r, f.path)) ?? "")));
		};
		const head = await load(ref);
		const baseByPath = base ? new Map((await load(base)).map((w) => [w.path, w])) : undefined;

		const insights: Insight[] = head.map((w) => {
			const diff = baseByPath ? diffBindings(baseByPath.get(w.path)?.bindings ?? [], w.bindings) : undefined;
			const summary = Object.entries(byType(w.bindings)).map(([t, bs]) => `${t}: ${bs!.map((b) => b.name).join(", ")}`);
			return {
				provider: "resource-map",
				severity: w.error ? "warn" : diff && (diff.added.length || diff.removed.length) ? "warn" : "info",
				scope: { repo, ref, path: w.path },
				title: w.error
					? `Could not parse ${w.path}`
					: diff
						? `${w.worker}: +${diff.added.length} −${diff.removed.length} bindings vs ${base}`
						: `${w.worker}: ${w.bindings.length} binding${w.bindings.length === 1 ? "" : "s"}`,
				detail: w.error ?? (summary.join("; ") || "No bindings declared."),
				evidence: [{ repo, path: w.path }],
				metrics: { worker: w.worker, bindings: byType(w.bindings), ...(diff ? { diff, newConfig: !baseByPath!.has(w.path) } : {}) },
			};
		});
		if (baseByPath) {
			const headPaths = new Set(head.map((w) => w.path));
			for (const [path, w] of baseByPath) {
				if (headPaths.has(path)) continue;
				insights.push({
					provider: "resource-map",
					severity: "warn",
					scope: { repo, ref, path },
					title: `${w.worker}: config removed vs ${base}`,
					detail: `${path} exists on ${base} but not on ${ref}; ${w.bindings.length} bindings dropped.`,
					evidence: [{ repo, path }],
					metrics: { worker: w.worker, diff: { added: [], removed: w.bindings, unchanged: [] } },
				});
			}
		}
		return insights;
	},
};
