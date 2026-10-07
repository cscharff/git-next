import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CommitInfo, RepoSource, TreeFile } from "../core/repo-context.ts";

/** The pseudo-ref for the working tree (tracked + untracked, minus ignored files). */
export const WORKTREE = "WORKTREE";
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"]);
const MAX_BLOB = 4 * 1024 * 1024;

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

export function isGitRepo(dir: string): boolean {
	try {
		return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
	} catch {
		return false;
	}
}

/**
 * RepoSource over a local directory. The working tree is read from disk (listed with `git ls-files` when it is
 * a git repo, so .gitignore applies); any other ref is read from local git objects without a checkout.
 */
export function localSource(dir: string): RepoSource {
	const inGit = isGitRepo(dir);
	const worktreePaths = new Map<string, string>();

	const listWorktree = (): TreeFile[] => {
		let paths: string[];
		if (inGit) {
			paths = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
		} else {
			paths = [];
			const walk = (d: string) => {
				for (const name of readdirSync(d)) {
					if (SKIP.has(name)) continue;
					const p = join(d, name);
					if (statSync(p).isDirectory()) walk(p);
					else paths.push(relative(dir, p));
				}
			};
			walk(dir);
		}
		const files: TreeFile[] = [];
		for (const path of paths) {
			if (path.split("/").some((seg) => SKIP.has(seg))) continue;
			const abs = join(dir, path);
			if (!existsSync(abs)) continue; // deleted but still in the index
			const st = statSync(abs);
			if (!st.isFile()) continue;
			// Key by path + size + mtime: unique per content version without reading every file up front.
			const hash = createHash("sha1").update(`${path}\0${st.size}\0${st.mtimeMs}`).digest("hex");
			worktreePaths.set(hash, abs);
			files.push({ path, hash });
		}
		return files;
	};

	return {
		async listFiles(ref) {
			if (ref === WORKTREE) return listWorktree();
			if (!inGit) throw new Error(`${dir} is not a git repository, so --ref/--base cannot be read`);
			return git(dir, ["ls-tree", "-r", "-z", "--full-tree", ref])
				.split("\0")
				.filter(Boolean)
				.flatMap((line) => {
					const m = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/s);
					return m && !m[2].split("/").some((seg) => SKIP.has(seg)) ? [{ path: m[2], hash: m[1] }] : [];
				});
		},
		async readBlob(hash) {
			const abs = worktreePaths.get(hash);
			if (abs) return statSync(abs).size > MAX_BLOB ? null : readFileSync(abs, "utf8");
			try {
				return git(dir, ["cat-file", "blob", hash]);
			} catch {
				return null;
			}
		},
		async log(ref, limit): Promise<CommitInfo[]> {
			if (!inGit) return [];
			const out = git(dir, ["log", `-n${limit}`, "--format=%H%x1f%an%x1f%ct%x1f%s", ref === WORKTREE ? "HEAD" : ref]);
			return out
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const [hash, author, ct, message] = l.split("\x1f");
					return { hash, author, committedAt: Number(ct), message };
				});
		},
	};
}
