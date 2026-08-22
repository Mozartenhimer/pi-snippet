/**
 * pi-clik TUI extension: the terminal counterpart of the web client
 * (PRD §12, surface parity F1).
 *
 * - Injects the same prompt snippet as the web variant (shared, guarded).
 * - Renders <pi:suggest> spans as numbered bracketed spans — `[1 rebuild the
 *   solution]` — via pi's markdown transformer hook. The hook is display-only:
 *   stored messages keep their raw tags, so sessions stay compatible with the
 *   web client and any other consumer.
 * - Alt+1..4 insert the Nth suggestion of the most recent finalized assistant
 *   message into the editor. Only that message is addressable, so a number
 *   never means two different things.
 * - `/suggestions` toggles the feature or just the hotkeys; the
 *   `--no-suggestions` flag disables it for a session.
 *
 * The transformer stays pure; the addressable set is derived once per
 * finalized message in the message_end handler and held in extension state,
 * never built during transformation (PRD §5.2 hard rule).
 */
import { parseSuggestions } from "../shared/suggestions.js";
import { toTuiMarkdown } from "../shared/tui-markdown.js";
import { registerPromptSnippet } from "./common.js";

interface TextBlock {
	type: string;
	text?: string;
}

export default function piClikTui(pi: any): void {
	const state = {
		enabled: true,
		hotkeysEnabled: true,
		/** Suggestions of the most recent finalized assistant message. */
		addressable: [] as string[],
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

	pi.on("session_start", () => {
		state.addressable = [];
	});

	pi.on("message_end", (event: { message?: { role?: string; content?: TextBlock[] } }) => {
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
	});

	for (const n of [1, 2, 3, 4]) {
		pi.registerShortcut(`alt+${n}`, {
			description: `Insert suggestion ${n} from the last reply`,
			handler: (ctx: any) => {
				if (!state.enabled || !state.hotkeysEnabled || !ctx.hasUI) return;
				const text = state.addressable[n - 1];
				if (text === undefined) return;
				const current: string = ctx.ui.getEditorText();
				const separator = current.length > 0 && !/\s$/.test(current) ? " " : "";
				ctx.ui.setEditorText(current + separator + text);
			},
		});
	}

	pi.registerCommand("suggestions", {
		description: "Toggle inline suggestions, or their keyboard shortcuts",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select("Inline suggestions", [
				`Suggestions: ${state.enabled ? "on" : "off"} — toggle`,
				`Alt+1..4 shortcuts: ${state.hotkeysEnabled ? "on" : "off"} — toggle`,
			]);
			if (!choice) return;
			if (choice.startsWith("Suggestions:")) {
				state.enabled = !state.enabled;
				if (!state.enabled) state.addressable = [];
				ctx.ui.notify(`Inline suggestions ${state.enabled ? "enabled" : "disabled"}`);
			} else {
				state.hotkeysEnabled = !state.hotkeysEnabled;
				ctx.ui.notify(`Suggestion shortcuts ${state.hotkeysEnabled ? "enabled" : "disabled"}`);
			}
		},
	});
}
