#!/usr/bin/env python3
"""Terminal-resolved clicking over a real SSH connection, end to end.

Runs inside the *client* container (see scripts/docker-ssh-env.sh); driven by
scripts/ssh-click-docker.py, which is the thing to run by hand.

scripts/ssh-remote-tmux.py asserts the same flow with SSH_TTY faked in one
process, which is enough for the UI contract and nothing else: the feature is
the wire. Here pi runs on another host behind real sshd, reached through a real
pty, so SSH_TTY and SSH_CONNECTION are set by sshd; the chip URL is scraped out
of the OSC 8 hyperlink the terminal actually received; the click is fired by the
handler `link-install.ts` generated on this machine; and it reaches the session
only by crossing the `ssh -L` unix-socket forward that /snippets printed.

The order matters and is the user's own: remote clicking goes on *first*, then
the message arrives, because a message rendered while it was off is painted with
bare labels and no URL to click.
"""
import json, os, pty, re, select, subprocess, sys, time

ROWS, COLS = 30, 110
SUGGESTION = "rebuild the solution"
REPLY = f"Two ways. Want me to <snippet>{SUGGESTION}</snippet>?"
HANDLER = os.path.expanduser("~/.local/share/pi-snippet/open-handler")
SOCKDIR = f"/tmp/pi-snippet-{os.getuid()}"
HOST = os.environ.get("PISNIP_SSH_HOST", "piserver")

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
remote_cmd = (
	"rm -rf /tmp/pi-agent /tmp/pi-snippet.json /tmp/pi-snippet-$(id -u); mkdir -p /tmp/pi-agent; "
	f"env {envstr} pi --no-session --no-extensions "
	"-e /repo/test/fixtures/mock-llm.js -e /repo/dist/extension/pi-snippet-tui.js "
	"--provider mockllm --model mock-small"
)

raw = bytearray()
DSR = re.compile(rb"\x1b\[6n")

pid, master = pty.fork()
if pid == 0:
	os.environ["TERM"] = "xterm-ghostty"
	os.execvp("ssh", ["ssh", "-tt", "-o", "BatchMode=yes", HOST, remote_cmd])

import fcntl, struct, termios
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))


def pump(seconds):
	"""Read for a while, answering cursor-position queries as a terminal does."""
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
	"""Press Down until `label`'s row is selected. The menu marks it with →,
	so this reads the live screen rather than counting keystrokes — the row
	order changes with the session's state."""
	end = time.time() + timeout
	while time.time() < end:
		tail = flat(text())[-4000:]
		rows = [l for l in re.split(r"[\r\n]", tail) if label in l]
		if rows and rows[-1].lstrip().startswith("→"):
			return True
		send(b"\x1b[B")
		pump(0.5)
	return False


results = {}


def check(name, ok):
	results[name] = bool(ok)
	print(("PASS" if ok else "FAIL"), name, flush=True)


def bail(message):
	open("/tmp/ssh-click.out", "w").write(text())
	print(message, file=sys.stderr)
	print(f"\n{sum(results.values())}/{len(results)} checks passed", flush=True)
	sys.exit(1)


# --- pi comes up over ssh -----------------------------------------------------
check("pi started over ssh", wait_for("Inline suggestions", 30) or wait_for("auto", 10))
pump(2)

# --- remote clicking on -------------------------------------------------------
send(b"/snippets\r")
check("menu opened", wait_for("Remote clicking", 20))
check("menu offers Remote clicking, not desktop registration",
      "Register click handler —" not in flat(text()))
check("selected the Remote clicking row", select_row("Remote clicking"))
send(b"\r")
check("toggle reported on", wait_for("Remote clicking on", 20))
check("recipe went to the composer", "ssh -L" in flat(text()))
# The first enable cannot verify — no forward exists yet. Saying so, rather than
# claiming success, is the contract.
check("first enable says no click yet", wait_for("No click yet", 25))
pump(2)

# --- the socket the session actually bound ------------------------------------
ls = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, f"ls {SOCKDIR}/"],
                    capture_output=True, text=True, timeout=20)
socks = [s for s in ls.stdout.split() if s.endswith(".sock")]
check("server bound exactly one socket", len(socks) == 1)
if not socks:
	bail("no socket on the server")
token = socks[0][:-5]
remote_sock = f"{SOCKDIR}/{socks[0]}"
print(f"    token={token} remote_sock={remote_sock}", flush=True)
check("recipe names this session's socket",
      token in flat(text()).replace(" ", "").replace("\n", "").replace("\r", ""))

# --- a message, now that chips carry URLs -------------------------------------
send(b"go\r")
check("assistant replied", wait_for("Two ways", 30))
pump(3)
urls = re.findall(r"\x1b\]8;[^;]*;(pisnip://[^\x1b\x07]+)", text())
check("chip carries a pisnip:// URL", len(urls) > 0)
if not urls:
	bail("no chip URL painted")
url = urls[-1]
print(f"    chip url={url}", flush=True)
check("URL names this session's token", url.startswith(f"pisnip://{token}/"))

# --- the forward, run for real ------------------------------------------------
os.makedirs(SOCKDIR, mode=0o700, exist_ok=True)
local_sock = f"{SOCKDIR}/{token}.sock"
if os.path.exists(local_sock):
	os.unlink(local_sock)
fwd = subprocess.Popen(
	["ssh", "-o", "BatchMode=yes", "-N", "-L", f"{local_sock}:{remote_sock}", HOST],
	stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(40):
	if os.path.exists(local_sock):
		break
	pump(0.25)
check("forward created the local socket", os.path.exists(local_sock))

# --- re-arm the verify window and click ---------------------------------------
# Off, then on. The token comes from the session id, so the path is unchanged
# and the forward above still lands — which is the property that lets a resumed
# session rebind the socket its own old scrollback points at.
send(b"/snippets\r"); wait_for("Remote clicking", 15)
select_row("Remote clicking"); send(b"\r")
check("toggling off reported off", wait_for("Remote clicking off", 20))
pump(1)
send(b"/snippets\r"); wait_for("Remote clicking", 15)
select_row("Remote clicking"); send(b"\r")
check("verify window re-armed", wait_for("Remote clicking on", 20))

before = len(raw)
rc = subprocess.run([HANDLER, url], capture_output=True, timeout=20)
check("handler exited 0 (it found the forwarded socket)", rc.returncode == 0)
check("click made the whole trip", wait_for("Verified", 25))
after = flat(bytes(raw[before:]).decode("utf-8", "replace"))
check("suggestion text landed in the composer", SUGGESTION in after)

fwd.terminate()
open("/tmp/ssh-click.out", "w").write(text())
print()
print(f"{sum(results.values())}/{len(results)} checks passed", flush=True)
sys.exit(0 if all(results.values()) else 1)
