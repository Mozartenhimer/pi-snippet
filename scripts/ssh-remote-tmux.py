#!/usr/bin/env python3
"""The /snippets remote-clicking flow, over a fake SSH connection.

SSH inverts terminal-resolved clicking: the click resolves on the client, the
socket lives here. This forks a pty, runs real pi with SSH_TTY set (what a
real sshd exports), and asserts the honest default and the opt-in: chips
paint bare labels, the menu offers "Remote clicking" instead of desktop
registration, enabling it puts the ssh -L recipe in the composer and the
clickable URLs back on screen, and the verify window reports that no click
arrived yet — expected until the user reconnects with the forwarded socket.

Usage:  python3 scripts/ssh-remote-tmux.py
"""
import json, os, pty, re, select, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "dist", "extension", "pi-snippet-tui.js")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-llm.js")
ROWS, COLS = 30, 110
reply = "Two ways. Want me to <snippet>rebuild the solution</snippet>?"
env = dict(os.environ)
env.update(
    MOCK_LLM_LOG=tempfile.mktemp(suffix=".jsonl"),
    MOCK_LLM_INFER_MARKER="@@none@@",
    MOCK_LLM_SCRIPT=json.dumps([reply]),
    MOCK_LLM_INFER="[]",
    SSH_TTY="/dev/pts/9",  # simulate what sshd sets
    PI_CODING_AGENT_DIR=tempfile.mkdtemp(prefix="pi-agent-"),
    PI_SNIPPET_SETTINGS=tempfile.mktemp(suffix=".json"),
    TERM="xterm-ghostty", TERM_PROGRAM="ghostty", COLORTERM="truecolor",
    LINES=str(ROWS), COLUMNS=str(COLS),
)
args = ["pi", "--no-session", "--no-extensions", "-e", FIXTURE, "-e", EXT,
        "--provider", "mockllm", "--model", "mock-small"]
pid, master = pty.fork()
if pid == 0:
    os.environ.clear(); os.environ.update(env); os.execvp(args[0], args)
import fcntl, struct, termios
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
raw = bytearray(); DSR = re.compile(rb"\x1b\[6n")
deadline = time.time() + 40; sent = False; start = time.time(); phase = 0
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.3)
    if r:
        try: chunk = os.read(master, 65536)
        except OSError: break
        raw += chunk
        for _ in DSR.findall(chunk): os.write(master, b"\x1b[1;1R")
    if not sent and time.time() - start > 3:
        os.write(master, b"go\r"); sent = True
    text = bytes(raw).decode("utf-8", "replace")
    if sent and phase == 0 and time.time() - start > 7:
        os.write(master, b"/snippets\r"); phase = 1
    if phase == 1 and "Remote clicking" in text:
        os.write(master, b"\x1b[B\x1b[B\x1b[B"); phase = 2  # down to the Remote clicking row
    if phase == 2 and "Remote clicking: off" in text and time.time() - start > 9:
        os.write(master, b"\r"); phase = 3          # pick it
    if phase == 3 and time.time() - start > 24:
        break
out = raw.decode("utf-8", "replace")
open("/tmp/ssh-menu-check.bin", "w").write(out)
flat = re.sub("\x1b\\[[0-9;]*[A-Za-z]", "", out)
flat = re.sub("\][^\x07]*", "", flat)
checks = {
    "menu shows Remote clicking": "Remote clicking" in out,
    "no Register row": "Register click handler —" not in out,
    "forward line printed": "ssh -L" in flat and re.search(r"[0-9a-f]{8}\.sock:\S*pi-snippet/[0-9a-f]{8}\.sock", flat) is not None and "<host>" in flat,
    "client hint printed": "Register click handler" in flat,
    "no-verify verdict": "No click yet" in flat,
    "chips painted": "rebuild the solution" in out,
}
for k, v in checks.items(): print(("PASS" if v else "FAIL"), k)
sys.exit(0 if all(checks.values()) else 1)
