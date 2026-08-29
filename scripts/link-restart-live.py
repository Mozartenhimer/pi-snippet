#!/usr/bin/env python3
"""Terminal-resolved click, across a real restart of the pi process.

link-click-live.py proves the click path within one process. This proves the
thing 3bc7870 ("key the link-mode socket on session id, not a random launch
token") actually claims: kill pi mid-conversation, relaunch it against the
*same* persisted session, and check that the chip repainted for the old
message still names a socket the new process binds -- i.e. that a click
survives the restart, not just a single process's lifetime.

    python3 scripts/link-restart-live.py

Exits 0 when the click inserts after the restart, 1 otherwise.
"""
import glob
import json
import os
import pty
import re
import select
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "dist", "extension", "pi-snippet-tui.js")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-llm.js")
ROWS, COLS = 40, 120
SUGGESTION = "rebuild the solution"
REPLY = f"Two ways forward. Want me to <snippet>{SUGGESTION}</snippet> or <snippet>run the tests</snippet>?"

sockdir = tempfile.mkdtemp(prefix="pi-snippet-sock-")
settings = tempfile.mktemp(suffix=".json")
with open(settings, "w") as f:
	json.dump({"enabled": True, "hotkeysEnabled": True, "clickEnabled": True,
			   "linkMode": True, "magicEnabled": False, "model": None}, f)

agent_dir = tempfile.mkdtemp(prefix="pi-agent-")
session_dir = tempfile.mkdtemp(prefix="pi-sessions-")

base_env = dict(os.environ)
base_env.update(
	MOCK_LLM_INFER_MARKER="@@none@@",
	MOCK_LLM_INFER="[]",
	PI_CODING_AGENT_DIR=agent_dir,
	PI_SNIPPET_SETTINGS=settings,
	PI_SNIPPET_SOCKET_DIR=sockdir,
	TERM="xterm-ghostty", TERM_PROGRAM="ghostty", COLORTERM="truecolor",
	LINES=str(ROWS), COLUMNS=str(COLS),
)
base_env.pop("TMUX", None)

DSR = re.compile(rb"\x1b\[6n")
URL = re.compile(rb"\x1b\]8;;(pisnip://[0-9a-f]+/[0-9a-f]+/c1)(?:\x07|\x1b\\)")


def launch(extra_args, script):
	env = dict(base_env)
	env["MOCK_LLM_LOG"] = tempfile.mktemp(suffix=".jsonl")
	env["MOCK_LLM_SCRIPT"] = json.dumps(script)
	args = ["pi", "-e", FIXTURE, "-e", EXT, "--session-dir", session_dir,
			"--provider", "mockllm", "--model", "mock-small", *extra_args]
	pid, master = pty.fork()
	if pid == 0:
		os.environ.clear()
		os.environ.update(env)
		os.execvp(args[0], args)
	import fcntl, struct, termios
	fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
	return pid, master


def pump(master, seconds):
	out = bytearray()
	end = time.time() + seconds
	while time.time() < end:
		r, _, _ = select.select([master], [], [], 0.2)
		if not r:
			continue
		try:
			chunk = os.read(master, 65536)
		except OSError:
			break
		if not chunk:
			break
		out += chunk
		for _ in DSR.findall(chunk):
			os.write(master, b"\x1b[1;1R")
	return bytes(out)


def kill(pid, master):
	try:
		os.kill(pid, 9)
		os.waitpid(pid, 0)
	except Exception:
		pass
	try:
		os.close(master)
	except Exception:
		pass


def fail(msg):
	print(f"FAIL: {msg}")
	sys.exit(1)


# --- Process 1: have a chip painted, then die without a clean shutdown ---
pid1, master1 = launch([], [REPLY])
pump(master1, 4)
os.write(master1, b"go\r")
painted1 = pump(master1, 10)
kill(pid1, master1)

match1 = URL.search(painted1)
if not match1:
	fail("no pisnip:// hyperlink was painted in the first process")
url1 = match1.group(1).decode()
token1 = url1.split("/")[2]
print(f"process 1  {url1}")

sessions = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")))
if not sessions:
	fail("no session file was persisted")
session_file = sessions[-1]
print(f"session    {session_file}")

# --- Process 2: resume that exact session, a fresh process, no clean shutdown of #1 ---
pid2, master2 = launch(["--session", session_file], [])
painted2 = pump(master2, 6)

match2 = URL.search(painted2)
if not match2:
	kill(pid2, master2)
	fail("no pisnip:// hyperlink was repainted after resuming")
url2 = match2.group(1).decode()
token2 = url2.split("/")[2]
print(f"process 2  {url2}")

if token2 != token1:
	kill(pid2, master2)
	fail(f"token changed across the restart: {token1} -> {token2}")

socket_path = os.path.join(sockdir, token2 + ".sock")
if not os.path.exists(socket_path):
	kill(pid2, master2)
	fail(f"process 2 never bound {socket_path}")

import socket as socketlib

client = socketlib.socket(socketlib.AF_UNIX, socketlib.SOCK_STREAM)
client.settimeout(3)
client.connect(socket_path)
client.sendall(("/".join(url2.split("/")[3:]) + "\n").encode())
client.close()
print("clicked    (handler wire format, one line)")

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
SUPERSCRIPTS = "\u00b9\u00b2\u00b3\u2070\u2074\u2075\u2076\u2077\u2078\u2079"


def bare_occurrences(data):
	found = 0
	needle = SUGGESTION.encode()
	at = data.find(needle)
	while at != -1:
		lookback = ANSI.sub(b"", data[max(0, at - 32):at]).decode("utf8", "replace")
		if not lookback.rstrip().endswith(tuple(SUPERSCRIPTS)):
			found += 1
		at = data.find(needle, at + 1)
	return found


before = bare_occurrences(painted2)
after_bytes = pump(master2, 3)
after = bare_occurrences(after_bytes)
print(f"un-numbered {SUGGESTION!r}: {before} before the click, {after} after")

kill(pid2, master2)

if before == 0 and after > 0:
	print("PASS: the click inserted the suggestion after the restart")
	sys.exit(0)
if before > 0:
	fail("the phrase appeared un-numbered before the click was sent")
fail("nothing was inserted after the restart")
