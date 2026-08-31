#!/usr/bin/env python3
"""Prototype of the Linux click-handler registration (docs/terminal-resolved-clicks.md §6).

Registering a URL scheme is the one part of terminal-resolved clicking that
happens outside pi, once per machine. This is that procedure, standalone, so it
can be run and argued with before it becomes a `/snippets` action.

    python3 scripts/link-register.py --install     # register pisnip:// for this user
    python3 scripts/link-register.py --probe       # fire a URL, prove it round-trips
    python3 scripts/link-register.py --status
    python3 scripts/link-register.py --uninstall

Everything is user-level: no root, no system paths. Measured 2026-08-28 in a
container with neither xdg-utils nor desktop-file-utils installed — a .desktop
file plus a mimeapps.list entry is sufficient on its own, so both tools are used
when present and skipped when not.
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

SCHEME = "pisnip"
DESKTOP_ID = "pi-snippet-open.desktop"
HANDLER_NAME = "open-handler"

HANDLER = '''#!/usr/bin/env python3
"""Forwards one pisnip:// URL to the pi session that painted it, then exits.

Stateless by design: the socket is derived from the token in the URL, so this
file is written once and serves every future session. It carries no text --
the URL names a slot, and the extension decides what that slot means.

Local delivery only, deliberately: this script is the probe for scheme
registration, not the shipped handler. The real one (link-install.ts) relays a
URL naming another host over ssh; here a URL for anywhere else is a miss.
"""
import os, socket, sys, urllib.parse

u = urllib.parse.urlparse(sys.argv[1] if len(sys.argv) > 1 else "")
# scheme://host/token/msg/cN -- the host is the netloc, the token is first in
# the path (ADR 0001).
parts = u.path.strip("/").split("/")
if u.scheme != "pisnip" or len(parts) != 3 or not parts[0].isalnum():
    sys.exit(2)
runtime = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
path = os.path.join(runtime, "pi-snippet", parts[0] + ".sock")
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(path)
    s.sendall(("/".join(parts[1:]) + "\\n").encode())
    s.close()
except OSError:
    # A dead session is the normal case for a chip clicked in old scrollback.
    sys.exit(1)
'''


def data_home() -> str:
	return os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")


def config_home() -> str:
	return os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")


def runtime_dir() -> str:
	return os.environ.get("XDG_RUNTIME_DIR") or "/tmp"


def handler_path() -> str:
	# Deliberately not under the pi agent dir: PI_CODING_AGENT_DIR moves per
	# session, and the Exec line baked into the .desktop file must not.
	return os.path.join(data_home(), "pi-snippet", HANDLER_NAME)


def desktop_path() -> str:
	return os.path.join(data_home(), "applications", DESKTOP_ID)


def mimeapps_path() -> str:
	return os.path.join(config_home(), "mimeapps.list")


def install() -> int:
	handler = handler_path()
	os.makedirs(os.path.dirname(handler), exist_ok=True)
	with open(handler, "w") as f:
		f.write(HANDLER)
	os.chmod(handler, 0o755)

	desktop = desktop_path()
	os.makedirs(os.path.dirname(desktop), exist_ok=True)
	with open(desktop, "w") as f:
		f.write(
			"[Desktop Entry]\n"
			"Type=Application\n"
			"Name=pi-snippet click handler\n"
			"Comment=Inserts a suggestion into the pi session that painted it\n"
			f"Exec={handler} %u\n"
			"Terminal=false\n"
			"NoDisplay=true\n"
			f"MimeType=x-scheme-handler/{SCHEME};\n"
		)

	# Both of these are conveniences. The association below is what actually
	# decides dispatch, and it is a plain ini file we can write ourselves.
	if shutil.which("desktop-file-validate"):
		subprocess.run(["desktop-file-validate", desktop], check=False)
	if shutil.which("update-desktop-database"):
		subprocess.run(["update-desktop-database", os.path.dirname(desktop)], check=False)

	if shutil.which("xdg-mime"):
		subprocess.run(
			["xdg-mime", "default", DESKTOP_ID, f"x-scheme-handler/{SCHEME}"], check=False
		)
	else:
		set_default_by_hand()

	# xdg-open parses Exec with `cut -d= -f2- | first_word | which`, so a
	# quoted path -- which the Desktop Entry spec allows and GLib handles --
	# reaches `which` with its quotes attached and fails. Unquoted works in
	# both parsers, at the cost of not surviving a space in the path.
	if " " in handler:
		print(f"warning: {handler} contains a space; xdg-open cannot parse it "
			  "(the portal and gio still can)", file=sys.stderr)

	print(f"handler   {handler}")
	print(f"desktop   {desktop}")
	print(f"assoc     {mimeapps_path()}")
	return 0


def set_default_by_hand() -> None:
	"""Add the association without xdg-utils, preserving the rest of the file."""
	path = mimeapps_path()
	os.makedirs(os.path.dirname(path), exist_ok=True)
	key = f"x-scheme-handler/{SCHEME}"
	lines = []
	if os.path.exists(path):
		with open(path) as f:
			lines = f.read().splitlines()
	out, in_defaults, written = [], False, False
	for line in lines:
		if line.strip().startswith("["):
			if in_defaults and not written:
				out.append(f"{key}={DESKTOP_ID}")
				written = True
			in_defaults = line.strip() == "[Default Applications]"
		if in_defaults and line.startswith(f"{key}="):
			continue  # replaced below
		out.append(line)
	if not any(l.strip() == "[Default Applications]" for l in out):
		out.append("[Default Applications]")
		in_defaults = True
	if not written:
		index = max(i for i, l in enumerate(out) if l.strip() == "[Default Applications]")
		out.insert(index + 1, f"{key}={DESKTOP_ID}")
	with open(path, "w") as f:
		f.write("\n".join(out) + "\n")


def dispatchers() -> list[list[str]]:
	"""Openers to try, nearest-to-Ghostty first.

	Ghostty's GTK apprt calls the XDG portal (with `ask=false`) and falls back
	to xdg-open only if the portal errors, so the portal is what a probe should
	exercise first.
	"""
	found = []
	if shutil.which("gdbus"):
		found.append(["gdbus", "call", "-e",
					  "-d", "org.freedesktop.portal.Desktop",
					  "-o", "/org/freedesktop/portal/desktop",
					  "-m", "org.freedesktop.portal.OpenURI.OpenURI",
					  "", "{url}", "{'ask': <false>}"])
	if shutil.which("gio"):
		found.append(["gio", "open", "{url}"])
	if shutil.which("xdg-open"):
		found.append(["xdg-open", "{url}"])
	return found


def probe() -> int:
	"""Fire a real URL at each dispatcher and see whether the socket hears it."""
	token = "probe000"
	directory = os.path.join(runtime_dir(), "pi-snippet")
	os.makedirs(directory, mode=0o700, exist_ok=True)
	sock_path = os.path.join(directory, f"{token}.sock")

	failures = 0
	for template in dispatchers():
		if os.path.exists(sock_path):
			os.unlink(sock_path)
		server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
		server.bind(sock_path)
		os.chmod(sock_path, 0o600)
		server.listen(1)
		server.settimeout(5)

		received: list[str] = []

		def accept() -> None:
			try:
				conn, _ = server.accept()
				received.append(conn.recv(4096).decode().strip())
				conn.close()
			except OSError:
				pass

		thread = threading.Thread(target=accept, daemon=True)
		thread.start()

		# scheme://host/token/msg/cN. The host is this machine, so the probe
		# never leaves it (ADR 0001); the shipped handler would relay any other.
		url = f"{SCHEME}://{socket.gethostname()}/{token}/0000/ping"
		argv = [a.replace("{url}", url) for a in template]
		result = subprocess.run(argv, capture_output=True, timeout=15, text=True)
		thread.join(timeout=6)
		server.close()
		if os.path.exists(sock_path):
			os.unlink(sock_path)

		ok = received and received[0] == "0000/ping"
		if ok:
			note = received[0]
		elif any(m in result.stderr for m in ("Error connecting:", "D-Bus", "session bus", "dbus-launch")):
			# No session bus is an absent environment, not a refusal. Says
			# nothing about whether the portal would dispatch the scheme.
			note = "skipped: no D-Bus session bus"
		else:
			note = (result.stderr.strip().splitlines() or ["nothing received"])[-1]
		label = "ok  " if ok else ("skip" if "skipped" in note else "FAIL")
		print(f"{label}  {argv[0]:10} -> {note[:88]}")
		if not ok and "skipped" not in note:
			failures += 1

	if not dispatchers():
		print("no opener found (gdbus, gio, xdg-open all absent)")
		return 1
	return 1 if failures else 0


def status() -> int:
	for label, path in (("handler", handler_path()), ("desktop", desktop_path())):
		print(f"{label:9} {'present' if os.path.exists(path) else 'MISSING'}  {path}")
	default = ""
	if shutil.which("xdg-mime"):
		default = subprocess.run(
			["xdg-mime", "query", "default", f"x-scheme-handler/{SCHEME}"],
			capture_output=True, text=True,
		).stdout.strip()
	print(f"{'assoc':9} {default or '(xdg-mime absent; check ' + mimeapps_path() + ')'}")
	return 0


def uninstall() -> int:
	"""Unregister pisnip:// everywhere gio looks, then ask the desktop.

	The first cut of this removed the two files and the config mimeapps.list and
	claimed success — and did not work: gio also consults the legacy
	~/.local/share/applications/mimeapps.list, and a stale mimeinfo.cache still
	recommended the deleted desktop file where update-desktop-database is
	absent. Mirrors uninstall() in src/extension/link-install.ts.
	"""
	for path in (desktop_path(), handler_path()):
		if os.path.exists(path):
			os.unlink(path)
			print(f"removed {path}")

	key = f"x-scheme-handler/{SCHEME}="
	locations = [mimeapps_path(), os.path.join(data_home(), "applications", "mimeapps.list")]
	for path in locations:
		if not os.path.exists(path):
			continue
		with open(path) as f:
			lines = f.read().splitlines()
		kept, changed = [], False
		for line in lines:
			if not line.startswith(key):
				kept.append(line)
				continue
			changed = True
			# The value is a ';'-separated handler list: drop ours, keep theirs.
			rest = [i for i in line[len(key):].split(";") if i and i != DESKTOP_ID]
			if rest:
				kept.append(key + ";".join(rest))
		if changed:
			try:
				with open(path, "w") as f:
					f.write("\n".join(kept) + "\n")
				print(f"cleaned {path}")
			except OSError as e:
				print(f"could not clean {path}: {e}", file=sys.stderr)

	if shutil.which("update-desktop-database"):
		subprocess.run(
			["update-desktop-database", os.path.dirname(desktop_path())], check=False
		)
	cache = os.path.join(data_home(), "applications", "mimeinfo.cache")
	if os.path.exists(cache):
		with open(cache) as f:
			lines = f.read().splitlines()
		kept = [l for l in lines if not l.startswith(key)]
		if kept != lines:
			with open(cache, "w") as f:
				f.write("\n".join(kept) + "\n")
			print(f"scrubbed {cache}")

	if shutil.which("xdg-mime"):
		default = subprocess.run(
			["xdg-mime", "query", "default", f"x-scheme-handler/{SCHEME}"],
			capture_output=True, text=True,
		).stdout.strip()
		if default == DESKTOP_ID:
			print("the desktop still reports our handler; a location above may be unwritable",
				  file=sys.stderr)
			return 1
		print(f"desktop reports no pi-snippet handler (default: {default or '(none)'})")
	return 0


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	group = parser.add_mutually_exclusive_group(required=True)
	for flag in ("install", "probe", "status", "uninstall"):
		group.add_argument(f"--{flag}", action="store_true")
	args = parser.parse_args()
	if args.install:
		return install()
	if args.probe:
		return probe()
	if args.status:
		return status()
	return uninstall()


if __name__ == "__main__":
	sys.exit(main())
