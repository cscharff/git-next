import { isCloud, isResourceKind, RESOURCE_KINDS, type Cloud, type EnvScope, type Insight, type InsightProvider, type ResourceKind } from "../core/types.ts";
import { parseJsonc } from "../parse/jsonc.ts";
import { parseToml } from "../parse/toml.ts";
import { CATALOG_FILE, equivalentApproval, parseCatalog, type Catalog } from "./catalog.ts";
import { extractBindings, type BindingType } from "./resource-map.ts";

// Environments the same app runs in, across clouds. Cloudflare environments are read from the repo's real wrangler
// configs; every other cloud is declared in .gitnext/environments.json and is MOCKED: nothing here calls a cloud API
// or holds a credential, and every insight about a mocked environment says so (scope.env.mocked, metrics.mocked).

export const ENVIRONMENTS_FILE = ".gitnext/environments.json";

export interface EnvResource {
	kind: ResourceKind;
	name: string;
	service: string;
	/** "<env>:<resource or binding name>" references this resource sends data to. */
	talksTo?: string[];
	/** Where it came from: a wrangler config path, or the environments file. */
	source?: string;
	/** Wrangler binding type, for Cloudflare resources. */
	binding?: string;
	/** The binding's env name (e.g. UPLOADS) when `name` is the underlying resource (the bucket). */
	alias?: string;
}

export interface Environment {
	name: string;
	cloud: Cloud;
	mocked: boolean;
	app?: string;
	region?: string;
	account?: string;
	/** Cloudflare only: wrangler configs (repo paths) whose bindings make up this environment. */
	wrangler?: string[];
	resources: EnvResource[];
}

export interface EnvironmentsFile {
	app?: string;
	environments: Environment[];
}

/** Parses and shape-checks environments.json. Non-Cloudflare environments are always mocked (there is no live reader). */
export function parseEnvironments(text: string): { file: EnvironmentsFile; errors: string[] } {
	const raw = parseJsonc(text) as { app?: unknown; environments?: unknown };
	if (!raw || typeof raw !== "object" || !Array.isArray(raw.environments)) throw new Error("environments.json needs an environments list");
	const errors: string[] = [];
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const environments: Environment[] = [];
	for (const e of raw.environments as Record<string, unknown>[]) {
		const name = str(e?.name);
		if (!name || !isCloud(e.cloud)) {
			errors.push(`environment ${JSON.stringify(e?.name ?? "?")}: needs a name and a cloud (cloudflare|gcp|aws|private)`);
			continue;
		}
		const resources: EnvResource[] = [];
		for (const r of Array.isArray(e.resources) ? (e.resources as Record<string, unknown>[]) : []) {
			if (!isResourceKind(r?.kind) || !str(r.name) || !str(r.service)) {
				errors.push(`${name}: resource ${JSON.stringify(r?.name ?? "?")} needs kind (${RESOURCE_KINDS.join("|")}), name and service`);
				continue;
			}
			const talksTo = Array.isArray(r.talksTo) ? r.talksTo.filter((t): t is string => typeof t === "string") : undefined;
			resources.push({ kind: r.kind, name: str(r.name)!, service: str(r.service)!, ...(talksTo?.length ? { talksTo } : {}), source: ENVIRONMENTS_FILE });
		}
		const wrangler = typeof e.wrangler === "string" ? [e.wrangler] : Array.isArray(e.wrangler) ? e.wrangler.filter((w): w is string => typeof w === "string") : undefined;
		environments.push({
			name,
			cloud: e.cloud,
			mocked: e.cloud !== "cloudflare" || e.mocked === true,
			...(str(e.app) ? { app: str(e.app) } : {}),
			...(str(e.region) ? { region: str(e.region) } : {}),
			...(str(e.account) ? { account: str(e.account) } : {}),
			...(wrangler?.length ? { wrangler } : {}),
			resources,
		});
	}
	return { file: { app: str(raw.app), environments }, errors };
}

