#!/usr/bin/env python3
"""Terminal-resolved click *with* the terminal: a real window, real pi, a real click.

`link-click-live.py` proves everything except the terminal — it speaks to the
socket the way the handler would. This closes that last hop, per terminal: a
window on an X display, a chip painted by real pi, a real button press on it,
and the terminal's own machinery carrying the URL out to the desktop. Nothing
here imitates a gesture; xdotool moves the pointer and presses the button.

    bash scripts/xvfb-env.sh                 # a display, if you have no desktop
    python3 scripts/link-register.py --install
    npm run build
    DISPLAY=:99 python3 scripts/terminal-click.py alacritty          # expect PASS
    DISPLAY=:99 python3 scripts/terminal-click.py alacritty --stock  # expect the gap
    DISPLAY=:99 python3 scripts/terminal-click.py kitty              # detected, works as shipped
    DISPLAY=:99 python3 scripts/terminal-click.py gnome-terminal     # works, undetected

Two regimes:

  default   PI_HYPERLINKS=1 forces pi-tui to paint OSC 8, which is the only way
            to see what a terminal does with a chip when pi-tui does not
            recognise it. On kitty this changes nothing — it is detected
            anyway.
  --stock   nothing forced: what a real session in that terminal gets today.
            The run passes when the terminal's *own* detection story holds —
            chips and a working click where pi-tui recognises the terminal, a
            bare label and a click that reaches nothing where it does not — so
            the harness fails the day either side changes.

Konsole and xterm are expected to FAIL the default regime and PASS `--stock`:
neither acts on an OSC 8 hyperlink at all, which is the terminal's answer and
not a regression here (docs/linux-terminals.md). kitty passes both regimes,
because it is the one terminal in the table pi-tui recognises.

What it needs: the terminal, xdotool, xclip, a display, `pi` on PATH, a
registered `pisnip://` handler, and a built extension. Exits 0 when the regime
behaved as described, 1 otherwise.
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
GESTURES = (("plain", []), ("ctrl", ["ctrl"]), ("ctrl+shift", ["ctrl", "shift"]), ("shift", ["shift"]))


def gnome_terminal_argv(inner):
	"""gnome-terminal, through the two things that stop it starting headless.

	It is a client: the window is drawn by gnome-terminal-server, activated
	over the session bus, so a machine with no desktop session needs
	`dbus-run-session`. And the launcher is a python script that imports
	pygobject, so it runs under whatever `/usr/bin/python3` points at — on a
	box where that is not the interpreter Debian installed `python3-gi` for,
	it dies with a confusing partially-initialised-`gi` ImportError. Find one
	that can import gi and run the real launcher with it.
	"""
	launcher = "/usr/bin/gnome-terminal"
	probe = subprocess.run([launcher, "--version"], capture_output=True, text=True)
	prefix = []
	if "gi" in probe.stderr and probe.returncode != 0:
		for candidate in ("python3.13", "python3.12", "python3.11", "python3.10"):
			path = shutil.which(candidate)
			if path and subprocess.run([path, "-c", "import gi"], capture_output=True).returncode == 0:
				prefix = [path]
				break
	return ["dbus-run-session", "--", *prefix, launcher, "--wait", "--", "bash", "-c", inner]


# Per terminal: how to launch it around a shell command, its window class, and
# the gesture its own documentation names. The gesture is a starting point, not
# a claim — every gesture is tried and the one that fired is reported.
SPEC = {
	"alacritty": (lambda c: ["alacritty", "-o", "window.padding.x=0", "-o", "window.padding.y=0",
							 "-e", "bash", "-c", c], "Alacritty", "plain"),
	"kitty": (lambda c: ["kitty", "-o", "window_padding_width=0", "bash", "-c", c], "kitty", "plain"),
	"gnome-terminal": (gnome_terminal_argv, "Gnome-terminal", "ctrl"),
	"konsole": (lambda c: ["dbus-run-session", "--", "konsole", "--nofork", "-e", "bash", "-c", c],
				"konsole", "ctrl"),
	"xterm": (lambda c: ["xterm", "-b", "0", "-e", "bash", "-c", c], "XTerm", "ctrl"),
}
# Terminals pi-tui recognises, which is what --stock is asserting against. It
# keys on KITTY_WINDOW_ID for kitty; every other terminal here exports nothing
# it looks at (docs/linux-terminals.md).
DETECTED = {"kitty"}

if len(sys.argv) < 2 or sys.argv[1] not in SPEC:
	sys.exit(f"usage: terminal-click.py [{'|'.join(SPEC)}] [--stock]")
name = sys.argv[1]
launch, wclass, documented_gesture = SPEC[name]
stock = "--stock" in sys.argv
display = os.environ.get("DISPLAY")
out = tempfile.mkdtemp(prefix=f"terminal-click-{name}-")
typescript = os.path.join(out, "pi.typescript")
size_file = os.path.join(out, "size")

for tool in (name, "xdotool", "xclip", "pi", "script"):
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
	# gnome-terminal-server refuses to start in a non-UTF-8 locale, with one
	# line on stderr and no window. Harmless for the others.
	LANG="C.UTF-8", LC_ALL="C.UTF-8",
)
# PI_HYPERLINKS is pi-tui's own override, and forcing it beats lying about
# TERM_PROGRAM — it says what we actually mean, which is "paint the links, we
# have measured that this terminal renders them".
env.pop("TERM_PROGRAM", None)
if not stock:
	env["PI_HYPERLINKS"] = "1"

# `script` records what pi paints while the terminal still receives it: the
# assertion at the end reads that recording, the same trick link-click-live.py
# uses on its pty. The window is the terminal under test either way.
pi_command = (f"stty size > {size_file}; exec pi --no-session --no-extensions --approve --offline "
			  f"-e {FIXTURE} -e {EXT} --provider mockllm --model mock-small")
# `script` sits between the terminal and pi, so the recording is what pi
# painted while the terminal was painting it for real. Neither quote style
# collides: pi_command has no quotes of its own.
inner = f"script -q -f {typescript} -c '{pi_command}'"
window_proc = subprocess.Popen(launch(inner), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cleanup(code, note=""):
	if note:
		print(note)
	window_proc.kill()
	subprocess.run(["pkill", "-x", name], capture_output=True)
	subprocess.run(["pkill", "-x", "xclip"], capture_output=True)
	subprocess.run(["pkill", "-f", "[g]nome-terminal-server"], capture_output=True)
	sys.exit(code)


window = ""
for _ in range(40):
	time.sleep(0.5)
	window = xdo("search", "--onlyvisible", "--class", wclass).split("\n")[-1]
	if window and os.path.exists(size_file):
		break
if not window or not os.path.exists(size_file):
	cleanup(1, f"{name} did not come up; is the display real?")

geometry = xdo("getwindowgeometry", window)
ox, oy = (int(v) for v in re.search(r"Position: (-?\d+),(-?\d+)", geometry).groups())
width, height = (int(v) for v in re.search(r"Geometry: (\d+)x(\d+)", geometry).groups())
rows, cols = (int(v) for v in open(size_file).read().split())
print(f"{name}: window {width}x{height} at {ox},{oy}, grid {cols}x{rows}, "
	  f"regime {'stock (nothing forced)' if stock else 'PI_HYPERLINKS=1'}")

xdo("windowfocus", window)
time.sleep(1)
xdo("type", "--delay", "40", "go")
time.sleep(0.5)
xdo("key", "Return")
time.sleep(10)


def clear_primary():
	"""Own PRIMARY with a placeholder, without waiting for xclip to finish.

	`xclip -i` forks a copy of itself that holds the selection until another
	client takes it, and that copy inherits our pipes — so waiting for it
	deadlocks, and the deadlock looks exactly like a slow scan. Hand it the
	text and walk away; it exits when the terminal takes the selection.
	"""
	writer = subprocess.Popen(["xclip", "-i", "-selection", "primary"], stdin=subprocess.PIPE,
							  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
	writer.stdin.write(b"<none>")
	writer.stdin.close()
	# Wait until it really owns the selection. Two failures hide here: an
	# xclip that grabs PRIMARY *after* the drag wipes the answer we came for,
	# and one that never grabs it at all leaves the previous row's text to be
	# read back as if it were this row's — which is a click on the wrong line.
	for _ in range(20):
		if primary() == "<none>":
			return True
		time.sleep(0.05)
	return False


def drag(x1, x2, y):
	if not clear_primary():
		return ""
	xdo("mousemove", "--sync", str(x1), str(y))
	time.sleep(0.06)
	xdo("mousedown", "1")
	time.sleep(0.06)
	xdo("mousemove", "--sync", str(x2), str(y))
	time.sleep(0.06)
	xdo("mouseup", "1")
	time.sleep(0.15)
	return primary()


# Where is the chip? Ask the terminal, one row band at a time.
#
# Replaying pi's byte stream through a terminal emulator gets the *content*
# right and the row wrong: pi scrolls, and a replay with no scrollback ends up
# several rows off, which is a click on the wrong line. Window geometry is no
# better — gnome-terminal has a menu bar and konsole a tab bar, so the grid
# does not start at the top of the window. The selection is the one answer that
# is the terminal's own. The right edge is avoided: a drag that ends on
# gnome-terminal's scrollbar cancels the selection instead of making one.
# Bottom-up, because pi paints the transcript just above the composer and a
# scan from the top spends its time on blank rows.
right = ox + int(width * 0.75)
chip = None
for y in range(oy + height - 4, oy + 2, -8):
	line = drag(ox + 2, right, y)
	for superscript in SUPERSCRIPTS:
		column = line.find(superscript + SUGGESTION)
		if column != -1:
			chip = (y, column)
			break
	if chip:
		break
if not chip:
	cleanup(1, "no chip label on screen; did the mock reply arrive?")

# Which pixel is a few characters into the label? Two more selections
# calibrate the row: how many characters a drag reaches tells you the cell
# width and where column zero starts, without assuming either — a terminal
# can put a scrollbar on the left, pad its grid, or scale its font.
# The pause matters: these drags start where the last one did, and two
# presses at the same spot inside the terminal's multi-click interval are a
# double click (a word) and then a triple click (the whole line), which is
# not the measurement being asked for. Measured on kitty.
def measure(x):
	"""How much of the chip's row a drag out to `x` selects.

	Retried, because a drag occasionally selects nothing at all — the pointer
	arriving and the button going down inside the same few milliseconds is
	enough for a terminal to treat it as a click rather than a drag.
	"""
	for _ in range(4):
		time.sleep(0.7)
		text = drag(ox + 2, x, chip[0]).rstrip()
		if text and text != "<none>":
			return text
	return ""


near, far = ox + int(width * 0.35), ox + int(width * 0.65)
near_text = measure(near)
far_text = measure(far)
near_len, far_len = len(near_text), len(far_text)
if far_len <= near_len:
	cleanup(1, "found the chip row but could not measure a column in it "
			   f"(near x={near} -> {near_text!r}, far x={far} -> {far_text!r})")
cell_w = (far - near) / (far_len - near_len)
origin = near - near_len * cell_w
click_x = int(origin + (chip[1] + 6.5) * cell_w)
click_y = chip[0]
print(f"chip label on the row at y={click_y}, column {chip[1]}, "
	  f"cell {cell_w:.2f}px wide — clicking x={click_x}")
xdo("mousemove", "--sync", str(ox + 2), str(oy + height - 3))
xdo("click", "1")
time.sleep(0.3)

before = open(typescript, "rb").read()
painted = b"\x1b]8;;pisnip://" in before


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


# Warm the dispatch path first. The first URL of a session pays for gio's or
# the portal's cold start, which is seconds — long enough that the gesture
# that happens to go first looks like the one that does not work. This URL
# names a token no session owns, so the handler finds no socket and exits.
subprocess.run(["xdg-open", f"pisnip://{os.uname().nodename}/deadbeef/0000/c1"],
			   capture_output=True)
time.sleep(3)

# And spend one click on the chip before measuring. Measured on alacritty: the
# first click after the pointer arrives in a freshly focused window does
# nothing at all, and every click after it works — so whichever gesture went
# first would be reported as the one that does not work.
xdo("mousemove", "--sync", str(click_x), str(click_y))
time.sleep(0.5)
xdo("click", "1")
time.sleep(3.5)

# Every gesture, documented one first: a terminal that needs Ctrl and a
# terminal that needs nothing are both worth knowing about, and asserting one
# of them would just encode today's guess.
order = sorted(GESTURES, key=lambda g: g[0] != documented_gesture)
fired = []
for label, mods in order:
	baseline = bare_occurrences(open(typescript, "rb").read())
	xdo("mousemove", "--sync", str(click_x), str(click_y))
	time.sleep(0.4)
	for mod in mods:
		xdo("keydown", mod)
	time.sleep(0.3)
	xdo("mousemove", "--sync", str(click_x + 3), str(click_y))
	time.sleep(0.2)
	xdo("click", "1")
	time.sleep(3.5)
	for mod in mods:
		xdo("keyup", mod)
	time.sleep(0.5)
	inserted = bare_occurrences(open(typescript, "rb").read()) - baseline
	print(f"  {label:11} -> {'inserted' if inserted > 0 else 'nothing'}")
	if inserted > 0:
		fired.append(label)

print(f"OSC 8 pisnip:// painted: {painted};  gestures that inserted: {fired or 'none'}")

if stock and name not in DETECTED:
	if not painted and not fired:
		cleanup(0, f"PASS: stock {name} paints a bare label and the click reaches nothing — "
				   "pi-tui does not recognise this terminal (docs/linux-terminals.md)")
	cleanup(1, f"UNEXPECTED: {name} painted or inserted without hyperlinks being forced; "
			   "has pi-tui learned to detect it?")
if not painted:
	cleanup(1, "FAIL: no OSC 8 chip was painted"
			   + ("" if stock else " even with PI_HYPERLINKS=1"))
if fired:
	cleanup(0, f"PASS: {name} resolved the click ({', '.join(fired)}) and the suggestion was inserted")
cleanup(1, f"FAIL: the chip painted, but no gesture reached the socket. Either {name} does not act "
		   "on OSC 8 hyperlinks, or the handler is not registered — check "
		   "`python3 scripts/link-register.py --install` and docs/terminal-resolved-clicks.md §9d")
