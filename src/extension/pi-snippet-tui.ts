/**
 * pi-snippet TUI extension: renders <pi:snippet> suggested-reply spans in
 * pi's terminal UI.
 *
 * - Injects the suggested-replies prompt contract (guarded against double
 *   injection).
 * - Renders <pi:snippet> spans as markdown links led by a small superscript
 *   number — `¹rebuild the solution` — via pi's markdown transformer hook.
 *   The hook is display-only: stored messages keep their raw tags, so
 *   sessions stay readable by any other transcript consumer.
 * - Clicking a chip inserts it into the editor. Mouse reporting is
 *   terminal-wide (the wheel stops scrolling the terminal and text selection
 *   needs Shift), so it is engaged only while the latest finalized message
 *   actually has suggestions, and can be toggled off in `/snippets`.
 * - Alt+N inserts the Nth suggestion of the most recent finalized assistant
 *   message into the editor. Holding Alt and typing two digits reaches 10 and
 *   above. Only the latest message is addressable, so a number never means two
 *   different things.
 * - `/snippets` toggles the feature, the hotkeys, or click-to-insert; the
 *   `--no-suggestions` flag disables everything for a session.
 *
 * The transformer stays pure; the addressable set is derived once per
 * finalized message in the message_end handler and held in extension state,
 * never built during transformation (PRD §5.2 hard rule).
 */
import { DigitChord } from "../shared/digit-chord.js";
import { parseSuggestions } from "../shared/suggestions.js";
import { chipLabel, toTuiMarkdown } from "../shared/tui-markdown.js";
import { registerPromptSnippet } from "./common.js";
import { ClickableText, type TuiLike } from "./tui-mouse.js";

interface TextBlock {
	type: string;
	text?: string;
}

export default function piSnippetTui(pi: any): void {
	const state = {
		enabled: true,
		hotkeysEnabled: true,
		clickEnabled: false,
		/** Suggestions of the most recent finalized assistant message. */
		addressable: [] as string[],
	};

	let tui: TuiLike | null = null;

	const insertText = (ctx: any, text: string) => {
		const current: string = ctx.ui.getEditorText();
		const separator = current.length > 0 && !/\s$/.test(current) ? " " : "";
		ctx.ui.setEditorText(current + separator + text);
	};

	let lastCtx: any = null;
	const clickable = new ClickableText({
		onActivate: (target) => {
			if (lastCtx) insertText(lastCtx, state.addressable[Number(target.id) - 1] ?? "");
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

	/** Engage mouse reporting only while there is something to click. */
	const syncMouse = (ctx: any) => {
		lastCtx = ctx;
		const captured = captureTui(ctx);
		if (captured) watchAltRelease(captured);
		const want = state.enabled && state.clickEnabled && state.addressable.length > 0;
		if (want) {
			const instance = captured;
			if (!instance) return;
			clickable.attach(instance);
			clickable.setTargets(
				state.addressable.map((text, i) => ({ id: String(i + 1), text: chipLabel(i + 1, text) })),
			);
		} else if (clickable.enabled) {
			clickable.detach();
		}
	};

	pi.registerFlag("no-suggestions", {
		description: "Disable inline suggestion snippets for this session",
		type: "boolean",
	});

	registerPromptSnippet(pi, () => {
		if (pi.getFlag("no-suggestions") === true) state.enabled = false;
		return state.enabled;
	});

	pi.registerMarkdownTransformer(
		(markdown: string, ctx: { messageType: string; isStreaming: boolean }) => {
			if (ctx.messageType !== "assistant") return markdown;
			return toTuiMarkdown(markdown, { isStreaming: ctx.isStreaming, enabled: state.enabled });
		},
	);

	const suggestionsFromMessage = (message?: { role?: string; content?: TextBlock[] }): string[] => {
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
		const suggestions: string[] = [];
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const res = parseSuggestions(block.text ?? "", { acceptedSoFar: suggestions.length });
			suggestions.push(...res.suggestions);
		}
		return suggestions;
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
		if (!state.enabled) return;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			if (entry.message.role === "assistant") state.addressable = suggestionsFromMessage(entry.message);
			break;
		}
	};

	pi.on("session_start", (event: { reason?: string }, ctx: any) => {
		if (event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
			hydrateFromBranch(ctx);
		} else {
			state.addressable = [];
		}
		syncMouse(ctx);
	});

	pi.on("session_tree", (_event: unknown, ctx: any) => {
		hydrateFromBranch(ctx);
		chord.reset();
		syncMouse(ctx);
	});

	pi.on("session_shutdown", () => {
		chord.reset();
		releaseWatcher?.();
		releaseWatcher = null;
		if (clickable.enabled) clickable.detach();
	});

	pi.on("message_end", (event: { message?: { role?: string; content?: TextBlock[] } }, ctx: any) => {
		if (!event.message || event.message.role !== "assistant" || !state.enabled) return;
		state.addressable = suggestionsFromMessage(event.message);
		chord.reset(); // digits typed against the previous message mean nothing now
		syncMouse(ctx);
	});

	for (let n = 0; n <= 9; n++) {
		pi.registerShortcut(`alt+${n}`, {
			description:
				n === 0
					? "Insert suggestion 10 (or extend a two-digit number)"
					: `Insert suggestion ${n} (hold Alt and type two digits for 10+)`,
			handler: (ctx: any) => {
				if (!state.enabled || !state.hotkeysEnabled || !ctx.hasUI) return;
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

	pi.registerCommand("snippets", {
		description: "Toggle inline suggestions, their shortcuts, or click-to-insert",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select(snippetStats(ctx), [
				`Suggestions: ${state.enabled ? "on" : "off"} — toggle`,
				`Alt+digit shortcuts: ${state.hotkeysEnabled ? "on" : "off"} — toggle`,
				`Click to insert: ${state.clickEnabled ? "on" : "off"} — toggle (mouse mode costs wheel scrolling while suggestions are shown)`,
			]);
			if (!choice) return;
			if (choice.startsWith("Suggestions:")) {
				state.enabled = !state.enabled;
				if (!state.enabled) state.addressable = [];
				ctx.ui.notify(`Inline suggestions ${state.enabled ? "enabled" : "disabled"}`);
			} else if (choice.startsWith("Click to insert:")) {
				state.clickEnabled = !state.clickEnabled;
				ctx.ui.notify(
					state.clickEnabled
						? "Click to insert enabled — while suggestions are on screen, the wheel belongs to pi and selection needs Shift"
						: "Click to insert disabled — scrolling and selection back to normal",
				);
			} else {
				state.hotkeysEnabled = !state.hotkeysEnabled;
				ctx.ui.notify(`Suggestion shortcuts ${state.hotkeysEnabled ? "enabled" : "disabled"}`);
			}
			syncMouse(ctx);
		},
	});
}
