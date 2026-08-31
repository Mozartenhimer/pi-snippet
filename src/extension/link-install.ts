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
import { agentDir } from "./settings.js";

const DESKTOP_ID = "pi-snippet-open.desktop";
const MIME = `x-scheme-handler/${LINK_SCHEME}`;
/** The relay host, beside the settings file rather than inside it. */
const REMOTES_FILE = "pi-snippet-remotes.json";
/**
 * Where a *server* records which clients relay clicks back to it — one empty
 * file per client address.
 *
 * A directory of stamps rather than a JSON map because the writer is a shell
 * command arriving over `ssh` (the bootstrap line's second half), and a merge
 * is the one thing a one-line shell command cannot do safely: with a file
 * each, two clients of the same host never overwrite one another.
 */
const RELAY_CLIENTS_DIR = "pi-snippet-relay-clients";

/**
 * Where the client records the host to relay unresolvable clicks to
 * (docs/ssh-back-handler.md).
 *
 * Separate from `pi-snippet.json` because it is read by the *handler*, a
 * python script with no access to this module — one file with one job is
 * cheaper to agree on across two languages than a key inside a growing
 * settings shape. `PI_SNIPPET_REMOTES` names it outright, for tests and for
 * an unwritable agent directory; the handler honours the same variable.
 */
export function remotesPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_SNIPPET_REMOTES;
	if (override !== undefined && override !== "") return override;
	return join(agentDir(env), REMOTES_FILE);
}

/**
 * A host is an ssh-config alias or a plain hostname, and nothing else.
 *
 * The value reaches an `ssh` argv in the handler, so the shape is checked on
 * the way in as well as on the way out — a rejected value is no relay, never a
 * quoted-around one.
 */
export function isRelayHost(host: string): boolean {
	return /^[A-Za-z0-9._@-]{1,255}$/.test(host);
}

/**
 * The hosts a click may be relayed to, in the order to try them.
 *
 * A list rather than the single host this started as, because one machine in
 * front of several remotes is the ordinary case and hand-editing a file to
 * switch between them is not a feature. It stays an allowlist: the handler
 * tries these and only these, so nothing a URL carries can point a click at a
 * host the user never named.
 *
 * `{ "host": "…" }` — what earlier versions wrote, and what a hand-written
 * file most likely says — is read as a one-entry list, after any `hosts`.
 * Malformed entries are dropped rather than refused: a file with one bad name
 * in it should still relay to the good ones.
 */
export function readRelayHosts(env: NodeJS.ProcessEnv = process.env): string[] {
	let listed: unknown[] = [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(remotesPath(env), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return [];
		const hosts = (parsed as { hosts?: unknown }).hosts;
		const single = (parsed as { host?: unknown }).host;
		if (Array.isArray(hosts)) listed = hosts;
		if (typeof single === "string") listed = [...listed, single];
	} catch {
		return [];
	}
	const hosts: string[] = [];
	for (const host of listed) {
		if (typeof host !== "string" || !isRelayHost(host)) continue;
		if (!hosts.includes(host)) hosts.push(host);
	}
	return hosts;
}

/**
 * Add a host to the front of the list, or clear the list when handed "".
 *
 * The front because the one just named is the one being set up, and the
 * handler tries them in order until a session answers — so a fresh entry costs
 * nothing to be wrong about, and being right saves a round trip. Adding rather
 * than replacing is what the bootstrap line does too: a second remote must not
 * cost the first.
 *
 * Nothing here is allowed to be fatal, same rule as the rest of this module:
 * an unwritable agent directory costs the relay, not the session.
 */
export function addRelayHost(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const path = remotesPath(env);
	try {
		if (host === "") {
			if (existsSync(path)) unlinkSync(path);
			return true;
		}
		if (!isRelayHost(host)) return false;
		const hosts = [host, ...readRelayHosts(env).filter((known) => known !== host)];
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ hosts }, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Where this host records the clients that relay clicks back to it.
 *
 * The server side of the relay, and the only part of it this machine writes for
 * itself: the stamps are made by the ssh-back the client runs, not by pi.
 * `PI_SNIPPET_RELAY_CLIENTS` names the directory outright, for tests and for
 * a bootstrap line that has to target an agent directory this session was
 * pointed at with `PI_CODING_AGENT_DIR`.
 */
export function relayClientsDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_SNIPPET_RELAY_CLIENTS;
	if (override !== undefined && override !== "") return override;
	return join(agentDir(env), RELAY_CLIENTS_DIR);
}

/**
 * What the bootstrap line carries where a hostname goes when this host cannot
 * name itself — a session reached over `SSH_TTY` alone knows there is a client
 * but not the address it came from. The user edits it before running the line,
 * so it has to survive being generated into one.
 */
export const HOST_PLACEHOLDER = "<this-host>";

/**
 * Has this client set relayed clicking up with this host?
 *
 * The whole of the remote session's evidence that painting chip URLs is worth
 * anything, and it does not expire: the stamp records that a connection from
 * that client succeeded, which stays true. A client that later stops relaying
 * costs a chip that looks clickable and is not — the same silence a dead
 * session already gives, and the reason nothing here is louder than a
 * `stat`. The address is checked because it becomes a file name, though only
 * ever one this side looks up rather than enumerates.
 */
export function relayClientSeen(address: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!/^[0-9A-Fa-f.:]{1,45}$/.test(address)) return false;
	return existsSync(join(relayClientsDir(env), address));
}

