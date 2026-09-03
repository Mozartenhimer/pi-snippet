#!/usr/bin/env python3
"""Watch the second model kick in, in a real terminal, end to end.

The user story this pins down: the primary model's reply streams
immediately; when the agent's turn ends on it, the second model re-emits the
message with more `<snippet>` tags and its chips light up one at a time; and every superscript
already on screen stays exactly what it was — even when a new chip lands
*before* an older one in the text, so painted order and numbered order
deliberately diverge.

What makes it possible without credentials or a live model:

  * `test/fixtures/mock-llm.js` registers a real pi provider served from a
    function. It plays both parts: the primary model (streamed a few words at
    a time, one tag of its own) and the second model (a re-emission of the
    message with more tags, streamed one completed tag per chunk — the
    chunking that makes chips appear one at a time).
  * tmux is the terminal: `send-keys` types the prompt, `capture-pane` reads
    the rendered screen back, superscripts and all.

The scripted exchange, and why the numbers come out the way they do:

  primary:  The build is green. Shall I rebuild, or <snippet>wait for CI</snippet>? I could also revert the commit.

  Layer 1 paints ¹wait for CI while the primary is still writing. The second
  model then streams the re-emission, first tagging *rebuild* — which sits
  EARLIER in the sentence than the ¹ chip — then *revert*:

  second:   The build is green. Shall I <snippet>rebuild</snippet>, or <snippet>wait for CI</snippet>? I could also <snippet>revert</snippet> the commit.

  Layer 1 has first claim on the numbers, and layer-2 chips number in
  arrival order after them, so the final line reads

    Shall I ²rebuild, or ¹wait for CI? I could also ³revert the commit.

  — ² painted to the LEFT of ¹. An implementation that numbered in document
  order would repaint the ¹ chip as the ² chip mid-session, silently moving
  a number the user may already be reaching for; that regression is what the
  intermediate captures here catch.

Usage:  python3 scripts/snippet-infer-tmux.py   (exit 0 = PASS)
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
FIXTURE = os.path.join(ROOT, "test", "fixtures", "mock-llm.js")
SESSION = "pi-snippet-infer-tmux"
ROWS, COLS = 40, 110

PROMPT = "how did the build go"
PRIMARY = (
	"The build is green. Shall I rebuild, or <snippet>wait for CI</snippet>? "
	"I could also revert the commit."
)
INFER = (
	"The build is green. Shall I <snippet>rebuild</snippet>, or "
	"<snippet>wait for CI</snippet>? I could also <snippet>revert</snippet> the commit."
)
# The inference engine's system prompt opens with this sentence; the fixture
# uses it to tell an inference request from a primary one.
INFER_MARKER = "You add to an AI coding assistant's message"


def tmux(*args, **kwargs):
	return subprocess.run(["tmux", *args], capture_output=True, text=True, **kwargs)


def capture():
	out = tmux("capture-pane", "-p", "-t", SESSION)
	return out.stdout if out.returncode == 0 else ""


def wait_for(predicate, seconds, label):
	"""Poll the pane until `predicate` holds; dump the screen and die if it never does."""
	end = time.time() + seconds
	last = ""
	while time.time() < end:
		last = capture()
		if predicate(last):
			return last
		time.sleep(0.05)
	print("FAIL: timed out waiting for %s" % label)
	print(last)
	dump_mock_log()
	cleanup()
	sys.exit(1)


MOCKLOG = {"path": None}


def dump_mock_log():
	path = MOCKLOG["path"]
	if path is None:
		return
	try:
		with open(path) as fh:
			print("mock-llm log:")
			print(fh.read())
	except OSError:
		print("mock-llm log: (never written — the mock was never asked for anything)")


def cleanup():
	tmux("kill-session", "-t", SESSION)


def main():
	if not shutil.which("tmux"):
		print("SKIP: tmux not installed")
		return 0
	if not shutil.which("pi"):
		print("SKIP: pi not found")
		return 0
	for path in (EXT, FIXTURE):
		if not os.path.exists(path):
			print("FAIL: %s missing — run `npm run build`" % path)
			return 1

	tmux("kill-session", "-t", SESSION)

	# A throwaway settings file, as in every harness here: never read or
	# rewrite whoever runs this's real preferences.
	dir = tempfile.mkdtemp(prefix="pi-snippet-infer-tmux-")
	settings = os.path.join(dir, "settings.json")
	# Every request the mock receives, as JSONL — the first thing to read when
	# this harness fails, since it says whether the second model was even asked.
	mocklog = os.path.join(dir, "mock-llm.log")
	MOCKLOG["path"] = mocklog

	env = " ".join(
		"%s=%s" % (k, "'" + v.replace("'", "'\\''") + "'")
		for k, v in {
			"PI_SNIPPET_SETTINGS": settings,
			"MOCK_LLM_LOG": mocklog,
			# One model plays both roles; the pin is what sends the second
			# model's requests to the mock instead of a real catalogue entry.
			"PI_SNIPPET_MODEL": "mockllm/mock-small",
			"MOCK_LLM_INFER_MARKER": INFER_MARKER,
			"MOCK_LLM_SCRIPT": json.dumps([PRIMARY]),
			"MOCK_LLM_INFER": json.dumps([INFER]),
			# Slow enough that intermediate frames are observable, fast enough
			# that the whole exchange takes a couple of seconds.
			"MOCK_LLM_CHUNK_MS": "120",
		}.items()
	)
	pi = shutil.which("pi")
	command = "seq 1 10; exec env %s %s --no-session --no-extensions -e %s -e %s --provider mockllm --model mock-small" % (
		env, pi, FIXTURE, EXT,
	)
	started = tmux("new-session", "-d", "-s", SESSION, "-x", str(COLS), "-y", str(ROWS), command)
	if started.returncode != 0:
		print("FAIL: could not start tmux session: %s" % started.stderr.strip())
		return 1

	try:
		wait_for(lambda s: len([l for l in s.split("\n")[11:] if l.strip()]) > 3, 30, "pi to boot")
		time.sleep(1)

		# --- the primary reply streams immediately, plain text first ---
		tmux("send-keys", "-t", SESSION, PROMPT)
		tmux("send-keys", "-t", SESSION, "Enter")
		wait_for(lambda s: "build is green" in s, 15, "the primary reply to start streaming")
		first_frame = capture()
		if "could also revert" in first_frame:
			print("FAIL: the whole reply painted at once — nothing streamed")
			print(first_frame)
			dump_mock_log()
			cleanup()
			return 1
		print("PASS: the primary reply is streaming (partial text visible, tail not yet)")

		# --- the footer tracks the second model in three states ---
		wait_for(lambda s: "snippet: not sent" in s, 10,
				 "the footer to say 'snippet: not sent' while the primary streams")
		print("PASS: footer says 'snippet: not sent' while the primary streams")

		# --- layer 1 paints while the primary is still writing ---
		wait_for(lambda s: "\u00b9wait for CI" in s, 15, "the layer-1 chip \u00b9wait for CI")
		print("PASS: layer 1 painted \u00b9wait for CI mid-stream")

		# --- the primary finishes; the second model takes over ---
		wait_for(lambda s: "could also revert" in s, 15, "the primary reply to finish")
		wait_for(lambda s: "snippet: sent (waiting)" in s, 5,
				 "the footer to say 'snippet: sent (waiting)' while the reply streams")
		print("PASS: footer says 'snippet: sent (waiting)' while the second model writes")
		wait_for(lambda s: "\u00b2rebuild" in s, 20, "the second model's first chip \u00b2rebuild")
		frame = capture()
		if "\u00b9wait for CI" not in frame:
			print("FAIL: the layer-1 chip lost its number when \u00b2 arrived")
			print(frame)
			dump_mock_log()
			cleanup()
			return 1
		print("PASS: second model painted \u00b2rebuild — earlier in the text than \u00b9, numbered after it")

		wait_for(lambda s: "\u00b3revert" in s, 20, "the second model's second chip \u00b3revert")
		final = capture()
		if "\u00b9wait for CI" not in final or "\u00b2rebuild" not in final:
			print("FAIL: an earlier chip's superscript moved as \u00b3 arrived")
			print(final)
			dump_mock_log()
			cleanup()
			return 1
		shall_line = next((l for l in final.split("\n") if "Shall I" in l and "\u00b2rebuild" in l), "")
		painted_order_ok = (
			"\u00b2rebuild" in shall_line
			and "\u00b9wait for CI" in shall_line
			and shall_line.index("\u00b2rebuild") < shall_line.index("\u00b9wait for CI")
		)
		if not painted_order_ok:
			print("FAIL: expected ²rebuild painted left of ¹wait for CI on one line; got: %r" % shall_line)
			print(final)
			dump_mock_log()
			cleanup()
			return 1
		print("PASS: \u00b3revert joined without moving \u00b9 or \u00b2; painted order \u00b2 \u00b9 \u00b3, numbered order \u00b9 \u00b2 \u00b3")

		# The report: two chips the primary never tagged landed.
		wait_for(lambda s: "snippet: 2 new chips" in s, 5,
				 "the footer to report the new-chip count")
		print("PASS: footer reports 'snippet: 2 new chips'")

		# --- the numbers on screen are the numbers Alt+N addresses ---
		before = sum(1 for l in final.split("\n") if "rebuild" in l)
		tmux("send-keys", "-t", SESSION, "M-2")
		after_screen = wait_for(
			lambda s: sum(1 for l in s.split("\n") if "rebuild" in l) > before,
			10,
			"Alt+2 to insert the second chip's text into the composer",
		)
		print("PASS: Alt+2 inserted %r — the painted ² is the addressed ²" % "rebuild")

		cleanup()
		print("PASS: primary streams at once, second model kicks in with stable superscripts")
		return 0
	except SystemExit:
		raise
	except Exception as exc:
		print("FAIL: unexpected error: %r" % exc)
		print(capture())
		dump_mock_log()
		cleanup()
		return 1


if __name__ == "__main__":
	sys.exit(main())
