# Human generated content
 The idea here is that the questionaire tools type things are too limited and rail roading. I've found myself copy and pasting content into my answer, and that's too much work. I'm extremely lazy.
 Why can't the LLM make that a bit easier by suggesting snippets that might be good replies? This is very much inspired by *Human Compatible* by Stuart Russell. 

So that's what this attempts to do.

An earlier version also had a web UI, but the best interface is the TUI for me at the moment. Mostly since it doesn't change my workflow now.

Below is what the machine created. Fable 5 did the initial design costing about 93 $ in credits, refinement with opus 5 and sonnet 5, and now glm 5.3-flash.

**Below is 99% clanker generated.**
# pi-snippet

Inline suggestion snippets for [pi](https://github.com/earendil-works/pi-mono). The model marks spans of its own prose as *suggested user replies* by wrapping them in `<snippet>…</snippet>`; the extension renders those spans in pi's terminal UI so you can insert them into the composer with a click or a keystroke. Inserting never sends — you can edit the text, add to it, or ignore it.

Suggestions come from two layers, painted as one. Layer 1 is the model's own tags. Layer 2 is a second, small model — OpenRouter's `qwen/qwen3.7-flash` by default, changeable in `/snippets`, `PI_SNIPPET_MODEL` overriding for a session — which reads each finished message (tags included, told to keep them and add more) and returns it with additional tags. Its chips are indistinguishable from layer-1 chips: numbered, `Alt+N` addressable, click-to-insert. It only runs on messages that ask something, caches its answers, stands down after three consecutive failures, and never surfaces an error — a message it cannot process simply has no extra chips. A question the primary model failed to tag still gets its chips; a message that asks nothing costs nothing.

What the model writes:

```
Want me to <snippet>rebuild the solution</snippet> or <snippet>run the tests</snippet>?
```
And it renders as 
> Want me to [¹rebuild the solution](#1) or [²run the tests](#2)?

What you see in the terminal — link-styled text led by a small superscript number. The transformer's actual output is a markdown link (`[¹rebuild the solution](#1)`-shaped) whose URL is  a real `pisnip://…` URL the terminal resolves on Ctrl+click. Whether a URL is *visible* is the terminal's call, not ours: pi-tui emits an OSC 8 hyperlink when the terminal supports one (Ghostty does) and the URL stays hidden, but where OSC 8 is unavailable — under tmux or screen, unless the client advertises `hyperlinks` — pi-tui falls back to printing the URL after the label. The extension paints no URL on such a terminal, so the fallback never appears; the chip is simply not clickable there.


More than ten in one message still each get their own number, and `Alt` addresses all of them (see below):

> - [¹check the logs](#1)
> - [²clear the cache](#2)
> - [³restart the server](#3)
> - [⁴roll back the deploy](#4)
> - [⁵grep the error](#5)
> - [⁶bump the version](#6)
> - [⁷open a ticket](#7)
> - [⁸ping the on-call](#8)
> - [⁹skip for now](#9)
> - [¹⁰rerun the pipeline](#10)
> - [¹¹diff the config](#11)

## Build

```bash
npm install
npm run build     # bundles the TUI extension into dist/
```

## TUI

```bash
pi -e /path/to/pi-snippet/dist/extension/pi-snippet-tui.js
```

Install it permanently with `pi install /path/to/pi-snippet/dist/extension/pi-snippet-tui.js`, or keep passing `-e` per run.

Suggestions render through pi's markdown transformer hook, which is **display-only**: stored messages keep their raw `<snippet>` tags, so a session stays readable by anything else that consumes the transcript.

- **Ctrl+click a chip** to insert it. The click is resolved by the terminal itself — the chip's href is a real `pisnip://` URL, and the desktop dispatches it back to the pi session that painted it. No terminal-wide mouse mode is ever engaged: the scroll wheel and text selection are never taken away. One-time setup: `/snippets` → *Register click handler* (Linux; needs a terminal that paints OSC 8 hyperlinks — Ghostty, kitty, WezTerm, …).
- **`Alt+N`** inserts the Nth suggestion of the most recent message — only that message is addressable, so a number never means two things. Ten digit keys address ten suggestions; **beyond ten**, hold Alt and type two digits (Alt held across `1` then `2` inserts the twelfth). A single digit commits immediately unless a longer number is still reachable, so the brief wait only exists on a message with ten or more suggestions. `Alt+0` still means the tenth. The cap is 99 — see below.
- **Trigger it while the model is still writing.** A chip goes live the moment its closing tag arrives, which is the moment it is painted: answer the question as it is asked, without waiting out the rest of the reply or the tool calls that follow it. A half-received suggestion is neither painted nor addressable, so `Alt+N` can never insert a partial sentence, and numbering never shifts as more suggestions stream in.
- **`/snippets`** chooses where chips come from — `off`, `tags only` (the tags the model writes itself), `tags + second model`, or `second model only`, which asks the primary model for nothing and leaves its system prompt untouched — toggles the `Alt` shortcuts, sets the second model by typing a `provider/id` (`/snippets model`), and registers or removes the click handler. The choices are remembered: they are written to `~/.pi/agent/pi-snippet.json`, beside pi's own `settings.json` (`PI_CODING_AGENT_DIR` moves it, `PI_SNIPPET_SETTINGS` overrides the filename outright), and read back at startup. `--no-suggestions` disables everything for one session without touching what is stored. Clicking itself has no toggle — it is always on, and the only thing that can make it inert is a terminal that cannot paint hyperlinks.

## How it works

| Piece | File | Role |
|---|---|---|
| Parser | `src/shared/suggestions.ts` | Pure function: raw assistant markdown → text/suggestion token stream. Holds every sanitization rule (code fences, inline code, unclosed and nested tags, blank-line spans, the 120-character length cap, the per-message cap) plus `visibleStreamingPrefix()`, so a partial tag is never painted mid-stream. Nodes carry offsets, which is what lets inferred anchors merge into the numbering. |
| Prompt snippet | `src/shared/prompt-snippet.ts` | The model-side contract: when to emit a tag, with worked good and bad examples. |
| Second-model contract | `src/shared/inferred.ts` | Pure: whether a message is worth a model call (`asksSomething` — a question mark outside code), the instruction sent to the second model, and validation of its reply — an anchor not verbatim in the message's non-code text is dropped, not repaired, and a tag echoing what layer 1 already painted drops too. |
| Second-model engine | `src/extension/infer.ts` | The call itself: fixed OpenRouter model (default `qwen/qwen3.7-flash`; `/snippets` text prompt and `PI_SNIPPET_MODEL` override), streamed via the provider's `streamSimple` with credentials fetched per call from the registry so each anchor becomes a chip as its closing tag arrives, cached by message text, stand-down after three consecutive failures. Every failure is silent. |
| Digit addressing | `src/shared/digit-chord.ts` | Pure rules for turning typed digits into a suggestion number. |
| TUI markdown | `src/shared/tui-markdown.ts` | `mergeSuggestions()` — the single source of truth for what a message's chips are and how they are numbered: layer-1 tags and layer-2 anchors merged into one document-ordered stream of `[¹text](chip:N)` nodes. The `chip:N` URL is inert and never navigated. |
| Extension | `src/extension/pi-snippet-tui.ts`, `common.ts` | Injects the prompt snippet, installs the markdown transformer, and wires up the `Alt+N` shortcuts and click handling. Injection goes through both the chained `systemPrompt` return (direct providers) and `systemPromptOptions.appendSystemPrompt` (bridges like pi-claude-bridge, which rebuild their own prompt and ignore the former). |
| Chip URLs | `src/shared/link-url.ts` | The `pisnip://<token>/<msg>/cN` URL a clickable chip carries: an index and a message key, never text. |
| OSC 8 detection | pi-tui's `getCapabilities().hyperlinks` | Asked of the renderer directly, so no URL is painted where pi-tui would print it in parentheses instead. |
| Click registration | `src/extension/link-install.ts` | Writes the `pisnip://` scheme handler (a `.desktop` entry plus a forwarder script) into the user's XDG dirs, proves it with a probe URL, and unregisters it cleanly — both `mimeapps.list` locations and the mimeinfo cache. |
| Click socket | `src/extension/link-server.ts` | The per-session unix socket the handler forwards clicks to, keyed by the session id so a resumed session rebinds the same path. |
| Settings | `src/extension/settings.ts` | The `/snippets` preferences in `~/.pi/agent/pi-snippet.json`, outside the session store: preferences about the tool, not state of one conversation. pi gives extensions no settings API — only session-scoped `appendEntry()` — so this follows the convention of pi's own `preset.ts` example and keeps a JSON file beside pi's. A missing or malformed file falls back to defaults, and a failed write is reported rather than silently promised. |

The parser is pure and the transformer is stateless: the set of addressable suggestions is derived in the message lifecycle handlers — `message_update` as the model writes, `message_end` when it stops, plus the second model's async results as they stream in — and kept outside the render path, which only ever *looks up* what was derived. Rendering runs on every stream tick and resize, so anything stateful built there would drift from what you see. The streaming path parses only on the ticks that actually carry a closing tag, and parses the same prefix the transformer paints, so what is addressable is exactly what is on screen.

Layer-2 chips appear after `message_end`, while the second model writes, and are session-ephemeral: the stored transcript keeps only the raw layer-1 tags and is never rewritten, so a resume repaints with layer-1 chips alone.

### Caps

`MAX_SUGGESTION_LENGTH` (120 characters) and `MAX_SUGGESTIONS_PER_MESSAGE` (99) are runaway guards, not style rules — 99 is simply what two-digit `Alt` addressing can reach. Over-cap suggestions degrade to plain text rather than disappearing. The second model has no cap of its own — more options are better than fewer; the 99 total per message across both layers is the only ceiling.

## Ground truth from a real terminal

One thing here cannot be honestly guessed: the bytes a terminal sends for a key gesture. It comes from Ghostty's own library (`libghostty-vt`, shipped with the Ghostty snap) rather than from a hand-written table.

```bash
bash scripts/ghostty-env.sh            # locate libghostty-vt, build the key-encoding helper
python3 scripts/chord-live.py          # Alt+digit gestures, keystrokes encoded by Ghostty
python3 scripts/osc8-probe.py ghostty  # what pi-tui paints for a chip URL: OSC 8, or the paren fallback
python3 scripts/link-register.py --probe  # scheme registration: a URL round-trips to a socket
python3 scripts/link-click-live.py     # link-mode click end to end: real pi, chip URL, insertion
```

A second harness, `npm run infer-sweep`, is unrelated to terminal ground truth but lives by the same rule: it scores the second model's task against real API responses rather than guessing which small models tag well. It sends the exact `INFER_SYSTEM_PROMPT` used in production to a curated list of OpenRouter models (8B–50B parameters, paid included) for a fixed set of sample messages, scores each reply with the real `extractAnchors` validator, and writes an HTML report (`scripts/.build/infer-sweep-report.html`) with the prompts, a per-model summary (copy fidelity, tag preservation, anchors accepted/dropped, failures, latency), and a per-sample detail grid. `npm run infer-sweep -- <model> <model>...` narrows it to a subset; needs `OPENROUTER_API_KEY`. Requests for a model's five samples run in parallel, with a shared concurrency cap across models. Two things it surfaced worth knowing before rerunning: OpenRouter's `:free` models share one account-wide quota (50 requests/day without added credits) that a 429 body names as `free-models-per-day`, and a reasoning model can spend its whole token budget on chain-of-thought before emitting content, which this harness reports as "empty reply" rather than a prompt failure.

Two findings worth keeping in mind:

- **The width table is gone with mouse mode.** It existed so click hit-testing could agree with the terminal about how many cells a glyph occupies; with terminal-resolved clicks the terminal does the hit-testing, and nothing here needs a width table anymore.
- **"Commit on Alt release" is not available in the terminal.** At the Kitty keyboard flags pi requests (7), Ghostty encodes a standalone Alt press or release as no bytes at all; modifier events need flag 8. The extension therefore settles a two-digit chord on a short timeout, and the release watcher stays dormant.

Support per terminal — gnome-terminal in particular — is in `docs/linux-terminals.md`; the measurements behind the click path are in `docs/terminal-resolved-clicks.md`.

## Tests

```bash
npm test          # unit and integration tests
npm run check     # tsc --noEmit
npm run test:e2e  # live, against a real model through pi RPC
```

The unit suite covers the parser edge-case matrix, the TUI transformer (including the layer-2 merge), digit addressing, the chip-URL contract, the second model's contract and engine — against fixed strings through a fake registry; no test makes a live model call — the click socket against a real `AF_UNIX` socket, and scheme registration/unregistration against a private XDG home — the uninstall removes the handler and desktop file, both `mimeapps.list` locations gio consults, the mimeinfo cache, and no one else's handler entries.

The e2e test spawns pi in RPC mode with the extension loaded, asks a question with two obvious answers, and asserts the model emits well-formed tags the parser accepts — and that a plain informational question draws none. Configure with `PI_SNIPPET_TEST_PROVIDER` and `PI_SNIPPET_TEST_MODEL` (defaults `claude-bridge` and `claude-haiku-4-5`).

## Known limits

- `pi -p` (print mode) with the claude-bridge provider hangs on this machine and has to be killed. RPC mode, which the e2e test uses, is unaffected.
- Not implemented from PRD Phase 3: surfacing suggestions in export/JSON modes.
- Clicking needs a terminal that paints OSC 8 hyperlinks and a registered handler; on anything else the chips are inert rather than falling back to another input mode. Per-terminal support: `docs/linux-terminals.md`.
- The second model needs OpenRouter auth configured in pi (`PI_SNIPPET_MODEL` points it elsewhere); without it, or if it errors, messages just get no layer-2 chips — nothing is reported, nothing blocks.
