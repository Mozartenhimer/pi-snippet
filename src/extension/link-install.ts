/**
 * Registering `pisnip://` with the desktop, and proving it works
 * (docs/terminal-resolved-clicks.md §6). Linux only.
 *
 * This is the one part of terminal-resolved clicking that happens outside pi,
 * once per machine. `scripts/link-register.py` is the same procedure as a
 * standalone script, and was where the following were measured rather than
 * assumed:
 *
 * - **No dependency on xdg-utils.** A `.desktop` file plus a `mimeapps.list`
 *   entry is sufficient; `mimeinfo.cache` is not consulted for a *default*
 *   lookup. `xdg-mime` and `update-desktop-database` are used when present and
 *   skipped when not — neither was installed on a stock container where this
 *   nonetheless worked.
 * - **The Exec path must not be quoted.** The Desktop Entry spec allows it and
 *   GLib parses it, but `xdg-open` reads the line with
 *   `cut -d= -f2- | first_word | which`, so the quotes reach `which` attached
 *   to the path and it fails. Unquoted parses in both.
 * - **`xdg-open`'s scheme lookup is gated behind `has_display`**, so a probe
 *   run without `DISPLAY`/`WAYLAND_DISPLAY` fails in a way that looks exactly
 *   like a broken registration and is not one.
 *
 * The handler is generated here rather than shipped: it has to bake in an
 * interpreter path and stay valid for every future session, and it must agree
 * with `link-server.ts` about where sockets live.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LINK_SCHEME } from "../shared/link-url.js";

const DESKTOP_ID = "pi-snippet-open.desktop";
const MIME = `x-scheme-handler/${LINK_SCHEME}`;

/**
 * An XDG directory from the environment, or the spec's default.
 *
 * A conditional rather than `value || fallback` so there is one decision here
 * rather than two conditions that cannot be told apart: the fallback is always
 * a non-empty path, so `a || b` has no false outcome at all and neither side
 * of it can be shown to drive the answer. Empty-string handling is the same
 * either way — an unset-or-empty XDG variable means "use the default".
 */
function envDir(value: string | undefined, fallback: string): string {
	return value ? value : fallback;
}

function dataHome(env: NodeJS.ProcessEnv): string {
	return envDir(env.XDG_DATA_HOME, join(homedir(), ".local", "share"));
}

function configHome(env: NodeJS.ProcessEnv): string {
	return envDir(env.XDG_CONFIG_HOME, join(homedir(), ".config"));
}

/**
 * Where the handler lives.
 *
 * Deliberately *not* the pi agent directory: the `Exec` line is baked into the
 * desktop entry at install time and has to stay valid for every future
 * session, while `PI_CODING_AGENT_DIR` moves per session (the test suite
 * repoints it on every run). Same reasoning as `settings.ts` keeping
 * preferences out of the session store, one level further out.
 */
function handlerPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataHome(env), "pi-snippet", "open-handler");
}

function desktopPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataHome(env), "applications", DESKTOP_ID);
}

function mimeappsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configHome(env), "mimeapps.list");
}

/**
 * The handler, as a python3 script.
 *
 * python3 because it is the most reliably present interpreter that can speak
 * AF_UNIX from a bare `exec` — a POSIX shell cannot, and pi's own executable is
 * not necessarily a node CLI (under the snap `process.execPath` is the pi
 * binary). It is stateless: the socket comes from the token in the URL, so this
 * file is written once and serves every session that follows.
 *
 * The directory list must match `socketDirCandidates()` in `link-server.ts`,
 * in the same order — these two processes may not share a namespace, and this
 * list is the whole of their agreement about where to meet.
 */
/**
 * Where a click looks for a live session, as python.
 *
 * The one list three processes agree on: this handler, the remote one-liner it
 * relays through, and `socketDirCandidates()` in `link-server.ts`. They may run
 * on two machines and never speak otherwise, so a divergence here is a click
 * that silently misses. Kept as one string for exactly that reason — the
 * handler and the relay cannot drift apart, because a regeneration writes both.
 *
 * Contains no apostrophe, and must not grow one: `relayCommand()` embeds it in
 * a single-quoted shell word.
 */
