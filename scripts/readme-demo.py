#!/usr/bin/env python3
"""Record the README's asciinema demo: real pi, real extension, no credentials.

The demo runs the same stack `scripts/snippet-infer-tmux.py` asserts against —
real pi, the real bundled extension, `test/fixtures/mock-llm.js` standing in
for both models — driven at reading speed instead of test speed, with
`asciinema rec` in the middle of the pty so what lands in the cast is exactly
what pi painted. Nothing here is a mock-up of the UI: every superscript, every
footer state and the insertion are the extension's own output.

**The scenario is pi-snippet itself**: someone in this repo asking how the
chip numbers work, and being answered by a model that marks its own offers of
what to do next. A demo of a suggestion tool should be a session someone could
actually have had, and the reply doubles as documentation — the numbering rule
it describes is the one the recording then demonstrates on screen. (The repo's
`.pi/skills/snippet-demo` skill exists for the other case: a throwaway
scenario for showing chips off with no real task attached. It is the better
thing to run by hand and the worse thing to put at the top of the README,
where a reader is still deciding what this is.)

The reply keeps the three shapes a chip comes in — a numbered list of whole
options, a binary framed as two complete replies, and a flat list of bare
names, here the three files the rules live in, left untagged so the second
model has something to find.

The exchange shows, in order: chips lighting up mid-stream as the primary
model closes each tag; the footer moving through `not sent` → `sent (waiting)`
→ `3 new chips`; the second model tagging those three filenames and its chips
taking the next free numbers rather than renumbering what is already on
screen; `Alt+2` inserting a chip into the composer; and the inserted text
being edited before it is sent, because inserting never sends.

**The chip that gets inserted is the longest one on screen, deliberately.**
`Explain why a chip's number never shifts mid-stream` is 50 characters that
arrive on one keystroke, which is the whole argument for the feature;
demonstrating it on a one-word chip shows the mechanism and hides the point.

Three things about the harness itself:

  * **No tmux.** The earlier take ran pi in a tmux session and recorded a
    client attached to it, which put a status bar and pi's `extended-keys is
    off` warning in the frame — and `extended-keys on`, the fix for the
    warning, makes tmux encode Alt+digit as CSI-u, which the chip chord never
    receives. A bare pty has neither problem.
  * **The terminal is announced as Ghostty** (`TERM_PROGRAM`, as
    `link-click-live.py` does) so pi-tui reports `hyperlinks: true` and the
    chips paint as real OSC 8 links — the rendering the README describes. An
    unidentified terminal gets the bare-label path instead.
  * **Cursor-position queries are answered** by the pump thread, as in every
    pty harness here; pi blocks on them otherwise.

Usage:  python3 scripts/readme-demo.py [--out docs/demo/pi-snippet.cast]
        agg --idle-time-limit 1.5 --font-size 16 docs/demo/pi-snippet.cast \
            docs/demo/pi-snippet.gif
"""
import argparse
import fcntl
import json
import os
import pty
import random
import re
import shlex
import shutil
import struct
import sys
import tempfile
import termios
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, "dist", "extension", "pi-snippet-tui.js")
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-llm.js")
ROWS, COLS = 30, 100

# The inference engine's system prompt opens with this sentence; the fixture
# uses it to tell a second-model request from a primary one. Kept identical to
# the harness's copy — if the prompt moves, both go stale together.
INFER_MARKER = "You add to an AI coding assistant's message"

