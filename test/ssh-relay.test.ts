/**
 * Relaying a click back over SSH (docs/ssh-back-handler.md, ADR 0001).
 *
 * The interesting half of this feature is a python script this repo generates
 * and never imports, so most of what follows *runs* the generated handler
 * rather than reading it: a handler that parses but relays to the wrong place,
 * or hangs, or shells out on a malformed URL, would pass every assertion made
 * against its text. `ssh` on the handler's PATH is a recording stub, so the
 * argv it would really use is observable without a second machine — the real
 * wire is `scripts/ssh-click-docker.py`.
 *
 * Since the host comes from the URL rather than from a file the user wrote,
 * the shape of that host is the whole safety argument on this side (ssh's own
 * `known_hosts` is the other half, and only a real `ssh` can enforce it). So
 * the refusals below are as load-bearing as the deliveries.
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

import { install, relayCommand } from "../src/extension/link-install.js";
import { isLinkHost } from "../src/shared/link-url.js";

const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;

/** A URL for this machine, and one for somewhere else. */
const HERE = "pisnip://testbox/a1b2c3d4/0f3e2a91/c3";
const THERE = "pisnip://mybox/a1b2c3d4/0f3e2a91/c3";

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

	/** The python `ssh` would hand to a shell on the far end. */
	const body = (): string => {
		const command = relayCommand();
		return command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"));
	};

	it.skipIf(!hasPython)("is valid python", () => {
		expect(() => execFileSync("python3", ["-c", `import ast,sys; ast.parse(sys.stdin.read())`], {
			input: body(),
		})).not.toThrow();
	});

	/**
	 * Run where it really runs: on the far end, as the command `ssh` hands to a
	 * shell there. The container harness covers the wire; this covers the
	 * python, without two machines.
	 */
	it.skipIf(!hasPython)("writes the click to the session socket", async () => {
		const sockDir = mkdtempSync(join(tmpdir(), "pi-snippet-relay-sock-"));
		const lines: string[] = [];
		const server: Server = createServer((socket) => {
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => lines.push(chunk));
		});
		await new Promise<void>((resolve) => server.listen(join(sockDir, "a1b2c3d4.sock"), resolve));
		try {
			const relay = (url: string) =>
				spawnSync("python3", ["-c", body(), url], {
					env: { ...process.env, PI_SNIPPET_SOCKET_DIR: sockDir },
					encoding: "utf8",
					timeout: 15_000,
				});
			// The token is the *second* segment now — the host took the netloc —
			// and only the two segments after it go on the wire.
			expect(relay(THERE).status).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(lines.join("")).toBe("0f3e2a91/c3\n");
			// A session that is gone is a quiet non-zero, same as everywhere else.
			expect(relay("pisnip://mybox/deadbeef/0f3e2a91/c3").status).toBe(1);
			// And a shape this end cannot make sense of is refused rather than
			// guessed at: it names the socket file, and nothing here knows what
			// validated the URL on the machine that sent it.
			expect(relay("pisnip://mybox/0f3e2a91/c3").status).toBe(2);
			expect(relay("pisnip://mybox/not-alnum/0f3e2a91/c3").status).toBe(2);
		} finally {
			server.close();
			rmSync(sockDir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!hasPython)("the host pattern, in both languages", () => {
	// `isLinkHost()` is the pattern; the handler is a standalone script that
	// imports nothing of ours and carries its own copy. Two copies of a
	// security guard is one more than there should be, so this is the thing
	// that catches them drifting apart.
	it("says the same thing in the handler as it does in TypeScript", () => {
		const handler = readFileSync(install(env).handler, "utf8");
		const pattern = /re\.match\(r"(\\A\[A-Za-z0-9\][^"]*\\Z)", u\.netloc\)/.exec(handler);
		expect(pattern, "no host pattern found in the generated handler").not.toBeNull();
		const hosts = [
			"mybox", "box.example.com", "user@host", "a-b_c.d", "h1", "localhost",
			"", "-", "--", "-Jevil.com", "-oProxyCommand=x", "a b", "a;b", "a$(id)",
			"a|b", "a&b", "a>b", "h".repeat(255), "h".repeat(256),
			// python's `$` also matches before a trailing newline; JavaScript's
			// does not. `\\A`/`\\Z` is what keeps this one input agreeing.
			"mybox\n",
		];
		const inPython = JSON.parse(
			execFileSync("python3", ["-c", [
				"import json,re,sys",
				`rx = re.compile(${JSON.stringify((pattern as RegExpExecArray)[1])})`,
				"print(json.dumps([bool(rx.match(h)) for h in json.load(sys.stdin)]))",
			].join("\n")], { input: JSON.stringify(hosts), encoding: "utf8" }),
		);
		expect(inPython).toEqual(hosts.map(isLinkHost));
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
				// What this machine calls itself, so "is that host me?" is a
				// decision the test controls rather than one the box it runs on
				// makes.
				PI_SNIPPET_HOST: "testbox",
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
		const lines: string[] = [];
		const server: Server = createServer((socket) => {
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => lines.push(chunk));
		});
		await new Promise<void>((resolve) => server.listen(join(sockDir, "a1b2c3d4.sock"), resolve));
		try {
			// Even a URL naming another host: the local scan comes first, so a
			// local click never touches the network and never notices the shape
			// changed.
			const result = runHandler(THERE);
			expect(result.status).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(lines.join("")).toBe("0f3e2a91/c3\n");
			expect(sshArgv()).toBeNull();
		} finally {
			server.close();
		}
	});

	it("relays to the host the URL names when nothing local answers", () => {
		const result = runHandler(THERE);
		expect(result.status).toBe(0);
		const argv = sshArgv();
		expect(argv).not.toBeNull();
		// BatchMode so a click never hangs on a password or host-key prompt —
		// and so an unknown host is refused rather than trusted, which is what
		// stands in for the allowlist this used to keep. A connect timeout so a
		// dark host costs seconds.
		expect(argv).toContain("-o");
		expect(argv).toContain("BatchMode=yes");
		expect(argv).toContain("ConnectTimeout=3");
		// `--` immediately before the host, so a name that somehow got past the
		// pattern still cannot be read as an option.
		expect(argv?.slice(-4)).toEqual(["--", "mybox", relayCommand(), THERE]);
	});

	it("passes the relay's own verdict back out", () => {
		writeFileSync(join(binDir, "ssh"), "#!/bin/sh\nexit 255\n", "utf8");
		chmodSync(join(binDir, "ssh"), 0o755);
		const result = runHandler(THERE);
		// Unreachable is the same situation as dead scrollback: nothing to say,
		// and nothing to configure either.
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it("carries on quietly past an ssh it could not run at all", () => {
		chmodSync(join(binDir, "ssh"), 0o644);
		const result = runHandler(THERE);
		expect(result.status).toBe(1);
		expect(result.stderr).toBe("");
	});

	it("never ssh-es to itself for a click its own scrollback painted", () => {
		// One URL shape everywhere means a local session names itself too. With
		// no socket listening the click is dead, and dying here is the point:
		// an ssh to ourselves would only fail again, slower.
		for (const url of [HERE, "pisnip://TestBox.example.com/a1b2c3d4/0f3e2a91/c3", "pisnip://localhost/a1b2c3d4/0f3e2a91/c3"]) {
			expect(runHandler(url).status, url).toBe(1);
			expect(sshArgv(), url).toBeNull();
		}
	});

	it("knows its own name without being told", () => {
		// PI_SNIPPET_HOST is the escape hatch, not the mechanism: with it unset
		// the handler still recognises the machine it is running on.
		const own = execFileSync("python3", ["-c", "import socket;print(socket.gethostname())"], {
			encoding: "utf8",
		}).trim();
		expect(runHandler(`pisnip://${own}/a1b2c3d4/0f3e2a91/c3`, { PI_SNIPPET_HOST: "" }).status).toBe(1);
		expect(sshArgv()).toBeNull();
	});

	it("refuses a malformed URL before anything can shell out", () => {
		for (const url of [
			"pisnip://mybox/a1b2c3d4/nothex/c1",
			"pisnip://mybox/a1b2c3d4/0f3e2a91/c1;id",
			"pisnip://mybox/a1b2c3d4/0f3e2a91/$(id)",
			"pisnip://mybox/not-alnum/0f3e2a91/c1",
			"pisnip://mybox/0f3e2a91/c1",
			"http://mybox/a1b2c3d4/0f3e2a91/c1",
			"pisnip://mybox/a1b2c3d4/0f3e2a91/c1 extra",
			"",
		]) {
			const result = runHandler(url);
			expect(result.status, url).toBe(2);
			expect(sshArgv(), url).toBeNull();
		}
	});

	it("refuses a host ssh would read as an option, or a shell would act on", () => {
		// The guard that had to ship with the URL naming its own server: the old
		// host pattern accepted `-Jevil.com`, which was harmless while only the
		// user could write it and is not once it arrives in a URL.
		for (const host of ["-Jevil.com", "-oProxyCommand=x", "-", "my box", "evil;id", "a$(id)"]) {
			const result = runHandler(`pisnip://${host}/a1b2c3d4/0f3e2a91/c3`);
			expect(result.status, host).toBe(2);
			expect(sshArgv(), host).toBeNull();
		}
	});
});
