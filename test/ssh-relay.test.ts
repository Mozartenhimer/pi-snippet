/**
 * Relaying a click back over SSH (docs/ssh-back-handler.md).
 *
 * The interesting half of this feature is a python script this repo generates
 * and never imports, so most of what follows *runs* the generated handler
 * rather than reading it: a handler that parses but relays to the wrong place,
 * or hangs, or shells out on a malformed URL, would pass every assertion made
 * against its text. `ssh` on the handler's PATH is a recording stub, so the
 * argv it would really use is observable without a second machine — the real
 * wire is `scripts/ssh-click-docker.py`.
 *
 * Skipped where python3 is absent: `npm test` may not assume an interpreter it
 * does not install, and a silent pass would be worse than a visible skip.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	install,
	isRelayHost,
	readRelayHost,
	relayCommand,
	remotesPath,
	writeRelayHost,
} from "../src/extension/link-install.js";

const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-snippet-relay-"));
	env = {
		HOME: home,
		XDG_DATA_HOME: join(home, "data"),
		XDG_CONFIG_HOME: join(home, "config"),
		PI_CODING_AGENT_DIR: join(home, "agent"),
	};
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("the relay host on file", () => {
	it("accepts ssh aliases and hostnames", () => {
		for (const host of ["mybox", "box.example.com", "user@host", "a-b_c.d", "h1"]) {
			expect(isRelayHost(host), host).toBe(true);
		}
	});

	it("refuses anything a shell could act on", () => {
		// The value reaches an ssh argv in the handler, so the shape is the
		// guard — not quoting around whatever arrives.
		for (const host of ["", "a b", "a;b", "a$(id)", "a|b", "a&b", "a>b", "-oProxyCommand=x y", "a\nb"]) {
			expect(isRelayHost(host), JSON.stringify(host)).toBe(false);
		}
		expect(isRelayHost("h".repeat(256))).toBe(false);
	});

	it("round-trips through the file, and clears with an empty host", () => {
		expect(readRelayHost(env)).toBeNull();
		expect(writeRelayHost("mybox", env)).toBe(true);
		expect(readRelayHost(env)).toBe("mybox");
		expect(writeRelayHost("", env)).toBe(true);
		expect(readRelayHost(env)).toBeNull();
	});

	it("reads nothing out of a malformed or hostile file", () => {
		mkdirSync(join(home, "agent"), { recursive: true });
		const path = remotesPath(env);
		for (const body of ["", "{", "[]", "null", '{"host":5}', '{"host":"a b"}', '{"nope":"x"}']) {
			writeFileSync(path, body, "utf8");
			expect(readRelayHost(env), body).toBeNull();
		}
	});

	it("honours PI_SNIPPET_REMOTES over the agent directory", () => {
		const explicit = join(home, "elsewhere.json");
		expect(remotesPath({ ...env, PI_SNIPPET_REMOTES: explicit })).toBe(explicit);
		expect(remotesPath(env)).toBe(join(home, "agent", "pi-snippet-remotes.json"));
	});

	it("treats an empty PI_SNIPPET_REMOTES as no override at all", () => {
		// An exported-but-empty variable is the ordinary shape of "unset" in a
		// shell, and a relay host written to "" would be written nowhere.
		expect(remotesPath({ ...env, PI_SNIPPET_REMOTES: "" })).toBe(
			join(home, "agent", "pi-snippet-remotes.json"),
		);
	});

	it("reads nothing out of valid JSON that is not an object", () => {
		mkdirSync(join(home, "agent"), { recursive: true });
		for (const body of ["123", '"mybox"', "true"]) {
			writeFileSync(remotesPath(env), body, "utf8");
			expect(readRelayHost(env), body).toBeNull();
		}
	});

	it("clears a host that was never written, without complaining", () => {
		// Clearing is idempotent: the state the user asked for is the state they
		// are already in, and a missing file is not a failure to report.
		expect(writeRelayHost("", env)).toBe(true);
		expect(readRelayHost(env)).toBeNull();
	});

	it("refuses to record a host the handler would refuse to use", () => {
		// Checked on the way in as well as on the way out — a value that cannot
		// be relayed to should never reach the file in the first place.
		expect(writeRelayHost("mybox; id", env)).toBe(false);
		expect(readRelayHost(env)).toBeNull();
	});
});

describe("the relay command", () => {
	it("carries no apostrophe inside its single-quoted body", () => {
		// `ssh host cmd arg` hands the whole line to a remote shell, so the
		// one-liner is a single-quoted word; one apostrophe in it would end the
		// quote and hand python's source to the shell.
		const command = relayCommand();
		const body = command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"));
		expect(body).not.toContain("'");
		expect(command.startsWith("python3 -c '")).toBe(true);
	});

	it("walks the same socket directories the local handler does", () => {
		// One list, three processes, two machines. A divergence is a silent miss.
		for (const marker of ["PI_SNIPPET_SOCKET_DIR", "XDG_RUNTIME_DIR", "pi-snippet-%d"]) {
			expect(relayCommand()).toContain(marker);
		}
	});

	it.skipIf(!hasPython)("is valid python", () => {
		const command = relayCommand();
		const body = command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"));
		expect(() => execFileSync("python3", ["-c", `import ast,sys; ast.parse(sys.stdin.read())`], {
			input: body,
		})).not.toThrow();
	});
});

describe.skipIf(!hasPython)("the generated handler, run", () => {
	let sockDir: string;
	let binDir: string;
	let sshLog: string;
	let handler: string;
	let runtime: string;

	beforeEach(() => {
		handler = install(env).handler;
		sockDir = join(home, "sockets");
		runtime = join(home, "runtime");
		binDir = join(home, "bin");
		sshLog = join(home, "ssh-argv.txt");
		mkdirSync(sockDir, { recursive: true });
		mkdirSync(runtime, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		// A recording stub, so the argv a real relay would use is observable.
		writeFileSync(
			join(binDir, "ssh"),
			`#!/usr/bin/env python3\nimport sys\nopen(${JSON.stringify(sshLog)}, "w").write("\\u0000".join(sys.argv[1:]))\n`,
			"utf8",
		);
		chmodSync(join(binDir, "ssh"), 0o755);
	});

	const runHandler = (url: string, extra: NodeJS.ProcessEnv = {}) =>
		spawnSync("python3", [handler, url], {
			env: {
				HOME: home,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				PI_SNIPPET_SOCKET_DIR: sockDir,
				XDG_RUNTIME_DIR: runtime,
				PI_CODING_AGENT_DIR: join(home, "agent"),
				...extra,
			},
			encoding: "utf8",
			timeout: 15_000,
		});

	const sshArgv = (): string[] | null => {
		try {
			return readFileSync(sshLog, "utf8").split("\u0000");
		} catch {
			return null;
		}
	};

	it("delivers to a live local socket and never relays", async () => {
		writeRelayHost("mybox", env);
		const lines: string[] = [];
		const server: Server = createServer((socket) => {
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => lines.push(chunk));
		});
		await new Promise<void>((resolve) => server.listen(join(sockDir, "a1b2c3d4.sock"), resolve));
		try {
			const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
			expect(result.status).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(lines.join("")).toBe("0f3e2a91/c3\n");
			// The local path is still the fast path; the wire is a fallback.
			expect(sshArgv()).toBeNull();
		} finally {
			server.close();
		}
	});

	it("relays through ssh when nothing local answers", () => {
		writeRelayHost("mybox", env);
		const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		expect(result.status).toBe(0);
		const argv = sshArgv();
		expect(argv).not.toBeNull();
		// BatchMode so a click never hangs on a password or host-key prompt,
		// and a connect timeout so a dark host costs seconds.
		expect(argv).toContain("-o");
		expect(argv).toContain("BatchMode=yes");
		expect(argv).toContain("ConnectTimeout=3");
		// The host comes from the file, and the URL is its own argument.
		expect(argv).toContain("mybox");
		expect(argv?.[argv.length - 1]).toBe("pisnip://a1b2c3d4/0f3e2a91/c3");
		expect(argv?.[argv.length - 2]).toBe(relayCommand());
	});

	it("stays quiet and exits 1 when no host is configured", () => {
		const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		expect(result.status).toBe(1);
		expect(sshArgv()).toBeNull();
	});

	it("explains the unconfigured case at most once an hour, per token", () => {
		// notify-send is absent here, so the observable is the stamp file the
		// rate limit is built on — which is what the design says to assert.
		runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		const stamp = join(runtime, "pi-snippet-unconfigured-a1b2c3d4");
		expect(() => readFileSync(stamp)).not.toThrow();
		const first = readFileSync(stamp, "utf8");
		runHandler("pisnip://a1b2c3d4/0f3e2a91/c4");
		expect(readFileSync(stamp, "utf8")).toBe(first);
	});

	it("refuses a malformed URL before anything can shell out", () => {
		writeRelayHost("mybox", env);
		for (const url of [
			"pisnip://a1b2c3d4/nothex/c1",
			"pisnip://a1b2c3d4/0f3e2a91/c1;id",
			"pisnip://a1b2c3d4/0f3e2a91/$(id)",
			"pisnip://not-alnum/0f3e2a91/c1",
			"http://a1b2c3d4/0f3e2a91/c1",
			"pisnip://a1b2c3d4/0f3e2a91/c1 extra",
			"",
		]) {
			const result = runHandler(url);
			expect(result.status, url).toBe(2);
			expect(sshArgv(), url).toBeNull();
		}
	});

	it("passes a relay failure through as a quiet non-zero exit", () => {
		writeRelayHost("mybox", env);
		writeFileSync(join(binDir, "ssh"), "#!/bin/sh\nexit 255\n", "utf8");
		chmodSync(join(binDir, "ssh"), 0o755);
		const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		// Configured but unreachable is the same situation as dead scrollback:
		// nothing to say, nothing to configure.
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it("ignores a host the file should never have carried", () => {
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(remotesPath(env), '{"host":"mybox; id"}', "utf8");
		const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		expect(result.status).toBe(1);
		expect(sshArgv()).toBeNull();
	});
});