/**
 * The one-time line the user runs on their machine, and whether it carries the
 * half that makes it the last time.
 *
 * Two commands joined by `&&`, run by two different shells and so quoted two
 * different ways:
 *
 * - The **config half** records this host in the client's relay list, keeping
 *   whatever is already there — a python one-liner rather than the `printf`
 *   this started as, because adding is the point and merging is the one thing a
 *   short shell command cannot do. It runs in the client's own shell and
 *   nothing re-parses it, so python's apostrophes inside a double-quoted word
 *   are safe here in a way they would not be below.
 * - The **stamp half** ssh-es straight back, which both proves the alias
 *   reaches here without a password — the same thing a relayed click needs —
 *   and leaves the file `relayClientSeen()` reads, after which this host paints
 *   chip URLs for that client on its own. Single-quoted, so `SSH_CONNECTION` is
 *   expanded by the shell *here*: the client never names itself.
 *
 * `stamps` is false when the agent directory cannot go in a single-quoted word
 * unescaped, which only an exotic `PI_CODING_AGENT_DIR` causes: the line drops
 * that half rather than being unpasteable, and the caller says so.
 *
 * The host is interpolated into a shell line and is *not* re-checked here:
 * `sshServerHost()` in `pi-snippet-tui.ts`, the only caller, yields either an
 * address that passed `isRelayHost()` or `HOST_PLACEHOLDER`.
 */
export function relayBootstrapLine(
	host: string,
	env: NodeJS.ProcessEnv = process.env,
): { line: string; stamps: boolean } {
	const config =
		`mkdir -p ~/.pi/agent && python3 -c "import json,os;h='${host}';`
		+ `p=os.path.expanduser('~/.pi/agent/${REMOTES_FILE}');`
		+ `d=json.load(open(p)) if os.path.exists(p) else {};`
		+ `k=[x for x in (d.get('hosts') or [d.get('host')]) if x and x!=h];`
		+ `json.dump({'hosts':[h]+k},open(p,'w'))"`;
	const dir = relayClientsDir(env);
	if (!/^[A-Za-z0-9._/@+-]{1,4096}$/.test(dir)) return { line: config, stamps: false };
	// `cd` rather than a second copy of the path: this line is pasted by hand,
	// and every character of it is read by someone deciding whether to trust it.
	return {
		line: `${config} && ssh ${host} 'mkdir -p ${dir} && cd ${dir} && touch "\${SSH_CONNECTION%% *}"'`,
		stamps: true,
	};
}

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
 * Self-contained on purpose: nothing is installed on the remote host, and
 * python3 is the same near-universal interpreter the handler itself needs.
 */
export function relayCommand(): string {
	return `python3 -c '
import os, socket, sys, tempfile, urllib.parse
${PY_CANDIDATES}
u = urllib.parse.urlparse(sys.argv[1])
for directory in candidates():
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(os.path.join(directory, u.netloc + ".sock"))
        s.sendall((u.path.strip("/") + "\\n").encode())
        s.close()
        sys.exit(0)
    except OSError:
        continue
sys.exit(1)
'`;
}

