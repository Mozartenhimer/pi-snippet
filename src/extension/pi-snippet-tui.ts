/**
 * pi-snippet TUI extension: renders <snippet> suggested-reply spans in
 * pi's terminal UI.
 *
 * - Injects the suggested-replies prompt contract (guarded against double
 *   injection).
 * - Renders <snippet> spans as markdown links led by a small superscript
 *   number — `¹rebuild the solution` — via pi's markdown transformer hook.
 *   The hook is display-only: stored messages keep their raw tags, so
 *   sessions stay readable by any other transcript consumer.
 * - Ctrl+clicking a chip inserts it into the editor. The click is resolved by
 *   the terminal itself: the chip's href is a real `pisnip://` URL, the
 *   terminal dispatches it to a once-registered handler (`link-install.ts`),
 *   and the handler forwards to this process over a unix socket
 *   (`link-server.ts`). No terminal-wide mouse mode is ever engaged, so the
 *   wheel and text selection are never taken away. Where pi-tui reports the
 *   terminal cannot paint a hyperlink no URL is painted at all and clicking
 *   is inert — it never falls back to mouse reporting.
 * - Alt+N inserts the Nth suggestion of the most recent assistant message into
 *   the editor. A suggestion becomes addressable the moment its closing tag
 *   arrives, so a chip can be triggered while the model is still writing —
 *   no waiting out the rest of the answer. Holding Alt and typing two digits
 *   reaches 10 and above. Only the latest message is addressable, so a number
 *   never means two different things.
 * - `/snippets` chooses where chips come from — off, the primary model's own
 *   tags, a second model's, or both — toggles the hotkeys, and registers or
 *   removes the click handler; each choice is written to disk so it holds for
 *   the next session too. The `--no-suggestions` flag disables everything for
 *   one session without touching the stored preference.
 *
 * The transformer stays pure; the addressable set is derived in the message
 * lifecycle handlers (`message_update` while the model writes, `message_end`
 * when it stops) and held in extension state, never built during
 * transformation (PRD §5.2 hard rule).
 */
import { putBounded } from "../shared/bounded-map.js";
import { DigitChord } from "../shared/digit-chord.js";
import { asksSomething } from "../shared/inferred.js";
import { parseSuggestions, SNIPPET_TAG, visibleStreamingPrefix, MAX_SUGGESTIONS_PER_MESSAGE } from "../shared/suggestions.js";
import { mergeSuggestions, toTuiMarkdown } from "../shared/tui-markdown.js";
import {
	DEFAULT_INFER_MODEL,
	InferenceEngine,
	MODEL_ENV_VAR,
	modelCompletions,
	resolveInferenceModel,
	resolvePin,
	type PiModel,
} from "./infer.js";
import { registerPromptSnippet } from "./common.js";
import { loadSettings, saveSettings, settingsPath, SNIPPET_MODES, type SnippetMode } from "./settings.js";
import { LinkServer } from "./link-server.js";
import * as linkInstall from "./link-install.js";
import { getCapabilities } from "@earendil-works/pi-tui";
import { buildChipUrl, messageKey, sessionToken } from "../shared/link-url.js";
import { randomBytes } from "node:crypto";
import type { TuiLike } from "./tui.js";

interface TextBlock {
	type: string;
	text?: string;
}

/** What a closing tag starts with; `</snippet   >` is legal, so match the head. */
const CLOSE_TAG_PREFIX = `</${SNIPPET_TAG}`;

/**
 * Two tables for the same four modes, which is not an oversight: the picker has
 * a whole line per option and can afford to say what the mode does, while the
 * `/snippets` menu shows the current mode inside a line that already carries a
 * stat and a click status. One table would either truncate the explanation or
 * push the menu line past the terminal width.
 */
/** How the mode picker names each mode, and what the label promises. */
const MODE_LABEL: Record<SnippetMode, string> = {
	off: "off — no chips at all",
	tags: "tags only — chips from the tags the model writes itself",
	both: "tags + second model — also chips a second model infers",
	infer: "second model only — the primary model is never asked for tags",
};

/** The same four, short enough to sit in the `/snippets` menu line. */
const MODE_SUMMARY: Record<SnippetMode, string> = {
	off: "off",
	tags: "tags only",
	both: "tags + second model",
	infer: "second model only",
};

