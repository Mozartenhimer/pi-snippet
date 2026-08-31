#!/usr/bin/env python3
"""Relayed clicking over real SSH: no setup, no config, no toggle.

Runs inside the *client* container (see scripts/docker-ssh-env.sh); driven by
scripts/ssh-click-docker.py, which is the thing to run by hand.

Since ADR 0001 there is nothing to arrange between the two machines. The chip
URL names the server (`pisnip://<host>/<token>/<msg>/cN`), so the click finds no
socket here, reads the host out of the URL, and tunnels itself back through a
fresh ssh. Nothing is installed on the server, nothing is written on the client,
and the flow this asserts is the whole of the feature: start pi over SSH, send a
message, chips carry URLs, click, text lands.

Deliberately hostile to a false pass: the local socket directory is removed
first, and any relay config an older version left behind is deleted, so nothing
here can succeed by a path that no longer exists.

The last two phases are the ones that pay for the guards. `known_hosts` is what
replaced the allowlist this used to keep, so a URL naming a host the client has
never connected to — the same sshd, reached by a second DNS name — must deliver
nothing; and a host `ssh` would read as an option must be refused before a
process is spawned at all.
"""
import json, os, pty, re, select, shutil, subprocess, sys, time

ROWS, COLS = 30, 800
SUGGESTION = "rebuild the solution"
REPLY = f"Two ways. Want me to <snippet>{SUGGESTION}</snippet>?"
HANDLER = os.path.expanduser("~/.local/share/pi-snippet/open-handler")
SOCKDIR = f"/tmp/pi-snippet-{os.getuid()}"
LEGACY = os.path.expanduser("~/.pi/agent/pi-snippet-remotes.json")
HOST = os.environ.get("PISNIP_SSH_HOST", "piserver")
# What the server calls itself, and so what its chips will name. The client has
# connected to it under this name (docker-ssh-env.sh seeds known_hosts), which
# is the assumption the whole design rests on: hosts are reachable by name.
SERVER = os.environ.get("PISNIP_SERVER_HOST", "pisnip-server")
# The same machine, same sshd, same key — under a name this client has never
# connected to.
UNKNOWN = os.environ.get("PISNIP_UNKNOWN_HOST", "otherserver")

# Nothing local may answer, and no leftover config may help.
shutil.rmtree(SOCKDIR, ignore_errors=True)
if os.path.exists(LEGACY):
	os.unlink(LEGACY)

remote_env = {
	"MOCK_LLM_INFER_MARKER": "@@none@@",
	"MOCK_LLM_SCRIPT": json.dumps([REPLY]),
	"MOCK_LLM_INFER": "[]",
	"PI_CODING_AGENT_DIR": "/tmp/pi-agent",
	"PI_SNIPPET_SETTINGS": "/tmp/pi-snippet.json",
	"TERM": "xterm-ghostty", "TERM_PROGRAM": "ghostty", "COLORTERM": "truecolor",
	"LINES": str(ROWS), "COLUMNS": str(COLS),
}
envstr = " ".join(f"{k}={json.dumps(v)}" for k, v in remote_env.items())
pi_cmd = (
	"mkdir -p /tmp/pi-agent; "
	f"env {envstr} pi --no-session --no-extensions "
	"-e /repo/test/fixtures/mock-llm.js -e /repo/dist/extension/pi-snippet-tui.js "
	"--provider mockllm --model mock-small"
)
RESET = "rm -rf /tmp/pi-agent /tmp/pi-snippet.json /tmp/pi-snippet-$(id -u); "

raw = bytearray()
DSR = re.compile(rb"\x1b\[6n")

import fcntl, struct, termios


def open_session(reset=True):
	"""Start pi on the server through a pty, as an interactive user would."""
	global pid, master, raw
	raw = bytearray()
	pid, master = pty.fork()
	if pid == 0:
		os.environ["TERM"] = "xterm-ghostty"
		os.execvp("ssh", ["ssh", "-tt", "-o", "BatchMode=yes", HOST,
		                  (RESET if reset else "") + pi_cmd])
	fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))


def close_session():
	send(b"\x03")
	pump(0.5)
	try:
		os.close(master)
	except OSError:
		pass
	try:
		os.kill(pid, 9)
		os.waitpid(pid, 0)
	except (OSError, ChildProcessError):
		pass


open_session()


def pump(seconds):
	global raw
	end = time.time() + seconds
	while time.time() < end:
		r, _, _ = select.select([master], [], [], 0.2)
		if not r:
			continue
		try:
			chunk = os.read(master, 65536)
		except OSError:
			return
		raw += chunk
		for _ in DSR.findall(chunk):
			os.write(master, b"\x1b[1;1R")


def text():
	return bytes(raw).decode("utf-8", "replace")


def flat(s):
	s = re.sub(r"\x1b\][^\x07]*\x07", "", s)
	return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", s)


