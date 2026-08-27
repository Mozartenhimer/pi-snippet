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
 * Click starts off: mouse mode is a real cost, so it is opt-in. Inference is
 * on but inert until it — its anchors are click-only, so it spends nothing
 * until there is something that could activate them.
 */
export const DEFAULT_SETTINGS: SnippetSettings = {
	enabled: true,
	hotkeysEnabled: true,
	clickEnabled: false,
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
