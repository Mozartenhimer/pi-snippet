/**
 * Unregistering `pisnip://` from the desktop.
 *
 * This had no tests and did not work: the uninstall removed its own two files
 * and the one mimeapps.list it had written, but gio consults more than that —
 * the legacy `~/.local/share/applications/mimeapps.list`, and `mimeinfo.cache`
 * when `update-desktop-database` is absent — and an association left in any of
 * them keeps the desktop answering "pisnip:// is handled" after the user was
 * told it was removed. Everything here runs against a private XDG home.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	install,
	isInstalled,
	mimeappsLocations,
	uninstall,
} from "../src/extension/link-install.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-snippet-uninstall-"));
	env = {
		HOME: home,
		XDG_DATA_HOME: join(home, "data"),
		XDG_CONFIG_HOME: join(home, "config"),
	};
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function read(path: string): string {
	return readFileSync(path, "utf8");
}

/** Write a mimeapps.list carrying our association among lines we must not lose. */
function seedMimeapps(path: string, body: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body, "utf8");
}

describe("uninstall", () => {
	it("removes the handler and desktop file it installed", () => {
		install(env);
		expect(isInstalled(env)).toBe(true);
		const result = uninstall(env);
		expect(result.removed).toEqual(
			expect.arrayContaining([
				join(env.XDG_DATA_HOME!, "pi-snippet", "open-handler"),
				join(env.XDG_DATA_HOME!, "applications", "pi-snippet-open.desktop"),
			]),
		);
		expect(isInstalled(env)).toBe(false);
	});

	it("cleans the mimeapps.list it wrote, and only our line", () => {
		install(env);
		const path = mimeappsLocations(env)[0]!;
		seedMimeapps(
			path,
			[
				"[Default Applications]",
				"text/plain=org.gnome.gedit.desktop",
				"x-scheme-handler/pisnip=pi-snippet-open.desktop",
				"",
			].join("\n"),
		);
		// install() would have rewritten the file; the point is the removal pass.
		const result = uninstall(env);
		expect(result.warnings).toEqual([]);
		expect(read(path)).toContain("text/plain=org.gnome.gedit.desktop");
		expect(read(path)).not.toContain("pisnip");
	});

	it("also cleans the legacy mimeapps.list gio still honors", () => {
		install(env);
		const legacy = mimeappsLocations(env)[1]!;
		seedMimeapps(
			legacy,
			["[Default Applications]", "x-scheme-handler/pisnip=pi-snippet-open.desktop", ""].join("\n"),
		);
		uninstall(env);
		expect(read(legacy)).not.toContain("pisnip");
	});

	it("preserves another handler that shares the scheme entry", () => {
		install(env);
		const path = mimeappsLocations(env)[0]!;
		seedMimeapps(
			path,
			[
				"[Default Applications]",
				"x-scheme-handler/pisnip=pi-snippet-open.desktop;theirs.desktop",
				"",
			].join("\n"),
		);
		uninstall(env);
		expect(read(path)).toContain("x-scheme-handler/pisnip=theirs.desktop");
		expect(read(path)).not.toContain("pi-snippet-open.desktop");
	});

	it("scrubs the stale mimeinfo.cache entry", () => {
		// Written whether or not update-desktop-database exists — the fallback
		// for machines without it, where the cache would keep recommending a
		// desktop file that is no longer there.
		install(env);
		const cache = join(env.XDG_DATA_HOME!, "applications", "mimeinfo.cache");
		seedMimeapps(
			cache,
			["[MIME Cache]", "x-scheme-handler/pisnip=pi-snippet-open.desktop", ""].join("\n"),
		);
		uninstall(env);
		expect(read(cache)).not.toContain("pisnip");
	});

	it("reports the locations it did not clean rather than claiming success", () => {
		install(env);
		const path = mimeappsLocations(env)[0]!;
		mkdirSync(join(path, ".."), { recursive: true });
		// A directory where the file wants to be: the clean of this location
		// must fail, and the failure must be visible to the caller.
		writeFileSync(join(path, "..", "mimeapps.list.d"), "not a file", "utf8");
		rmSync(path, { force: true });
		mkdirSync(path, { recursive: true });
		const result = uninstall(env);
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.clean).toBe(false);
	});

	it("is idempotent on a machine that was never installed", () => {
		const result = uninstall(env);
		expect(result.removed).toEqual([]);
		expect(result.clean).toBe(true);
		expect(existsSync(join(env.XDG_DATA_HOME!, "pi-snippet"))).toBe(false);
	});
});