export default function piSnippetTui(pi: any): void {
	/**
	 * The stored preferences, read once at load. `state` starts from them and is
	 * written back on every `/snippets` toggle, so the two switches mean the
	 * same thing in the next session as in this one.
	 */
	const settingsFile = settingsPath();
	const stored = loadSettings(settingsFile);

	const state = {
		/**
		 * Which layers run: `off`, `tags` (layer 1 only), `both`, or `infer`
		 * (layer 2 only, so the primary model's prompt stays untouched). The
		 * gates below are the only readers; nothing else branches on it.
		 */
		mode: stored.mode,
		/**
		 * The second model, as chosen in `/snippets`. Undefined means the
		 * built-in default; `PI_SNIPPET_MODEL` overrides both for a session.
		 * Named `inferModel`, not `model` — that key belonged to the removed
		 * 2026 layer, and a stale pin from it must stay dead, not hijack this
		 * one.
		 */
		inferModel: stored.inferModel,
		hotkeysEnabled: stored.hotkeysEnabled,
		/**
		 * Suggestions of the most recent assistant message — the one streaming,
		 * once it has produced a complete suggestion of its own, otherwise the
		 * last one that finished. Includes the second model's chips once they
		 * have arrived.
		 */
		addressable: [] as string[],
	};

	/**
	 * The second model (shared/inferred.ts, extension/infer.ts): after an
	 * assistant message ends, a small fixed model re-emits it with `<snippet>`
	 * tags around the replies the primary model didn't tag. Its anchors live
	 * here — keyed by the stripped message text, appended as they stream in —
	 * and are merged into the chip numbering by `mergeSuggestions`, which is
	 * the one place that decides what a message's chips are. Nothing else in
	 * the UI knows or cares which layer painted a chip.
	 *
	 * Session-ephemeral by design: a restart loses the answers, and the stored
	 * transcript (raw tags only, never rewritten) repaints with layer-1 chips
	 * alone. Anchors are answers, not part of the message.
	 */
	const infer = new InferenceEngine(() => state.inferModel);
	/**
	 * Whether there is a second model to send anything to.
	 *
	 * The same resolution the engine itself does — env pin, stored pin, then
	 * the default, each refused outright rather than substituted when it has no
	 * auth — plus the failure breaker, so a layer that has given up for the
	 * session counts as unreachable too.
	 */
	const secondModelReachable = (ctx: any): boolean =>
		!infer.stoodDown &&
		resolveInferenceModel({ modelRegistry: ctx?.modelRegistry }, state.inferModel) !== undefined;
	const inferred = new Map<string, string[]>();
	const INFERRED_LIMIT = 64;
	/** Anchors inferred for a message so far, by its stripped text. */
	const inferredFor = (message?: { content?: TextBlock[] }): string[] => {
		if (!message) return [];
		return inferred.get(messageText(message)) ?? [];
	};
	/**
	 * The same anchors, indexed by the hash of every shape of the message the
	 * markdown transformer might be handed. pi renders an assistant message one
	 * text block at a time and trims each block before transforming it, so a
	 * lookup keyed only by the joined message text — or by the raw, untrimmed
	 * block — misses, and the second model's chips end up addressable but never
	 * painted. Written alongside `inferred` by `applyInferredAnchor`, read by
	 * the transformer, and as session-ephemeral as the answers themselves.
	 */
	const inferredByForm = new Map<string, string[]>();
	/**
	 * How many assistant messages have started this session. An inference
	 * result outlives the turn that asked for it; a callback arriving after a
	 * newer message began — or after `/tree` moved the branch — must not paint
	 * or address into the wrong message.
	 */
	let assistantSeq = 0;
	let latestAssistantSeq = 0;

	/**
	 * `--no-suggestions` is a session override, deliberately kept out of
	 * `state.enabled`: the stored preference is what the user chose in
	 * `/snippets`, and a session started with the flag must not overwrite it
	 * with `off` the next time any toggle is saved.
	 */
	let flagDisabled = false;
	/** Anything at all: chips painted, addressable, clickable. */
	const isEnabled = () => state.mode !== "off" && !flagDisabled;
	/** Layer 1: ask the primary model to tag its own replies. */
	const tagsOn = () => isEnabled() && state.mode !== "infer";
	/** Layer 2: hand finished messages to the second model. */
	const inferOn = () => isEnabled() && state.mode !== "tags";

	/**
	 * The footer's line about the second model, in the states it can honestly
	 * be in: not sent (the message on screen has not been handed to it — still
	 * streaming, or the gate said no), unavailable (there is nothing to hand it
	 * to), sent and waiting for its reply, failed (it was asked and the request
	 * died), and the report of what came back: how many new chips it added.
	 * Painted through `ctx.ui.setStatus` so the built-in footer carries it
	 * alongside pi's own lines — replacing the footer wholesale would drop
	 * those.
	 *
	 * "Unavailable" and "failed" are states of their own rather than more
	 * silence because all three look identical from the outside and mean
	 * different things: a session whose second model has no credentials, or
	 * whose provider is rate-limiting it, would otherwise report "not sent"
	 * after every question forever, which reads as a layer that is working and
	 * declining rather than one that never got an answer. The reason is still
	 * never shown — only that there wasn't one.
	 *
	 * A number means resolved: the count of chips that actually landed, which
	 * is a live count while the reply is still streaming in, and the final
	 * report once it settles — zero included, so a reply that validated to
	 * nothing (or failed) still reports rather than dangling on "waiting".
	 */
	type InferStatus = "off" | "idle" | "unavailable" | "failed" | "waiting" | number;
	let inferStatus: InferStatus = "off";
	let appliedChips = 0;
	let lastStatusCtx: any = null;

	const syncInferStatus = (ctx?: any): void => {
		const c = ctx ?? lastStatusCtx;
		if (!c) return;
		lastStatusCtx = c;
		if (c.mode !== "tui") return;
		if (!inferOn()) inferStatus = "off";
		let text: string | undefined;
		if (inferStatus === "idle") text = "snippet: not sent";
		else if (inferStatus === "unavailable") text = "snippet: second model unavailable";
		else if (inferStatus === "failed") text = "snippet: second model failed";
		else if (inferStatus === "waiting") text = "snippet: sent (waiting)";
		else if (typeof inferStatus === "number")
			text = `snippet: ${inferStatus} new chip${inferStatus === 1 ? "" : "s"}`;
		// Matches the rest of the footer, which pi dims wholesale (footer.js's own
		// theme.fg("dim", ...) calls) — without this, this one line is the only
		// undimmed text down there.
		c.ui?.setStatus?.("pi-snippet", text === undefined ? undefined : (c.ui.theme?.fg("dim", text) ?? text));
	};

	let tui: TuiLike | null = null;

	/**
	 * Names this session in every chip URL it paints, so a click dispatched by
	 * the desktop reaches the pi that painted it and no other. Random four
	 * bytes until `session_start` supplies the real session id (`sessionToken`
	 * below) — not to withstand an attacker who can already read the runtime
	 * directory, but so a resumed session rebinds the same socket path its own
	 * old scrollback already points to, rather than a fresh one nothing can
	 * reach.
	 */
	let linkToken = randomBytes(4).toString("hex");

	/**
	 * Clicking is always on, delivered by the terminal — the one delivery path
	 * since mouse reporting was removed. It is live when suggestions are on,
	 * the terminal can paint a hyperlink (OSC 8), and the desktop has a
	 * registered handler to dispatch to.
	 *
	 * The OSC 8 question is asked of pi-tui rather than answered here, because
	 * the renderer that would fall back to printing the href is pi-tui's own:
	 * disagree with it and every chip trails a visible
	 * `(pisnip://a1b2c3d4/ff2ee691/c1)`.
	 */
	/**
	 * An SSH session turns the delivery path inside out. The click is resolved
	 * by the terminal on the machine in front of the user, and the desktop
	 * there dispatches it to *its* handler — which has no socket for this
	 * session; the socket lives here. A chip URL painted by default over SSH
	 * is therefore a dead click that fails silently, which is the one outcome
	 * this layer refuses to dress up: without an explicit opt-in, SSH paints
	 * bare labels (Alt+N still works — it is in-band). The opt-in, "Remote
	 * clicking" in `/snippets`, is session state, not a persisted setting:
	 * the socket it forwards is named by *this* session's token, so a persisted
	 * yes would paint dead URLs into every future session that never set a
	 * forward up. The recipe it prints is the `ssh -L` unix-socket forward;
	 * `docs/ssh-back-handler.md` designs the zero-setup successor.
	 */
	const overSsh = (): boolean =>
		Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
	let remoteClicks = false;
	const linkOn = () =>
		isEnabled() && getCapabilities().hyperlinks && (!overSsh() || remoteClicks);

	/**
	 * What each rendered message's chips mean, keyed by a hash of the exact
	 * text they were painted from (`messageKey`).
	 *
	 * A URL has to carry the answer, because it can be clicked long after the
	 * message scrolled away — and resolving `c3` against whatever is
	 * addressable *now* would insert some other message's third suggestion,
	 * silently and wrongly. Bounded: old entries are worth keeping, but not
	 * without limit.
	 */
	const linkTargets = new Map<string, { chips: string[] }>();
	const LINK_TARGET_LIMIT = 64;
	const rememberLinkTargets = (text: string, chips: string[]): void => {
		if (text.length === 0) return;
		putBounded(linkTargets, messageKey(text), { chips }, LINK_TARGET_LIMIT);
	};

	/**
	 * Index a message the way the transformer will hash it.
	 *
	 * The transformer is handed either a whole message or a single text block
	 * depending on how the message was built, and while streaming it paints
	 * `visibleStreamingPrefix` of what has arrived — so every form it might
	 * hash is registered, each against the suggestions parsed from that same
	 * string. Registering the parse of the identical text is what keeps the
	 * numbering in the URL and the numbering on screen the same numbering.
	 */
	const indexMessageForLinks = (
		message: { content?: TextBlock[] } | undefined,
		opts?: { streaming?: boolean },
	): void => {
		if (!message || !Array.isArray(message.content)) return;
		const anchors = inferredFor(message);
		for (const form of messageForms(message, opts)) {
			if (form.length === 0) continue;
			const chips = mergeSuggestions(form, undefined, anchors).suggestions;
			if (chips.length > 0) rememberLinkTargets(form, chips);
		}
	};

	/**
	 * Every shape of a message the transformer may be handed, since pi renders
	 * an assistant message one text block at a time and trims each block before
	 * transforming it. Both the raw and the trimmed shape of every block — and
	 * of the joined message — are registered; a key derived only from the joined
	 * text would miss every per-block render, and one derived only from raw
	 * blocks would miss the trim.
	 */
	const messageForms = (
		message: { content?: TextBlock[] } | undefined,
		opts?: { streaming?: boolean },
	): string[] => {
		const forms: string[] = [];
		if (!message || !Array.isArray(message.content)) return forms;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const raw = block.text ?? "";
			// Both shapes, even though they are the same string for most blocks:
			// the caller hashes each form, and a duplicate hash costs one wasted
			// map write, while a missing one costs a chip that is addressable but
			// never painted. Cheap in the direction that fails safely.
			forms.push(raw, raw.trim());
			if (opts?.streaming) {
				forms.push(visibleStreamingPrefix(raw), visibleStreamingPrefix(raw.trim()));
			}
		}
		const whole = messageText(message);
		forms.push(whole, whole.trim());
		return forms;
	};

	/**
	 * Closing tags seen so far in the message now streaming — the gate described
	 * on `countCloseTags`. Reset per assistant message.
	 */
	let streamCloseTags = 0;

	const insertText = (ctx: any, text: string) => {
		const current: string = ctx.ui.getEditorText();
		const separator = current.length > 0 && !/\s$/.test(current) ? " " : "";
		ctx.ui.setEditorText(current + separator + text);
	};

	let lastCtx: any = null;

	/**
	 * The far end of a terminal-resolved click. Keyed by message, so a chip
	 * clicked in old scrollback still means what it meant.
	 */
	/** Set while an install probe is in flight; see `installClickHandler`. */
	let probeArrived: (() => void) | null = null;
	/**
	 * Set while the remote-clicking verify window is open: fired by any click
	 * that resolves, probe or real, because over SSH there is no local opener
	 * to fire a synthetic probe — the user's own Ctrl+click is the probe.
	 */
	let anyClickArrived: (() => void) | null = null;
	/** The message key a probe URL uses, which no real message can collide with. */
	const PROBE_KEY = "00000000";
	const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	const linkServer = new LinkServer({
		token: () => linkToken,
		resolve: (msg, index) => {
			anyClickArrived?.();
			if (msg === PROBE_KEY) {
				probeArrived?.();
				return undefined; // a probe proves the path; it inserts nothing
			}
			return linkTargets.get(msg)?.chips[index - 1];
		},
		onActivate: (text) => {
			if (!lastCtx) return;
			insertText(lastCtx, text);
			// A socket callback is even further outside pi's render pass than a
			// consumed keystroke: without this the text sits invisibly in the
			// editor until the next keypress.
			tui?.requestRender?.();
		},
	});

	/**
	 * Alt+digit addressing. One digit is one suggestion; holding Alt and typing
	 * two digits reaches 10 and up. A pending prefix shows in the status line
	 * and settles when Alt is released (in terminals that report releases) or
	 * when the chord times out.
	 */
	const chord = new DigitChord({
		onCommit: (value) => {
			const text = state.addressable[value - 1];
			if (text === undefined || !lastCtx) return;
			insertText(lastCtx, text);
			tui?.requestRender?.();
		},
		onReject: (digits) => {
			lastCtx?.ui?.notify?.(`No suggestion ${Number(digits)}`);
		},
		onPending: (digits) => {
			lastCtx?.ui?.setStatus?.(digits === "" ? "" : `Alt+${digits}…`);
			tui?.requestRender?.();
		},
	});

	/**
	 * Adopt a new addressable set, dropping a pending chord only when the
	 * numbers it was aimed at have actually changed. A message that streams its
	 * chips and then finalizes with the same ones must not cancel a two-digit
	 * gesture the user is mid-way through typing.
	 */
	const setAddressable = (next: string[]): void => {
		const changed =
			next.length !== state.addressable.length || next.some((t, i) => t !== state.addressable[i]);
		state.addressable = next;
		if (changed) chord.reset(); // digits typed against the old numbering mean nothing now
	};

	/**
	 * Watch for the Alt key being released so a two-digit chord settles the
	 * instant the user lets go, rather than waiting out the timeout.
	 *
	 * Dormant as things stand, and deliberately kept: a standalone modifier is
	 * only reported under the Kitty keyboard protocol's REPORT_ALL flag (8), and
	 * pi asks for flags 7 (disambiguate | report events | report alternates).
	 * Measured against Ghostty's own encoder — see scripts/ghostty-keys.c — Alt
	 * press and release encode to nothing at all at flag 7, and to
	 * `CSI 57443;1:3u` at flag 15. So today every terminal settles on the
	 * timeout, and this costs one regex per input chunk while a chord is
	 * pending. If pi ever raises its flags, the gesture gets crisper for free.
	 */
	const ALT_RELEASE = /\x1b\[(57443|57449)(?:;[0-9:]*)?:3u/;
	let releaseWatcher: (() => void) | null = null;
	const watchAltRelease = (instance: TuiLike) => {
		if (releaseWatcher) return;
		releaseWatcher = instance.addInputListener((data: string) => {
			if (chord.pending && ALT_RELEASE.test(data)) chord.release(state.addressable.length);
			return undefined;
		});
	};

	/**
	 * Borrow the TUI instance: the footer factory receives it, so install a
	 * do-nothing footer for a moment and immediately restore the default.
	 */
	const captureTui = (ctx: any): TuiLike | null => {
		if (tui || ctx.mode !== "tui") return tui;
		try {
			ctx.ui.setFooter((instance: TuiLike) => {
				tui = instance;
				return { render: () => [], invalidate: () => {} };
			});
		} finally {
			ctx.ui.setFooter(undefined);
		}
		return tui;
	};

	/**
	 * Say once, when it would actually help, that the handler is missing.
	 *
	 * A fresh install paints working hyperlinks that the desktop has nothing to
	 * dispatch to — Ctrl+click would do nothing, with no way to tell why. This
	 * is said at most once per session, and only when there is something to
	 * click, so it is a next step rather than a complaint.
	 */
	let unregisteredHintShown = false;
	const hintIfUnregistered = (ctx: any): void => {
		if (unregisteredHintShown || process.platform !== "linux") return;
		// Over SSH the desktop is on the client machine; "register the handler"
		// here would write into a desktop nobody is looking at.
		if (overSsh()) return;
		if (state.addressable.length === 0) return;
		if (linkInstall.isInstalled()) return;
		unregisteredHintShown = true;
		ctx.ui?.notify?.(
			"Ctrl+click needs a one-time handler registration — run /snippets and pick “Register click handler”",
		);
	};

	/**
	 * Point clicking at the one delivery path — terminal-resolved — and keep
	 * the socket listener alive only while it can matter.
	 *
	 * The link server is cheap enough to leave listening: it holds a socket,
	 * not a terminal mode, so unlike the old mouse reporting it does not need
	 * an "only while there are chips" gate. It is stopped when suggestions are
	 * off, the terminal cannot paint a hyperlink, or (over SSH) remote clicking
	 * is off — because then nothing can paint a URL that names it.
	 */
	const syncClicks = (ctx: any) => {
		lastCtx = ctx;
		const captured = captureTui(ctx);
		if (captured) watchAltRelease(captured);
		if (linkOn()) {
			if (!linkServer.listening) linkServer.start();
			hintIfUnregistered(ctx);
		} else if (linkServer.listening) {
			linkServer.stop();
		}
	};

	pi.registerFlag("no-suggestions", {
		description: "Disable inline suggestion snippets for this session",
		type: "boolean",
	});

	registerPromptSnippet(pi, () => {
		if (pi.getFlag("no-suggestions") === true) flagDisabled = true;
		// Layer 1 is the injection: in `infer` mode the primary model is never
		// told about the tag, and the second model does all the tagging.
		return tagsOn();
	});

	pi.registerMarkdownTransformer(
		(markdown: string, ctx: { messageType: string; isStreaming: boolean }) => {
			if (ctx.messageType !== "assistant") return markdown;
			return toTuiMarkdown(markdown, {
				isStreaming: ctx.isStreaming,
				enabled: isEnabled(),
				linkToken: linkOn() ? linkToken : undefined,
				// The second model's anchors, keyed by the exact text the
				// transformer was handed — the same deterministic key the click
				// targets use. A lookup, never a build: the anchors were derived
				// in the message lifecycle handlers (PRD §5.2) and indexed per
				// form by `applyInferredAnchor`.
				inferred: isEnabled() ? inferredByForm.get(messageKey(markdown)) : undefined,
			});
		},
	);

	/**
	 * The suggestions of a message, in document order.
	 *
	 * `streaming` cuts each text block down to the prefix the transformer is
	 * actually painting (`visibleStreamingPrefix`) before parsing, so the
	 * addressable set is exactly the chips on screen. A `<snippet>` whose
	 * closing tag has not arrived yet is neither painted nor counted, which is
	 * what keeps Alt+N from ever inserting half a sentence.
	 */
	const suggestionsFromMessage = (
		message?: { role?: string; content?: TextBlock[] },
		opts?: { streaming?: boolean },
	): string[] => {
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
		const anchors = inferredFor(message);
		if (opts?.streaming) {
			const suggestions: string[] = [];
			for (const block of message.content) {
				if (block.type !== "text") continue;
				const raw = block.text ?? "";
				const text = visibleStreamingPrefix(raw);
				const res = mergeSuggestions(text, { acceptedSoFar: suggestions.length }, anchors);
				suggestions.push(...res.suggestions);
			}
			return suggestions;
		}
		return mergeSuggestions(messageText(message), undefined, anchors).suggestions;
	};

	/** The message text, in document order. */
	const messageText = (message?: { content?: TextBlock[] }): string => {
		if (!message || !Array.isArray(message.content)) return "";
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
	};

	/**
	 * Cheap gate for the streaming path: `message_update` fires per token, and
	 * a suggestion can only become addressable when a closing tag lands, so the
	 * parser runs only on the ticks that actually carry one. Deliberately
	 * sloppier than the parser (it counts tags in code fences too) — it decides
	 * whether to re-parse, never what is addressable.
	 */
	const countCloseTags = (message: { content?: TextBlock[] }): number => {
		if (!Array.isArray(message.content)) return 0;
		let count = 0;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const text = block.text ?? "";
			for (
				let i = text.indexOf(CLOSE_TAG_PREFIX);
				i !== -1;
				i = text.indexOf(CLOSE_TAG_PREFIX, i + 1)
			) {
				count++;
			}
		}
		return count;
	};

	/**
	 * Recompute the addressable set from wherever the active leaf currently is.
	 * Needed in two situations where `message_end` never fires for the message
	 * now at the tip of the branch:
	 *
	 * - A fork/clone/resume rebinds the extension with a blank `state`, but the
	 *   transcript it lands on may still end on a message with suggestion chips
	 *   — the transformer renders them from stored markdown regardless.
	 * - `/tree` navigation moves the active leaf to an earlier point in the
	 *   *same* session without reloading the extension at all, so a stale
	 *   `state.addressable` from whatever the leaf was before keeps hanging
	 *   around — chips render (transformer is display-only) but Alt+N/click
	 *   silently do nothing, or worse, address the wrong message's chips.
	 */
	const hydrateFromBranch = (ctx: any) => {
		state.addressable = [];
		if (!isEnabled()) return;
		const branch = ctx.sessionManager.getBranch();
		// Two passes over the same array on purpose, because they answer
		// different questions: *every* assistant message has to be re-indexed for
		// clicking, while only the last one decides what Alt+N addresses. Folding
		// them together would mean either indexing only the tip (a click on older
		// scrollback then resolves against an empty map) or letting an older
		// message's chips win the numbering.
		//
		// Every assistant message in the branch gets repainted through the
		// transformer on resume/fork/reload, each with the URL it had before —
		// messageKey and (as of the session-id token) linkToken are both
		// deterministic. `linkTargets` has to be rebuilt for all of them, not
		// just the tip, or a click on a chip anywhere but the last message
		// resolves against an empty map and silently does nothing.
		for (const entry of branch) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				indexMessageForLinks(entry.message);
			}
		}
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			if (entry.message.role === "assistant") {
				state.addressable = suggestionsFromMessage(entry.message);
			}
			break;
		}
	};

	pi.on("session_start", (event: { reason?: string }, ctx: any) => {
		// Nothing on screen has been sent anywhere yet; the first assistant
		// message flips this to "not sent" while it streams.
		inferStatus = "off";
		appliedChips = 0;
		syncInferStatus(ctx);
		// Falls back to the random token from setup if the session has no id
		// (a trust-limited or otherwise degraded ctx); a socket that dies with
		// the process is the same behavior this extension always had.
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			if (id) linkToken = sessionToken(id);
		} catch {
			/* keep the random fallback */
		}
		// "startup" is a real restart too: `pi --session <file>` fires it, not
		// "resume" — that reason is only for /resume inside a running process.
		// A restart that skips hydration leaves linkTargets empty, so the chip
		// URLs the transcript is repainted with resolve to nothing.
		// A fresh session re-arms the second model: the failure breaker exists
		// to stop a dead credential firing per message, not to outlive a fix.
		infer.rearm();
		if (
			event.reason === "startup" ||
			event.reason === "resume" ||
			event.reason === "fork" ||
			event.reason === "reload"
		) {
			hydrateFromBranch(ctx);
		} else {
			state.addressable = [];
		}
		syncClicks(ctx);
	});

	pi.on("session_tree", (_event: unknown, ctx: any) => {
		// Pending inference callbacks address the message that asked for them;
		// once the branch moves, no live message owns the numbering, so the
		// sequence must move past anything in flight.
		assistantSeq++;
		latestAssistantSeq = assistantSeq;
		hydrateFromBranch(ctx);
		streamCloseTags = 0;
		chord.reset();
		syncClicks(ctx);
	});

	pi.on("session_shutdown", () => {
		chord.reset();
		releaseWatcher?.();
		releaseWatcher = null;
		linkServer.stop();
	});

	pi.on("message_start", (event: { message?: { role?: string } }, ctx: any) => {
		if (event.message?.role !== "assistant") return;
		streamCloseTags = 0;
		appliedChips = 0;
		inferStatus = inferOn() ? "idle" : "off";
		assistantSeq++;
		latestAssistantSeq = assistantSeq;
		syncInferStatus(ctx);
	});

	/**
	 * Make a suggestion addressable as soon as it is complete, without waiting
	 * for the message to finish. The model often asks its question and then
	 * keeps writing (or calls a tool) for a while; making the user wait out
	 * that tail before Alt+N or a click does anything is the whole point of
	 * this handler.
	 *
	 * The set only ever grows within a message — a chip is accepted once its
	 * closing tag has arrived, and later text cannot un-accept it — so numbering
	 * never shifts under the user's fingers.
	 *
	 * The previous message's chips stay addressable until this one produces a
	 * chip of its own: the handover happens on the first complete suggestion,
	 * not at `message_start`, so a long tool-calling turn doesn't strip the
	 * chips still on screen above it.
	 */
	/**
	 * Send a finished assistant message to the second model.
	 *
	 * The message goes as stored, layer-1 tags included: the second model sees
	 * what is already covered and is asked to add more, not to repeat it — and
	 * anything it echoes anyway is dropped at validation time. The gate is the
	 * old one: a message that asks nothing pays nothing. Every failure inside
	 * is silent.
	 */
	const queueInference = (message: { role?: string; content?: TextBlock[] }, ctx: any): void => {
		if (!inferOn()) return;
		if (!secondModelReachable(ctx)) {
			// Checked before the gate, not after: this is a condition of the
			// session rather than of the message, and the user needs to see it
			// whether or not this particular message would have been worth a call.
			inferStatus = "unavailable";
			syncInferStatus(ctx);
			return;
		}
		const raw = messageText(message);
		if (!asksSomething(raw)) return;
		const existing = parseSuggestions(raw).suggestions;
		const seq = latestAssistantSeq;
		inferStatus = "waiting";
		syncInferStatus(ctx);
		const settleInferStatus = (result: string[] | null) => {
			// A newer message owns the footer now; this reply's report would
			// overwrite its "not sent" / "waiting" with a stale count.
			if (seq !== latestAssistantSeq) return;
			// null means no answer arrived. A zero report would claim one did;
			// "not sent" would claim the layer chose not to ask, when it asked
			// and got nothing back. Once the breaker has tripped the honest
			// line is that there is nothing left to ask.
			if (result === null) {
				inferStatus = secondModelReachable(ctx) ? "failed" : "unavailable";
			} else if (inferStatus === "waiting") {
				inferStatus = appliedChips;
			}
			syncInferStatus();
		};
		void infer
			.infer(
				raw,
				{ modelRegistry: ctx.modelRegistry, signal: ctx.signal },
				existing,
				(anchor) => {
					applyInferredAnchor(seq, message, raw, anchor, ctx);
				},
			)
			.then(settleInferStatus, settleInferStatus)
			.catch(() => {
				/* the engine resolves to [] on failure; a floating rejection
				   must never crash the session either */
			});
	};

	/**
	 * Paint one freshly streamed-in anchor: register it under the message's
	 * key, extend the addressable set, and force a repaint — this runs outside
	 * pi's render pass, where nothing repaints by itself.
	 */
	const applyInferredAnchor = (
		seq: number,
		message: { role?: string; content?: TextBlock[] },
		raw: string,
		anchor: string,
		ctx: any,
	): void => {
		if (!isEnabled()) return;
		const known = inferred.get(raw) ?? [];
		if (known.includes(anchor)) return;
		if (seq !== latestAssistantSeq) return; // a newer message owns the numbering now
		// Keep two-digit addressing meaningful: layer 1 has first claim on the
		// numbers, and the runaway guard caps what the keyboard can reach.
		const layer1 = parseSuggestions(messageText(message)).suggestions.length;
		if (layer1 + known.length >= MAX_SUGGESTIONS_PER_MESSAGE) return;
		const next = [...known, anchor];
		putBounded(inferred, raw, next, INFERRED_LIMIT);
		// Index the answer under every form of the message the transformer can
		// be handed (a trimmed block among them) — without this the chips stay
		// addressable but never paint. Deliberately a second map rather than a
		// lookup through the first: `inferred` is keyed by the message text the
		// second model was asked about, which is what the engine's cache and the
		// sequence checks above are keyed by too, while this one is keyed by the
		// hash of whatever fragment the transformer happens to be handed. One map
		// cannot be both without the transformer having to guess which shape of
		// the message it is looking at.
		for (const form of messageForms(message)) {
			if (form.length === 0) continue;
			putBounded(inferredByForm, messageKey(form), next, INFERRED_LIMIT);
		}
		indexMessageForLinks(message);
		setAddressable(suggestionsFromMessage(message));
		syncClicks(ctx);
		appliedChips++;
		inferStatus = appliedChips;
		syncInferStatus(ctx);
		// The transformer runs inside pi-tui's render, and a finished message's
		// Markdown component caches its output on (text, width) — neither of
		// which has changed. A plain requestRender would re-run the render loop
		// straight into those caches, and the new chip would stay invisible
		// until something else happened to repaint; the components must be
		// invalidated so the transformer is asked again. (A layer-1 chip never
		// needs this: pi rebuilds the message component on every message_update
		// while streaming.)
		tui?.invalidate?.();
		tui?.requestRender?.(true);
	};

	pi.on("message_update", (event: { message?: { role?: string; content?: TextBlock[] } }, ctx: any) => {
		if (!event.message || event.message.role !== "assistant" || !isEnabled()) return;
		const closeTags = countCloseTags(event.message);
		if (closeTags === streamCloseTags) return; // nothing newly closed
		streamCloseTags = closeTags;
		const suggestions = suggestionsFromMessage(event.message, { streaming: true });
		if (suggestions.length === 0) return; // a close tag that resolved to plain text
		setAddressable(suggestions);
		indexMessageForLinks(event.message, { streaming: true });
		syncClicks(ctx);
	});

	pi.on("message_end", (event: { message?: { role?: string; content?: TextBlock[] } }, ctx: any) => {
		if (!event.message || event.message.role !== "assistant" || !isEnabled()) return;
		setAddressable(suggestionsFromMessage(event.message));
		indexMessageForLinks(event.message);
		streamCloseTags = 0;
		syncClicks(ctx);
		queueInference(event.message, ctx);
	});

	// pi's /hotkeys table gives every registerShortcut call its own row (no
	// "hidden" option exists, and there's no unregister), and all ten digits
	// must be bound for the chord in digit-chord.ts to see every keystroke —
	// so ten rows are unavoidable. Only one needs the full explanation.
	for (let n = 0; n <= 9; n++) {
		const suggestion = n === 0 ? 10 : n;
		pi.registerShortcut(`alt+${n}`, {
			description:
				n === 1
					? "Insert suggestion 1 (hold Alt and type two digits for 10+, e.g. Alt+1 Alt+0)"
					: `Insert suggestion ${suggestion}`,
			handler: (ctx: any) => {
				if (!isEnabled() || !state.hotkeysEnabled || !ctx.hasUI) return;
				lastCtx = ctx;
				chord.press(n, state.addressable.length);
			},
		});
	}

	/** Emission stats for the current branch: how often the model actually offers suggestions. */
	const snippetStats = (ctx: any): string => {
		let messages = 0;
		let messagesWithSuggestions = 0;
		let totalSuggestions = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			messages++;
			const count = suggestionsFromMessage(entry.message).length;
			if (count > 0) messagesWithSuggestions++;
			totalSuggestions += count;
		}
		if (messages === 0) return "Inline suggestions (no assistant messages yet)";
		const pct = Math.round((messagesWithSuggestions / messages) * 100);
		return `Inline suggestions — ${messagesWithSuggestions}/${messages} messages had suggestions (${pct}%), ${totalSuggestions} total`;
	};

	/**
	 * How Ctrl+click stands right now — what the menu header reports, so the
	 * state that used to be a toggle stays visible without being one.
	 */
	const clickStatusLabel = (): string => {
		if (process.platform !== "linux") return "Ctrl+click: unavailable off Linux";
		if (overSsh() && !remoteClicks)
			return "Ctrl+click: over SSH — the click resolves on your machine, not this one; enable remote clicking below";
		if (!getCapabilities().hyperlinks) {
			return "Ctrl+click: inert — this terminal paints no hyperlinks (see docs/linux-terminals.md)";
		}
		if (overSsh()) return "Ctrl+click: remote — chips are clickable through the ssh socket forward";
		if (!linkInstall.isInstalled()) return "Ctrl+click: handler not registered";
		return "Ctrl+click: on";
	};

	/**
	 * Register `pisnip://` with the desktop, then prove it round-trips.
	 *
	 * Registration that is not proven is a guess, so Ctrl+click is only offered
	 * as working after a real URL has travelled the whole path — opener,
	 * handler, socket — and arrived here. The failure message names the step
	 * that broke rather than saying it did not work.
	 */
	const installClickHandler = async (ctx: any): Promise<void> => {
		if (process.platform !== "linux") {
			ctx.ui.notify("Terminal-resolved clicking is Linux-only for now", "warning");
			return;
		}
		if (overSsh()) {
			ctx.ui.notify(
				"Over SSH the desktop is on the machine in front of you — register the handler there. "
					+ "Here, use “Remote clicking” instead.",
				"warning",
			);
			return;
		}
		const result = linkInstall.install();
		for (const warning of result.warnings) ctx.ui.notify(warning, "warning");

		// Probe against the live server, so what is tested is the real socket.
		const started = linkServer.listening ? linkServer.socketPath : linkServer.start();
		if (!started) {
			ctx.ui.notify("Could not open a socket to receive clicks on", "warning");
			return;
		}
		let arrived = false;
		const previous = probeArrived;
		probeArrived = () => {
			arrived = true;
		};
		try {
			const url = buildChipUrl(linkToken, PROBE_KEY, 1);
			const outcome = await linkInstall.probe(url, async () => {
				// The dispatch is asynchronous all the way through: opener,
				// handler process, connect. Give it a moment before judging.
				for (let i = 0; i < 20 && !arrived; i++) await delay(100);
				return arrived;
			});
			if (outcome.opener) {
				ctx.ui.notify(
					`Click handler installed and verified via ${outcome.opener}. ` +
						`Ctrl+click a chip to insert it — no mouse mode${persist()}`,
				);
			} else {
				ctx.ui.notify(
					`Registered, but no opener completed the round trip (${outcome.tried.join(", ")}). ` +
						"Ctrl+click will not reach pi until that works.",
					"warning",
				);
			}
		} finally {
			probeArrived = previous;
		}
		syncClicks(ctx);
	};

	/**
	 * Remote clicking over SSH, on and off.
	 *
	 * Turning it on paints chip URLs again (this session only) and prints the
	 * one thing the user cannot derive from here: the `ssh -L` argument that
	 * carries this session's socket across the wire, with the local side
	 * written as `$(id -u)` so it expands in *their* shell on the client
	 * machine, where the handler looks for it. The remote side is the path the
	 * listener actually bound — not a path computed from the same rules, which
	 * is exactly the disagreement a confined snap can introduce (see
	 * `link-server.ts`).
	 *
	 * Every invocation while on ends in a verify window: over SSH there is no
	 * local opener to fire a synthetic probe, so the user's own Ctrl+click is
	 * the probe, and the first enable cannot pass it (the forward does not
	 * exist until they reconnect). The verdict is honest about that — "no click
	 * yet" is the expected first-run answer, not a failure to retry blindly.
	 */
	const toggleRemoteClicking = async (ctx: any): Promise<void> => {
		if (remoteClicks) {
			remoteClicks = false;
			syncClicks(ctx);
			ctx.ui.notify("Remote clicking off — chips paint as plain labels again");
			return;
		}
		remoteClicks = true;
		syncClicks(ctx); // starts the listener: the far end of the forward
		const started = linkServer.listening ? linkServer.socketPath : linkServer.start();
		if (!started) {
			remoteClicks = false;
			syncClicks(ctx);
			ctx.ui.notify("Could not open a socket to forward", "warning");
			return;
		}
		// The verify window opens here, not after the recipe below: the socket
		// exists from this moment, and a click that lands while the toasts
		// settle must still count.
		let arrived = false;
		const previous = anyClickArrived;
		anyClickArrived = () => {
			arrived = true;
		};
		// The recipe goes in the composer, not a toast: it is something the user
		// must copy to another machine verbatim, and toasts clip at the terminal
		// width and coalesce when fired within a render tick — both measured
		// live, and either would silently truncate the one line that matters.
		// The editor already has the precedent (`/snippets model` prefills it)
		// and one more property toasts lack: the text survives reading it.
		ctx.ui.setEditorText(
			`mkdir -p /tmp/pi-snippet-$(id -u) && ssh -L /tmp/pi-snippet-$(id -u)/${linkToken}.sock:${started} <host>`,
		);
		tui?.requestRender?.();
		ctx.ui.notify("Remote clicking on — the ssh command is in the editor. Reconnect with it, then resume (pi --continue).");
		// A beat apart, or the toast coalescing above eats the first one.
		await delay(1200);
		ctx.ui.notify("Once, on your machine: pi /snippets → “Register click handler”.");
		try {
			for (let i = 0; i < 100 && !arrived; i++) await delay(100);
		} finally {
			anyClickArrived = previous;
		}
		if (arrived) {
			ctx.ui.notify("Verified: a click made the whole trip — desktop, handler, forward, this session.");
		} else {
			ctx.ui.notify(
				"No click yet — expected until you reconnect. Then pick this again to verify.",
				"warning",
			);
		}
	};

	/**
	 * Write the preferences back to disk. A failure — read-only home, a full
	 * disk — is not worth interrupting anyone over, but it does change what the
	 * toggle means, so the notification says so instead of promising a
	 * persistence that did not happen.
	 */
	const persist = (): string => {
		// The three persisted fields, passed straight from state: `saveSettings`
		// is what decides the file's shape (it drops an undefined `inferModel`
		// rather than writing a null), so spelling the same normalization out
		// here again would just be a second place to keep it in step.
		const ok = saveSettings(
			{
				mode: state.mode,
				hotkeysEnabled: state.hotkeysEnabled,
				inferModel: state.inferModel,
			},
			settingsFile,
		);
		return ok ? "" : " (this session only — could not write the settings file)";
	};

	/**
	 * The model the second layer would use right now, for the menu to show:
	 * the stored choice, else the session's environment override, else the
	 * built-in default.
	 */
	const effectiveModel = (): { id: string; fromEnv: boolean } => {
		if (process.env[MODEL_ENV_VAR]) return { id: process.env[MODEL_ENV_VAR]!, fromEnv: true };
		return { id: state.inferModel ?? DEFAULT_INFER_MODEL, fromEnv: false };
	};

	/**
	 * Apply a `provider/id` pin: empty resets to the default, anything else is
	 * validated against the registry before it is stored, because the engine
	 * falls through to the default on an unknown pin — a typo must cost a
	 * warning, not layer 2 quietly going silent. Shared by `/snippets model`'s
	 * handler and the RPC/print-mode fallback in `pickModel`.
	 */
	const applyModelPin = async (pin: string, ctx: any): Promise<void> => {
		if (pin === "") {
			if (!state.inferModel) {
				ctx.ui.notify(`Second model is already the default (${effectiveModel().id})`);
				return;
			}
			state.inferModel = undefined;
			infer.rearm(); // a dead credential on the old model says nothing about the default
			ctx.ui.notify(`Second model reset to the default${persist()}`);
			return;
		}
		const available: PiModel[] = ctx.modelRegistry?.getAvailable?.() ?? [];
		if (available.length > 0 && !resolvePin(pin, available)) {
			ctx.ui.notify(`No model "${pin}" in the registry — nothing changed`, "warning");
			return;
		}
		if (pin === state.inferModel) return;
		state.inferModel = pin;
		infer.rearm();
		ctx.ui.notify(`Second model set to ${pin}${persist()}`);
	};

	/**
	 * Pick which layers run.
	 *
	 * Four options rather than a toggle and a sub-toggle, because the two
	 * layers are independent and each costs something different: layer 1 costs
	 * a system-prompt injection, layer 2 costs a request per question-bearing
	 * message. A second `select` rather than four entries in the first one —
	 * they are one choice, and cycling blind through four states on a single
	 * "toggle" entry is worse than being shown them.
	 */
	const pickMode = async (ctx: any): Promise<void> => {
		// Parenthetical, not another em dash: every label already has one.
		const options = SNIPPET_MODES.map(
			(mode) => `${MODE_LABEL[mode]}${mode === state.mode ? " (current)" : ""}`,
		);
		const choice = await ctx.ui.select("Where chips come from", options);
		if (!choice) return;
		const picked = SNIPPET_MODES.find((mode) => choice.startsWith(MODE_LABEL[mode]));
		if (picked === undefined || picked === state.mode) return;
		state.mode = picked;
		if (!isEnabled()) state.addressable = [];
		// Turning the layer back on is an explicit ask; a breaker tripped by a
		// credential that may since have been fixed must not outlive it.
		if (inferOn()) infer.rearm();
		syncInferStatus(ctx);
		syncClicks(ctx);
		ctx.ui.notify(`Suggestions: ${MODE_SUMMARY[picked]}${persist()}`);
	};

	/**
	 * Pick the second model.
	 *
	 * In the TUI this prefills `/snippets model <current pin>` in the composer
	 * and hands focus back, rather than opening a blocking dialog: `ui.input()`
	 * has no autocomplete (`ExtensionUIDialogOptions` offers a timeout and an
	 * abort signal, nothing else), and only a slash command's own
	 * `getArgumentCompletions` gets pi's tab-completing dropdown — the same one
	 * `/model` uses. Elsewhere (RPC, print) there is no composer to prefill, so
	 * this keeps the old typed prompt, which is also what scripted callers
	 * (`docs/rpc.md`) already drive.
	 */
	const pickModel = async (ctx: any): Promise<void> => {
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(`/snippets model ${state.inferModel ?? ""}`);
			ctx.ui.notify("Tab-completes provider/id — leave it empty and press Enter to reset to the default");
			tui?.requestRender?.();
			return;
		}
		const current = effectiveModel();
		const entry = await ctx.ui.input(
			`Second model (tags the primary model didn't add) — currently ${current.id}${current.fromEnv ? " (PI_SNIPPET_MODEL override)" : ""}`,
			"provider/id — leave empty to reset to the default",
		);
		if (entry === undefined) return; // cancelled
		await applyModelPin(entry.trim(), ctx);
	};

	pi.registerCommand("snippets", {
		description:
			"Toggle inline suggestions or their shortcuts; register or remove the click handler; `model` sets the second model",
		/**
		 * Only the `model` subcommand tab-completes, folded in from the former
		 * standalone `/snippet-model` — two top-level commands for one feature
		 * was the annoyance being fixed. Per `CombinedAutocompleteProvider`
		 * (`pi-tui`'s `autocomplete.js`), `prefix` here is everything typed after
		 * `/snippets ` and a returned `value` replaces that whole span, which is
		 * why completions below are prefixed back with `model `. `lastCtx` rather
		 * than a ctx argument for the same reason `/model`'s own completions work
		 * this way (see interactive-mode.js): `getArgumentCompletions` gets only
		 * the typed prefix. `syncClicks` sets `lastCtx` on `session_start`, before
		 * a user could type anything, so a registry is always there by the time
		 * completion runs.
		 */
		getArgumentCompletions: (prefix: string) => {
			const spaceIdx = prefix.indexOf(" ");
			if (spaceIdx === -1) {
				if (prefix !== "" && !"model".startsWith(prefix)) return null;
				return [{ value: "model ", label: "model", description: "Set the second model" }];
			}
			if (prefix.slice(0, spaceIdx) !== "model") return null;
			const available: PiModel[] = lastCtx?.modelRegistry?.getAvailable?.() ?? [];
			if (available.length === 0) return null;
			const items = modelCompletions(prefix.slice(spaceIdx + 1), available);
			return items.length > 0 ? items.map((item) => ({ ...item, value: `model ${item.value}` })) : null;
		},
		handler: async (args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const trimmed = args.trim();
			if (trimmed === "model" || trimmed.startsWith("model ")) {
				await applyModelPin(trimmed.slice("model".length).trim(), ctx);
				return;
			}
			if (flagDisabled) {
				ctx.ui.notify("Inline suggestions are off for this session (--no-suggestions)");
				return;
			}
			// At most one click row, chosen three ways. Over SSH the desktop that
			// would dispatch a click is the user's own machine, so the only thing
			// this session can offer is the socket forward; off Linux there is no
			// handler to register at all; otherwise it is register-or-remove —
			// one condition, not the two inverted copies of it this used to ask.
			const clickRows = overSsh()
				? [
						`Remote clicking: ${remoteClicks ? "on" : "off"} — ${
							remoteClicks
								? "print the forward line again and verify a click"
								: "make Ctrl+click work over SSH (forwards this session's socket)"
						}`,
					]
				: process.platform !== "linux"
					? []
					: linkInstall.isInstalled()
						? ["Remove click handler — unregister pisnip:// from the desktop"]
						: ["Register click handler — one-time desktop setup, needed before Ctrl+click works"];
			const model = effectiveModel();
			const choice = await ctx.ui.select(
				`${snippetStats(ctx)} — ${clickStatusLabel()}`,
				[
					`Suggestions: ${MODE_SUMMARY[state.mode]} — change`,
					`Alt+digit shortcuts: ${state.hotkeysEnabled ? "on" : "off"} — toggle`,
					`Second model: ${model.id}${model.fromEnv ? " (PI_SNIPPET_MODEL override)" : ""} — change`,
					...clickRows,
				],
			);
			if (!choice) return;
			if (choice.startsWith("Suggestions:")) {
				await pickMode(ctx);
			} else if (choice.startsWith("Second model:")) {
				await pickModel(ctx);
			} else if (choice.startsWith("Remote clicking:")) {
				await toggleRemoteClicking(ctx);
			} else if (choice.startsWith("Register click handler")) {
				await installClickHandler(ctx);
			} else if (choice.startsWith("Remove click handler")) {
				const result = linkInstall.uninstall();
				const detail =
					result.removed.length > 0 ? ` (${result.removed.length} files cleaned)` : "";
				if (result.clean) {
					ctx.ui.notify(`pisnip:// unregistered${detail}${persist()}`);
				} else {
					for (const warning of result.warnings) ctx.ui.notify(warning, "warning");
					ctx.ui.notify(
						`pisnip:// unregistered, but not cleanly${detail}. If Ctrl+click still opens ` +
							"the old handler, restart the terminal or run " +
							"`systemctl --user restart xdg-desktop-portal` — desktop daemons cache " +
							`the handler until then${persist()}`,
						"warning",
					);
				}
			} else {
				state.hotkeysEnabled = !state.hotkeysEnabled;
				ctx.ui.notify(
					`Suggestion shortcuts ${state.hotkeysEnabled ? "enabled" : "disabled"}${persist()}`,
				);
			}
			syncClicks(ctx);
		},
	});
}
