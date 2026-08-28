/**
 * The `/snippets` toggles, persisted across sessions.
 *
 * Click-to-insert is the toggle that most needs this: it is off by default
 * (mouse reporting costs wheel scrolling, see tui-mouse.ts), so anyone who
 * wants it wants it every session — turning it back on after each restart is
 * the whole friction. Suggestions and the Alt shortcuts ride along, so all
 * three switches behave the same way. The inference layer (PRD §17) rides
 * along too, together with the model it was told to use: picking a small model
 * once and re-picking it every session would be the same friction again.
 *
 * The file lives outside the session store on purpose: these are preferences
 * about the tool, not state of one conversation, so a fork or a resume must
 * not carry a different answer than a fresh start.
 *
 * pi has no settings or key-value API for extensions — `ExtensionAPI` offers
 * only `appendEntry()`, which is session-scoped and branch-aware, so it is the
 * wrong shape for a preference. Its own shipped extensions (`preset.ts`) keep
 * their config in a JSON file of their own next to pi's, and that is what this
 * does: `~/.pi/agent/pi-snippet.json`, beside `settings.json` and
 * `presets.json`.
 *
 * Nothing here is allowed to be fatal. A missing file, an unreadable one, a
 * half-written one, a read-only home directory — each degrades to "defaults,
 * this session only" rather than taking the extension down with it.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SnippetSettings {
	enabled: boolean;
	hotkeysEnabled: boolean;
	clickEnabled: boolean;
	/**
	 * *How* a click is delivered, not whether clicking is on.
	 *
	 * False is mouse reporting (`tui-mouse.ts`), which costs the wheel and
	 * shift-less selection while suggestions are on screen. True is
	 * terminal-resolved: the chip's href becomes a real URL, the terminal
	 * dispatches Ctrl+click to a registered handler, and none of those costs
	 * apply. It rides beside `clickEnabled` rather than replacing it because
	 * the two answer different questions, and because a machine that loses its
	 * handler registration should fall back to mouse rather than to nothing.
	 */
	linkMode: boolean;
	/** Layer 2 — infer replies for questions the model left untagged (PRD §17). */
	magicEnabled: boolean;
	/**
	 * Model pinned for inference, as `provider/id`, or null to auto-select.
	 *
	 * The one non-boolean here, and worth persisting for the same reason as the
	 * toggles: someone who picked a model in `/snippets` picked it about the
	 * tool, not about one conversation. `--snippet-model` and
	 * `PI_SNIPPET_MODEL` still override it, so a pin stored here is the
	 * least-specific source rather than a sticky trap.
	 */
	model: string | null;
}

/**
 * Clicking starts **on**, delivered by the terminal.
 *
 * It used to start off, and the reason was entirely about mouse reporting:
 * that path takes the wheel away from the terminal's own scrollback and makes
 * text selection need Shift, which is a bad trade for anyone who scrolls more
 * than they click. Link mode has none of those costs — the terminal resolves
 * the click itself — so the reason to default off went away with it, and what
 * is left is a feature that costs nothing until someone Ctrl+clicks.
 *
 * Two things keep that honest rather than presumptuous. Link mode paints no
 * URL at all where the terminal cannot render a hyperlink (`osc8.ts`), so it
 * can never leave `(pisnip://…)` sitting after every chip. And it never
 * silently falls back to mouse reporting: choosing link mode means links or
 * nothing, because a terminal-wide mode is precisely the thing nobody opted
 * into.
 *
 * Dispatch still needs a handler registered with the desktop, which is a
 * one-time `/snippets` action — a scheme handler is a change to the user's
 * system and is not something to do behind their back.
 */
export const DEFAULT_SETTINGS: SnippetSettings = {
	enabled: true,
	hotkeysEnabled: true,
	clickEnabled: true,
	linkMode: true,
	magicEnabled: true,
	model: null,
};

/**
 * pi's agent directory, resolved the way pi resolves it (`getAgentDir()` in
 * its `config.ts`): `PI_CODING_AGENT_DIR` if set, `~/.pi/agent` otherwise.
 *
 * Deliberately re-derived in three lines rather than imported from
 * `@mariozechner/pi-coding-agent`: this extension bundles standalone and has
 * no runtime dependency on pi, and one import for one path is not worth
 * pinning ourselves to a pi version. The cost is a rebranded distribution
 * (PRD H3), where pi renames both the directory and this variable — such a
 * build should set `PI_SNIPPET_SETTINGS`.
 */
function agentDir(env: NodeJS.ProcessEnv): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (configured === undefined || configured === "") return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	return configured.startsWith("~/") ? homedir() + configured.slice(1) : configured;
}

/**
 * Where the toggles live: beside pi's own `settings.json` and the
 * `presets.json` its example extension writes.
 *
 * `PI_SNIPPET_SETTINGS` names the file outright — tests point it at a temp
 * directory, and it is the escape hatch for a rebranded pi or an unwritable
 * agent directory.
 */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_SNIPPET_SETTINGS;
	if (override !== undefined && override !== "") return override;
	return join(agentDir(env), "pi-snippet.json");
}

/**
 * Take only the keys we know, and only when they hold the type we expect.
 *
 * A key whose stored value is the wrong type falls back to its default rather
 * than failing the whole read: one hand-edited field costs that field, not the
 * rest of the preferences.
 */
function merge(raw: unknown): SnippetSettings {
	const settings = { ...DEFAULT_SETTINGS };
	if (typeof raw !== "object" || raw === null) return settings;
	const source = raw as Record<string, unknown>;
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SnippetSettings)[]) {
		const value = source[key];
		if (key === "model") {
			// Empty string means "no pin", same as absent — it would resolve to
			// nothing anyway, and storing it would look like a broken model id.
			if (typeof value === "string" && value.trim() !== "") settings.model = value;
			else if (value === null) settings.model = null;
			continue;
		}
		if (typeof value === "boolean") settings[key] = value;
	}
	return settings;
}

/**
 * Read the toggles, falling back to defaults for anything missing, malformed,
 * or unreadable. A settings file someone hand-edited into invalid JSON costs
 * them their preferences, never their session.
 */
export function loadSettings(path: string = settingsPath()): SnippetSettings {
	try {
		return merge(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Write the toggles, and report whether it worked so the caller can say
 * "this session only" instead of quietly promising persistence it did not get.
 *
 * The write goes to a sibling temp file and is renamed into place: a crash
 * mid-write then leaves the previous settings intact rather than a truncated
 * file that reads as corrupt on the next start.
 */
export function saveSettings(settings: SnippetSettings, path: string = settingsPath()): boolean {
	const temp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const body: SnippetSettings = {
			enabled: settings.enabled,
			hotkeysEnabled: settings.hotkeysEnabled,
			clickEnabled: settings.clickEnabled,
			linkMode: settings.linkMode,
			magicEnabled: settings.magicEnabled,
			model: settings.model,
		};
		writeFileSync(temp, `${JSON.stringify(body, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
		return true;
	} catch {
		try {
			unlinkSync(temp);
		} catch {
			// nothing to clean up, or we cannot clean it up; either way, not fatal
		}
		return false;
	}
}
