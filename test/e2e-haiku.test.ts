/**
 * Live end-to-end test against a real model (Claude Haiku 4.5).
 *
 * Spawns pi in RPC mode exactly the way the pi-clik server does — with the
 * pi-clik extension loaded and global extension discovery disabled — sends a
 * prompt engineered to elicit suggestions, and asserts that the model emits
 * well-formed <pi:suggest> tags that our parser accepts.
 *
 * Requires: `pi` on PATH with a working provider (default claude-bridge).
 * Run with `npm run test:e2e`. Skipped automatically when pi is missing.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSuggestions } from "../src/shared/suggestions.js";

const PROVIDER = process.env.PI_CLIK_TEST_PROVIDER ?? "claude-bridge";
const MODEL = process.env.PI_CLIK_TEST_MODEL ?? "claude-haiku-4-5";
const TIMEOUT_MS = 240_000;

const piAvailable = spawnSync("pi", ["--version"], { timeout: 10_000 }).status === 0;

function settingsPackages(): string[] {
	try {
		const settings = JSON.parse(
			readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
		) as { packages?: string[] };
		return settings.packages ?? [];
	} catch {
		return [];
	}
}

interface RpcRun {
	send(cmd: object): void;
	waitFor(predicate: (msg: any) => boolean, timeoutMs: number): Promise<any>;
	stop(): void;
}

function startRpc(): RpcRun {
	const here = dirname(fileURLToPath(import.meta.url));
	const extensionPath = join(here, "..", "dist", "extension", "pi-clik.js");
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		extensionPath,
		...settingsPackages().flatMap((p) => ["-e", p]),
		"--provider",
		PROVIDER,
		"--model",
		MODEL,
	];
	const cwd = mkdtempSync(join(tmpdir(), "pi-clik-e2e-"));
	const proc = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	proc.stderr.setEncoding("utf8");
	let stderr = "";
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
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			for (const l of [...listeners]) l(msg);
		}
	});

	return {
		send(cmd: object) {
			proc.stdin.write(`${JSON.stringify(cmd)}\n`);
		},
		waitFor(predicate, timeoutMs) {
			return new Promise((resolvePromise, reject) => {
				const timer = setTimeout(() => {
					listeners.splice(listeners.indexOf(onMsg), 1);
					reject(new Error(`timeout waiting for RPC message; stderr:\n${stderr.slice(-2000)}`));
				}, timeoutMs);
				const onMsg = (msg: any) => {
					if (predicate(msg)) {
						clearTimeout(timer);
						listeners.splice(listeners.indexOf(onMsg), 1);
						resolvePromise(msg);
					}
				};
				listeners.push(onMsg);
			});
		},
		stop() {
			proc.kill("SIGTERM");
		},
	};
}

describe.skipIf(!piAvailable)("e2e with live model", () => {
	it(
		"model emits parseable <pi:suggest> tags when asked a two-option question",
		async () => {
			const rpc = startRpc();
			try {
				rpc.send({
					id: "p1",
					type: "prompt",
					message:
						"I finished refactoring the auth module. Two obvious next steps: rebuild the project, or run the test suite. Ask me which I want.",
				});
				await rpc.waitFor((m) => m.type === "agent_end", TIMEOUT_MS);
				rpc.send({ id: "t1", type: "get_last_assistant_text" });
				const resp = await rpc.waitFor((m) => m.type === "response" && m.id === "t1", 15_000);
				expect(resp.success).toBe(true);
				const text: string = resp.data.text;

				const res = parseSuggestions(text);
				expect(res.suggestions.length).toBeGreaterThanOrEqual(1);
				expect(res.suggestions.length).toBeLessThanOrEqual(4);
				for (const s of res.suggestions) {
					expect(s.length).toBeGreaterThan(0);
					expect(s.length).toBeLessThanOrEqual(120);
				}
			} finally {
				rpc.stop();
			}
		},
		TIMEOUT_MS + 30_000,
	);

	it(
		"model emits no tags for a plain informational answer",
		async () => {
			const rpc = startRpc();
			try {
				rpc.send({
					id: "p1",
					type: "prompt",
					message: "State the capital of France in one short sentence.",
				});
				await rpc.waitFor((m) => m.type === "agent_end", TIMEOUT_MS);
				rpc.send({ id: "t1", type: "get_last_assistant_text" });
				const resp = await rpc.waitFor((m) => m.type === "response" && m.id === "t1", 15_000);
				const res = parseSuggestions(resp.data.text);
				expect(res.suggestions.length).toBe(0);
			} finally {
				rpc.stop();
			}
		},
		TIMEOUT_MS + 30_000,
	);
});
