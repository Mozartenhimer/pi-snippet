# Human generated content

**Currently linux only**

 The idea here is that the questionaire tools type things are too limited and rail roading. I've found myself copy and pasting content into my answer, and that's too much work. I'm extremely lazy.
 Why can't the LLM make that a bit easier by suggesting snippets that might be good replies? This is very much inspired by *Human Compatible* by Stuart Russell. 

So that's what this attempts to do.

An earlier version also had a web UI, but the best interface is the TUI for me at the moment. Mostly since it doesn't change my workflow now.

Below is what the machine created. Fable 5 did the initial design costing about 93 $ in credits, refinement with opus 5 and sonnet 5, and now glm 5.3-flash.

## Design history
Originally I tried having the TUI extension do mouse reporting, but that sacrificed scrollback and other terminal TUI functionality. Landing on markdown hyperlink rendering made me realize I could instead register an `xdg-open` handler, since my instinct already wanted to Ctrl+click links.

# pi-snippet
**Below is 99% clanker generated.**

Inline suggestion snippets for [pi](https://github.com/earendil-works/pi-mono). The model marks spans of its own prose as *suggested user replies* by wrapping them in `<snippet>…</snippet>`; the extension renders those spans in pi's terminal UI as clickable chips you can insert into the composer. Inserting never sends — you can edit the text, add to it, or ignore it.

What the model writes:

```
Want me to <snippet>rebuild the solution</snippet> or <snippet>run the tests</snippet>?
```

renders as

> Want me to [¹rebuild the solution](pisnip://…) or [²run the tests](pisnip://…)?

— link-styled text led by a small superscript number. The superscript is all a chip needs: `Alt+N` addresses it, and the URL behind it stays hidden whenever the terminal supports hyperlinks. On terminals that cannot paint a hyperlink the chip paints as a bare label — inert rather than falling back to some other input mode.

## Install

```bash
pi install /path/to/pi-snippet/src/extension/pi-snippet-tui.ts
```

or keep loading it per run with `pi -e /path/to/pi-snippet/src/extension/pi-snippet-tui.ts`.

## Using it

- **Ctrl+click a chip** to insert it. The click is resolved by the terminal itself — the chip's href is a real `pisnip://` URL, and the desktop dispatches it back to the pi session that painted it. No terminal-wide mouse mode is ever engaged: the scroll wheel and text selection are never taken away. One-time setup: `/snippets` → *Register click handler* (Linux; needs a terminal that paints OSC 8 hyperlinks — Ghostty, kitty, WezTerm, …).
- **`Alt+N`** inserts the Nth suggestion of the most recent message. Beyond ten, hold Alt and type two digits; `Alt+0` means the tenth. A chip goes live the moment its closing tag arrives, so you can answer while the model is still writing, and numbering never shifts as more suggestions stream in.
- **`/snippets`** chooses where chips come from — `off`, `tags only`, `tags + second model`, or `second model only` — and registers or removes the click handler. The choices are remembered in `~/.pi/agent/pi-snippet.json`. `--no-suggestions` disables everything for one session.

## Inferred chips: not Fully baked yet

Besides the tags the model writes itself, a second small model can read each finished message and add more tags. The mode exists and might work if you hold it right.

## How it works

The model wraps reply-shaped spans of its prose in `<snippet>` tags. The extension renders each tag as a hyperlink whose URL names a per-session unix socket; a registered desktop handler receives the terminal-resolved click and forwards it to that socket, which inserts the chip's text into the composer. Stored messages keep their raw tags — the rendering is display-only, so any other transcript consumer reads them unharmed.

## Roadmap

- **SSH.** Clicking works locally today; the goal is for it to work fully over SSH too, with the terminal resolving the click on the client. The design sketch is in `docs/ssh-back-handler.md`.

## Tests

```bash
npm test          # unit and integration tests
npm run check     # tsc --noEmit
npm run test:e2e  # live, against a real model through pi RPC
```

No test makes a live model call except the e2e, which spawns pi in RPC mode and asserts the model emits well-formed tags (configure with `PI_SNIPPET_TEST_PROVIDER` and `PI_SNIPPET_TEST_MODEL`).
