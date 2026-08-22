#!/usr/bin/env python3
"""Live reproduction of the Ghostty click bug: pi launched mid-screen.

Acts as a minimal terminal emulator on a pty: tracks a character grid and the
cursor, and ANSWERS DSR (ESC[6n) queries the way a real terminal does. pi is
started below 10 lines of shell output, so its buffer row 0 sits at screen row
~11 — exactly the offset that broke clicking in Ghostty. The driver waits for a
suggestion chip "[1 ..." to render, clicks its true screen position once
(no spraying), and then submits, so the session file proves the insertion.
"""
import fcntl
import glob
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ROWS, COLS = 40, 110
EXT = "/home/fcb/sw/pi-clik/dist/extension/pi-clik-tui.js"
PROMPT = ("I finished refactoring the auth module. Two obvious next steps: "
          "rebuild the project, or run the test suite. Ask me which I want.")

raw = open("/tmp/pi-clik-click-raw.bin", "wb", buffering=0)
grid = [[" "] * COLS for _ in range(ROWS)]
row = col = 0
saved = (0, 0)
dsr_answered = 0
log = []


def scroll_if_needed():
    global row
    while row >= ROWS:
        grid.pop(0)
        grid.append([" "] * COLS)
        row -= 1


def put(ch):
    global col
    if col < COLS and 0 <= row < ROWS:
        grid[row][col] = ch
    col += 1


CSI = re.compile(r"^\x1b\[([0-9;?<>]*)([ -/]*)([@-~])")
OSC = re.compile(r"^\x1b[\]_P][^\x07\x1b]*(\x07|\x1b\\)")
CHARSET = re.compile(r"^\x1b[()][0-9A-Za-z]")

pending = ""


def feed(data, master):
    global pending, row, col, saved, dsr_answered
    s = pending + data
    pending = ""
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\x1b":
            rest = s[i:]
            m = CSI.match(rest)
            if m:
                params, final = m.group(1), m.group(3)
                nums = [int(x) for x in params.replace("?", "").split(";") if x.isdigit()]
                n = nums[0] if nums else 1
                if final == "A":
                    row = max(0, row - max(1, n))
                elif final == "B":
                    row += max(1, n); scroll_if_needed()
                elif final == "C":
                    col += max(1, n)
                elif final == "D":
                    col = max(0, col - max(1, n))
                elif final == "G":
                    col = max(0, n - 1)
                elif final == "H" or final == "f":
                    row = max(0, (nums[0] if nums else 1) - 1)
                    col = max(0, (nums[1] if len(nums) > 1 else 1) - 1)
                    scroll_if_needed()
                elif final == "K":
                    mode = nums[0] if nums else 0
                    if 0 <= row < ROWS:
                        if mode == 0:
                            for c in range(min(col, COLS), COLS):
                                grid[row][c] = " "
                        elif mode == 2:
                            grid[row] = [" "] * COLS
                elif final == "J" and nums and nums[0] == 2:
                    for r in range(ROWS):
                        grid[r] = [" "] * COLS
                elif final == "n" and n == 6:
                    resp = "\x1b[%d;%dR" % (row + 1, col + 1)
                    os.write(master, resp.encode())
                    dsr_answered += 1
                    log.append("answered DSR #%d: cursor at row %d (1-based)" % (dsr_answered, row + 1))
                i += m.end()
                continue
            m = OSC.match(rest) or CHARSET.match(rest)
            if m:
                i += m.end()
                continue
            if rest[1:2] in ("7",):
                saved = (row, col); i += 2; continue
            if rest[1:2] in ("8",):
                row, col = saved; i += 2; continue
            if rest[1:2] in ("=", ">", "M", "c"):
                i += 2
                continue
            # Possibly an escape sequence truncated at the chunk boundary:
            # buffer anything that still looks like a prefix of one.
            if re.match(r"^\x1b(\[[0-9;?<>]*[ -/]*)?$", rest) or \
               re.match(r"^\x1b[\]_P][^\x07\x1b]*(\x1b)?$", rest):
                pending = rest
                break
            i += 1  # unknown escape, skip ESC
            continue
        if ch == "\r":
            col = 0
        elif ch == "\n":
            row += 1; col = 0; scroll_if_needed()
        elif ch == "\b":
            col = max(0, col - 1)
        elif ch == "\t":
            col = (col // 8 + 1) * 8
        elif ch >= " ":
            put(ch)
        i += 1


def screen_text():
    return ["".join(r).rstrip() for r in grid]


def find_chip():
    for r, line in enumerate(screen_text()):
        c = line.find("[1 ")
        if c >= 0:
            return r, c, line
    return None


def pump(master, seconds, until=None):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.2)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                return False
            if not data:
                return False
            raw.write(data)
            feed(data.decode("utf-8", "replace"), master)
        if until is not None and until():
            return True
    return until is None