PROMPT_ONE = "how do the chip numbers work?"
# The answer a model working on this repo would give, marked up the way the
# injected prompt asks for. The three filenames at the end are deliberately
# left bare: they are what the second model has left to find.
PRIMARY_ONE = (
	"Chips come from two layers and share one numbering. Layer 1 is the tags the model "
	"writes itself; layer 2 is a second model that reads the finished message and adds "
	"more, appended in arrival order. Where do you want to start:\n\n"
	"1. <snippet>Show me where the merge happens</snippet>?\n"
	"2. <snippet>Explain why a chip's number never shifts mid-stream</snippet>?\n"
	"3. <snippet>Walk me through the second model's prompt</snippet>?\n\n"
	"There is also an open question about the footer: should it "
	"<snippet>keep the four states it has</snippet>, or "
	"<snippet>collapse them into one line</snippet>?\n\n"
	"The rules live in three files: tui-markdown.ts, inferred.ts, and link-url.ts. "
	"Which one do you want open?"
)
# The second model's re-emission: the five tags above come back unchanged (and
# are dropped at validation — layer 1 already paints them), plus the three
# filenames the primary never tagged, which land as ⁶ ⁷ ⁸ without disturbing ¹–⁵.
INFER_ONE = (
	"Chips come from two layers and share one numbering. Layer 1 is the tags the model "
	"writes itself; layer 2 is a second model that reads the finished message and adds "
	"more, appended in arrival order. Where do you want to start:\n\n"
	"1. <snippet>Show me where the merge happens</snippet>?\n"
	"2. <snippet>Explain why a chip's number never shifts mid-stream</snippet>?\n"
	"3. <snippet>Walk me through the second model's prompt</snippet>?\n\n"
	"There is also an open question about the footer: should it "
	"<snippet>keep the four states it has</snippet>, or "
	"<snippet>collapse them into one line</snippet>?\n\n"
	"The rules live in three files: <snippet>tui-markdown.ts</snippet>, "
	"<snippet>inferred.ts</snippet>, and <snippet>link-url.ts</snippet>. "
	"Which one do you want open?"
)
# What the user adds to the inserted chip before sending it, to show that
# inserting is not sending. Kept short on purpose: the contrast between the 50
# characters Alt+2 delivered and the handful typed after it is the demo.
EDIT = ", with an example"
PRIMARY_TWO = (
	"The set is rebuilt from the message on every tick, and layer-2 anchors land after "
	"layer 1, so a number never moves once you can see it. Want the "
	"<snippet>test that pins it</snippet>, or <snippet>the click path next</snippet>?"
)
# Nothing left for the second model to find, which is the ordinary case and
# the footer says so: `0 new chips`.
INFER_TWO = PRIMARY_TWO

DSR = re.compile(rb"\x1b\[6n")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


