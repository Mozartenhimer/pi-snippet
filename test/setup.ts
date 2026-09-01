/**
 * Keep the persisted `/snippets` state out of the developer's real config.
 *
 * The extension reads its settings file at load and writes it on every toggle,
 * so without this a test run would inherit — and then overwrite — whatever the
 * person running it had chosen. A fresh file per test also keeps one test's
 * toggles from leaking into the next.
 *
 * `PI_SNIPPET_HOST` is pinned for the same reason one level up: a chip URL now
 * carries the machine's own name (ADR 0001), and a suite that read the real
 * `hostname()` would assert against whatever box it happened to run on.
 *
 * `PI_HYPERLINKS` is pi-tui's explicit capability override, and outranks every
 * terminal-identifying variable its detection would otherwise sniff. Without it
 * the suite's baseline is the terminal the developer happens to be sitting in:
 * run inside Ghostty, `getCapabilities().hyperlinks` is true, `linkOn()` follows
 * and chips that the tests expect bare come out as `pisnip://` links. The two
 * click suites mock the module outright, so pinning it off here is the same
 * baseline they assume.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

// Before any test file's module scope runs, since pi-tui caches capabilities on
// the first call and a file need not reset that cache.
process.env.PI_HYPERLINKS = "0";

const dir = mkdtempSync(join(tmpdir(), "pi-snippet-settings-"));
let n = 0;

// A fresh file per test, so a test that toggles something off cannot change
// what the next one starts from.
beforeEach(() => {
	process.env.PI_SNIPPET_SETTINGS = join(dir, `settings-${n++}.json`);
	process.env.PI_SNIPPET_HOST = "testbox";
	process.env.PI_HYPERLINKS = "0";
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});
