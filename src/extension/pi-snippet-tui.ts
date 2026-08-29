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
 * - Clicking a chip inserts it into the editor. Mouse reporting is
 *   terminal-wide (the wheel stops scrolling the terminal and text selection
 *   needs Shift), so it is engaged only while the latest message actually has
 *   suggestions, and can be toggled off in `/snippets`.
 * - Alt+N inserts the Nth suggestion of the most recent assistant message into
 *   the editor. A suggestion becomes addressable the moment its closing tag
 *   arrives, so a chip can be triggered while the model is still writing —
 *   no waiting out the rest of the answer. Holding Alt and typing two digits
 *   reaches 10 and above. Only the latest message is addressable, so a number
 *   never means two different things.
 * - `/snippets` toggles the feature, the hotkeys, or click-to-insert, and each
 *   choice is written to disk so it holds for the next session too; the
 *   `--no-suggestions` flag disables everything for one session without
 *   touching the stored preference.
 *
 * The transformer stays pure; the addressable set is derived in the message
 * lifecycle handlers (`message_update` while the model writes, `message_end`
 * when it stops) and held in extension state, never built during
 * transformation (PRD §5.2 hard rule).
 */
import { asksSomething, type InferredSuggestion } from "../shared/inferred.js";
import { DigitChord } from "../shared/digit-chord.js";
import { parseSuggestions, SNIPPET_TAG, visibleStreamingPrefix } from "../shared/suggestions.js";
import { chipLabel, toTuiMarkdown } from "../shared/tui-markdown.js";
import { registerPromptSnippet } from "./common.js";
import { inferenceCandidates, MagicInferrer, MODEL_ENV_VAR, type ModelPin, pickInferenceModel } from "./magic.js";
import { loadSettings, saveSettings, settingsPath } from "./settings.js";
import { ClickableText, type TuiLike } from "./tui-mouse.js";
import { LinkServer } from "./link-server.js";
import * as linkInstall from "./link-install.js";
import { terminalSupportsOsc8 } from "./osc8.js";
import { buildChipUrl, messageKey, sessionToken } from "../shared/link-url.js";
import { randomBytes } from "node:crypto";

interface TextBlock {
	type: string;
	text?: string;
}

/** What a closing tag starts with; `</snippet   >` is legal, so match the head. */
const CLOSE_TAG_PREFIX = `</${SNIPPET_TAG}`;

