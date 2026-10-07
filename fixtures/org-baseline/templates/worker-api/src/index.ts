// {{name}}: Worker API created from org-baseline (worker-api template).

interface Env {
	AI: Ai;
}

/** Every model call goes through the org AI Gateway with git.next cost metadata. */
export function gateway(task: string) {
	return { gateway: { id: "git-next", metadata: { repo: "{{name}}", agent: "app", task } } };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return Response.json({ ok: true });
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
