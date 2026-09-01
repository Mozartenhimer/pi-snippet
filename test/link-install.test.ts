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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	install,
	isInstalled,
	mimeappsLocations,
	probe,
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

	it("does not report a mimeapps.list that never named us as removed", () => {
		install(env);
		const path = mimeappsLocations(env)[0]!;
		seedMimeapps(path, ["[Default Applications]", "text/plain=org.gnome.gedit.desktop", ""].join("\n"));
		const result = uninstall(env);
		expect(result.removed).not.toContain(path);
		expect(read(path)).toContain("text/plain=org.gnome.gedit.desktop");
		expect(result.clean).toBe(true);
	});

	it("is idempotent on a machine that was never installed", () => {
		const result = uninstall(env);
		expect(result.removed).toEqual([]);
		expect(result.clean).toBe(true);
		expect(existsSync(join(env.XDG_DATA_HOME!, "pi-snippet"))).toBe(false);
	});
});

/**
 * The desktop tooling, faked. Everything below needs `xdg-mime` and
 * `update-desktop-database` to exist and to answer, which they do not in a
 * bare container — so these paths had never run at all, including the one that
 * reports a handler the uninstall could not shift.
 */
describe("install and uninstall against a desktop that answers", () => {
	let bin: string;
	const realPath = process.env.PATH ?? "";

	afterEach(() => {
		process.env.PATH = realPath;
	});

	/** A PATH entry holding fake xdg tools that record and answer. */
	function fakeTools(queryAnswer: string): void {
		bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		for (const [name, body] of [
			["update-desktop-database", "#!/bin/sh\nexit 0\n"],
			[
				"xdg-mime",
				`#!/bin/sh\nif [ "$1" = "query" ]; then printf '%s\\n' '${queryAnswer}'; fi\nexit 0\n`,
			],
		] as const) {
			const path = join(bin, name);
			writeFileSync(path, body, "utf8");
			chmodSync(path, 0o755);
		}
		// `run()` shells out with this process's PATH, not the env it is given,
		// so the fakes have to be findable from here. Restored in afterEach.
		process.env.PATH = `${bin}:${realPath}`;
		env.PATH = process.env.PATH;
	}

	it("uses the desktop's own tools when they are there", () => {
		fakeTools("");
		const result = install(env);
		expect(result.ok).toBe(true);
		// xdg-mime took the association, so nothing was written by hand.
		expect(existsSync(join(env.XDG_CONFIG_HOME!, "mimeapps.list"))).toBe(false);
		expect(result.warnings).toEqual([]);
	});

	it("reports a handler the desktop still names after an uninstall", () => {
		fakeTools("pi-snippet-open.desktop");
		install(env);
		const result = uninstall(env);
		expect(result.clean).toBe(false);
		expect(result.warnings.join(" ")).toContain("still reports");
	});

	it("is clean when the desktop names nothing afterwards", () => {
		fakeTools("");
		install(env);
		const result = uninstall(env);
		expect(result.clean).toBe(true);
	});
});

describe("install — writing the association by hand into a file already there", () => {
	/**
	 * With no xdg tools on PATH `install()` falls back to editing mimeapps.list
	 * itself, and the interesting half of that is the file it did not create:
	 * an existing `[Default Applications]` section takes the entry spliced in
	 * under it, not a second section appended. Both were reached only by the
	 * developer's own ~/.config leaking into the suite — which also meant the
	 * suite was rewriting a real mimeapps.list.
	 */
	const realPath = process.env.PATH ?? "";

	afterEach(() => {
		process.env.PATH = realPath;
	});

	it("splices into the section that is already there, keeping its neighbours", () => {
		// `run()` uses this process's PATH, so an empty one is how both tools go
		// missing and the by-hand path is taken.
		process.env.PATH = join(home, "empty-bin");
		const path = join(env.XDG_CONFIG_HOME!, "mimeapps.list");
		seedMimeapps(path, "[Added Associations]\ntext/plain=nano.desktop\n\n[Default Applications]\ntext/plain=nano.desktop\n");
		install({ ...env, PATH: process.env.PATH });
		const lines = read(path).split("\n");
		expect(lines.filter((line) => line === "[Default Applications]")).toHaveLength(1);
		expect(lines[lines.indexOf("[Default Applications]") + 1]).toBe(
			"x-scheme-handler/pisnip=pi-snippet-open.desktop",
		);
		expect(read(path)).toContain("[Added Associations]");
	});

	it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
		// The default every machine that sets no XDG variables uses. `homedir()`
		// reads $HOME on Linux, which is what keeps this off the real one.
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const result = install({ HOME: home });
			expect(result.handler).toBe(join(home, ".local", "share", "pi-snippet", "open-handler"));
			expect(isInstalled({ HOME: home })).toBe(true);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});
});