const PY_CANDIDATES = `def candidates():
    explicit = os.environ.get("PI_SNIPPET_SOCKET_DIR")
    if explicit:
        yield explicit
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        yield os.path.join(runtime, "pi-snippet")
    yield os.path.join(tempfile.gettempdir(), "pi-snippet-%d" % os.getuid())`;

/**
 * What the handler runs *on the remote host* when the click found no socket
 * here (docs/ssh-back-handler.md).
 *
 * Single-quoted so the remote shell hands it to python as one argument.
 * `ssh host cmd arg` joins its arguments into one command line for the remote
 * shell, so the URL is re-parsed by a shell no matter how this process splits
 * its argv — which is safe only because the handler validates the URL's shape
 * strictly before it gets here. The validation is the security boundary; the
 * argv split is defence in depth, and both are load-bearing.
 *
 * It re-checks the shape anyway, cheaply: three path segments and an
 * alphanumeric token, because the token becomes a socket file name here and
 * this end has no idea what validated the URL.
 *
 * Self-contained on purpose: nothing is installed on the remote host, and
 * python3 is the same near-universal interpreter the handler itself needs.
 */
export function relayCommand(): string {
	return `python3 -c '
import os, socket, sys, tempfile, urllib.parse
${PY_CANDIDATES}
parts = urllib.parse.urlparse(sys.argv[1]).path.strip("/").split("/")
if len(parts) != 3 or not parts[0].isalnum():
    sys.exit(2)
wire = parts[1] + "/" + parts[2]
for directory in candidates():
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(os.path.join(directory, parts[0] + ".sock"))
        s.sendall((wire + "\\n").encode())
        s.close()
        sys.exit(0)
    except OSError:
        continue
sys.exit(1)
'`;
}

/**
 * The host pattern, as python — the same shape `isLinkHost()` enforces in
 * `shared/link-url.ts`, written out because the handler is a standalone script
 * that imports nothing of ours.
 *
 * The leading class is narrower than the rest on purpose: a host beginning
 * with `-` would be read by `ssh` as an option and the destination would shift
 * to the next argument, which is a real hazard now that the host arrives in a
 * URL rather than from a file the user wrote.
 *
 * `\A`/`\Z` rather than `^`/`$`: python's `$` also matches before a trailing
 * newline, which JavaScript's does not, so anchoring loosely would leave the
 * two copies of this guard disagreeing about exactly one input.
 */
const PY_HOST = String.raw`\A[A-Za-z0-9][A-Za-z0-9._@-]{0,254}\Z`;