export default function piSnippetTui(pi: any): void {
	/**
	 * The stored preferences, read once at load. `state` starts from them and is
	 * written back on every `/snippets` toggle, so the three switches mean the
	 * same thing in the next session as in this one.
	 */
	const settingsFile = settingsPath();
	const stored = loadSettings(settingsFile);

	const state = {
		enabled: stored.enabled,
		hotkeysEnabled: stored.hotkeysEnabled,
		clickEnabled: stored.clickEnabled,
		/**
		 * Deliver clicks through the terminal's own hyperlink resolution
		 * rather than mouse reporting (docs/terminal-resolved-clicks.md).
		 * Requires a registered handler, so it is only reachable from
		 * `/snippets` once the install probe has round-tripped.
		 */
		linkMode: stored.linkMode,
		/**
		 * Layer 2 (PRD §17): infer suggestions for questions the model left
		 * untagged. Click-only, so it stays inert until clicking is on — no
		 * message is ever sent to the small model for chips nobody could press.
		 */
		magicEnabled: stored.magicEnabled,
		/**
		 * Suggestions of the most recent assistant message — the one streaming,
		 * once it has produced a complete suggestion of its own, otherwise the
		 * last one that finished.
		 */
		addressable: [] as string[],
		/**
		 * Inferred anchors for the message at the tip of the branch. Only ever
		 * populated for a message that carried no tags at all: layer 1 wins
		 * outright, so a numbered chip and an underline never compete for the
		 * same sentence.
		 */
		inferred: [] as InferredSuggestion[],
		/**
		 * Inference model chosen in `/snippets` for this session. Overrides the
		 * `--snippet-model` flag and `PI_SNIPPET_MODEL`, both of which override
		 * auto-selection.
		 */
		modelOverride: (stored.model ?? undefined) as ModelPin,
	};

	const magic = new MagicInferrer();

	/**
	 * Which model reads untagged messages, most specific source first: what was
	 * picked in `/snippets`, then `--snippet-model`, then `PI_SNIPPET_MODEL`,
	 * then whatever auto-selection finds. Resolved per call rather than cached,
	 * so switching models mid-session takes effect on the next message.
	 */
	const modelPin = (): ModelPin => {
		if (state.modelOverride) return state.modelOverride;
		const flag = pi.getFlag("snippet-model");
		if (typeof flag === "string" && flag.trim().length > 0) return flag;
		const env = process.env[MODEL_ENV_VAR];
		return env && env.trim().length > 0 ? env : undefined;
	};

	/**
	 * Anchors to underline, keyed by the exact text they were inferred from.
	 *
	 * This is what lets the transformer stay a pure function of its input while
	 * rendering spans that are not marked up in the text itself (PRD §5.2): it
	 * looks anchors up by the markdown it was handed, so a message renders its
	 * own anchors and no others, at any point in the transcript, on every
	 * repaint and resize, with nothing built during the render pass.
	 */
	const anchorsByText = new Map<string, string[]>();
	const ANCHOR_INDEX_LIMIT = 64;
	const rememberAnchors = (text: string, anchors: string[]): void => {
		anchorsByText.set(text, anchors);
		while (anchorsByText.size > ANCHOR_INDEX_LIMIT) {
			const oldest = anchorsByText.keys().next();
			if (oldest.done) break;
			anchorsByText.delete(oldest.value);
		}
	};

	/**
	 * `--no-suggestions` is a session override, deliberately kept out of
	 * `state.enabled`: the stored preference is what the user chose in
	 * `/snippets`, and a session started with the flag must not overwrite it
	 * with `off` the next time any toggle is saved.
	 */
	let flagDisabled = false;
	const isEnabled = () => state.enabled && !flagDisabled;

	/**
	 * `--snippet-click` is the same shape of override, pointing the other way:
	 * it turns clicking on for one session without writing that choice to disk.
	 * Kept out of `state.clickEnabled` for exactly the reason `flagDisabled` is
	 * kept out of `state.enabled` — the stored value must stay what the user
	 * chose in `/snippets`, or the next toggle of any switch would persist the
	 * flag's answer as if it had been chosen.
	 *
	 * An explicit toggle in `/snippets` supersedes it: having asked for clicking
	 * in this session and then turned it off, the user means off.
	 */
	let flagClick = false;
	const clickOn = () => state.clickEnabled || flagClick;

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
	 * Clicking is on, the terminal is the one resolving it, and the terminal
	 * can actually render a hyperlink.
	 *
	 * That last condition is what keeps the new default safe: where pi-tui
	 * would fall back to printing the href, no `pisnip://` URL is painted at
	 * all and chips keep their inert `chip:N` placeholder.
	 */
	const linkOn = () => isEnabled() && clickOn() && state.linkMode && terminalSupportsOsc8();

	/**
	 * Could a click actually reach a suggestion right now?
	 *
	 * `clickOn()` used to answer this, back when "clicking is on" and "clicking
	 * works" were the same statement. They no longer are: link mode paints
	 * nothing on a terminal without OSC 8, and never falls back to mouse, so
	 * clicking can be switched on and still have no way through. That matters
	 * beyond cosmetics — PRD §17.2 gates the inference layer on "spend nothing
	 * when nothing could reach the result", and this is that condition.
	 */
	const clickActive = () =>
		isEnabled() && clickOn() && (state.linkMode ? terminalSupportsOsc8() : true);

	/**
	 * What each rendered message's chips mean, keyed by a hash of the exact
	 * text they were painted from (`messageKey`).
	 *
	 * The mouse path never needed this: it hit-tests the labels currently on
	 * screen against the current addressable set, so "which message" is
	 * implicit. A URL has to carry the answer, because it can be clicked long
	 * after the message scrolled away — and resolving `c3` against whatever is
	 * addressable *now* would insert some other message's third suggestion,
	 * silently and wrongly. Bounded for the same reason `anchorsByText` is: old
	 * entries are worth keeping, but not without limit.
	 */
	const linkTargets = new Map<string, { chips: string[]; anchors: InferredSuggestion[] }>();
	const LINK_TARGET_LIMIT = 64;
	const rememberLinkTargets = (
		text: string,
		chips: string[],
		anchors: InferredSuggestion[],
	): void => {
		if (text.length === 0) return;
		linkTargets.set(messageKey(text), { chips, anchors });
		while (linkTargets.size > LINK_TARGET_LIMIT) {
			const oldest = linkTargets.keys().next();
			if (oldest.done) break;
			linkTargets.delete(oldest.value);
		}
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
		const forms: string[] = [];
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const raw = block.text ?? "";
			forms.push(raw);
			if (opts?.streaming) forms.push(visibleStreamingPrefix(raw));
		}
		forms.push(messageText(message));
		for (const form of forms) {
			if (form.length === 0) continue;
			const chips = parseSuggestions(form).suggestions;
			const anchors = state.inferred.filter((a) => form.includes(a.anchor));
			if (chips.length > 0 || anchors.length > 0) rememberLinkTargets(form, chips, anchors);
		}
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
	 * Target ids carry their layer: `c3` is the third tagged chip, `a2` the
	 * second inferred anchor. Clicking a chip inserts the chip; clicking an
	 * anchor inserts the reply that was inferred for it, not the assistant's
	 * own words that are underlined on screen.
	 */
	const clickable = new ClickableText({
		onActivate: (target) => {
			if (!lastCtx) return;
			const index = Number(target.id.slice(1)) - 1;
			const text =
				target.id.startsWith("a") ? state.inferred[index]?.reply : state.addressable[index];
			if (text) insertText(lastCtx, text);
		},
	});

	/**
	 * The far end of a terminal-resolved click. Same lookup the mouse path
	 * does, reached from a socket instead of an escape sequence — and keyed by
	 * message, so a chip clicked in old scrollback still means what it meant.
	 */
	/** Set while an install probe is in flight; see `installClickHandler`. */
	let probeArrived: (() => void) | null = null;
	/** The message key a probe URL uses, which no real message can collide with. */
	const PROBE_KEY = "00000000";
	const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	const linkServer = new LinkServer({
		token: () => linkToken,
		resolve: (msg, kind, index) => {
			if (msg === PROBE_KEY) {
				probeArrived?.();
				return undefined; // a probe proves the path; it inserts nothing
			}
			const entry = linkTargets.get(msg);
			if (!entry) return undefined;
			return kind === "a" ? entry.anchors[index - 1]?.reply : entry.chips[index - 1];
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
	 * With link mode on by default, a fresh install paints working hyperlinks
	 * that the desktop has nothing to dispatch to — Ctrl+click would do
	 * nothing, with no way to tell why. This is said at most once per session,
	 * and only when everything *else* is ready, so it is a next step rather
	 * than a complaint.
	 */
	let unregisteredHintShown = false;
	const hintIfUnregistered = (ctx: any): void => {
		if (unregisteredHintShown || process.platform !== "linux") return;
		if (state.addressable.length === 0 && state.inferred.length === 0) return;
		if (linkInstall.isInstalled()) return;
		unregisteredHintShown = true;
		ctx.ui?.notify?.(
			"Ctrl+click needs a one-time handler registration — run /snippets and pick “Register click handler”",
		);
	};

	/**
	 * Point clicking at whichever delivery path is selected, and only while
	 * there is something to click.
	 *
	 * The two are mutually exclusive by design. Mouse reporting is a
	 * terminal-wide mode with real costs (the wheel, shift-less selection), so
	 * it stays off entirely in link mode — the whole point of letting the
	 * terminal resolve the click is that none of those costs apply. The link
	 * server, by contrast, is cheap enough to leave listening: it holds a
	 * socket, not a terminal mode, so it does not need the "only while there
	 * are chips" gate that mouse reporting does.
	 */
	const syncMouse = (ctx: any) => {
		lastCtx = ctx;
		const captured = captureTui(ctx);
		if (captured) watchAltRelease(captured);

		// Link mode means links or nothing. Falling back to mouse reporting
		// would quietly impose the terminal-wide mode that choosing link mode
		// was a way of avoiding — so a terminal that cannot paint a hyperlink
		// gets no clicking, not a surprise change of input mode.
		if (state.linkMode) {
			if (clickable.enabled) clickable.detach();
			if (linkOn()) {
				if (!linkServer.listening) linkServer.start();
				hintIfUnregistered(ctx);
			} else if (linkServer.listening) {
				linkServer.stop();
			}
			return;
		}
		if (linkServer.listening) linkServer.stop();

		const want =
			clickActive() && (state.addressable.length > 0 || state.inferred.length > 0);
		if (want) {
			const instance = captured;
			if (!instance) return;
			clickable.attach(instance);
			clickable.setTargets([
				...state.addressable.map((text, i) => ({ id: `c${i + 1}`, text: chipLabel(i + 1, text) })),
				...state.inferred.map((s, i) => ({ id: `a${i + 1}`, text: s.anchor })),
			]);
		} else if (clickable.enabled) {
			clickable.detach();
		}
	};

	pi.registerFlag("no-suggestions", {
		description: "Disable inline suggestion snippets for this session",
		type: "boolean",
	});

	pi.registerFlag("snippet-click", {
		description:
			"Turn on click-to-insert at startup (otherwise it starts off and is toggled in /snippets)",
		type: "boolean",
	});

	pi.registerFlag("snippet-model", {
		description:
			"Model that infers replies for untagged questions, as provider/id (default: the cheapest small model of the session's provider)",
		type: "string",
	});

	registerPromptSnippet(pi, () => {
		if (pi.getFlag("no-suggestions") === true) flagDisabled = true;
		return isEnabled();
	});

	pi.registerMarkdownTransformer(
		(markdown: string, ctx: { messageType: string; isStreaming: boolean }) => {
			if (ctx.messageType !== "assistant") return markdown;
			return toTuiMarkdown(markdown, {
				isStreaming: ctx.isStreaming,
				enabled: isEnabled(),
				// A streaming message has no anchors yet — it hasn't been read.
				anchors: ctx.isStreaming ? [] : anchorsByText.get(markdown),
				linkToken: linkOn() ? linkToken : undefined,
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
		const suggestions: string[] = [];
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const raw = block.text ?? "";
			const text = opts?.streaming ? visibleStreamingPrefix(raw) : raw;
			const res = parseSuggestions(text, { acceptedSoFar: suggestions.length });
			suggestions.push(...res.suggestions);
		}
		return suggestions;
	};

	/** The message as the small model should read it: its text, in order. */
	const messageText = (message?: { content?: TextBlock[] }): string => {
		if (!message || !Array.isArray(message.content)) return "";
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
	};

	/**
	 * Publish inferred anchors for a message and light them up.
	 *
	 * Anchors are indexed under the joined message text *and* under each text
	 * block that contains one, because pi may hand the transformer either a
	 * whole message or a single block depending on how the message was built.
	 */
	const applyAnchors = (
		message: { content?: TextBlock[] },
		joined: string,
		anchors: InferredSuggestion[],
		ctx: any,
	): void => {
		state.inferred = anchors;
		const labels = anchors.map((a) => a.anchor);
		rememberAnchors(joined, labels);
		for (const block of message.content ?? []) {
			if (block.type !== "text") continue;
			const text = block.text ?? "";
			const here = labels.filter((label) => text.includes(label));
			if (here.length > 0) rememberAnchors(text, here);
		}
		indexMessageForLinks(message);
		syncMouse(ctx);
		tui?.requestRender?.();
	};

	/**
	 * Ask the small model to fill in the chips this message didn't get.
	 *
	 * Four gates before a single token is spent: the feature is on, clicking is
	 * on (nothing else can activate an anchor), layer 1 produced nothing, and
	 * the message actually asks something. The answer lands asynchronously, so
	 * it is dropped unless the branch is still sitting on the same message —
	 * anchors from a message the user has already moved past would underline
	 * text that is no longer the question.
	 */
	const maybeInfer = (message: { content?: TextBlock[] }, ctx: any): void => {
		if (!isEnabled() || !state.magicEnabled || !clickActive()) return;
		if (state.addressable.length > 0) return; // the model tagged it; layer 1 wins
		const joined = messageText(message);
		if (joined.trim().length === 0 || !asksSomething(joined)) return;

		const cached = magic.peek(joined);
		if (cached) {
			if (cached.length > 0) applyAnchors(message, joined, cached, ctx);
			return;
		}
		void magic.infer(joined, ctx, modelPin()).then((anchors) => {
			if (anchors.length === 0) return;
			if (messageText(tipMessage(ctx)) !== joined) return; // the branch moved on
			applyAnchors(message, joined, anchors, ctx);
		});
	};

	/** The assistant message at the tip of the active branch, if any. */
	const tipMessage = (ctx: any): { role?: string; content?: TextBlock[] } | undefined => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			return entry.message.role === "assistant" ? entry.message : undefined;
		}
		return undefined;
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
		state.inferred = [];
		if (!isEnabled()) return;
		const branch = ctx.sessionManager.getBranch();
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
				// A message read once keeps its anchors: walking back to it with
				// /tree costs nothing, and re-asking would be the same question.
				const joined = messageText(entry.message);
				const cached = state.addressable.length === 0 ? magic.peek(joined) : undefined;
				if (cached && cached.length > 0) {
					state.inferred = cached;
					rememberAnchors(joined, cached.map((a) => a.anchor));
				}
			}
			break;
		}
	};

	pi.on("session_start", (event: { reason?: string }, ctx: any) => {
		// Falls back to the random token from setup if the session has no id
		// (a trust-limited or otherwise degraded ctx); a socket that dies with
		// the process is the same behavior this extension always had.
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			if (id) linkToken = sessionToken(id);
		} catch {
			/* keep the random fallback */
		}
		if (pi.getFlag("snippet-click") === true) flagClick = true;
		// "startup" is a real restart too: `pi --session <file>` fires it, not
		// "resume" — that reason is only for /resume inside a running process.
		// A restart that skips hydration leaves linkTargets empty, so the chip
		// URLs the transcript is repainted with resolve to nothing.
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
		syncMouse(ctx);
	});

	pi.on("session_tree", (_event: unknown, ctx: any) => {
		hydrateFromBranch(ctx);
		streamCloseTags = 0;
		chord.reset();
		syncMouse(ctx);
	});

	pi.on("session_shutdown", () => {
		chord.reset();
		releaseWatcher?.();
		releaseWatcher = null;
		if (clickable.enabled) clickable.detach();
	});

	pi.on("message_start", (event: { message?: { role?: string } }) => {
		if (event.message?.role !== "assistant") return;
		streamCloseTags = 0;
		// Anchors belong to the message they were read from; the new one has
		// not been read yet.
		state.inferred = [];
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
	pi.on("message_update", (event: { message?: { role?: string; content?: TextBlock[] } }, ctx: any) => {
		if (!event.message || event.message.role !== "assistant" || !isEnabled()) return;
		const closeTags = countCloseTags(event.message);
		if (closeTags === streamCloseTags) return; // nothing newly closed
		streamCloseTags = closeTags;
		const suggestions = suggestionsFromMessage(event.message, { streaming: true });
		if (suggestions.length === 0) return; // a close tag that resolved to plain text
		setAddressable(suggestions);
		indexMessageForLinks(event.message, { streaming: true });
		syncMouse(ctx);
	});

	pi.on("message_end", (event: { message?: { role?: string; content?: TextBlock[] } }, ctx: any) => {
		if (!event.message || event.message.role !== "assistant" || !isEnabled()) return;
		setAddressable(suggestionsFromMessage(event.message));
		indexMessageForLinks(event.message);
		streamCloseTags = 0;
		syncMouse(ctx);
		maybeInfer(event.message, ctx);
	});

	for (let n = 0; n <= 9; n++) {
		pi.registerShortcut(`alt+${n}`, {
			description:
				n === 0
					? "Insert suggestion 10 (or extend a two-digit number)"
					: `Insert suggestion ${n} (hold Alt and type two digits for 10+)`,
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
		const tagged = `Inline suggestions — ${messagesWithSuggestions}/${messages} messages had suggestions (${pct}%), ${totalSuggestions} total`;
		const { calls, input, output } = magic.usage;
		if (calls === 0) return tagged;
		return `${tagged}; inferred ${calls} message${calls === 1 ? "" : "s"} (${input + output} tokens)`;
	};

	/**
	 * Write the preferences back to disk. A failure — read-only home, a full
	 * disk — is not worth interrupting anyone over, but it does change what the
	 * toggle means, so the notification says so instead of promising a
	 * persistence that did not happen.
	 */
	const persist = (): string => {
		const ok = saveSettings(
			{
				enabled: state.enabled,
				hotkeysEnabled: state.hotkeysEnabled,
				clickEnabled: state.clickEnabled,
				linkMode: state.linkMode,
				magicEnabled: state.magicEnabled,
				model: state.modelOverride ?? null,
			},
			settingsFile,
		);
		return ok ? "" : " (this session only — could not write the settings file)";
	};

	/** How the inference layer describes itself in `/snippets`. */
	const magicLabel = (ctx: any): string => {
		if (!state.magicEnabled) return "off — toggle";
		const model = pickInferenceModel(ctx, modelPin());
		const pin = modelPin();
		if (!model) {
			return pin
				? `on, but ${pin} is unusable here — toggle`
				: "on, but no usable model — toggle";
		}
		if (magic.stoodDown) return `stood down — ${model.id} kept failing — toggle to retry`;
		if (!clickActive()) {
			return state.linkMode && clickOn()
				? `on via ${model.id}, idle until this terminal can paint hyperlinks — toggle`
				: `on via ${model.id}, idle until click-to-insert is on — toggle`;
		}
		return `on via ${model.id} — toggle`;
	};

	/**
	 * How a click reaches the editor, and what changing it would cost.
	 *
	 * Phrased as the action rather than the state, because turning link mode on
	 * is not a toggle — it registers a scheme handler with the desktop, which
	 * is a thing worth naming before it happens.
	 */
	const clickMethodLabel = (): string => {
		if (process.platform !== "linux") return "mouse reporting (link mode is Linux-only for now)";
		if (state.linkMode) {
			return linkInstall.isInstalled()
				? "Ctrl+click, resolved by the terminal — switch back to mouse"
				: "Ctrl+click, resolved by the terminal (not registered yet) — switch back to mouse";
		}
		return linkInstall.isInstalled()
			? "mouse reporting — switch to Ctrl+click (handler already registered, will re-verify)"
			: "mouse reporting — switch to Ctrl+click (registers a handler with your desktop)";
	};

	/** Let the user name the inference model rather than trusting the guess. */
	const chooseModel = async (ctx: any): Promise<void> => {
		const candidates = inferenceCandidates(ctx);
		if (candidates.length === 0) {
			ctx.ui.notify("No models with configured auth to infer with", "warning");
			return;
		}
		const AUTO = "Auto — cheapest small model of this provider";
		const labels = candidates.map((m) => `${m.provider ?? "?"}/${m.id}`);
		const choice = await ctx.ui.select("Model for inferring untagged questions", [AUTO, ...labels]);
		if (!choice) return;
		state.modelOverride = choice === AUTO ? undefined : choice;
		magic.rearm(); // a new model deserves a fresh chance
		const saved = persist();
		const resolved = pickInferenceModel(ctx, modelPin());
		ctx.ui.notify(
			(resolved ? `Inferring with ${resolved.id}` : "No usable inference model") + saved,
			resolved ? "info" : "warning",
		);
	};

	/**
	 * Register `pisnip://` with the desktop, then prove it round-trips.
	 *
	 * Registration that is not proven is a guess, so link mode is only offered
	 * after a real URL has travelled the whole path — opener, handler, socket —
	 * and arrived here. The failure message names the step that broke rather
	 * than saying it did not work.
	 */
	const installClickHandler = async (ctx: any): Promise<void> => {
		if (process.platform !== "linux") {
			ctx.ui.notify("Terminal-resolved clicking is Linux-only for now", "warning");
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
			const url = buildChipUrl(linkToken, PROBE_KEY, "c", 1);
			const outcome = await linkInstall.probe(url, async () => {
				// The dispatch is asynchronous all the way through: opener,
				// handler process, connect. Give it a moment before judging.
				for (let i = 0; i < 20 && !arrived; i++) await delay(100);
				return arrived;
			});
			if (outcome.opener) {
				state.linkMode = true;
				ctx.ui.notify(
					`Click handler installed and verified via ${outcome.opener}. ` +
						`Ctrl+click a chip to insert it — no mouse mode${persist()}`,
				);
			} else {
				ctx.ui.notify(
					`Registered, but no opener completed the round trip (${outcome.tried.join(", ")}). ` +
						"Clicking stays on the mouse path.",
					"warning",
				);
			}
		} finally {
			probeArrived = previous;
		}
		syncMouse(ctx);
	};

	pi.registerCommand("snippets", {
		description: "Toggle inline suggestions, their shortcuts, or click-to-insert",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			if (flagDisabled) {
				ctx.ui.notify("Inline suggestions are off for this session (--no-suggestions)");
				return;
			}
			const choice = await ctx.ui.select(snippetStats(ctx), [
				`Suggestions: ${state.enabled ? "on" : "off"} — toggle`,
				`Alt+digit shortcuts: ${state.hotkeysEnabled ? "on" : "off"} — toggle`,
				`Click to insert: ${clickOn() ? "on" : "off"} — toggle${
					clickOn() && !state.linkMode
						? " (mouse mode costs wheel scrolling while suggestions are shown)"
						: ""
				}`,
				`Click method: ${clickMethodLabel()}`,
				...(process.platform === "linux" && state.linkMode && !linkInstall.isInstalled()
					? ["Register click handler — one-time desktop setup, needed before Ctrl+click works"]
					: []),
				`Infer untagged questions: ${magicLabel(ctx)}`,
				"Inference model — choose",
				...(process.platform === "linux" && linkInstall.isInstalled()
					? ["Remove click handler — unregister pisnip:// from the desktop"]
					: []),
			]);
			if (!choice) return;
			if (choice.startsWith("Suggestions:")) {
				state.enabled = !state.enabled;
				if (!state.enabled) state.addressable = [];
				ctx.ui.notify(`Inline suggestions ${state.enabled ? "enabled" : "disabled"}${persist()}`);
			} else if (choice.startsWith("Click to insert:")) {
				state.clickEnabled = !clickOn();
				flagClick = false; // an explicit choice supersedes --snippet-click
				if (!state.clickEnabled) state.inferred = [];
				ctx.ui.notify(
					(state.clickEnabled
						? "Click to insert enabled — while suggestions are on screen, the wheel belongs to pi and selection needs Shift"
						: "Click to insert disabled — scrolling and selection back to normal") + persist(),
				);
			} else if (choice.startsWith("Register click handler")) {
				await installClickHandler(ctx);
			} else if (choice.startsWith("Click method:")) {
				if (!state.linkMode) {
					// Turning it on is the install: without a registered
					// handler the URLs would dispatch to nothing.
					await installClickHandler(ctx);
				} else {
					state.linkMode = false;
					ctx.ui.notify(
						`Clicks back on mouse reporting — the wheel belongs to pi while suggestions show${persist()}`,
					);
				}
			} else if (choice.startsWith("Remove click handler")) {
				linkInstall.uninstall();
				state.linkMode = false;
				ctx.ui.notify(`Click handler removed from the desktop${persist()}`);
			} else if (choice.startsWith("Inference model")) {
				await chooseModel(ctx);
			} else if (choice.startsWith("Infer untagged questions:")) {
				state.magicEnabled = !state.magicEnabled;
				if (!state.magicEnabled) state.inferred = [];
				else magic.rearm();
				const saved = persist();
				const model = state.magicEnabled ? pickInferenceModel(ctx) : undefined;
				ctx.ui.notify(
					(!state.magicEnabled
						? "Inference off — only the suggestions the model tags itself"
						: !model
							? "Inference on, but no model with configured auth was found — nothing will be inferred"
							: !clickOn()
								? `Inference on via ${model.id} — inferred replies are click-only, so turn on click to insert to reach them`
								: `Inference on via ${model.id} — untagged questions get underlined replies`) + saved,
				);
			} else {
				state.hotkeysEnabled = !state.hotkeysEnabled;
				ctx.ui.notify(
					`Suggestion shortcuts ${state.hotkeysEnabled ? "enabled" : "disabled"}${persist()}`,
				);
			}
			syncMouse(ctx);
		},
	});
}