function handlerSource(): string {
	return `#!/usr/bin/env python3
"""pi-snippet click handler. Forwards one ${LINK_SCHEME}:// URL and exits.

Generated by pi-snippet; edits are lost on the next install. Carries no text:
the URL names a slot, and the pi session decides what that slot means.

Two deliveries, in order: a unix socket on this machine, and — when the session
lives on another host, reached over SSH — a relay back to it through ssh. The
relay host comes from ${REMOTES_FILE}, never from the URL: a hostname in the URL
would make any pasteable ${LINK_SCHEME}:// link an instruction to SSH somewhere.
"""
import json, os, re, socket, subprocess, sys, tempfile, time, urllib.parse

url = sys.argv[1] if len(sys.argv) > 1 else ""
u = urllib.parse.urlparse(url)
if u.scheme != "${LINK_SCHEME}" or not u.netloc.isalnum():
    sys.exit(2)
# Strict before the relay, because the relay hands this path to a remote shell:
# hex and a small integer have no metacharacter to act on. Matches
# parseChipPath() in shared/link-url.ts, so nothing valid is turned away here.
if not re.match(r"^/[0-9a-f]{1,16}/c[0-9]{1,3}$", u.path):
    sys.exit(2)

${PY_CANDIDATES}

for directory in candidates():
    path = os.path.join(directory, u.netloc + ".sock")
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(path)
        s.sendall((u.path.strip("/") + "\\n").encode())
        s.close()
        sys.exit(0)
    except OSError:
        continue


def agent_dir():
    configured = os.environ.get("PI_CODING_AGENT_DIR")
    if not configured:
        return os.path.join(os.path.expanduser("~"), ".pi", "agent")
    if configured == "~":
        return os.path.expanduser("~")
    if configured.startswith("~/"):
        return os.path.expanduser("~") + configured[1:]
    return configured


def remotes_path():
    override = os.environ.get("PI_SNIPPET_REMOTES")
    return override or os.path.join(agent_dir(), "${REMOTES_FILE}")


def relay_hosts():
    """Every host this click may be sent to, in the order to try them.

    The file is the allowlist, so nothing outside it is ever tried — and a
    malformed entry is dropped rather than failing the lot: one bad name should
    not cost the good ones. An ssh-config alias or a plain hostname is all a
    name may be; anything a shell could act on is refused rather than quoted
    around, because these values reach an ssh argv.
    """
    try:
        with open(remotes_path(), "r") as fh:
            data = json.load(fh)
        listed = data.get("hosts")
        single = data.get("host")
    except (OSError, ValueError, AttributeError):
        return []
    if not isinstance(listed, list):
        listed = []
    if isinstance(single, str):
        listed = listed + [single]
    hosts = []
    for host in listed:
        if not isinstance(host, str) or not re.match(r"^[A-Za-z0-9._@-]{1,255}$", host):
            continue
        if host not in hosts:
            hosts.append(host)
    return hosts


def cache_path():
    runtime = os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    return os.path.join(runtime, "pi-snippet-relay-%s" % u.netloc)


def remembered(hosts):
    """Which host answered for this session last time.

    Only ever a hint about *order*: a name that is no longer in the file is
    ignored, so a tampered cache cannot send a click anywhere the user has not
    named. Without it, a click on a second remote pays a dead ssh handshake for
    every host ahead of it in the list, on every click.
    """
    try:
        with open(cache_path(), "r") as fh:
            host = fh.read().strip()
    except OSError:
        return None
    return host if host in hosts else None


def remember(host):
    try:
        with open(cache_path(), "w") as fh:
            fh.write(host)
    except OSError:
        pass


def explain_once():
    """The one failure worth telling the user about, at most once an hour.

    A chip clicked in old scrollback finds no session and must stay silent —
    an error dialog for a dead chip is noise. This is the other case: the
    session is alive on a host this machine has not been told about, and the
    fix is a one-time setting. The handler is stateless and spawns fresh per
    click, so the rate limit is a stamp file rather than a variable.
    """
    runtime = os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    stamp = os.path.join(runtime, "pi-snippet-unconfigured-%s" % u.netloc)
    try:
        if time.time() - os.path.getmtime(stamp) < 3600:
            return
    except OSError:
        pass
    try:
        with open(stamp, "w") as fh:
            fh.write("")
    except OSError:
        pass
    try:
        subprocess.run(
            ["notify-send", "pi-snippet", "This chip belongs to a pi session on "
             "another host. Run pi /snippets on this machine and set the SSH "
             "relay host to make remote chips clickable."],
            timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        pass  # no notify-send, or no display: degrade to the old silence


hosts = relay_hosts()
if not hosts:
    explain_once()
    sys.exit(1)
first = remembered(hosts)
if first is not None:
    hosts = [first] + [host for host in hosts if host != first]
for host in hosts:
    try:
        # BatchMode so a click never hangs on a password or a host-key prompt,
        # and two timeouts so a dark host costs seconds rather than a stuck
        # process — which is also what makes trying several of them bearable.
        done = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", host,
             ${JSON.stringify(relayCommand())}, url],
            timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        continue
    if done.returncode == 0:
        remember(host)
        sys.exit(0)
# Configured but unreachable is the same situation as dead scrollback: the user
# has already opted in, and there is nothing left to configure. Quiet either way.
sys.exit(1)
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