function handlerSource(): string {
	return `#!/usr/bin/env python3
"""pi-snippet click handler. Forwards one ${LINK_SCHEME}:// URL and exits.

Generated by pi-snippet; edits are lost on the next install. Carries no text:
the URL names a slot, and the pi session decides what that slot means.

Two deliveries, in order: a unix socket on this machine, and — when the URL
names another host — a relay back to it through ssh (ADR 0001). The host comes
from the URL, and what keeps that safe is ssh's own allowlist: BatchMode turns
StrictHostKeyChecking into a hard failure, so a host missing from known_hosts
is refused at the host-key check, before authentication.
"""
import os, re, socket, subprocess, sys, tempfile, urllib.parse

url = sys.argv[1] if len(sys.argv) > 1 else ""
u = urllib.parse.urlparse(url)
# Strict before the relay, because the relay hands both of these to a remote
# shell — and the host to an ssh argv. A hostname, hex and a small integer have
# no metacharacter to act on. The path matches parseChipPath() in
# shared/link-url.ts with the session token in front, so nothing valid is
# turned away here.
if u.scheme != "${LINK_SCHEME}" or not re.match(r"${PY_HOST}", u.netloc):
    sys.exit(2)
route = re.match(r"^/([0-9a-z]{1,32})(/[0-9a-f]{1,16}/c[0-9]{1,3})$", u.path)
if not route:
    sys.exit(2)
token, wire = route.group(1), route.group(2).strip("/")

${PY_CANDIDATES}

for directory in candidates():
    path = os.path.join(directory, token + ".sock")
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(path)
        s.sendall((wire + "\\n").encode())
        s.close()
        sys.exit(0)
    except OSError:
        continue


def own_names():
    """Every name that means this machine, reduced to first labels.

    A local session paints its own hostname too — one URL shape everywhere —
    so a click on dead local scrollback must fail here rather than ssh back to
    ourselves to find the socket we just failed to reach. PI_SNIPPET_HOST is
    the escape hatch a session uses when its hostname is meaningless off-box;
    honoured here as well so a machine that renames itself for others still
    recognises itself.
    """
    names = ["localhost", socket.gethostname(), os.environ.get("PI_SNIPPET_HOST") or ""]
    return set(n.lower().split("@")[-1].split(".")[0] for n in names if n)


host = u.netloc
if host.lower().split("@")[-1].split(".")[0] in own_names():
    # Nothing local answered and there is nowhere else to look. Same silence as
    # a chip clicked in scrollback whose session has exited.
    sys.exit(1)
try:
    # BatchMode so a click never hangs on a password or a host-key prompt — and
    # so an unknown host is refused rather than trusted, which is what stands in
    # for the allowlist this used to keep. ConnectTimeout so a dark host costs
    # seconds rather than a stuck process. \`--\` so a host that somehow got past
    # the pattern above still cannot be read as an option.
    done = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "--", host,
         ${JSON.stringify(relayCommand())}, url],
        timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except (OSError, subprocess.SubprocessError):
    sys.exit(1)
# Unreachable is the same situation as dead scrollback: nothing to say, and now
# nothing to configure either. Quiet either way.
sys.exit(done.returncode)
`;
}

export interface InstallResult {
	ok: boolean;
	handler: string;
	desktop: string;
	mimeapps: string;
	warnings: string[];
}

export interface UninstallResult {
	/** Paths actually deleted, for the toggle to report honestly. */
	removed: string[];
	/** Locations consulted but unwritable, or a stale association that survived. */
	warnings: string[];
	/** True when nothing we know of still claims the scheme. */
	clean: boolean;
}

export function install(env: NodeJS.ProcessEnv = process.env): InstallResult {
	const handler = handlerPath(env);
	const desktop = desktopPath(env);
	const warnings: string[] = [];

	mkdirSync(dirname(handler), { recursive: true });
	writeFileSync(handler, handlerSource(), "utf8");
	chmodSync(handler, 0o755);

	// Unquoted on purpose — see the header. The cost is that a path containing
	// a space cannot be expressed in a way xdg-open will parse, so say so
	// rather than installing something that silently only half works.
	if (handler.includes(" ")) {
		warnings.push(
			`${handler} contains a space; xdg-open cannot parse its Exec line (the portal and gio still can)`,
		);
	}

	mkdirSync(dirname(desktop), { recursive: true });
	writeFileSync(
		desktop,
		[
			"[Desktop Entry]",
			"Type=Application",
			"Name=pi-snippet click handler",
			"Comment=Inserts a suggestion into the pi session that painted it",
			`Exec=${handler} %u`,
			"Terminal=false",
			"NoDisplay=true",
			`MimeType=${MIME};`,
			"",
		].join("\n"),
		"utf8",
	);

	if (!run("update-desktop-database", [dirname(desktop)])) {
		warnings.push("update-desktop-database not run (absent); the default association still applies");
	}
	if (!run("xdg-mime", ["default", DESKTOP_ID, MIME])) {
		setDefaultByHand(env);
	}

	return { ok: true, handler, desktop, mimeapps: mimeappsPath(env), warnings };
}

/**
 * Every mimeapps.list gio consults for the user, most specific first.
 *
 * `~/.config/mimeapps.list` is where this install writes, but gio also reads
 * the legacy `~/.local/share/applications/mimeapps.list`, and anything another
 * tool wrote there (an older xdg-mime, a dotfiles setup, a manual association)
 * takes effect the moment the config copy stops naming a default. An uninstall
 * that cleans only one of the two is an uninstall that "didn't work".
 */
