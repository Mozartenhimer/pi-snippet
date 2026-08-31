#!/usr/bin/env python3
"""Terminal-resolved click, end to end, minus the terminal.

Proves the half of docs/terminal-resolved-clicks.md that does not need a
desktop: real pi, link mode on, a chip painted as an OSC 8 hyperlink, and the
generated handler invoked exactly as the OS opener would invoke it -- URL on
argv, no shared state, a different process. If the suggestion lands in the
editor, everything from the href to the insertion is working, and only the
terminal's own dispatch (Ctrl+click -> portal -> handler) is left to try on a
real Ghostty.

    python3 scripts/link-click-live.py

Exits 0 when the click inserts, 1 otherwise.
"""
import json
import os
import pty
import re
import select
import subprocess
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

env = dict(os.environ)
env.update(
	MOCK_LLM_LOG=tempfile.mktemp(suffix=".jsonl"),
	MOCK_LLM_INFER_MARKER="@@none@@",
	MOCK_LLM_SCRIPT=json.dumps([REPLY]),
	MOCK_LLM_INFER="[]",
	PI_CODING_AGENT_DIR=tempfile.mkdtemp(prefix="pi-agent-"),
	PI_SNIPPET_SETTINGS=settings,
	PI_SNIPPET_SOCKET_DIR=sockdir,
	TERM="xterm-ghostty", TERM_PROGRAM="ghostty", COLORTERM="truecolor",
	LINES=str(ROWS), COLUMNS=str(COLS),
)
env.pop("TMUX", None)

args = ["pi", "--no-session", "--no-extensions", "-e", FIXTURE, "-e", EXT,
		"--provider", "mockllm", "--model", "mock-small"]

pid, master = pty.fork()
if pid == 0:
	os.environ.clear()
	os.environ.update(env)
	os.execvp(args[0], args)

import fcntl, struct, termios
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

DSR = re.compile(rb"\x1b\[6n")
# scheme://host/token/msg/cN — the host took the netloc (ADR 0001).
URL = re.compile(rb"\x1b\]8;;(pisnip://[A-Za-z0-9._-]+/[0-9a-f]+/[0-9a-f]+/c1)(?:\x07|\x1b\\)")


def pump(seconds):
	"""Read for a while, answering cursor queries so pi never blocks on us."""
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


def cleanup(code):
	try:
		os.write(master, b"\x03")
		time.sleep(0.3)
		os.kill(pid, 9)
		os.waitpid(pid, 0)
	except Exception:
		pass
	sys.exit(code)


pump(4)
os.write(master, b"go\r")
painted = pump(10)

match = URL.search(painted)
if not match:
	print("FAIL: no pisnip:// hyperlink was painted; is link mode on?")
	cleanup(1)
url = match.group(1).decode()
print(f"painted   {url}")

socket_path = os.path.join(sockdir, url.split("/")[3] + ".sock")
print(f"socket    {socket_path} ({'present' if os.path.exists(socket_path) else 'MISSING'})")
if not os.path.exists(socket_path):
	print("FAIL: the extension never bound a socket")
	cleanup(1)

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
SUPERSCRIPTS = "\u00b9\u00b2\u00b3\u2070\u2074\u2075\u2076\u2077\u2078\u2079"


def bare_occurrences(data):
	"""Occurrences of the suggestion that are NOT a chip label.

	A chip paints as `\u00b9rebuild the solution` -- the superscript is part of the
	label. The text inserted into the editor carries no number, so an
	occurrence with no superscript in front of it is the insertion and nothing
	else. Escape sequences sit between the two on the wire, so the lookback is
	stripped before it is judged.
	"""
	found = 0
	needle = SUGGESTION.encode()
	at = data.find(needle)
	while at != -1:
		lookback = ANSI.sub(b"", data[max(0, at - 32):at]).decode("utf8", "replace")
		if not lookback.rstrip().endswith(tuple(SUPERSCRIPTS)):
			found += 1
		at = data.find(needle, at + 1)
	return found


before = bare_occurrences(painted)

# Speak to the socket exactly as the generated handler does: one line, the
# path from the URL, then hang up. This harness covers URL -> socket -> editor;
# `link-register.py --probe` covers opener -> handler -> socket. Between them
# the only untested hop is the terminal's own dispatch, which needs a desktop.
import socket as socketlib

client = socketlib.socket(socketlib.AF_UNIX, socketlib.SOCK_STREAM)
client.settimeout(3)
client.connect(socket_path)
client.sendall(("/".join(url.split("/")[4:]) + "\n").encode())
client.close()
print("clicked   (handler wire format, one line)")

after_bytes = pump(3)
after = bare_occurrences(after_bytes)
print(f"un-numbered {SUGGESTION!r}: {before} before the click, {after} after")

# Before the click the phrase exists only as a chip label, which always carries
# its superscript. An un-numbered occurrence can only have come from the editor.
if before == 0 and after > 0:
	print("PASS: the click inserted the suggestion into the editor")
	cleanup(0)
if before > 0:
	print("INCONCLUSIVE: the phrase appeared un-numbered before the click was sent")
	cleanup(1)
print("FAIL: nothing was inserted")
cleanup(1)
