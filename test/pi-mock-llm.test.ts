/**
 * The inference layer, driven through real pi against a mock LLM.
 *
 * The unit tests stub `ctx.modelRegistry.complete` directly, which proves the
 * logic but not the wiring: whether pi's own lifecycle actually reaches the
 * layer, whether a real `ModelRegistry` accepts the call we build, and whether
 * the cost gates hold where it counts. This test closes that gap without a
 * network or a credential — `test/fixtures/mock-llm.js` registers a provider
 * whose completions come from a function (`ProviderConfig.streamSimple`), so a
 * real pi process runs a real session against a model that is entirely
 * scripted.
 *
 * The mock plays both parts: the primary model answering the user, and the
 * small model answering the inference layer. It logs every request it is
 * asked for, and most of what is asserted here is which requests *didn't*
 * happen — the four gates of PRD §17.2 are all "spend nothing when …".
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INFER_SYSTEM_PROMPT, parseInferred } from "../src/shared/inferred.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const EXTENSION = join(root, "dist", "extension", "pi-snippet-tui.js");
const FIXTURE = join(here, "fixtures", "mock-llm.js");

/** pi on PATH (the snap), else the npm one in node_modules. */
function findPi(): string | undefined {
	if (spawnSync("pi", ["--version"], { timeout: 15_000 }).status === 0) return "pi";
	const local = join(root, "node_modules", ".bin", "pi");
	if (existsSync(local) && spawnSync(local, ["--version"], { timeout: 15_000 }).status === 0) {
		return local;
	}
	return undefined;
}

const PI = findPi();
const BUILT = existsSync(EXTENSION);

/** The slice of the real contract the fixture uses to spot an inference call. */
const INFER_MARKER = INFER_SYSTEM_PROMPT.slice(0, 48);

const QUESTION = "I'm done the model, do you want to see it?";
const ANCHORS = '[{"anchor":"do you want to see it?","reply":"Show me the model."}]';

interface MockRequest {
	kind: "primary" | "infer";
	model: string;
	systemPromptHead: string;
	userText: string;
	reply: string;
}

/**
 * Run one pi session against the mock: send a prompt per scripted reply, then
 * let any inference settle before reading the log.
 */
async function runSession(options: {
	script: string[];
	infer?: string;
	click?: boolean;
	settleMs?: number;
}): Promise<MockRequest[]> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-snippet-mock-"));
	const log = join(cwd, "requests.jsonl");
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		FIXTURE,
		"-e",
		EXTENSION,
		"--provider",
		"mockllm",
		"--model",
		"mock-small",
	];

	// Clicking is on by default now, so the interesting case is turning it off,
	// and mouse delivery is what this test's terminal can actually do.
	const settings = join(cwd, "pi-snippet.json");
	writeFileSync(
		settings,
		JSON.stringify({
			enabled: true,
			hotkeysEnabled: true,
			clickEnabled: options.click !== false,
			linkMode: false,
			magicEnabled: true,
			model: null,
		}),
		"utf8",
	);
	const proc = spawn(PI!, args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_SNIPPET_SETTINGS: settings,
			MOCK_LLM_LOG: log,
			MOCK_LLM_INFER_MARKER: INFER_MARKER,
			MOCK_LLM_SCRIPT: JSON.stringify(options.script),
			MOCK_LLM_INFER: options.infer ?? ANCHORS,
		},
	});

	let stderr = "";
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d: string) => {
		stderr += d;
	});

	const listeners: Array<(msg: any) => void> = [];
	let buf = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		buf += chunk;
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				for (const l of [...listeners]) l(msg);
			} catch {
				/* not a protocol line */
			}
		}
	});

	const waitFor = (predicate: (msg: any) => boolean, timeoutMs: number) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.splice(listeners.indexOf(onMsg), 1);
				reject(new Error(`timeout waiting for pi; stderr:\n${stderr.slice(-2000)}`));
			}, timeoutMs);
			const onMsg = (msg: any) => {
				if (!predicate(msg)) return;
				clearTimeout(timer);
				listeners.splice(listeners.indexOf(onMsg), 1);
				resolve();
			};
			listeners.push(onMsg);
		});

	try {
		for (let turn = 0; turn < options.script.length; turn++) {
			proc.stdin.write(`${JSON.stringify({ id: `p${turn}`, type: "prompt", message: `turn ${turn}` })}\n`);
			await waitFor((m) => m.type === "agent_end", 60_000);
		}
		// Inference starts at message_end and nobody awaits it; give it room to
		// land — and, for the negative cases, room to prove it never does.
		await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 2_000));
	} finally {
		proc.kill("SIGTERM");
	}

	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as MockRequest);
}

const missing = !PI ? "pi not found" : !BUILT ? "dist not built (npm run build)" : "";

describe.skipIf(missing !== "")(`inference layer against a mock LLM in real pi${missing && ` — skipped: ${missing}`}`, () => {
	it(
		"asks the small model about an untagged question, and believes the answer",
		async () => {
			const requests = await runSession({ script: [QUESTION] });

			const primary = requests.filter((r) => r.kind === "primary");
			const infer = requests.filter((r) => r.kind === "infer");
			expect(primary).toHaveLength(1);
			expect(infer).toHaveLength(1);

			// The request carries our contract and the assistant's own words.
			expect(INFER_SYSTEM_PROMPT.startsWith(infer[0]!.systemPromptHead)).toBe(true);
			expect(infer[0]!.userText).toContain(QUESTION);
			expect(infer[0]!.userText).toContain("<assistant_message>");
			expect(infer[0]!.model).toBe("mock-small");

			// And what came back is what the layer would have underlined.
			expect(parseInferred(infer[0]!.reply, QUESTION)).toEqual([
				{ anchor: "do you want to see it?", reply: "Show me the model." },
			]);
		},
		120_000,
	);

	it(
		"spends nothing on a message the model already tagged, or one that asks nothing",
		async () => {
			const requests = await runSession({
				script: [
					"Want me to <snippet>rebuild the solution</snippet>?",
					"I've pushed the branch and CI is green.",
				],
			});

			expect(requests.filter((r) => r.kind === "primary")).toHaveLength(2);
			expect(requests.filter((r) => r.kind === "infer")).toHaveLength(0);
		},
		120_000,
	);

	it(
		"reads the same question once, however often it is asked",
		async () => {
			const requests = await runSession({ script: [QUESTION, QUESTION, QUESTION] });

			expect(requests.filter((r) => r.kind === "primary")).toHaveLength(3);
			expect(requests.filter((r) => r.kind === "infer")).toHaveLength(1);
		},
		120_000,
	);

	it(
		"spends nothing while click-to-insert is off, since nothing could reach the result",
		async () => {
			const requests = await runSession({ script: [QUESTION], click: false });

			expect(requests.filter((r) => r.kind === "primary")).toHaveLength(1);
			expect(requests.filter((r) => r.kind === "infer")).toHaveLength(0);
		},
		120_000,
	);

	it(
		"underlines nothing when the small model paraphrases the span",
		async () => {
			const requests = await runSession({
				script: [QUESTION],
				infer: '[{"anchor":"Do you want to see it","reply":"Show me the model."}]',
			});

			const infer = requests.filter((r) => r.kind === "infer");
			expect(infer).toHaveLength(1);
			// The call happened; the answer simply isn't supported by the message.
			expect(parseInferred(infer[0]!.reply, QUESTION)).toEqual([]);
		},
		120_000,
	);
});