export function mimeappsLocations(env: NodeJS.ProcessEnv = process.env): string[] {
	return [mimeappsPath(env), join(dataHome(env), "applications", "mimeapps.list")];
}

/**
 * Remove this desktop's id from one scheme entry, preserving the rest.
 *
 * The value is a `;`-separated list: `pisnip=ours.desktop;theirs.desktop`. A
 * line filter drops the other handler with ours; editing the value removes
 * only ours and leaves the line only when something else still claims the
 * scheme.
 */
function stripHandler(lines: string[]): { lines: string[]; changed: boolean } {
	const key = `${MIME}=`;
	let changed = false;
	const kept: string[] = [];
	for (const line of lines) {
		if (!line.startsWith(key)) {
			kept.push(line);
			continue;
		}
		const rest = line
			.slice(key.length)
			.split(";")
			.map((id) => id.trim())
			.filter((id) => id.length > 0 && id !== DESKTOP_ID);
		changed = true;
		if (rest.length > 0) kept.push(key + rest.join(";"));
	}
	return { lines: kept, changed };
}

/**
 * Drop our id from one `key=value;value` file, whatever the file is for.
 *
 * The two kinds of file this runs against — every `mimeapps.list` gio consults,
 * and `mimeinfo.cache` — had a function each, identical but for their return
 * types. They are the same edit for the same reason: the scheme entry is a
 * `;`-separated list, ours has to come out of it, and anything else on the line
 * has to survive.
 *
 * `mimeinfo.cache` gets this treatment because `update-desktop-database`, which
 * would regenerate it properly, is an optional tool — where it is absent a stale
 * cache still lists a desktop file that is no longer there, so `gio mime` keeps
 * recommending it. That is precisely what "I removed it and it's still
 * registered" looks like from the outside.
 *
 * `"unchanged"` covers both "no such file" and "the file never named us": the
 * caller reports what it removed, and a file it did not have to touch is not a
 * removal.
 */
function stripHandlerFrom(path: string): "cleaned" | "unchanged" | "failed" {
	try {
		if (!existsSync(path)) return "unchanged";
		const { lines, changed } = stripHandler(readFileSync(path, "utf8").split("\n"));
		if (!changed) return "unchanged";
		writeFileSync(path, lines.join("\n"), "utf8");
		return "cleaned";
	} catch {
		return "failed";
	}
}

function cachePath(env: NodeJS.ProcessEnv): string {
	return join(dataHome(env), "applications", "mimeinfo.cache");
}

/**
 * Unregister `pisnip://`, every place it is registered, and say what happened.
 *
 * This used to remove the two files and one mimeapps.list and claim success —
 * and then not work: the legacy mimeapps.list still carried the association,
 * or the mimeinfo.cache still named the deleted desktop file (no
 * update-desktop-database on the machine), so the desktop's answer to "what
 * handles pisnip://" did not change. It now cleans both mimeapps.list
 * locations and the cache, and then *asks the desktop* what it thinks before
 * reporting, so the toggle's message is a measurement rather than an intention.
 */
export function uninstall(env: NodeJS.ProcessEnv = process.env): UninstallResult {
	const removed: string[] = [];
	const warnings: string[] = [];

	for (const path of [desktopPath(env), handlerPath(env)]) {
		try {
			if (existsSync(path)) {
				unlinkSync(path);
				removed.push(path);
			}
		} catch (error) {
			warnings.push(`could not remove ${path} (${(error as NodeJS.ErrnoException).code})`);
		}
	}

	for (const path of mimeappsLocations(env)) {
		const outcome = stripHandlerFrom(path);
		if (outcome === "cleaned") removed.push(path);
		else if (outcome === "failed") warnings.push(`could not clean ${path}`);
	}
	// Regenerate the cache when the tool exists, and scrub our id regardless:
	// where update-desktop-database is absent (or fails) a stale cache keeps
	// recommending a desktop file that is no longer there, which is precisely
	// what "I removed it and it's still registered" looks like from outside.
	// The cache's outcome is not reported: it is a derived file, so failing to
	// scrub it is only a problem if the desktop still answers with our id — which
	// is what the query below actually checks.
	run("update-desktop-database", [dirname(desktopPath(env))]);
	stripHandlerFrom(cachePath(env));

	// Ask, rather than assume. An empty query answer is the success case; our
	// id still in it means a location we could not clean survived.
	const claimed = queryDefaultHandler(env);
	if (claimed === DESKTOP_ID) {
		warnings.push(
			`the desktop still reports ${DESKTOP_ID} as the handler — a location above may be unwritable`,
		);
	}
	return { removed, warnings, clean: warnings.length === 0 };
}

