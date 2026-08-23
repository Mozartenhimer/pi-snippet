#!/usr/bin/env python3
"""Live check of Alt-digit suggestion addressing, driven by Ghostty's encoder.

Runs pi under a pty below ten lines of shell output, asks the model for twelve
suggestions, then plays each gesture using the exact bytes Ghostty would send
(scripts/ghostty-keys, linked against libghostty-vt) and asserts which
suggestion landed in the editor.

The gesture that matters: hold Alt, press 1, press 2 — two Kitty-protocol
CSI-u sequences a millisecond apart — must insert suggestion twelve, not one.

Run: python3 scripts/chord-live.py   (needs pi with a working provider, and
Ghostty for the encoder; falls back to legacy ESC-digit bytes without it).
"""
import fcntl
import os
import re
import signal
import struct
import subprocess
import sys
import termios
import types

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = os.path.join(HERE, ".build", "ghostty-keys")
EXT = os.path.join(HERE, "..", "dist", "extension", "pi-snippet-tui.js")

PROMPT = ("I'm testing suggestion numbering. Give me exactly twelve different one-line "
          "next steps I could ask for, each wrapped as a suggestion. Keep each under six words.")

# Reuse the terminal emulator from the click harness.
_src = open(os.path.join(HERE, "click-offset-repro.py")).read().replace(
    'if __name__ == "__main__":\n    main()', '')
repro = types.ModuleType("repro")
exec(compile(_src, "click-offset-repro.py", "exec"), repro.__dict__)

SUPERSCRIPT = {"⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
               "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9"}
# Not a contiguous range: ¹²³ are Latin-1 (U+00B9/B2/B3), the rest are U+207x.
SUPS = "".join(SUPERSCRIPT)


def encode(*keys):
    """Bytes Ghostty sends for these keys, at the Kitty flags pi requests."""
    if os.path.exists(KEYS):
        return subprocess.check_output([KEYS, "--flags", "7", *keys])
    # No libghostty: fall back to the legacy encoding, which pi also accepts.
    out = b""
    for key in keys:
        if key.startswith("alt+"):
            out += b"\x1b" + key[4:].encode()
        elif key == "alt-release":
            pass  # not expressible without the Kitty protocol
        elif key.startswith("ctrl+"):
            out += bytes([ord(key[5]) - 96])
    return out


def labels():
    """Suggestion number -> the first words of its visible text."""
    found = {}
    for line in repro.screen_text():
        for match in re.finditer(f"([{SUPS}]+)([^{SUPS}]*)", line):
            digits = "".join(SUPERSCRIPT.get(c, "") for c in match.group(1))
            words = match.group(2).strip().rstrip(".,;:?")
            if digits and words:
                found.setdefault(int(digits), " ".join(words.split()[:2]))
    return found


def main():
    if not os.path.exists(KEYS):
        print("note: libghostty-vt helper missing; using legacy ESC-digit bytes")
        print("      (build it with scripts/ghostty-env.sh for real Ghostty encodings)")

    child, master = os.forkpty()
    if child == 0:
        os.environ["TERM"] = "xterm-ghostty"
        os.execvp("bash", ["bash", "-c", f"seq 1 10; exec pi --no-session -e {EXT} "
                                         "--provider claude-bridge --model claude-haiku-4-5"])
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", repro.ROWS, repro.COLS, 0, 0))
    repro.pump(master, 8)
    os.write(master, PROMPT.encode())
    repro.pump(master, 1)
    os.write(master, b"\r")

    if not repro.pump(master, 180, until=lambda: any("¹²" in l for l in repro.screen_text())):
        print("FAIL: the model never produced a twelfth suggestion")
        sys.exit(1)
    repro.pump(master, 4)

    known = labels()
    print("suggestions on screen:", sorted(known))
    failures = []

    def gesture(name, keys, wait, expect):
        os.write(master, encode("ctrl+u"))  # clear the editor line
        repro.pump(master, 0.6)
        os.write(master, encode(*keys))
        repro.pump(master, wait)
        tail = "\n".join(repro.screen_text()[-8:])
        want = known.get(expect, "")
        hit = bool(want) and want in tail
        strays = [n for n, text in known.items() if n != expect and text and text in tail]
        ok = hit and not strays
        if not ok:
            failures.append(name)
        note = "" if not strays else f"; also saw {strays}"
        print(f"  {name:<44} {'ok' if ok else 'FAIL'}  (wanted #{expect} {want!r}{note})")

    print(f"gestures (bytes from {'Ghostty' if os.path.exists(KEYS) else 'legacy fallback'}):")
    gesture("Alt+3 alone, unambiguous", ["alt+3"], 0.35, 3)
    gesture("Alt+1 alone, waits out the timeout", ["alt+1"], 1.2, 1)
    gesture("hold Alt: 1 then 2", ["alt+1", "alt+2"], 1.2, 12)
    gesture("hold Alt: 1 then 0", ["alt+1", "alt+0"], 1.2, 10)
    gesture("Alt+0 alone, legacy tenth", ["alt+0"], 0.9, 10)
    gesture("hold Alt: 1, 2, release Alt", ["alt+1", "alt+2", "alt-release"], 1.2, 12)

    os.write(master, b"\x03")
    repro.pump(master, 0.5)
    os.write(master, b"\x03")
    repro.pump(master, 0.5)
    try:
        os.kill(child, signal.SIGKILL)
    except OSError:
        pass

    if failures:
        print("FAILED:", failures)
        sys.exit(1)
    print("PASS: every Alt-addressing gesture inserted the right suggestion")


if __name__ == "__main__":
    main()