describe("install — a path the Exec line cannot express", () => {
	it("says so rather than installing something that half works", () => {
		const spaced = join(home, "data dir");
		const result = install({ ...env, XDG_DATA_HOME: spaced });
		expect(result.ok).toBe(true);
		expect(result.warnings.join(" ")).toContain("contains a space");
	});
});

describe("uninstall — a mimeapps entry with an empty id in it", () => {
	it("drops the empty id along with ours, keeping the rest", () => {
		const path = join(env.XDG_CONFIG_HOME!, "mimeapps.list");
		seedMimeapps(
			path,
			"[Default Applications]\nx-scheme-handler/pisnip=;pi-snippet-open.desktop;other.desktop;\n",
		);
		uninstall(env);
		expect(read(path)).toContain("x-scheme-handler/pisnip=other.desktop");
	});
});

describe("isInstalled — half of an installation", () => {
	it("is not installed when the desktop entry is missing", () => {
		install(env);
		rmSync(join(env.XDG_DATA_HOME!, "applications", "pi-snippet-open.desktop"));
		expect(isInstalled(env)).toBe(false);
	});
});

/**
 * Firing the URL at an opener.
 *
 * `probe` is the one part of registration that leaves the process, and nothing
 * had ever run it: the container has a real `gio` and a real `gdbus`, so a test
 * that let it reach them would dispatch a live URL at whatever desktop was
 * listening. `PATH` is replaced rather than prepended to for that reason —
 * every opener the probe tries is then one of these or genuinely absent.
 */
describe("probing the openers", () => {
	const realPath = process.env.PATH ?? "";

	afterEach(() => {
		process.env.PATH = realPath;
	});

	/** A bin directory holding only what is named, and a PATH holding only it. */
	function onlyOnPath(files: Record<string, string>): void {
		const bin = join(home, "probe-bin");
		mkdirSync(bin, { recursive: true });
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(bin, name), body, "utf8");
			chmodSync(join(bin, name), 0o755);
		}
		process.env.PATH = bin;
	}

	it("names every opener that is not installed, and finds none", async () => {
		onlyOnPath({});
		const result = await probe("pisnip://a1b2c3d4/deadbeef/c1", async () => true);
		expect(result.opener).toBeNull();
		expect(result.tried).toEqual(["gdbus (absent)", "gio (absent)", "xdg-open (absent)"]);
	});

	it("tells an opener that failed apart from one that is missing", async () => {
		onlyOnPath({ "xdg-open": "#!/bin/sh\nexit 3\n" });
		const result = await probe("pisnip://a1b2c3d4/deadbeef/c1", async () => true);
		expect(result.opener).toBeNull();
		expect(result.tried).toEqual(["gdbus (absent)", "gio (absent)", "xdg-open (failed)"]);
	});

	it("reports the opener whose dispatch came back", async () => {
		onlyOnPath({ "xdg-open": "#!/bin/sh\nexit 0\n" });
		const result = await probe("pisnip://a1b2c3d4/deadbeef/c1", async () => true);
		expect(result.opener).toBe("xdg-open");
		// Only the openers before it were tried; it is the last word.
		expect(result.tried).toEqual(["gdbus (absent)", "gio (absent)"]);
	});

	it("keeps going past an opener that ran but delivered nothing", async () => {
		onlyOnPath({ "gio": "#!/bin/sh\nexit 0\n", "xdg-open": "#!/bin/sh\nexit 0\n" });
		const seen: boolean[] = [];
		// The first dispatch goes nowhere, the second arrives.
		const result = await probe("pisnip://a1b2c3d4/deadbeef/c1", async () => {
			seen.push(true);
			return seen.length > 1;
		});
		expect(result.opener).toBe("xdg-open");
		expect(result.tried).toEqual(["gdbus (absent)", "gio (no round trip)"]);
	});
});
