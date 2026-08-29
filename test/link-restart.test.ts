/**
 * A restarted pi process is a fresh `piSnippetTui()` call with its own random
 * seed for `linkToken`, so the invariant that matters is not "the token is
 * stable within one process" (trivially true) but "two processes that load
 * the *same* session compute the *same* token" — otherwise a chip painted
 * before the restart names a socket the new process never binds.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS } from "../src/extension/settings.js";
import { resetOsc8Cache } from "../src/extension/osc8.js";

class FakeTui {
	written: string[] = [];
	lines: string[] = [];
	hardwareCursorRow = 0;
	requestRender(): void {}
	terminal = { columns: 80, rows: 24, write: (data: string) => this.written.push(data) };
	render(_width: number): string[] {
		return this.lines;
	}
	addInputListener(): () => void {
		return () => {};
	}
}

const original = { ...process.env };

afterEach(() => {
	process.env = { ...original };
	resetOsc8Cache();
});

/** One simulated pi process, for the same session id, loading its own extension instance. */
function launch(sessionId: string | undefined, reason: string) {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	let transformer: ((md: string, c: any) => string) | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: (t: any) => {
			transformer = t;
		},
		registerShortcut: () => {},
		registerCommand: () => {},
	};
	piSnippetTui(pi as any);

	const tui = new FakeTui();
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getBranch: () => [],
			getSessionId: sessionId === undefined ? undefined : () => sessionId,
		},
		ui: {
			getEditorText: () => "",
			setEditorText: () => {},
			notify: () => {},
			setStatus: () => {},
			select: async () => undefined,
			setFooter: (factory?: any) => {
				if (factory) factory(tui);
			},
		},
	};

	handlers.get("session_start")!({ reason }, ctx);

	const say = (text: string) => {
		const message = { role: "assistant", content: [{ type: "text", text }] };
		handlers.get("message_end")!({ message }, ctx);
	};

	const chipUrl = (text: string): string => {
		say(text);
		const rendered = transformer!(text, { messageType: "assistant", isStreaming: false });
		const match = rendered.match(/\((pisnip:\/\/[0-9a-f]{8}\/[0-9a-f]{8}\/c\d+)\)/);
		if (!match) throw new Error(`no pisnip:// URL in: ${rendered}`);
		return match[1]!;
	};

	return { chipUrl };
}

function setup(env: Record<string, string>) {
	writeFileSync(process.env.PI_SNIPPET_SETTINGS!, JSON.stringify(DEFAULT_SETTINGS), "utf8");
	for (const key of [
		"TERM",
		"TERM_PROGRAM",
		"TMUX",
		"KITTY_WINDOW_ID",
		"GHOSTTY_RESOURCES_DIR",
		"WEZTERM_PANE",
		"WARP_SESSION_ID",
		"WARP_TERMINAL_SESSION_UUID",
		"ITERM_SESSION_ID",
		"WT_SESSION",
	]) {
		delete process.env[key];
	}
	process.env.XDG_DATA_HOME ??= mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
	Object.assign(process.env, env);
	resetOsc8Cache();
}

const CHIPPED = "Want me to <snippet>rebuild the solution</snippet>?";

describe("the chip URL survives a restart of the pi process", () => {
	it("two processes loading the same session id agree on the socket token", () => {
		setup({ TERM_PROGRAM: "ghostty" });
		const before = launch("3fae1c2e-9b7c-4b8b-8f2a-1a2b3c4d5e6f", "startup");
		const beforeUrl = before.chipUrl(CHIPPED);

		setup({ TERM_PROGRAM: "ghostty" });
		const after = launch("3fae1c2e-9b7c-4b8b-8f2a-1a2b3c4d5e6f", "resume");
		const afterUrl = after.chipUrl(CHIPPED);

		const tokenOf = (url: string) => url.replace("pisnip://", "").split("/")[0];
		expect(tokenOf(afterUrl)).toBe(tokenOf(beforeUrl));
	});

	it("two different session ids get two different tokens", () => {
		setup({ TERM_PROGRAM: "ghostty" });
		const a = launch("session-a", "startup").chipUrl(CHIPPED);
		setup({ TERM_PROGRAM: "ghostty" });
		const b = launch("session-b", "startup").chipUrl(CHIPPED);

		const tokenOf = (url: string) => url.replace("pisnip://", "").split("/")[0];
		expect(tokenOf(a)).not.toBe(tokenOf(b));
	});
});