class Pump:
	"""Read the pty forever on a thread, answering cursor-position queries.

	Everything the child paints is kept, ANSI stripped, as one long string:
	the waits below match against that rather than against a screen grid, so a
	chip label wrapped across two lines still has to be matched by a fragment
	short enough not to straddle the break.
	"""

	def __init__(self, master):
		self.master = master
		self.raw = bytearray()
		self.lock = threading.Lock()
		self.alive = True
		self.thread = threading.Thread(target=self._run, daemon=True)
		self.thread.start()

	def _run(self):
		while self.alive:
			try:
				chunk = os.read(self.master, 65536)
			except OSError:
				break
			if not chunk:
				break
			with self.lock:
				self.raw += chunk
			for _ in DSR.findall(chunk):
				try:
					os.write(self.master, b"\x1b[1;1R")
				except OSError:
					break

	def text(self):
		with self.lock:
			raw = bytes(self.raw)
		return ANSI.sub(b"", raw).decode("utf-8", "replace")

	def tail(self, lines=30):
		return "\n".join(self.text().splitlines()[-lines:])


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--out", default=os.path.join(ROOT, "docs", "demo", "pi-snippet.cast"))
	# pi's footer prints the working directory and its git branch, so the
	# recording carries whatever branch this was recorded from. Point --cwd at
	# a checkout of `main` (a `git worktree` is enough) to keep a scratch
	# branch name out of the README's GIF. The extension and the fixture are
	# always the ones in *this* tree — they are passed by absolute path — so
	# what is being demonstrated is still the code you have.
	parser.add_argument("--cwd", default=ROOT)
	args = parser.parse_args()
	out = os.path.abspath(args.out)
	cwd = os.path.abspath(args.cwd)

	for tool in ("asciinema", "pi"):
		if not shutil.which(tool):
			print("FAIL: %s not installed" % tool)
			return 1
	for path in (EXT, FIXTURE):
		if not os.path.exists(path):
			print("FAIL: %s missing — run `npm run build`" % path)
			return 1
	os.makedirs(os.path.dirname(out), exist_ok=True)

	env = dict(os.environ)
	env.update(
		# A throwaway settings file, as in every harness here: the recording
		# must not read or rewrite whoever runs it's real preferences.
		PI_SNIPPET_SETTINGS=os.path.join(tempfile.mkdtemp(prefix="pi-snippet-demo-"), "settings.json"),
		# One model plays both roles; the pin is what sends the second model's
		# requests to the mock instead of a real catalogue entry.
		PI_SNIPPET_MODEL="mockllm/mock-small",
		MOCK_LLM_INFER_MARKER=INFER_MARKER,
		MOCK_LLM_SCRIPT=json.dumps([PRIMARY_ONE, PRIMARY_TWO]),
		MOCK_LLM_INFER=json.dumps([INFER_ONE, INFER_TWO]),
		# Slow enough to watch a tag close and a chip light up.
		MOCK_LLM_CHUNK_MS="110",
		TERM="xterm-ghostty", TERM_PROGRAM="ghostty", COLORTERM="truecolor",
		LINES=str(ROWS), COLUMNS=str(COLS),
	)
	env.pop("TMUX", None)

	pi_command = " ".join(shlex.quote(a) for a in [
		shutil.which("pi"), "--no-session", "--no-extensions",
		"-e", FIXTURE, "-e", EXT, "--provider", "mockllm", "--model", "mock-small",
	])
	rec = ["asciinema", "rec", "-q", "--overwrite", "-c", pi_command, out]

	pid, master = pty.fork()
	if pid == 0:
		# Size the pty before asciinema starts, so the cast header carries the
		# demo's dimensions instead of a default that resizes on the first frame.
		fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
		os.chdir(cwd)
		os.environ.clear()
		os.environ.update(env)
		os.execvp(rec[0], rec)

	pump = Pump(master)

	def send(data):
		os.write(master, data)

	def type_text(text, cps=17.0):
		"""One character at a time, with jitter, so the cast looks typed."""
		for ch in text:
			send(ch.encode())
			time.sleep(random.uniform(0.55, 1.6) / cps)

	def wait_for(fragment, seconds, label):
		end = time.time() + seconds
		while time.time() < end:
			if fragment in pump.text():
				return
			time.sleep(0.05)
		raise SystemExit("timed out waiting for %s\n%s" % (label, pump.tail()))

	def wait_regex(pattern, since, seconds, label):
		"""Wait for a match in output painted *after* `since`.

		The pump keeps every byte the session ever painted, so a plain
		substring cannot tell a fresh paint from the twentieth repaint of the
		same sentence. The composer insertion is exactly that case: the chip's
		text is already on screen inside the message, so what proves Alt+2
		landed is the same words painted again without the superscript in
		front of them, after the keystroke.
		"""
		rx = re.compile(pattern)
		end = time.time() + seconds
		while time.time() < end:
			if rx.search(pump.text()[since:]):
				return
			time.sleep(0.05)
		raise SystemExit("timed out waiting for %s\n%s" % (label, pump.tail()))

	try:
		wait_for("mock-small", 40, "pi to boot")
		time.sleep(2.0)

		# --- the prompt, typed ---
		type_text(PROMPT_ONE)
		time.sleep(0.9)
		send(b"\r")

		# --- layer 1: chips close and light up while the model is still writing ---
		# Short fragments throughout: pi wraps at 100 columns and the captured
		# text carries the break, so a predicate long enough to straddle one
		# never matches. Every fragment below sits well inside a line.
		wait_for("¹Show", 30, "the ¹ chip mid-stream")
		wait_for("⁵collapse", 30, "the last layer-1 chip")
		wait_for("link-url", 30, "the primary reply to finish")
		time.sleep(2.0)

		# --- layer 2: the three bare filenames become chips ⁶ ⁷ ⁸ ---
		wait_for("⁸link", 45, "the second model's last chip")
		wait_for("3 new chips", 15, "the footer to report the new chips")
		time.sleep(3.5)

		# --- Alt+2 inserts 50 characters; ESC-prefixed, as a terminal sends it ---
		# Checked rather than slept through: the mock answers whatever is sent,
		# so a chord that never arrived would still produce a plausible-looking
		# recording of the wrong thing.
		mark = len(pump.text())
		send(b"\x1b2")
		wait_regex("(?<!²)Explain why a chip's number never shifts mid-stream", mark, 15,
				   "Alt+2 to put the chip in the composer")
		time.sleep(2.2)
		type_text(EDIT)
		time.sleep(1.8)
		send(b"\r")

		# --- the second exchange, so the loop is visible ---
		wait_for("rebuilt from the message", 30, "the second reply")
		wait_for("²the click", 30, "the second reply's own chips")
		wait_for("0 new chips", 20, "the second model's report on the second message")
		time.sleep(3.5)

		# Ctrl+C twice is pi's exit; asciinema writes the cast when pi is gone.
		send(b"\x03")
		time.sleep(0.4)
		send(b"\x03")
		for _ in range(80):
			if os.path.exists(out) and os.path.getsize(out) > 0:
				break
			time.sleep(0.25)
		pump.alive = False
		if not os.path.exists(out):
			print("FAIL: asciinema wrote no cast")
			return 1
		print("wrote %s (%d bytes)" % (out, os.path.getsize(out)))
		print("render with: agg --idle-time-limit 1.5 --font-size 16 %s %s"
			  % (out, out[:-5] + ".gif"))
		return 0
	except SystemExit as exc:
		print("FAIL: %s" % exc)
		return 1
	finally:
		pump.alive = False
		try:
			os.kill(pid, 9)
			os.waitpid(pid, 0)
		except OSError:
			pass


if __name__ == "__main__":
	sys.exit(main())
