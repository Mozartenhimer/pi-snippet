/**
 * Keep the persisted `/snippets` state out of the developer's real config.
 *
 * The extension reads its settings file at load and writes it on every toggle,
 * so without this a test run would inherit — and then overwrite — whatever the
 * person running it had chosen. A fresh file per test also keeps one test's
 * toggles from leaking into the next.
 *
 * The relay host (`pi-snippet-remotes.json`) lives beside it and is read on
 * every `/snippets` render where a handler is installed, so it gets the same
 * treatment for the same reason — as does the directory of relay-client stamps
 * (`pi-snippet-relay-clients`), which is read at every session start over SSH
 * and decides whether chips paint URLs without being asked.
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
	process.env.PI_SNIPPET_SETTINGS = join(dir, `settings-${n}.json`);
	process.env.PI_SNIPPET_REMOTES = join(dir, `remotes-${n}.json`);
	// A directory, and deliberately one that does not exist: a test that has
	// not stamped a client must see the honest default.
	process.env.PI_SNIPPET_RELAY_CLIENTS = join(dir, `relay-clients-${n++}`);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});
