#!/usr/bin/env python3
"""Relayed clicking over real SSH: no forward, no flag, no resume.

Runs inside the *client* container (see scripts/docker-ssh-env.sh); driven by
scripts/ssh-click-docker.py, which is the thing to run by hand.

The sibling harness (ssh-click-client.py) asserts the shipped `ssh -L` path,
which costs a flag on every ssh invocation. This asserts the successor
(docs/ssh-back-handler.md): the click finds no socket on this machine, reads
the relay host off the client's own config, and tunnels *itself* back through
a fresh ssh — so the only per-machine setup is the one-time bootstrap line,
which is taken from where the remote /snippets put it rather than hardcoded.

Deliberately hostile to a false pass: the local socket directory is removed and
any forward killed first, so nothing here can succeed by the shipped path.

The last phase is the automatic opt-in: pi is restarted on the server without
wiping its agent directory, and must paint chip URLs with nothing asked of the
user — no /snippets, no toggle, no forward. That is what the stamp the
bootstrap line left there is for.
"""
import json, os, pty, re, select, shutil, subprocess, sys, time

ROWS, COLS = 30, 800  # wide, so the bootstrap line lands unwrapped
SUGGESTION = "rebuild the solution"
REPLY = f"Two ways. Want me to <snippet>{SUGGESTION}</snippet>?"
HANDLER = os.path.expanduser("~/.local/share/pi-snippet/open-handler")
SOCKDIR = f"/tmp/pi-snippet-{os.getuid()}"
REMOTES = os.path.expanduser("~/.pi/agent/pi-snippet-remotes.json")
HOST = os.environ.get("PISNIP_SSH_HOST", "piserver")

# Nothing local may answer, or a pass proves nothing.
subprocess.run(["pkill", "-f", "ssh -o BatchMode=yes -N -L"], capture_output=True)
shutil.rmtree(SOCKDIR, ignore_errors=True)
if os.path.exists(REMOTES):
	os.unlink(REMOTES)

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
	"""Start pi on the server through a pty, as an interactive user would.

	`reset` wipes the server-side agent directory first — which is why the
	second session does not: the stamp the bootstrap left there is the thing
	under test, and deleting it would test nothing at all.
	"""
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


def select_row(label, timeout=12):
	end = time.time() + timeout
	while time.time() < end:
		tail = flat(text())[-6000:]
		rows = [l for l in re.split(r"[\r\n]", tail) if label in l]
		if rows and rows[-1].lstrip().startswith("→"):
			return True
		send(b"\x1b[B")
		pump(0.5)
	return False


def clear_composer():
	"""Empty the editor before typing a command into it.

	/snippets writes into the composer — the forward recipe, the bootstrap
	line — and a command typed after one of those is just more text appended
	to it, not a command. Ctrl+U first, then backspaces for an editor that
	does not take it.
	"""
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


check("pi started over ssh", wait_for("Inline suggestions", 30) or wait_for("auto", 10))
pump(2)

# --- the one-time bootstrap, taken from where the remote put it ---------------
clear_composer(); send(b"/snippets\r")
check("menu opened", wait_for("SSH relay setup", 20))
check("selected the relay setup row", select_row("SSH relay setup"))
send(b"\r")
check("bootstrap line went to the composer", wait_for("pi-snippet-remotes.json", 20))
pump(2)

lines = re.findall(r"mkdir -p ~/\.pi/agent && python3 -c [^\r\n\x1b]*", flat(text()))
check("bootstrap line is complete and unwrapped", len(lines) > 0)
if not lines:
	bail("no bootstrap line on screen")
bootstrap = lines[-1].strip()
print(f"    bootstrap={bootstrap}", flush=True)

# The remote knows which address the client reached it at (SSH_CONNECTION), and
# offers it. It cannot know the alias, which is why the toast says to prefer one
# — so the harness does exactly what a user is told to do.
peer = subprocess.run(["getent", "hosts", "pisnip-server"], capture_output=True, text=True)
server_ip = peer.stdout.split()[0] if peer.stdout.split() else ""
check("bootstrap suggests this host's own address", server_ip != "" and server_ip in bootstrap)
retargeted = bootstrap.replace(server_ip, HOST) if server_ip else bootstrap
subprocess.run(["bash", "-lc", retargeted], check=False)
try:
	written = json.load(open(REMOTES))
except (OSError, ValueError):
	written = None
check("client config written by that line", written == {"hosts": [HOST]})
# The second half of the same line, and the whole point of it: run from here,
# it proves the alias reaches the server without a password and leaves a stamp
# there naming this client. Nothing was installed on the server to do it.
check("bootstrap line carries the ssh-back too", f"ssh {HOST} " in retargeted)
stamped = subprocess.run(
	["ssh", "-o", "BatchMode=yes", HOST, "ls /tmp/pi-agent/pi-snippet-relay-clients"],
	capture_output=True, text=True)
