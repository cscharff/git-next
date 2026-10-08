import { execFileSync, spawnSync } from "node:child_process";

// `git next new --artifacts`: put the new repo in Cloudflare Artifacts and have git.next review every push to it.
// Uses the `cf` CLI (already signed in with `cf auth login`) for the account-level calls. The repo's write token goes
// only into GIT_CONFIG_* env vars for the one push; it's never printed, stored in git config or put in a URL.

export interface ArtifactsPublisher {
	/** Creates the repo; returns its HTTPS remote and a write token for the first push. */
	createRepo(name: string, description: string): Promise<{ remote: string; token: string }>;
	/** Subscribes the queue git.next consumes to the repo's push events. */
	subscribe(name: string, queueId: string): Promise<{ id: string }>;
	/** Pushes HEAD to main with the token supplied through env vars (the pre-push hook still runs). */
	push(dir: string, remote: string, token: string, opts?: { force?: boolean }): { ok: boolean; output: string };
}

const NAMESPACE = "default";
const cf = (...args: string[]) => JSON.parse(execFileSync("npx", ["cf", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Record<string, any>;

export const cfPublisher: ArtifactsPublisher = {
	async createRepo(name, description) {
		let r: { remote?: string; token?: string };
		try {
			const out = cf("artifacts", "namespaces", "repos", "create", NAMESPACE, "--name", name, "--description", description, "--default-branch", "main");
			r = (out.result ?? out) as typeof r;
		} catch (err) {
			// Re-running after a failed first push: reuse the repo (still empty, or the push below fails) with a fresh token.
			if (!/already exists|conflict|409/i.test(`${err}${(err as { stderr?: string }).stderr ?? ""}`)) throw err;
			const info = cf("artifacts", "namespaces", "repos", "get", name, "--namespace", NAMESPACE);
			const token = cf("artifacts", "namespaces", "tokens", "create", NAMESPACE, "--repo", name, "--scope", "write", "--ttl", "600");
			r = { remote: (info.result ?? info).remote, token: (token.result ?? token).plaintext };
		}
		if (!r.remote || !r.token) throw new Error("Artifacts didn't return a remote and token for the repo");
		return { remote: r.remote, token: r.token };
	},
	async subscribe(name, queueId) {
		// Already subscribed (a re-run): keep the existing subscription.
		const list = cf("queues", "subscriptions", "list");
		const existing = ((list.result ?? list) as { id: string; source?: { repo_name?: string }; destination?: { queue_id?: string } }[]).find((x) => x.source?.repo_name === name && x.destination?.queue_id === queueId);
		if (existing) return { id: existing.id };
		const body = { name: `git-next-pushes-${name}`, enabled: true, source: { type: "artifacts.repo", namespace: NAMESPACE, repo_name: name }, destination: { type: "queues.queue", queue_id: queueId }, events: ["pushed"] };
		const out = cf("queues", "subscriptions", "create", "--body", JSON.stringify(body));
		return { id: String((out.result ?? out).id ?? "") };
	},
	push(dir, remote, token, opts = {}) {
		const remotes = execFileSync("git", ["remote"], { cwd: dir, encoding: "utf8" }).split("\n");
		execFileSync("git", ["remote", remotes.includes("origin") ? "set-url" : "add", "origin", remote], { cwd: dir, stdio: "pipe" });
		const r = spawnSync("git", ["push", "-q", ...(opts.force ? ["--force"] : []), "origin", "HEAD:main"], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`, GIT_TERMINAL_PROMPT: "0" } });
		return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.replace(/Bearer\s+\S+/g, "Bearer ***").replace(/https:\/\/[0-9a-f]{32}\./g, "https://<account>.").trim() };
	},
};
