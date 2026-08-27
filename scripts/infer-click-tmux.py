#!/usr/bin/env python3
"""Click an inferred anchor in a real terminal, end to end, with no provider.

What this covers that nothing else does: pi's real TUI, drawing real frames in
a real terminal emulator, with a real mouse report arriving as bytes on stdin
and the composer read back off the screen.

Two pieces make it possible without credentials or a live model:

  * `test/fixtures/mock-llm.js` registers a pi provider whose completions come
    from a function, so the primary model and the small model are both
    scripted and deterministic.
  * tmux is the terminal. `send-keys -H` writes raw bytes into the pane's
    stdin, which is how a mouse report gets injected; `capture-pane` reads the
    rendered screen back. tmux also answers the DSR query (ESC[6n) that the
    click mapping depends on, exactly as any other terminal would.

pi is started ten lines down the screen, so buffer row 0 is not screen row 0 —
the offset that makes click mapping non-trivial (see scripts/click-offset-repro.py,
which predates this and drives its own pty emulator because the machine it was
written for has no tmux).

The assertion is unambiguous in a way layer 1's cannot be: an inferred anchor
inserts a *reply* that appears nowhere in the assistant's message, so finding
"Show me the model." on screen can only mean the click worked.

Usage:  python3 scripts/infer-click-tmux.py   (exit 0 = PASS)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, "dist", "extension", "pi-snippet-tui.js")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-llm.js")
SESSION = "pi-snippet-infer-click"
ROWS, COLS = 40, 110

QUESTION = "I'm done the model, do you want to see it?"
ANCHOR = "do you want to see it?"
REPLY = "Show me the model."
ANCHORS_JSON = json.dumps([{"anchor": ANCHOR, "reply": REPLY}])

# The inference layer's own system prompt identifies its requests to the mock.
# Kept in sync by reading it out of the source rather than restating it.
INFER_MARKER = ""
with open(os.path.join(ROOT, "src", "shared", "inferred.ts")) as fh:
    m = re.search(r"INFER_SYSTEM_PROMPT = `([^\n]+)", fh.read())
    INFER_MARKER = m.group(1)[:48] if m else ""


def tmux(*args, **kwargs):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, **kwargs)


def capture():
    """The visible pane, as plain text: one string per screen row."""
    out = tmux("capture-pane", "-p", "-t", SESSION)
    return out.stdout.split("\n") if out.returncode == 0 else []


def wait_for(predicate, seconds, label):
    end = time.time() + seconds
    while time.time() < end:
        screen = capture()
        found = predicate(screen)
        if found:
            return found
        time.sleep(0.25)
    print("FAIL: timed out waiting for %s" % label)
    print("\n".join("%2d|%s" % (i, l) for i, l in enumerate(capture()) if l.strip()))
    cleanup()
    sys.exit(1)


def find_text(screen, needle):
    """(row, col) of `needle` on screen, 0-based, or None."""
    for r, line in enumerate(screen):
        c = line.find(needle)
        if c >= 0:
            return (r, c)
    return None


def send_click(row, col):
    """Inject an SGR mouse press and release at a 0-based screen position."""
    press = "\x1b[<0;%d;%dM" % (col + 1, row + 1)
    release = "\x1b[<0;%d;%dm" % (col + 1, row + 1)
    payload = (press + release).encode()
    tmux("send-keys", "-t", SESSION, "-H", *["%02x" % b for b in payload])


def cleanup():
    tmux("kill-session", "-t", SESSION)


def main():
    if not shutil.which("tmux"):
        print("SKIP: tmux not installed")
        return 0
    if not os.path.exists(EXT):
        print("FAIL: %s missing — run `npm run build`" % EXT)
        return 1
    pi = shutil.which("pi") or os.path.join(ROOT, "node_modules", ".bin", "pi")
    if not os.path.exists(pi) and not shutil.which("pi"):
        print("SKIP: pi not found")
        return 0

    tmux("kill-session", "-t", SESSION)

    # The extension persists the /snippets toggles now, so point it at a
    # throwaway file: the harness must not read — or rewrite — whatever the
    # person running it has chosen.
    settings = os.path.join(tempfile.mkdtemp(prefix="pi-snippet-tmux-"), "settings.json")

    env = [
        "PI_SNIPPET_SETTINGS=%s" % json_arg(settings),
        "MOCK_LLM_INFER_MARKER=%s" % json_arg(INFER_MARKER),
        "MOCK_LLM_SCRIPT=%s" % json_arg(json.dumps([QUESTION])),
        "MOCK_LLM_INFER=%s" % json_arg(ANCHORS_JSON),
    ]
    # `seq 1 10` puts pi ten rows down the screen: buffer row 0 is not screen
    # row 0, which is the whole point of the DSR-corrected mapping.
    command = "seq 1 10; exec env %s %s --no-session --no-extensions -e %s -e %s --snippet-click --provider mockllm --model mock-small" % (
        " ".join(env), pi, FIXTURE, EXT,
    )
    started = tmux("new-session", "-d", "-s", SESSION, "-x", str(COLS), "-y", str(ROWS), command)
    if started.returncode != 0:
        print("FAIL: could not start tmux session: %s" % started.stderr.strip())
        return 1

    # pi has booted once the shell lines are up and it has drawn its editor.
    wait_for(lambda s: any(l.strip() for l in s[11:]), 30, "pi to boot below the shell output")
    time.sleep(2)

    tmux("send-keys", "-t", SESSION, "are you done?")
    time.sleep(0.5)
    tmux("send-keys", "-t", SESSION, "Enter")

    # The assistant answers, then the inference layer reads it and the anchor
    # is painted. Nothing on screen distinguishes a painted anchor from plain
    # text in a capture, so wait for the message, then let inference land.
    wait_for(lambda s: find_text(s, ANCHOR), 60, "the assistant's question to render")
    time.sleep(3)

    screen = capture()
    hit = find_text(screen, ANCHOR)
    row, col = hit
    print("anchor on screen row %d, col %d: %r" % (row, col, screen[row].strip()[:90]))
    if row < 10:
        print("WARNING: anchor above row 10 — the mid-screen offset was not reproduced")

    if find_text(screen, REPLY):
        print("FAIL: %r was already on screen before the click" % REPLY)
        cleanup()
        return 1

    send_click(row, col + 3)

    inserted = wait_for(
        lambda s: find_text(s, REPLY),
        10,
        "the inferred reply to appear in the composer after the click",
    )
    irow, _ = inserted
    print("reply appeared on screen row %d: %r" % (irow, capture()[irow].strip()[:90]))

    if irow <= row:
        print("FAIL: %r appeared above the anchor — that is the transcript, not the composer" % REPLY)
        cleanup()
        return 1

    cleanup()
    print("PASS: clicking an inferred anchor mid-screen composed %r" % REPLY)
    return 0


def json_arg(value):
    """Quote a value for the shell command tmux runs."""
    return "'" + value.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    sys.exit(main())
