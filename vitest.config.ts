import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Points PI_SNIPPET_SETTINGS at a temp file: see test/setup.ts.
		setupFiles: ["test/setup.ts"],
	},
});
