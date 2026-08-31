/**
 * The guards that make always-on Ctrl+click safe.
 *
 * Two properties matter, and neither is obvious from reading the link path
 * alone:
 *
 * **No mouse reporting, ever.** Mouse mode takes the wheel away from the
 * terminal and makes selection need Shift. Nobody opted into that by leaving a
 * default alone, so a terminal that cannot paint a hyperlink gets no clicking
 * rather than a surprise change of input mode.
 *
 * **No URL where the href would be visible.** pi-tui prints the href in
 * parentheses when the terminal has no OSC 8, so a `pisnip://` URL on such a
 * terminal would trail every chip on screen.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piSnippetTui from "../src/extension/pi-snippet-tui.js";
import { DEFAULT_SETTINGS } from "../src/extension/settings.js";
import { resetCapabilitiesCache } from "@earendil-works/pi-tui";

/** DECSET 1000 — the byte that means "the wheel now belongs to pi". */
const MOUSE_ON = "\x1b[?1000h";

class FakeTui {
	written: string[] = [];
	lines: string[] = [];
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
	resetCapabilitiesCache();
});

/**
 * Point both XDG homes at a fresh temp directory.
 *
 * Both, not just the data home: `install()` writes the desktop entry and the
 * handler under `XDG_DATA_HOME`, but the association it adds by hand (when
 * `xdg-mime` is absent, which it is in CI) goes to
 * `XDG_CONFIG_HOME/mimeapps.list` — so a test that isolated only the first
 * wrote into the developer's real `~/.config`. That residue then made the next
 * run of the suite cover a branch (`setDefaultByHand` finding an existing
 * file) that a clean machine never reaches, which is exactly the way a
 * measurement lies.
 */
function isolateXdg(opts: { fresh?: boolean } = {}): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
	if (opts.fresh) {
		process.env.XDG_DATA_HOME = dir;
		process.env.XDG_CONFIG_HOME = dir;
		return;
	}
	process.env.XDG_DATA_HOME ??= dir;
	process.env.XDG_CONFIG_HOME ??= dir;
}

function setup(
	settings: Partial<typeof DEFAULT_SETTINGS>,
	env: Record<string, string>,
	opts: { selectReply?: string } = {},
) {
	writeFileSync(
		process.env.PI_SNIPPET_SETTINGS!,
		JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }),
		"utf8",
	);
	// Every env var pi-tui's capability detection reads, so a test never
	// inherits the host terminal's own identity (this suite failed under real
	// Ghostty, which left GHOSTTY_RESOURCES_DIR set, before this list grew to
	// match). PI_HYPERLINKS is pi-tui's explicit override and outranks them all.
	for (const key of [
		"TERM",
		"TERM_PROGRAM",
		"TERMINAL_EMULATOR",
		"TMUX",
		"KITTY_WINDOW_ID",
		"GHOSTTY_RESOURCES_DIR",
		"WEZTERM_PANE",
		"WARP_SESSION_ID",
		"WARP_TERMINAL_SESSION_UUID",
		"ITERM_SESSION_ID",
		"WT_SESSION",
		"PI_HYPERLINKS",
		"SSH_TTY",
		"SSH_CONNECTION",
	]) {
		delete process.env[key];
	}
	isolateXdg();
	Object.assign(process.env, env);
	resetCapabilitiesCache();

	const handlers = new Map<string, (event: any, ctx: any) => void>();
	let transformer: ((md: string, c: any) => string) | undefined;
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerMarkdownTransformer: (t: any) => {
			transformer = t;
		},
		registerShortcut: () => {},
		registerCommand: (_name: string, opts: any) => {
			command = opts.handler;
		},
	};
	piSnippetTui(pi as any);

	const tui = new FakeTui();
	const offered: string[] = [];
	const notes: string[] = [];
	const editors: string[] = [];
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			getEditorText: () => "",
			setEditorText: (text: string) => {
				editors.push(text);
			},
			notify: (message: string) => {
				notes.push(message);
			},
			setStatus: () => {},
			select: async (_title: string, choices: string[]) => {
				offered.push(...choices);
				return opts.selectReply;
			},
			setFooter: (factory?: any) => {
				if (factory) factory(tui);
			},
		},
	};

	const say = (text: string) => {
		const message = { role: "assistant", content: [{ type: "text", text }] };
		handlers.get("message_end")!({ message }, ctx);
		return message;
	};

	return {
		tui,
		notes,
		editors,
		say,
		menu: async () => {
			offered.length = 0;
			await command!("", ctx);
			return [...offered];
		},
		render: (md: string) => transformer!(md, { messageType: "assistant", isStreaming: false }),
	};
}

