#!/usr/bin/env python3
"""Terminal-resolved click *with* the terminal: real alacritty, real pi, real click.

`link-click-live.py` proves everything except the terminal — it speaks to the
socket the way the handler would. This closes that last hop on Alacritty: a
window on an X display, a chip painted by real pi, a real left-click on it, and
alacritty's own hint machinery carrying the URL out to `xdg-open`. Nothing here
imitates a gesture; xdotool moves the pointer and presses the button.

    bash scripts/xvfb-env.sh                 # a display, if you have no desktop
    python3 scripts/link-register.py --install
    npm run build
    DISPLAY=:99 python3 scripts/alacritty-click.py            # expect PASS
    DISPLAY=:99 python3 scripts/alacritty-click.py --stock    # expect the gap

Two regimes, and the gap between them is the whole Alacritty story
(docs/linux-terminals.md):

  default   PI_HYPERLINKS=1 forces pi-tui to paint OSC 8. Chip → click →
            xdg-open → handler → socket → composer. Measured working.
  --stock   nothing forced, which is what a real alacritty session gives you:
            **alacritty sets no TERM_PROGRAM**, pi-tui's alacritty entry is
            keyed on exactly that, so the chip paints as a bare label and the
            click reaches nothing. The run passes when the click does nothing,
            because that is the current, correct behaviour of the pair.

What it needs: alacritty, xdotool, xclip, a display, `pi` on PATH, a registered
`pisnip://` handler, and a built extension. Exits 0 when the regime behaved as
described, 1 otherwise.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "dist", "extension", "pi-snippet-tui.js")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-llm.js")
SUGGESTION = "rebuild the solution"
REPLY = f"Two ways forward. Want me to <snippet>{SUGGESTION}</snippet> or <snippet>run the tests</snippet>?"
SUPERSCRIPTS = "¹²³⁰⁴⁵⁶⁷⁸⁹"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

stock = "--stock" in sys.argv
display = os.environ.get("DISPLAY")
out = tempfile.mkdtemp(prefix="alacritty-click-")
typescript = os.path.join(out, "pi.typescript")
size_file = os.path.join(out, "size")

for tool in ("alacritty", "xdotool", "xclip", "pi", "script"):
	if not shutil.which(tool):
		sys.exit(f"missing {tool}; see the docstring for what this harness needs")
if not display:
	sys.exit("no DISPLAY; run under a desktop or start one (scripts/xvfb-env.sh)")
if not os.path.exists(EXT):
	sys.exit(f"no {EXT}; run `npm run build` first (the harness loads the bundle, not the sources)")


def xdo(*args):
	return subprocess.run(["xdotool", *args], capture_output=True, text=True).stdout.strip()


def primary():
	"""What the terminal thinks is selected — its own answer, not our replay."""
	return subprocess.run(["xclip", "-o", "-selection", "primary"], capture_output=True, text=True).stdout


env = dict(os.environ)
env.update(
	MOCK_LLM_LOG=os.path.join(out, "mock.jsonl"),
	MOCK_LLM_INFER_MARKER="@@none@@",
	MOCK_LLM_SCRIPT=json.dumps([REPLY]),
	MOCK_LLM_INFER="[]",
	PI_CODING_AGENT_DIR=os.path.join(out, "agent"),
	PI_SNIPPET_SETTINGS=os.path.join(out, "settings.json"),
	PI_OFFLINE="1",
)
# Alacritty exports ALACRITTY_WINDOW_ID and nothing pi-tui reads, so the regime
# is decided here rather than by the terminal: PI_HYPERLINKS is pi-tui's own
# override, and forcing it beats lying about TERM_PROGRAM — it says what we
# actually mean, which is "paint the links, we have measured that this terminal
# renders them".
env.pop("TERM_PROGRAM", None)
if not stock:
	env["PI_HYPERLINKS"] = "1"

# `script` records what pi paints while alacritty still receives it: the
# assertion at the end reads that recording, the same trick link-click-live.py
# uses on its pty. The window is the terminal under test either way.
inner = (f"stty size > {size_file}; exec pi --no-session --no-extensions --approve --offline "
		 f"-e {FIXTURE} -e {EXT} --provider mockllm --model mock-small")
pi_window = subprocess.Popen(
	["alacritty", "-o", "window.padding.x=0", "-o", "window.padding.y=0",
	 "-e", "script", "-q", "-f", typescript, "-c", inner],
	env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cleanup(code, note=""):
	if note:
		print(note)
	pi_window.kill()
	sys.exit(code)


time.sleep(6)
window = xdo("search", "--class", "Alacritty").split("\n")[-1]
geometry = xdo("getwindowgeometry", window)
match = re.search(r"Geometry: (\d+)x(\d+)", geometry)
if not match or not os.path.exists(size_file):
	cleanup(1, "alacritty did not come up; is the display real?")
width, height = (int(v) for v in match.groups())
rows, cols = (int(v) for v in open(size_file).read().split())
# Padding is pinned to zero above, and alacritty leaves the remainder at the
# right and bottom rather than centring the grid, so cell (0,0) starts at (0,0).
cell_w, cell_h = width / cols, height / rows
print(f"window {width}x{height}px, grid {cols}x{rows}, cell {cell_w:.2f}x{cell_h:.2f}px, "
	  f"regime {'stock (nothing forced)' if stock else 'PI_HYPERLINKS=1'}")

xdo("windowfocus", window)
time.sleep(1)
xdo("type", "--delay", "40", "go")
time.sleep(0.5)
xdo("key", "Return")
time.sleep(10)


def row_text(row):
	"""Drag-select one row and read it back out of the terminal.

	Replaying pi's byte stream through a terminal emulator gets the *content*
	right and the row wrong: pi scrolls, and a replay with no scrollback ends
	up a handful of rows off, which is a click on the wrong line. So the
	terminal is asked where its own text is. Alacritty trims trailing
	whitespace from a selection but keeps leading spaces, so the returned
	index is the column.
	"""
	y = int(row * cell_h + cell_h / 2)
	xdo("mousemove", "--sync", "0", str(y))
	time.sleep(0.15)
	xdo("mousedown", "1")
	time.sleep(0.15)
	xdo("mousemove", "--sync", str(int((cols - 1) * cell_w)), str(y))
	time.sleep(0.15)
	xdo("mouseup", "1")
	time.sleep(0.25)
	return primary()


chip = None
for row in range(rows - 1, -1, -1):
	line = row_text(row)
	for superscript in SUPERSCRIPTS:
		column = line.find(superscript + SUGGESTION)
		if column != -1:
			chip = (row, column)
			break
	if chip:
		break
if not chip:
	cleanup(1, "no chip label on screen; did the mock reply arrive?")
print(f"chip label at row {chip[0]}, column {chip[1]}")

# Drop the selection before clicking: a click that lands inside a selection is
# still a click, but leaving one up makes the screenshot of a failure confusing.
xdo("mousemove", "--sync", "0", "0")
xdo("click", "1")
time.sleep(0.3)

before = open(typescript, "rb").read()
x = int((chip[1] + 1 + len(SUGGESTION) // 2) * cell_w + cell_w / 2)
y = int(chip[0] * cell_h + cell_h / 2)
print(f"clicking the middle of the label at ({x},{y}) — no modifier, which is "
	  f"alacritty's own default for a hyperlink hint")
xdo("mousemove", "--sync", str(x), str(y))
time.sleep(0.4)
xdo("click", "1")
time.sleep(3)


def bare_occurrences(data):
	"""Occurrences of the suggestion that are not a chip label.

	A chip always paints its superscript; the text the socket inserts carries
	no number, so an occurrence with no superscript in front of it came from
	the composer. Escape sequences sit between the two on the wire, so the
	lookback is stripped before it is judged. Same rule as link-click-live.py.
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


after = open(typescript, "rb").read()
inserted = bare_occurrences(after) - bare_occurrences(before)
painted = b"\x1b]8;;pisnip://" in after
print(f"OSC 8 pisnip:// painted: {painted};  un-numbered insertions after the click: {inserted}")

if stock:
	if not painted and inserted == 0:
		cleanup(0, "PASS: stock alacritty paints a bare label and the click reaches nothing — "
				   "pi-tui has no TERM_PROGRAM to recognise (docs/linux-terminals.md)")
	cleanup(1, "UNEXPECTED: something painted or inserted without hyperlinks being forced; "
			   "has pi-tui learned to detect alacritty?")
if not painted:
	cleanup(1, "FAIL: PI_HYPERLINKS=1 did not produce an OSC 8 chip")
if inserted > 0:
	cleanup(0, "PASS: the click was resolved by alacritty and inserted the suggestion")
cleanup(1, "FAIL: the chip painted, but the click inserted nothing — check that "
		   "`python3 scripts/link-register.py --install` has run and that the socket "
		   "directories agree (docs/terminal-resolved-clicks.md §9d)")
