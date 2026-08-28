#!/usr/bin/env python3
"""What does pi-tui actually paint for a chip's URL?

The premise of docs/terminal-resolved-clicks.md is that a chip's markdown href
reaches the terminal verbatim inside an OSC 8 hyperlink, so a custom scheme
would survive the trip. That is a claim about pi-tui, and this answers it by
reading the bytes rather than the source: fork a pty, run real pi against the
mock LLM, and dump what lands on the wire.

Two regimes, because pi-tui's `detectCapabilities()` gates OSC 8 on the
terminal it thinks it is talking to:

    ghostty   TERM_PROGRAM=ghostty  → hyperlinks: true  → OSC 8 expected
    unknown   TERM=xterm-256color   → hyperlinks: false → " (url)" expected

Usage:  python3 scripts/osc8-probe.py [ghostty|unknown] [--url URL]
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

regime = sys.argv[1] if len(sys.argv) > 1 else "ghostty"
custom_url = None
if "--url" in sys.argv:
    custom_url = sys.argv[sys.argv.index("--url") + 1]

# The model's reply. Either our own tags (the real chip path) or a raw markdown
# link, which is how a custom scheme is put through pi's renderer without
# touching our transformer at all.
if custom_url:
    reply = f"Here you go: [click me]({custom_url}) and that is all."
else:
    reply = ("Two ways forward. Want me to <snippet>rebuild the solution</snippet> "
             "or <snippet>run the tests</snippet>?")

env = dict(os.environ)
env.update(
    MOCK_LLM_LOG=tempfile.mktemp(suffix=".jsonl"),
    MOCK_LLM_INFER_MARKER="@@none@@",
    MOCK_LLM_SCRIPT=json.dumps([reply]),
    MOCK_LLM_INFER="[]",
    PI_CODING_AGENT_DIR=tempfile.mkdtemp(prefix="pi-agent-"),
    # Honour a prepared settings file, so a run can exercise link mode.
    PI_SNIPPET_SETTINGS=os.environ.get("PI_SNIPPET_SETTINGS") or tempfile.mktemp(suffix=".json"),
    LINES=str(ROWS), COLUMNS=str(COLS),
)
if regime == "ghostty":
    env.update(TERM="xterm-ghostty", TERM_PROGRAM="ghostty", COLORTERM="truecolor")
else:
    env.update(TERM="xterm-256color")
    env.pop("TERM_PROGRAM", None)
    env.pop("GHOSTTY_RESOURCES_DIR", None)
env.pop("TMUX", None)

args = ["pi", "--no-session", "--no-extensions", "-e", FIXTURE, "-e", EXT,
        "--provider", "mockllm", "--model", "mock-small", "--snippet-click"]

pid, master = pty.fork()
if pid == 0:
    os.environ.clear()
    os.environ.update(env)
    os.execvp(args[0], args)

import fcntl, struct, termios
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

raw = bytearray()
DSR = re.compile(rb"\x1b\[6n")
deadline = time.time() + 45
sent = False
start = time.time()
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.3)
    if r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw += chunk
        # Answer cursor-position queries so pi never blocks on us.
        for _ in DSR.findall(chunk):
            os.write(master, b"\x1b[1;1R")
    if not sent and time.time() - start > 4:
        os.write(master, b"go\r")          # any prompt; the mock ignores it
        sent = True
    if sent and time.time() - start > 16:
        break

os.write(master, b"\x03")
time.sleep(0.4)
try:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
except Exception:
    pass

out = bytes(raw)
open(f"/tmp/osc8-probe-{regime}.bin", "wb").write(out)

print(f"=== regime: {regime}  ({len(out)} bytes captured) ===")
links = re.findall(rb"\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)", out)
urls = [u.decode("utf8", "replace") for u in links if u]
print(f"OSC 8 opens seen: {len(urls)}")
for u in dict.fromkeys(urls):
    print(f"  url: {u!r}")
for probe in (b"chip:1", b"chip:2", b"pisnip", b"(chip:", b"rebuild the solution"):
    print(f"  {probe.decode():24} present={probe in out}")
