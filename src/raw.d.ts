declare module "*?raw" {
	const text: string;
	export default text;
}

// Vite's import.meta.glob, used to bundle samples/demo-run/*.json into the Worker.
interface ImportMeta {
	glob<T = unknown>(pattern: string, options?: { eager?: boolean; import?: string }): Record<string, T>;
}