const CHIPPED = "Want me to <snippet>rebuild the solution</snippet>?";

describe("clicking on by default, by the terminal", () => {
	it("engages no mouse mode, on any terminal", () => {
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		h.say(CHIPPED);
		expect(h.tui.written.join("")).not.toContain(MOUSE_ON);
	});

	it("paints no URL on a terminal that cannot paint hyperlinks, so nothing trails the chip", () => {
		const h = setup({}, { TERM: "xterm-256color" });
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toBe("Want me to ¹rebuild the solution?");
	});

	it("is not fooled by the host terminal's own identity leaking through", () => {
		// Regression: this suite ran fine in a container and failed under real
		// Ghostty, because GHOSTTY_RESOURCES_DIR survives from the outer shell
		// and setup() wasn't clearing it.
		process.env.GHOSTTY_RESOURCES_DIR = "/snap/ghostty/current/share/ghostty";
		const h = setup({}, { TERM: "xterm-256color" });
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toBe("Want me to ¹rebuild the solution?");
	});

	it("paints a dispatchable URL where the terminal does render hyperlinks", () => {
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toMatch(/\]\(pisnip:\/\/[0-9a-f]{8}\/[0-9a-f]{8}\/c1\)/);
	});

	// The only route to a working Ctrl+click is this row, so its presence is
	// the feature.
	it("offers registration while the handler is missing", async () => {
		isolateXdg({ fresh: true });
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		const choices = await h.menu();
		expect(choices).toContainEqual(expect.stringContaining("Register click handler"));
	});

	it("offers removal to someone with a handler, instead", async () => {
		isolateXdg({ fresh: true });
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		// Install by hand: the menu only offers the row when files are present.
		const { install } = await import("../src/extension/link-install.js");
		install();
		const choices = await h.menu();
		expect(choices).toContainEqual(expect.stringContaining("Remove click handler"));
		expect(choices).not.toContainEqual(expect.stringContaining("Register click handler"));
	});
});

describe("over SSH", () => {
	// SSH_TTY is what a real sshd sets; either marker must trigger the same
	// behavior, since SSH_CONNECTION can appear without a TTY (port forwards).
	const SSH_ENV = { TERM_PROGRAM: "ghostty", SSH_TTY: "/dev/pts/3" };

	it("paints bare labels until remote clicking is on, even where hyperlinks work", () => {
		const h = setup({}, SSH_ENV);
		h.say(CHIPPED);
		// Without a forward, a URL is a click that dies silently on the client
		// machine — the outcome the layer refuses to paint by default.
		expect(h.render(CHIPPED)).toBe("Want me to ¹rebuild the solution?");
	});

	it("offers remote clicking instead of desktop registration", async () => {
		const h = setup({}, SSH_ENV);
		const choices = await h.menu();
		expect(choices).toContainEqual(expect.stringContaining("Remote clicking: off"));
		expect(choices).not.toContainEqual(expect.stringContaining("Register click handler"));
	});

	it("enabling paints URLs, prints the forward line, and verifies on a real click", async () => {
		const h = setup({}, SSH_ENV, { selectReply: "Remote clicking: on" });
		const pending = h.menu();
		// The enable path ends in a verify window waiting for a click; deliver
		// one through the socket it just opened, in the handler's wire format —
		// exactly how a click forwarded over ssh -L arrives.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const recipe = h.editors.find((text) => text.includes("-L "));
		expect(recipe).toMatch(/mkdir -p \/tmp\/pi-snippet-\$\(id -u\) && ssh -L \/tmp\/pi-snippet-\$\(id -u\)\/[0-9a-f]{8}\.sock:(\S+) <host>/);
		const socketPath = recipe!.match(/ssh -L \/tmp\/pi-snippet-\$\(id -u\)\/[0-9a-f]{8}\.sock:(\S+)/)![1]!;
		await new Promise<void>((resolve, reject) => {
			const s = connect(socketPath, () => {
				s.write("00000000/c1\n");
				s.end();
				resolve();
			});
			s.on("error", reject);
		});
		await pending;
		expect(h.render(CHIPPED)).toMatch(/\]\(pisnip:\/\/[0-9a-f]{8}\/[0-9a-f]{8}\/c1\)/);
		expect(h.notes.join("\n")).toContain("Verified:");
		// And off again: bare labels, socket closed, nothing left to hang vitest.
		await h.menu();
		expect(h.render(CHIPPED)).toBe("Want me to ¹rebuild the solution?");
	});
});
