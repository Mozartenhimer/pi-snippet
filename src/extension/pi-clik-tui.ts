/**
 * pi-clik TUI extension: the terminal counterpart of the web client
 * (PRD §12, surface parity F1).
 *
 * - Injects the same prompt snippet as the web variant (shared, guarded).
 * - Renders <pi:suggest> spans as bold accent-colored spans led by a small
 *   superscript number — `¹rebuild the solution` — via pi's markdown
 *   transformer hook. The hook is display-only: stored messages keep their raw
 *   tags, so sessions stay compatible with the web client and any other
 *   consumer.
 * - Clicking a chip inserts it into the editor. Mouse reporting is
 *   terminal-wide (the wheel stops scrolling the terminal and text selection
 *   needs Shift), so it is engaged only while the latest finalized message
 *   actually has suggestions, and can be toggled off in `/suggestions`.
 * - Alt+1..9,0 insert the Nth suggestion of the most recent finalized
 *   assistant message into the editor. Only that message is addressable, so a
 *   number never means two different things.
 * - `/suggestions` toggles the feature, the hotkeys, or click-to-insert; the
 *   `--no-suggestions` flag disables everything for a session.
 *
 * The transformer stays pure; the addressable set is derived once per
 * finalized message in the message_end handler and held in extension state,
 * never built during transformation (PRD §5.2 hard rule).
 */
import { parseSuggestions } from "../shared/suggestions.js";
import { chipLabel, toTuiMarkdown } from "../shared/tui-markdown.js";
import { registerPromptSnippet } from "./common.js";
import { ClickableText, type TuiLike } from "./tui-mouse.js";

interface TextBlock {
	type: string;
	text?: string;
}

export default function piClikTui(pi: any): void {
	const state = {
		enabled: true,
		hotkeysEnabled: true,
		clickEnabled: true,
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
		const want = state.enabled && state.clickEnabled && state.addressable.length > 0;
		if (want) {
			const instance = captureTui(ctx);
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

	pi.on("session_start", (_event: unknown, ctx: any) => {
		state.addressable = [];
		syncMouse(ctx);
	});

	pi.on("session_shutdown", () => {
		if (clickable.enabled) clickable.detach();
	});

	pi.on("message_end", (event: { message?: { role?: string; content?: TextBlock[] } }, ctx: any) => {
		const message = event.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		if (!state.enabled) return;
		const suggestions: string[] = [];
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const res = parseSuggestions(block.text ?? "", { acceptedSoFar: suggestions.length });
			suggestions.push(...res.suggestions);
		}
		state.addressable = suggestions;
		syncMouse(ctx);
	});

	// Alt+1..9 for suggestions 1-9, Alt+0 for the 10th.
	for (let n = 1; n <= 10; n++) {
		const key = n === 10 ? "alt+0" : `alt+${n}`;
		pi.registerShortcut(key, {
			description: `Insert suggestion ${n} from the last reply`,
			handler: (ctx: any) => {
				if (!state.enabled || !state.hotkeysEnabled || !ctx.hasUI) return;
				const text = state.addressable[n - 1];
				if (text === undefined) return;
				insertText(ctx, text);
			},
		});
	}

	pi.registerCommand("suggestions", {
		description: "Toggle inline suggestions, their shortcuts, or click-to-insert",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select("Inline suggestions", [
				`Suggestions: ${state.enabled ? "on" : "off"} — toggle`,
				`Alt+1..9,0 shortcuts: ${state.hotkeysEnabled ? "on" : "off"} — toggle`,
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
