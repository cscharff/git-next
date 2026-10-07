import { describe, expect, it } from "vitest";
import { parsePushEvent } from "../src/results.ts";

const event = (over: Record<string, any> = {}) => ({
	type: "cf.artifacts.repo.pushed",
	source: { type: "artifacts.repo", namespace: "default", repoName: "agents-demo-r2" },
	payload: { ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), commits: [{ id: "b".repeat(40), message: "SOW-1042: add r2 example\n\nbody", author: { name: "r2-agent" } }], totalCommitsCount: 1 },
	...over,
});

describe("parsePushEvent", () => {
	it("extracts repo, branch and trigger from a push event", () => {
		expect(parsePushEvent(event(), "default")).toMatchObject({ repo: "agents-demo-r2", ref: "main", trigger: { after: "b".repeat(40), before: "a".repeat(40), commits: [{ message: "SOW-1042: add r2 example", author: "r2-agent" }], totalCommitsCount: 1 } });
	});

	it("ignores other namespaces, tags, deletions, bad names and other event types", () => {
		expect(parsePushEvent(event({ source: { type: "artifacts.repo", namespace: "other", repoName: "x" } }), "default")).toBeNull();
		expect(parsePushEvent(event({ payload: { ref: "refs/tags/v1", after: "b".repeat(40) } }), "default")).toBeNull();
		expect(parsePushEvent(event({ payload: { ref: "refs/heads/main", after: "0".repeat(40) } }), "default")).toBeNull();
		expect(parsePushEvent(event({ source: { type: "artifacts.repo", namespace: "default", repoName: "../x" } }), "default")).toBeNull();
		expect(parsePushEvent(event({ type: "cf.artifacts.repo.cloned" }), "default")).toBeNull();
	});

	it("treats a new branch (zero before) as having no base", () => {
		expect(parsePushEvent(event({ payload: { ref: "refs/heads/feature", before: "0".repeat(40), after: "c".repeat(40) } }), "default")?.trigger.before).toBeNull();
	});
});
