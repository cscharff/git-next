import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests run in plain Node without the Workers plugin.
export default defineConfig({
	test: { include: ["test/**/*.test.ts"] },
});
