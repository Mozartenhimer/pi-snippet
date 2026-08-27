/**
 * Keep the persisted `/snippets` toggles out of the developer's real config.
 *
 * The extension reads its settings file at load and writes it on every toggle,
 * so without this a test run would inherit — and then overwrite — whatever the
 * person running it had chosen. A fresh file per test also keeps one test's
 * toggles from leaking into the next.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "pi-snippet-settings-"));
let n = 0;

// A fresh file per test, so a test that toggles something off cannot change
// what the next one starts from.
beforeEach(() => {
	process.env.PI_SNIPPET_SETTINGS = join(dir, `settings-${n++}.json`);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});