check("server now has a stamp for this client",
      stamped.returncode == 0 and stamped.stdout.strip() != "")
print(f"    stamped={stamped.stdout.strip()!r}", flush=True)

# --- paint URLs (a chip over SSH is bare until the user opts in) --------------
clear_composer(); send(b"/snippets\r")
wait_for("Remote clicking", 15)
check("selected the Remote clicking row", select_row("Remote clicking"))
send(b"\r")
check("remote clicking on", wait_for("Remote clicking on", 20))
check("first enable says no click yet", wait_for("No click yet", 25))
pump(2)

clear_composer(); send(b"go\r")
check("assistant replied", wait_for("Two ways", 30))
pump(3)
urls = re.findall(r"\x1b\]8;[^;]*;(pisnip://[^\x1b\x07]+)", text())
check("chip carries a pisnip:// URL", len(urls) > 0)
if not urls:
	bail("no chip URL painted")
url = urls[-1]
print(f"    chip url={url}", flush=True)

# --- nothing local may answer -------------------------------------------------
shutil.rmtree(SOCKDIR, ignore_errors=True)
check("no local socket directory on the client", not os.path.exists(SOCKDIR))

# --- re-arm the verify window, then click -------------------------------------
clear_composer(); send(b"/snippets\r"); wait_for("Remote clicking", 15)
select_row("Remote clicking"); send(b"\r")
check("toggling off reported off", wait_for("Remote clicking off", 20))
pump(1)
clear_composer(); send(b"/snippets\r"); wait_for("Remote clicking", 15)
select_row("Remote clicking"); send(b"\r")
check("verify window re-armed", wait_for("Remote clicking on", 20))

before = len(raw)
started = time.time()
rc = subprocess.run([HANDLER, url], capture_output=True, timeout=30)
elapsed = time.time() - started
print(f"    handler exit={rc.returncode} in {elapsed:.1f}s", flush=True)
check("handler exited 0 (it relayed over ssh)", rc.returncode == 0)
check("handler said nothing on the way", rc.stdout == b"" and rc.stderr == b"")
check("click made the whole trip, with no forward", wait_for("Verified", 25))
after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
check("suggestion text landed in the composer", SUGGESTION in after)

# --- more than one remote: the handler finds the right one by itself ----------
# The list is the allowlist and the order is a guess, so a host that answers
# nothing must cost a handshake and not the click.
CACHE = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp",
                     "pi-snippet-relay-" + url.split("/")[2])
json.dump({"hosts": ["dark.invalid", HOST]}, open(REMOTES, "w"))
if os.path.exists(CACHE):
	os.unlink(CACHE)
clear_composer()
before = len(raw)
started = time.time()
rc = subprocess.run([HANDLER, url], capture_output=True, timeout=60)
print(f"    two-host handler exit={rc.returncode} in {time.time() - started:.1f}s", flush=True)
check("click lands past a host that answers nothing", rc.returncode == 0)
pump(3)
after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
check("suggestion text landed anyway", SUGGESTION in after)
check("the host that answered is remembered",
      os.path.exists(CACHE) and open(CACHE).read().strip() == HOST)

# --- the point of the stamp: the next session needs no toggle at all ----------
close_session()
open_session(reset=False)
check("pi restarted on the server", wait_for("Inline suggestions", 30) or wait_for("auto", 10))
check("second session turned remote clicking on by itself",
      wait_for("relays clicks back", 20))
clear_composer(); send(b"go\r")
check("assistant replied in the second session", wait_for("Two ways", 30))
pump(3)
auto_urls = re.findall(r"\x1b\]8;[^;]*;(pisnip://[^\x1b\x07]+)", text())
check("chips carry URLs with no toggle and no forward", len(auto_urls) > 0)
if auto_urls:
	before = len(raw)
	rc = subprocess.run([HANDLER, auto_urls[-1]], capture_output=True, timeout=30)
	check("a click on those chips relays and lands", rc.returncode == 0)
	pump(3)
	after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
	check("suggestion text landed in the second session", SUGGESTION in after)

# --- and the unconfigured case still fails quietly ----------------------------
os.unlink(REMOTES)
quiet = subprocess.run([HANDLER, url], capture_output=True, timeout=30)
check("unconfigured click exits 1 quietly", quiet.returncode == 1 and quiet.stdout == b"")
stamp = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp",
                     "pi-snippet-unconfigured-" + url.split("/")[2])
check("unconfigured click leaves the rate-limit stamp", os.path.exists(stamp))

open("/tmp/ssh-relay.out", "w").write(text())
print()
print(f"{sum(results.values())}/{len(results)} checks passed", flush=True)
sys.exit(0 if all(results.values()) else 1)
