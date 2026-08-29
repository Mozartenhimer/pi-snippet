#!/usr/bin/env python3
"""Live smoke test: `/snippets model` inside a real pi process, over RPC.

RPC mode has no composer and no autocomplete UI (`ExtensionUIContext`'s
dialog methods are the whole surface — see docs/rpc.md's Extension UI
Protocol), so this cannot show the tab-completing dropdown the command exists
for; that needs a real terminal and is what scripts/snippet-model-tmux.py is
for. What this proves instead, against real pi rather than a fake registry:

  * the command actually registers and its handler actually runs;
  * `pi.registerProvider`'s models are exactly what
    `ctx.modelRegistry.getAvailable()` hands back to `resolvePin` /
    `modelCompletions` inside the running process;
  * a valid pin is accepted, notified, and persisted to the settings file;
  * an unknown pin is refused, with the file left untouched.

No network, no credentials: test/fixtures/mock-models.js registers a
provider's model catalogue only, never answering a prompt.

Usage:  python3 scripts/snippet-model-rpc-smoke.py   (exit 0 = PASS)
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


def main():
    pi = shutil.which("pi")
    if not pi:
        print("SKIP: pi not found on PATH")
        return 0
    if not os.path.exists(EXT):
        print("FAIL: %s missing — run `npm run build`" % EXT)
        return 1
    if not os.path.exists(FIXTURE):
        print("FAIL: %s missing" % FIXTURE)
        return 1

    settings = os.path.join(tempfile.mkdtemp(prefix="pi-snippet-rpc-smoke-"), "settings.json")
    env = dict(os.environ)
    env["PI_SNIPPET_SETTINGS"] = settings

    proc = subprocess.Popen(
        [
            pi, "--mode", "rpc", "--no-session", "--no-extensions",
            "-e", FIXTURE, "-e", EXT,
            "--provider", "mockllm", "--model", "zzpisnip-small",
        ],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=ROOT, env=env,
    )

    notices = []

    def send(obj):
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def pump_until(predicate, seconds, label):
        end = time.time() + seconds
        while time.time() < end:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "extension_ui_request" and event.get("method") == "notify":
                notices.append(event.get("message", ""))
            if predicate(event):
                return event
        print("FAIL: timed out waiting for %s" % label)
        print("stderr tail:\n%s" % proc.stderr.read())
        return None

    try:
        # An extension command runs immediately per docs/rpc.md; the response
        # to `prompt` is enough to know the handler has already returned.
        send({"id": "set", "type": "prompt", "message": "/snippets model mockllm/zzpisnip-large-reasoner"})
        resp = pump_until(
            lambda e: e.get("type") == "response" and e.get("id") == "set", 15,
            "the /snippets model prompt to be accepted",
        )
        if resp is None:
            return 1
        if not resp.get("success"):
            print("FAIL: prompt command rejected: %s" % resp)
            return 1

        # Fire-and-forget notify events race the response; give one a moment.
        time.sleep(0.3)
        while proc.stdout in select_ready(proc.stdout, 0.2):
            line = proc.stdout.readline()
            if not line:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "extension_ui_request" and event.get("method") == "notify":
                notices.append(event.get("message", ""))

        if not any("Second model set to mockllm/zzpisnip-large-reasoner" in n for n in notices):
            print("FAIL: no confirmation notice seen; notices were: %r" % notices)
            return 1
        print("PASS: notified %r" % next(n for n in notices if "Second model set to" in n))

        if not os.path.exists(settings):
            print("FAIL: settings file was never written: %s" % settings)
            return 1
        with open(settings) as fh:
            stored = json.load(fh)
        if stored.get("inferModel") != "mockllm/zzpisnip-large-reasoner":
            print("FAIL: settings file has inferModel=%r" % stored.get("inferModel"))
            return 1
        print("PASS: %s persisted inferModel=mockllm/zzpisnip-large-reasoner" % settings)

        # An unknown pin must be refused and must not touch the file.
        notices.clear()
        send({"id": "bad", "type": "prompt", "message": "/snippets model mockllm/does-not-exist"})
        resp = pump_until(
            lambda e: e.get("type") == "response" and e.get("id") == "bad", 15,
            "the rejected pin's prompt to be accepted",
        )
        if resp is None or not resp.get("success"):
            print("FAIL: the rejecting prompt itself did not round-trip: %s" % resp)
            return 1
        time.sleep(0.3)
        while proc.stdout in select_ready(proc.stdout, 0.2):
            line = proc.stdout.readline()
            if not line:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "extension_ui_request" and event.get("method") == "notify":
                notices.append(event.get("message", ""))
        if not any("nothing changed" in n for n in notices):
            print("FAIL: no rejection notice seen for an unknown pin; notices were: %r" % notices)
            return 1
        with open(settings) as fh:
            stored_after = json.load(fh)
        if stored_after.get("inferModel") != "mockllm/zzpisnip-large-reasoner":
            print("FAIL: the unknown pin changed the stored model to %r" % stored_after.get("inferModel"))
            return 1
        print("PASS: an unknown pin was refused and the stored choice was left alone")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def select_ready(stream, timeout):
    import select
    ready, _, _ = select.select([stream], [], [], timeout)
    return ready


if __name__ == "__main__":
    sys.exit(main())