/**
 * What the desktop says handles `pisnip://` right now, or null when there is
 * no tool to ask (or the desktop names nothing).
 *
 * `xdg-mime query default` is the cheap, widely-present form of gio's lookup;
 * when it is absent the file checks above are the best available answer.
 */
function queryDefaultHandler(env: NodeJS.ProcessEnv = process.env): string | null {
	try {
		const out = execFileSync("xdg-mime", ["query", "default", MIME], {
			// The caller's environment merged over this process's: the XDG
			// variables pick the files queried, the rest (PATH above all) is
			// what makes xdg-mime findable at all. A wholesale replacement with
			// a partial env would drop PATH and silently answer null.
			env: { ...process.env, ...env },
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

export function isInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
	return existsSync(handlerPath(env)) && existsSync(desktopPath(env));
}

/**
 * Add the default association without xdg-utils, preserving everything else in
 * the file. `mimeapps.list` is a plain ini and this is the only key we own.
 */
function setDefaultByHand(env: NodeJS.ProcessEnv = process.env): void {
	const path = mimeappsPath(env);
	const entry = `${MIME}=${DESKTOP_ID}`;
	let lines: string[] = [];
	try {
		if (existsSync(path)) lines = readFileSync(path, "utf8").split("\n");
	} catch {
		lines = [];
	}
	lines = lines.filter((line) => !line.startsWith(`${MIME}=`));
	const header = lines.findIndex((line) => line.trim() === "[Default Applications]");
	if (header === -1) lines.push("[Default Applications]", entry, "");
	else lines.splice(header + 1, 0, entry);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, lines.join("\n"), "utf8");
	} catch {
		/* an unwritable config dir costs link mode, not the session */
	}
}

/** Run a helper if it exists. False means "not available", never "it failed". */
function run(command: string, args: string[]): boolean {
	try {
		execFileSync(command, args, { stdio: "ignore", timeout: 10_000 });
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT";
	}
}

/**
 * The openers a probe should try, nearest-to-Ghostty first: its GTK apprt calls
 * the XDG portal with `ask=false` and only falls back to `xdg-open` when the
 * portal errors.
 */
function probeCommands(url: string): Array<{ command: string; args: string[] }> {
	return [
		{
			command: "gdbus",
			args: [
				"call", "-e",
				"-d", "org.freedesktop.portal.Desktop",
				"-o", "/org/freedesktop/portal/desktop",
				"-m", "org.freedesktop.portal.OpenURI.OpenURI",
				"", url, "{'ask': <false>}",
			],
		},
		{ command: "gio", args: ["open", url] },
		{ command: "xdg-open", args: [url] },
	];
}

/**
 * Fire a URL at each opener in turn and stop at the first that arrives.
 *
 * The caller supplies `arrived` — in practice a promise resolved by the live
 * `LinkServer`, so the probe exercises the real socket rather than a stand-in.
 */
export async function probe(
	url: string,
	arrived: () => Promise<boolean>,
): Promise<{ opener: string | null; tried: string[] }> {
	const tried: string[] = [];
	for (const { command, args } of probeCommands(url)) {
		try {
			execFileSync(command, args, { stdio: "ignore", timeout: 10_000 });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			tried.push(code === "ENOENT" ? `${command} (absent)` : `${command} (failed)`);
			continue;
		}
		if (await arrived()) return { opener: command, tried };
		tried.push(`${command} (no round trip)`);
	}
	return { opener: null, tried };
}
