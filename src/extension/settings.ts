/**
 * The `/snippets` toggles, persisted across sessions.
 *
 * Two settings: where chips come from (`mode`) and the Alt+digit shortcuts.
 * They need this file for the same reason as before — a preference about the
 * tool, not state of one conversation, so a fork or a resume must not carry a
 * different answer than a fresh start.
 *
 * Clicking is no longer a preference. It is always on, delivered by the
 * terminal's own Ctrl+click (`link-url.ts`), which has no terminal-wide costs
 * to opt out of: the wheel and selection are never taken away, so there is
 * nothing to toggle and nothing to persist. Where pi-tui reports the terminal
 * cannot paint a hyperlink no URL is painted and clicking is simply inert.
 *
 * Older settings files may still carry `clickEnabled`, `linkMode`,
 * `magicEnabled` or `model` keys, from switches and from a removed inference
 * layer that no longer exist; `merge` reads only the keys it knows and ignores
 * the rest, so a stale file costs nothing.
 *
 * The file lives outside the session store on purpose. pi has no settings or
 * key-value API for extensions — `ExtensionAPI` offers only `appendEntry()`,
 * which is session-scoped and branch-aware — so it is the wrong shape for a
 * preference. pi's own shipped extensions (`preset.ts`) keep their config in a
 * JSON file of their own next to pi's, and that is what this does:
 * `~/.pi/agent/pi-snippet.json`, beside `settings.json` and `presets.json`.
 *
 * Nothing here is allowed to be fatal. A missing file, an unreadable one, a
 * half-written one, a read-only home directory — each degrades to "defaults,
 * this session only" rather than taking the extension down with it.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Which of the two suggestion layers run.
 *
 * They are independent, so the setting is the four combinations rather than
 * an on/off plus a sub-switch: layer 1 is the primary model tagging its own
 * replies (which costs a system-prompt injection), layer 2 is a second model
 * tagging them afterwards (which costs a request per question-bearing
 * message). Wanting exactly one of those is an ordinary preference — `infer`
 * in particular is the way to get chips without putting anything in the
 * primary model's prompt.
 */
export type SnippetMode =
	/** No chips, no prompt injection, nothing sent to a second model. */
	| "off"
	/** Layer 1 only: the `<snippet>` tags the primary model writes itself. */
	| "tags"
	/** Both layers, the default. */
	| "both"
	/** Layer 2 only: the primary model is never asked to tag anything. */
	| "infer";

export const SNIPPET_MODES: readonly SnippetMode[] = ["off", "tags", "both", "infer"];

export interface SnippetSettings {
	mode: SnippetMode;
	hotkeysEnabled: boolean;
	/**
	 * The second model (`provider/id`), as chosen in `/snippets`. Undefined
	 * means the built-in default; `PI_SNIPPET_MODEL` overrides both for a
	 * session. Typed into the same `/snippets` prompt that sets it. Kept
	 * separate from `mode` so a mode that stands the layer down and back up
	 * remembers which model it was pointed at.
	 */
	inferModel?: string;
}

export const DEFAULT_SETTINGS: SnippetSettings = {
	mode: "both",
	hotkeysEnabled: true,
	inferModel: undefined,
};

/**
 * pi's agent directory, resolved the way pi resolves it (`getAgentDir()` in
 * its `config.ts`): `PI_CODING_AGENT_DIR` if set, `~/.pi/agent` otherwise.
 *
 * Deliberately re-derived in three lines rather than imported from
 * `@earendil-works/pi-coding-agent`: this extension bundles standalone and has
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
	if (typeof source.hotkeysEnabled === "boolean") settings.hotkeysEnabled = source.hotkeysEnabled;
	if (SNIPPET_MODES.includes(source.mode as SnippetMode)) settings.mode = source.mode as SnippetMode;
	// `mode` replaced a boolean `enabled`. Someone who had turned suggestions
	// off is the one case where dropping the old key silently does the wrong
	// thing, so that one is read across; every other dead key stays dead.
	else if (source.enabled === false) settings.mode = "off";
	if (typeof source.inferModel === "string" && source.inferModel.trim() !== "") settings.inferModel = source.inferModel;
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
			mode: settings.mode,
			hotkeysEnabled: settings.hotkeysEnabled,
			...(settings.inferModel ? { inferModel: settings.inferModel } : {}),
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