def wait_for(needle, timeout=30):
	end = time.time() + timeout
	while time.time() < end:
		pump(0.3)
		if needle in flat(text()):
			return True
	return False


def send(data):
	os.write(master, data)


def clear_composer():
	"""Empty the editor before typing a command into it."""
	send(b"\x15")
	pump(0.3)
	send(b"\x7f" * 250)
	pump(0.5)

results = {}


def check(name, ok):
	results[name] = bool(ok)
	print(("PASS" if ok else "FAIL"), name, flush=True)


def bail(message):
	open("/tmp/ssh-relay.out", "w").write(text())
	print(message, file=sys.stderr)
	print(f"\n{sum(results.values())}/{len(results)} checks passed", flush=True)
	sys.exit(1)


def chip_urls():
	return re.findall(r"\x1b\]8;[^;]*;(pisnip://[^\x1b\x07]+)", text())


check("pi started over ssh", wait_for("Inline suggestions", 30) or wait_for("auto", 10))
pump(2)

# --- the first message already carries clickable chips ------------------------
# No bootstrap line, no stamp, no toggle: the URL says which machine to deliver
# to, so there is nothing for either end to arrange first.
clear_composer(); send(b"go\r")
check("assistant replied", wait_for("Two ways", 30))
pump(3)
urls = chip_urls()
check("chip carries a pisnip:// URL with nothing set up", len(urls) > 0)
if not urls:
	bail("no chip URL painted")
url = urls[-1]
print(f"    chip url={url}", flush=True)
check("the URL names the server, not the session token", url.split("/")[2] == SERVER)

# --- nothing local may answer -------------------------------------------------
shutil.rmtree(SOCKDIR, ignore_errors=True)
check("no local socket directory on the client", not os.path.exists(SOCKDIR))
check("no relay config on the client either", not os.path.exists(LEGACY))

# --- the click, resolved here and delivered there -----------------------------
clear_composer()
before = len(raw)
started = time.time()
rc = subprocess.run([HANDLER, url], capture_output=True, timeout=30)
elapsed = time.time() - started
print(f"    handler exit={rc.returncode} in {elapsed:.1f}s", flush=True)
check("handler exited 0 (it relayed over ssh)", rc.returncode == 0)
check("handler said nothing on the way", rc.stdout == b"" and rc.stderr == b"")
pump(3)
after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
check("suggestion text landed in the composer", SUGGESTION in after)

# --- and again after a restart, still with nothing arranged -------------------
# There is no per-session state left anywhere, so this is only interesting as
# proof of that: a fresh pi on the server paints working chips immediately.
close_session()
open_session()
check("pi restarted on the server", wait_for("Inline suggestions", 30) or wait_for("auto", 10))
clear_composer(); send(b"go\r")
check("assistant replied in the second session", wait_for("Two ways", 30))
pump(3)
again = chip_urls()
check("chips carry URLs from the first message again", len(again) > 0)
if again:
	before = len(raw)
	rc = subprocess.run([HANDLER, again[-1]], capture_output=True, timeout=30)
	check("a click on those chips relays and lands", rc.returncode == 0)
	pump(3)
	after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
	check("suggestion text landed in the second session", SUGGESTION in after)
	url = again[-1]

# --- a host this client has never connected to must not be dialled ------------
# The same sshd, the same key, a second DNS name. ssh's own known_hosts is what
# replaced the relay allowlist, and BatchMode is what makes it a refusal rather
# than a prompt — so this is the security argument, run.
clear_composer()
before = len(raw)
stranger = url.replace(f"//{SERVER}/", f"//{UNKNOWN}/")
check("the stranger URL differs from the good one", stranger != url)
rc = subprocess.run([HANDLER, stranger], capture_output=True, timeout=30)
print(f"    unknown-host exit={rc.returncode}", flush=True)
check("a URL naming an unknown host delivers nothing", rc.returncode != 0)
check("and says nothing while failing", rc.stdout == b"" and rc.stderr == b"")
pump(3)
after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
check("no text reached the session from the unknown host", SUGGESTION not in after)

# --- and a host ssh would read as an option is refused before any spawn -------
# `-Jevil.com` in the host slot would make ssh shift its destination to the next
# argument. The pattern refuses it, which is why exit 2 (malformed) and not 1.
for bad in ("-J" + UNKNOWN, "-oProxyCommand=x", "my host", "a;id"):
	rc = subprocess.run([HANDLER, url.replace(f"//{SERVER}/", f"//{bad}/")],
	                    capture_output=True, timeout=30)
	check(f"refuses {bad!r} as a host", rc.returncode == 2)

open("/tmp/ssh-relay.out", "w").write(text())
print()
print(f"{sum(results.values())}/{len(results)} checks passed", flush=True)
sys.exit(0 if all(results.values()) else 1)