/** Wrangler binding type → normalized kind and service name. Types not listed (services, workflows, browser...) are skipped. */
export const CLOUDFLARE_KINDS: Partial<Record<BindingType | "worker_loaders" | "secrets_store_secrets", { kind: ResourceKind; service: string }>> = {
	r2_buckets: { kind: "object-store", service: "R2" },
	d1_databases: { kind: "sql-db", service: "D1" },
	hyperdrive: { kind: "sql-db", service: "Hyperdrive" },
	kv_namespaces: { kind: "kv-cache", service: "Workers KV" },
	queues: { kind: "queue", service: "Queues" },
	durable_objects: { kind: "compute", service: "Durable Objects" },
	containers: { kind: "compute", service: "Containers" },
	worker_loaders: { kind: "compute", service: "Worker Loaders" },
	ai: { kind: "ai", service: "Workers AI" },
	vectorize: { kind: "vector", service: "Vectorize" },
	secrets_store_secrets: { kind: "secrets", service: "Secrets Store" },
};

/** A wrangler config as environment resources: the Worker itself (compute) plus each mapped binding. */
export function cloudflareResources(path: string, text: string): EnvResource[] {
	const config = (path.endsWith(".toml") ? parseToml(text) : parseJsonc(text)) as Record<string, any>;
	const out: EnvResource[] = [];
	if (typeof config.name === "string") out.push({ kind: "compute", name: config.name, service: "Workers", source: path, binding: "workers" });
	const add = (type: keyof typeof CLOUDFLARE_KINDS, name: string, resource?: string) => {
		const m = CLOUDFLARE_KINDS[type];
		if (m && !out.some((r) => r.binding === type && r.name === (resource ?? name))) out.push({ kind: m.kind, name: resource ?? name, service: m.service, source: path, binding: type, ...(resource && resource !== name ? { alias: name } : {}) });
	};
	for (const b of extractBindings(config)) add(b.type, b.name, b.type === "ai" ? undefined : b.resource);
	// Not in the resource map's binding list (yet); read straight from the config.
	for (const b of Array.isArray(config.worker_loaders) ? config.worker_loaders : []) if (typeof b?.binding === "string") add("worker_loaders", b.binding);
	for (const b of Array.isArray(config.secrets_store_secrets) ? config.secrets_store_secrets : []) if (typeof b?.binding === "string") add("secrets_store_secrets", b.binding, b.secret_name);
	return out;
}

export interface MatrixCell {
	service: string;
	name: string;
	/** null when the catalog has nothing to say (no catalog, or the Worker script itself). */
	approved: boolean | null;
	reason?: string;
	alternative?: string;
}

export interface EnvironmentsReport {
	app?: string;
	environments: Environment[];
	kinds: ResourceKind[];
	/** kind → environment name → resources of that kind. */
	matrix: Record<string, Record<string, MatrixCell[]>>;
	drift: { kind: ResourceKind; services: { env: string; cloud: Cloud; mocked: boolean; services: string[] }[] }[];
	edges: { from: { env: string; cloud: Cloud; mocked: boolean; resource: string; kind: ResourceKind; service: string }; to: { env: string; cloud: Cloud; mocked: boolean; resource: string; kind: ResourceKind; service: string } }[];
	unresolved: string[];
	errors: string[];
}

/** Builds the kinds × environments matrix, drift between services of the same kind, and cross-cloud edges. */
export function analyzeEnvironments(file: EnvironmentsFile, catalog?: Catalog, errors: string[] = []): EnvironmentsReport {
	const envs = file.environments;
	const matrix: EnvironmentsReport["matrix"] = {};
	for (const env of envs) {
		for (const r of env.resources) {
			const a = catalog && r.binding !== "workers" ? equivalentApproval(catalog, { cloud: env.cloud, kind: r.kind, service: r.service, type: r.binding }) : undefined;
			((matrix[r.kind] ??= {})[env.name] ??= []).push({ service: r.service, name: r.name, approved: a ? a.approved : null, ...(a?.reason ? { reason: a.reason } : {}), ...(a?.alternative ? { alternative: a.alternative } : {}) });
		}
	}
	const kinds = RESOURCE_KINDS.filter((k) => matrix[k]);
	const drift: EnvironmentsReport["drift"] = [];
	for (const kind of kinds) {
		const per = envs.filter((e) => matrix[kind][e.name]).map((e) => ({ env: e.name, cloud: e.cloud, mocked: e.mocked, services: [...new Set(matrix[kind][e.name].map((c) => c.service))] }));
		const distinct = new Set(per.flatMap((p) => p.services.map((s) => s.toLowerCase())));
		if (per.length >= 2 && distinct.size >= 2) drift.push({ kind, services: per });
	}
	const edges: EnvironmentsReport["edges"] = [];
	const unresolved: string[] = [];
	const ref = (env: Environment, r: EnvResource) => ({ env: env.name, cloud: env.cloud, mocked: env.mocked, resource: r.name, kind: r.kind, service: r.service });
	for (const env of envs) {
		for (const r of env.resources) {
			for (const t of r.talksTo ?? []) {
				const [envName, resName] = t.split(":");
				const target = envs.find((e) => e.name === envName);
				const res = target?.resources.find((x) => x.name === resName || x.alias === resName);
				if (!target || !res) {
					unresolved.push(`${env.name}:${r.name} → ${t}`);
					continue;
				}
				if (target.cloud !== env.cloud) edges.push({ from: ref(env, r), to: ref(target, res) });
			}
		}
	}
	return { app: file.app, environments: envs, kinds, matrix, drift, edges, unresolved, errors };
}

