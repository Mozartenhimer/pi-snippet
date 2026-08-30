#!/usr/bin/env bash
# Measure masking MC/DC over src/ by running the ordinary test suite against an
# instrumented copy of it.
#
# The copy lives in .mcdc/src and the suite is pointed at it by a vitest alias,
# so nothing under src/ is touched and an interrupted run leaves no debris
# beyond .mcdc/ itself.
set -euo pipefail
cd "$(dirname "$0")/../.."

rm -rf .mcdc
mkdir -p .mcdc/runs
npx tsx scripts/mcdc/instrument.ts .
cp scripts/mcdc/recorder.ts .mcdc/src/__mcdc-recorder.ts

# Each worker writes its own observations when its last test finishes. An exit
# hook is not enough: vitest tears workers down around it.
cat > .mcdc/flush.ts <<'FLUSH'
import { afterAll } from "vitest";
import { __mcdcFlush } from "./src/__mcdc-recorder.js";

afterAll(__mcdcFlush);
FLUSH

cat > .mcdc/vitest.config.ts <<'CONFIG'
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(import.meta.dirname, "..");

export default defineConfig({
	root,
	resolve: {
		alias: [
			// Every test reaches the sources as `../src/…` (fixtures, one level
			// deeper, as `../../src/…`). Rewriting the prefix is enough to run the
			// whole suite against the instrumented tree.
			{ find: /^(?:\.\.\/)+src\/(.*)$/, replacement: resolve(root, ".mcdc/src") + "/$1" },
		],
	},
	test: {
		setupFiles: ["test/setup.ts", ".mcdc/flush.ts"],
		include: ["test/**/*.test.ts"],
		exclude: ["**/e2e-*.test.ts", "**/node_modules/**"],
	},
});
CONFIG

MCDC_OUT="$(pwd)/.mcdc/runs" npx vitest run --config .mcdc/vitest.config.ts "$@"
npx tsx scripts/mcdc/analyze.ts .
