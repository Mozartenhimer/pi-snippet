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
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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

function setup(
	settings: Partial<typeof DEFAULT_SETTINGS>,
	env: Record<string, string>,
	opts: { selectReply?: string | ((options: string[]) => string | undefined) } = {},
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
	// Keep `isInstalled()` off the developer's real ~/.local/share.
	process.env.XDG_DATA_HOME ??= mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
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
	const titles: string[] = [];
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
			select: async (title: string, choices: string[]) => {
				titles.push(title);
				offered.push(...choices);
				// A function answers each select by what it was offered, which is
				// how a test drives a row and then the picker behind it.
				return typeof opts.selectReply === "function"
					? opts.selectReply(choices)
					: opts.selectReply;
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
		titles,
		say,
		/**
		 * A session beginning — where the extension decides, among other
		 * things, whether this client has earned chip URLs without asking.
		 */
		start: (reason = "startup") => handlers.get("session_start")!({ reason }, ctx),
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
		process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
		const h = setup({}, { TERM_PROGRAM: "ghostty" });
		const choices = await h.menu();
		expect(choices).toContainEqual(expect.stringContaining("Register click handler"));
	});

	it("gives the click socket back when suggestions are turned off", async () => {
		// The listener is cheap but not free, and nothing can paint a URL that
		// names it once the layer is off — so it does not stay bound.
		const sockets = mkdtempSync(join(tmpdir(), "pi-snippet-sock-"));
		const h = setup(
			{},
			{ TERM_PROGRAM: "ghostty", PI_SNIPPET_SOCKET_DIR: sockets },
			{
				selectReply: (options) =>
					options.find((o) => o.startsWith("Suggestions:"))
					?? options.find((o) => o.startsWith("off —")),
			},
		);
		h.say(CHIPPED);
		expect(h.render(CHIPPED)).toMatch(/\]\(pisnip:\/\//);
		expect(readdirSync(sockets)).toHaveLength(1);
		await h.menu(); // Suggestions → off
		expect(readdirSync(sockets)).toHaveLength(0);
	});

	it("offers removal to someone with a handler, instead", async () => {
		process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pi-snippet-xdg-"));
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

	it("offers the one-time relay setup instead of desktop registration", async () => {
		// The desktop that would dispatch a click is the user's own machine, so
		// registering a handler here would write into a desktop nobody is
		// looking at. What this side can offer is the line to run there.
		const h = setup({}, SSH_ENV);
		const choices = await h.menu();
		expect(choices).toContainEqual(expect.stringContaining("SSH relay setup"));
		expect(choices).not.toContainEqual(expect.stringContaining("Register click handler"));
	});

	/** A client that has set relayed clicking up with this host. */
	const stampClient = (address: string): void => {
		const dir = process.env.PI_SNIPPET_RELAY_CLIENTS!;
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, address), "", "utf8");
	};

	const CONNECTION = { TERM_PROGRAM: "ghostty", SSH_CONNECTION: "10.1.0.7 51234 10.1.0.9 22" };

	describe("the relay, once the client has been set up", () => {
		// The relay costs nothing per session, so neither should turning it on:
		// a stamp left here by the client is the evidence that a chip URL will
		// reach somebody, and it is the only thing this decision rests on.
		it("paints URLs from the session start, with nothing asked of the user", async () => {
			stampClient("10.1.0.7");
			const h = setup({}, CONNECTION);
			h.start();
			h.say(CHIPPED);
			expect(h.render(CHIPPED)).toMatch(/\]\(pisnip:\/\/[0-9a-f]{8}\/[0-9a-f]{8}\/c1\)/);
			expect(h.notes.join("\n")).toContain("relays clicks back");
			const choices = await h.menu();
			// And says which delivery is painting them, because "on" with no
			// forward in sight reads like a bug to anyone who set one up before.
			expect(h.titles.join("\n")).toContain("relayed back over SSH");
			expect(choices).toContainEqual(expect.stringContaining("set up already"));
		});

		it("keeps the honest default for a client it has never heard from", () => {
			stampClient("10.1.0.8"); // some other machine, same host
			const h = setup({}, CONNECTION);
			h.start();
			h.say(CHIPPED);
			expect(h.render(CHIPPED)).toBe("Want me to ¹rebuild the solution?");
			expect(h.notes.join("\n")).not.toContain("relays clicks back");
		});

		it("says nothing twice, and nothing at all off SSH", () => {
			stampClient("10.1.0.7");
			const local = setup({}, { TERM_PROGRAM: "ghostty" });
			local.start();
			// A stamp is about clicks arriving from elsewhere; here the desktop
			// is the one in front of the user and clicking was never off.
			expect(local.notes.join("\n")).not.toContain("relays clicks back");

			const h = setup({}, CONNECTION);
			h.start();
			h.start("resume");
			expect(h.notes.filter((note) => note.includes("relays clicks back"))).toHaveLength(1);
		});
	});
});