const envScope = (e: { name?: string; env?: string; cloud: Cloud; mocked: boolean; region?: string; account?: string }): EnvScope => ({
	cloud: e.cloud,
	name: e.name ?? e.env,
	...(e.account ? { account: e.account } : {}),
	...(e.region ? { region: e.region } : {}),
	mocked: e.mocked,
});
const tag = (e: { mocked: boolean }) => (e.mocked ? " (mocked)" : "");

export interface EnvironmentsOptions {
	/** Catalog to check resources against when the repo has none of its own. */
	baseline?: Catalog;
}

export function environmentsProvider(opts: EnvironmentsOptions = {}): InsightProvider {
	return {
		id: "environments",
		title: "Environments",
		needs: ["files"],
		async analyze({ repo, ref, files }) {
			const text = await files.readFile(repo, ref, ENVIRONMENTS_FILE);
			if (text == null) return [];
			const evidence = [{ repo, path: ENVIRONMENTS_FILE }];
			let parsed: ReturnType<typeof parseEnvironments>;
			try {
				parsed = parseEnvironments(text);
			} catch (err) {
				return [{ provider: "environments", severity: "warn", scope: { repo, ref, path: ENVIRONMENTS_FILE }, title: "Could not read environments.json", detail: String(err), evidence }];
			}
			const { file, errors } = parsed;
			// Live Cloudflare environments: resources from the real wrangler configs, plus any declared annotations (talksTo).
			for (const env of file.environments.filter((e) => e.cloud === "cloudflare" && !e.mocked)) {
				const declared = env.resources;
				env.resources = [];
				for (const path of env.wrangler ?? []) {
					const cfg = await files.readFile(repo, ref, path);
					if (cfg == null) {
						errors.push(`${env.name}: ${path} not found`);
						continue;
					}
					try {
						env.resources.push(...cloudflareResources(path, cfg));
					} catch (err) {
						errors.push(`${env.name}: ${path}: ${err}`);
					}
				}
				for (const d of declared) {
					const match = env.resources.find((r) => r.name === d.name || r.alias === d.name);
					if (match) match.talksTo = [...(match.talksTo ?? []), ...(d.talksTo ?? [])];
					else errors.push(`${env.name}: declared ${d.kind} "${d.name}" is not in its wrangler config`);
				}
			}
			let catalog = opts.baseline;
			const catalogText = await files.readFile(repo, ref, CATALOG_FILE);
			if (catalogText) {
				try {
					catalog = parseCatalog(catalogText);
				} catch {
					// reported by the catalog provider
				}
			}
			const rep = analyzeEnvironments(file, catalog, errors);
			const mocked = rep.environments.filter((e) => e.mocked);
			const clouds = [...new Set(rep.environments.map((e) => e.cloud))];
			const insights: Insight[] = [
				{
					provider: "environments",
					severity: rep.errors.length || rep.unresolved.length ? "warn" : "info",
					scope: { repo, ref, path: ENVIRONMENTS_FILE },
					title: `Environments: ${rep.environments.length}${rep.app ? ` for ${rep.app}` : ""} (${rep.environments.length - mocked.length} live, ${mocked.length} mocked)`,
					detail: `${rep.kinds.length} resource kinds across ${clouds.join(", ")}; ${rep.drift.length} drift, ${rep.edges.length} cross-cloud edge(s).${mocked.length ? ` Mocked: ${mocked.map((e) => e.name).join(", ")} (declared in ${ENVIRONMENTS_FILE}, no cloud API read).` : ""}${rep.errors.length ? ` Errors: ${rep.errors.join("; ")}` : ""}${rep.unresolved.length ? ` Unresolved talksTo: ${rep.unresolved.join("; ")}` : ""}`,
					evidence,
					metrics: {
						app: rep.app ?? null,
						clouds,
						mocked: mocked.length > 0,
						catalogVersion: catalog?.version ?? null,
						kinds: rep.kinds,
						environments: rep.environments.map(({ resources, ...e }) => ({ ...e, resources: resources.length })),
						matrix: rep.matrix,
						errors: rep.errors,
					},
				},
				...rep.environments.map(
					(e): Insight => ({
						provider: "environments",
						severity: "info",
						scope: { repo, ref, env: envScope(e) },
						title: `${e.name}: ${e.cloud}${e.region ? ` ${e.region}` : ""}${tag(e)}, ${e.resources.length} resources`,
						detail: e.mocked ? `Declared in ${ENVIRONMENTS_FILE}; not read from ${e.cloud}.` : `From ${e.wrangler?.join(", ") || "no wrangler config"}.`,
						evidence: e.mocked ? evidence : (e.wrangler ?? []).map((path) => ({ repo, path })),
						metrics: { mocked: e.mocked, resources: e.resources.map(({ source, ...r }) => r) },
					}),
				),
				...rep.drift.map(
					(d): Insight => ({
						provider: "environments",
						severity: "warn",
						scope: { repo, ref },
						title: `Environment drift: ${d.kind} is ${d.services.map((s) => `${s.services.join("+")} on ${s.env}`).join(", ")}`,
						detail: `Same app, different ${d.kind} service per environment. Not wrong by itself, but code paths, limits and failure modes differ: test against each, or keep the differences behind one interface.${d.services.some((s) => s.mocked) ? " Includes mocked environments." : ""}`,
						evidence,
						metrics: { kind: d.kind, services: d.services, clouds: [...new Set(d.services.map((s) => s.cloud))], mocked: d.services.some((s) => s.mocked) },
					}),
				),
				...rep.edges.map(
					(e): Insight => ({
						provider: "environments",
						severity: "warn",
						scope: { repo, ref, env: envScope(rep.environments.find((x) => x.name === e.from.env)!) },
						title: `Cross-cloud edge: ${e.from.env}:${e.from.resource} (${e.from.service}) → ${e.to.env}:${e.to.resource} (${e.to.service})`,
						detail: `${e.from.cloud} → ${e.to.cloud}: data leaves ${e.to.cloud === "private" || e.from.cloud === "private" ? "the private network" : `one cloud for another`}. Check egress cost and data residency${e.to.cloud === "private" || e.from.cloud === "private" ? " (on-prem data must not leave the network)" : ""}.${e.from.mocked || e.to.mocked ? " Mocked environment." : ""}`,
						evidence,
						metrics: { from: e.from, to: e.to, clouds: [...new Set([e.from.cloud, e.to.cloud])], mocked: e.from.mocked || e.to.mocked },
					}),
				),
			];
			for (const e of mocked) {
				for (const r of e.resources) {
					const cell = rep.matrix[r.kind]?.[e.name]?.find((c) => c.name === r.name);
					if (cell?.approved !== false) continue;
					insights.push({
						provider: "environments",
						severity: "warn",
						scope: { repo, ref, env: envScope(e) },
						title: `Not in catalog: ${r.service} as ${r.kind} on ${e.name}`,
						detail: `${e.name}:${r.name}: ${cell.reason}.${cell.alternative ? ` ${cell.alternative[0].toUpperCase()}${cell.alternative.slice(1)}.` : ""} Mocked environment.`,
						evidence,
						metrics: { kind: r.kind, service: r.service, resource: r.name, catalogVersion: catalog?.version ?? null, mocked: true },
					});
				}
			}
			return insights;
		},
	};
}
