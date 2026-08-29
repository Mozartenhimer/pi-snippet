#!/usr/bin/env python3
"""Tab-complete `/snippets model` in a real terminal, end to end.

RPC mode (scripts/snippet-model-rpc-smoke.py) proves the command's plumbing
against real pi, but RPC has no composer and no autocomplete UI at all — the
whole point of `/snippets model` is a dropdown painted by pi's own editor as
you type, the same one `/model` uses. Only a real terminal shows that. tmux
plays that part: `send-keys` writes real keystrokes into the pane's stdin,
`capture-pane` reads the rendered screen back — the same technique the
(removed, see git history) mouse-click harness used.

No network, no credentials: test/fixtures/mock-models.js registers a
provider's model catalogue only, and answers no prompt — nothing here ever
sends the model a message.

What's checked, in order:

  1. Typing `/snippets model zzpisnip-larg` paints a dropdown containing
     "zzpisnip-large-reasoner" — the fuzzy matcher (`@earendil-works/pi-tui`'s
     `fuzzyFilter`, the same one `/model` uses) found it from a partial,
     non-prefix query, and `model` is just the first word of everything pi
     hands `getArgumentCompletions` after `/snippets ` — matched and stripped
     by hand, then restored on each completion's value. `getAvailable()` in a
     real process returns pi's whole model catalogue alongside the fixture's,
     so the query targets the fixture's `zzpisnip-` id prefix specifically —
     a generic word like "large" is a legitimate fuzzy match against real
     catalogue entries too, and asserting the wrong one won without that
     prefix is what this script caught the first time it ran.
  2. Tab accepts the top match, and the composer line becomes exactly
     `/snippets model mockllm/zzpisnip-large-reasoner` — completion inserts
     the `provider/id` value, not the display label.
  3. Enter submits it, pi confirms with a notice, and the setting lands in
     the settings file on disk — the same file `/snippets` reads back from
     on the next restart.
  4. `/snippets` → "Second model: … — change" prefills the composer with
     `/snippets model mockllm/zzpisnip-large-reasoner ` instead of opening a
     blocking dialog with no completion at all.

Usage:  python3 scripts/snippet-model-tmux.py   (exit 0 = PASS)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, "dist", "extension", "pi-snippet-tui.js")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-models.js")
SESSION = "pi-snippet-model-tmux"
ROWS, COLS = 40, 110


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
    for r, line in enumerate(screen):
        c = line.find(needle)
        if c >= 0:
            return (r, c)
    return None


def line_containing(screen, needle):
    hit = find_text(screen, needle)
    return screen[hit[0]] if hit else None


def cleanup():
    tmux("kill-session", "-t", SESSION)


def json_arg(value):
    return "'" + value.replace("'", "'\\''") + "'"


def main():
    if not shutil.which("tmux"):
        print("SKIP: tmux not installed")
        return 0
    if not os.path.exists(EXT):
        print("FAIL: %s missing — run `npm run build`" % EXT)
        return 1
    if not os.path.exists(FIXTURE):
        print("FAIL: %s missing" % FIXTURE)
        return 1
    if not shutil.which("pi"):
        print("SKIP: pi not found")
        return 0

    tmux("kill-session", "-t", SESSION)

    # A throwaway settings file, same reasoning as every other harness here:
    # this must not read, or rewrite, whoever runs it's real preferences.
    settings = os.path.join(tempfile.mkdtemp(prefix="pi-snippet-model-tmux-"), "settings.json")

    env = ["PI_SNIPPET_SETTINGS=%s" % json_arg(settings)]
    pi = shutil.which("pi")
    # pi starts ten rows down, matching the other tmux harness: buffer row 0
    # is not screen row 0, so a capture that only checked the top of the
    # pane would miss a real rendering bug the same way it would there.
    command = "seq 1 10; exec env %s %s --no-session --no-extensions -e %s -e %s --provider mockllm --model zzpisnip-small" % (
        " ".join(env), pi, FIXTURE, EXT,
    )
    started = tmux("new-session", "-d", "-s", SESSION, "-x", str(COLS), "-y", str(ROWS), command)
    if started.returncode != 0:
        print("FAIL: could not start tmux session: %s" % started.stderr.strip())
        return 1

    try:
        wait_for(lambda s: any(l.strip() for l in s[11:]), 30, "pi to boot below the shell output")
        time.sleep(1)

        # --- 1 & 2: type a partial query, expect a dropdown, accept it ---
        tmux("send-keys", "-t", SESSION, "/snippets model zzpisnip-larg")
        wait_for(
            lambda s: find_text(s, "zzpisnip-large-reasoner"),
            10,
            "the autocomplete dropdown to list zzpisnip-large-reasoner",
        )
        print("PASS: dropdown listed zzpisnip-large-reasoner for a partial, non-prefix query")

        tmux("send-keys", "-t", SESSION, "Tab")
        completed = wait_for(
            lambda s: line_containing(s, "/snippets model mockllm/zzpisnip-large-reasoner"),
            10,
            "Tab to complete the argument to the full provider/id value",
        )
        print("PASS: Tab completed to %r" % completed.strip())

        # --- 3: submit, expect confirmation, expect persistence ---
        tmux("send-keys", "-t", SESSION, "Enter")
        wait_for(
            lambda s: find_text(s, "Second model set to mockllm/zzpisnip-large-reasoner"),
            10,
            "the confirmation notice",
        )
        print("PASS: pi confirmed the change on screen")

        deadline = time.time() + 5
        stored = None
        while time.time() < deadline:
            if os.path.exists(settings):
                with open(settings) as fh:
                    stored = json.load(fh)
                if stored.get("inferModel") == "mockllm/zzpisnip-large-reasoner":
                    break
            time.sleep(0.25)
        if not stored or stored.get("inferModel") != "mockllm/zzpisnip-large-reasoner":
            print("FAIL: settings file has inferModel=%r" % (stored or {}).get("inferModel"))
            cleanup()
            return 1
        print("PASS: %s persisted inferModel=mockllm/zzpisnip-large-reasoner" % settings)

        # --- 4: /snippets menu redirects into the same completing command ---
        tmux("send-keys", "-t", SESSION, "/snippets")
        tmux("send-keys", "-t", SESSION, "Enter")
        wait_for(lambda s: find_text(s, "Alt+digit shortcuts"), 10, "the /snippets menu to open")
        # Menu order: Suggestions, Alt+digit shortcuts, Second model, …
        tmux("send-keys", "-t", SESSION, "Down")
        tmux("send-keys", "-t", SESSION, "Down")
        tmux("send-keys", "-t", SESSION, "Enter")
        prefilled = wait_for(
            lambda s: line_containing(s, "/snippets model mockllm/zzpisnip-large-reasoner"),
            10,
            "\u201cSecond model \u2014 change\u201d to prefill /snippets model instead of opening a dialog",
        )
        print("PASS: menu prefilled %r" % prefilled.strip())

        cleanup()
        print("PASS: /snippets model tab-completes, applies, persists, and is reachable from the /snippets menu")
        return 0
    except SystemExit:
        raise
    except Exception as exc:  # keep the pane around for a human to look at on an unexpected error
        print("FAIL: unexpected error: %r" % exc)
        print("\n".join("%2d|%s" % (i, l) for i, l in enumerate(capture()) if l.strip()))
        cleanup()
        return 1


if __name__ == "__main__":
    sys.exit(main())