def main():
    child, master = pty.fork()
    if child == 0:
        os.environ["TERM"] = "xterm-ghostty"
        os.execvp("bash", ["bash", "-c",
                           "seq 1 10; exec pi --no-session -e %s --provider claude-bridge --model claude-haiku-4-5" % EXT])
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    pump(master, 8)  # let the shell lines print and pi boot
    boot = [l for l in screen_text() if l]
    print("after boot, %d non-empty rows; last: %r" % (len(boot), boot[-1] if boot else ""))

    os.write(master, PROMPT.encode())
    pump(master, 1)
    os.write(master, b"\r")

    ok = pump(master, 120, until=lambda: find_chip() is not None)
    if not ok:
        print("FAIL: no suggestion chip rendered within 120s")
        print("\n".join("%2d|%s" % (r, l) for r, l in enumerate(screen_text()) if l))
        os.kill(child, signal.SIGKILL)
        sys.exit(1)
    pump(master, 3)  # let the message finish streaming / settle

    chip = find_chip()
    r, c, line = chip
    print("chip found at screen row %d (0-based), col %d: %r" % (r, c, line.strip()[:80]))
    if r < 10:
        print("WARNING: chip above row 10 — offset scenario not reproduced?")

    # Read the label so we know what text a successful click inserts.
    m = re.search(r"\[1 ([^\]]*)\]?", line)
    label = (m.group(1) if m else "").strip()
    print("chip label: %r" % label)

    click_col = c + 3  # inside the label
    raw.write(b"\n<<<CLICK>>>\n")
    os.write(master, b"\x1b[<0;%d;%dM\x1b[<0;%d;%dm" % (click_col + 1, r + 1, click_col + 1, r + 1))
    pump(master, 3)
    raw.write(b"\n<<<AFTER-CLICK-CHECK>>>\n")

    after = screen_text()
    editor = [l for l in after if label and label in l]
    print("DSR queries answered: %d" % dsr_answered)
    for entry in log:
        print("  " + entry)

    # The editor lives at the bottom; the inserted text should now appear there
    # in a row BELOW the chip row (the transcript copy is at/above chip row).
    inserted = any(label in l for i, l in enumerate(after) if i > r and l.strip() and "[1 " not in l)
    print("rows containing the label below the chip:")
    for i, l in enumerate(after):
        if i > r and label and label in l:
            print("  %2d|%s" % (i, l[:100]))

    if not inserted:
        # Control probe: does insertion work at all? Alt+1 uses the same
        # insertText but the shortcut handler's own ctx.
        os.write(master, b"\x1b1")
        pump(master, 2)
        probe = screen_text()
        alt_worked = any(label in l for i, l in enumerate(probe) if i > r and "[1 " not in l)
        print("alt+1 control probe inserted: %s" % alt_worked)
        for i, l in enumerate(probe):
            if i > r and label and label in l:
                print("  %2d|%s" % (i, l[:100]))

    os.write(master, b"\x03")
    pump(master, 1)
    os.write(master, b"\x03")
    pump(master, 1)
    try:
        os.kill(child, signal.SIGKILL)
    except OSError:
        pass

    if dsr_answered == 0:
        print("FAIL: extension never asked for the cursor position — DSR path not engaged")
        sys.exit(1)
    if not inserted:
        print("FAIL: click did not insert the suggestion into the editor")
        print("\n".join("%2d|%s" % (i, l) for i, l in enumerate(after) if l))
        sys.exit(1)
    print("PASS: mid-screen click inserted %r via DSR-corrected mapping" % label)


if __name__ == "__main__":
    main()
