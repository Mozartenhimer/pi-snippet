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
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	addRelayHost,
	HOST_PLACEHOLDER,
	install,
	isRelayHost,
	readRelayHosts,
	relayBootstrapLine,
	relayClientSeen,
	relayClientsDir,
	relayCommand,
	remotesPath,
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

	it("round-trips through the file, and clears on an empty host", () => {
		expect(readRelayHosts(env)).toEqual([]);
		expect(addRelayHost("mybox", env)).toBe(true);
		expect(readRelayHosts(env)).toEqual(["mybox"]);
		expect(addRelayHost("", env)).toBe(true);
		expect(readRelayHosts(env)).toEqual([]);
	});

	it("keeps every host named, newest first, without duplicating one", () => {
		// One machine in front of several remotes is the ordinary case; naming
		// the second must not cost the first, and naming the same one twice
		// must not grow the list the handler walks.
		expect(addRelayHost("mybox", env)).toBe(true);
		expect(addRelayHost("work", env)).toBe(true);
		expect(readRelayHosts(env)).toEqual(["work", "mybox"]);
		expect(addRelayHost("mybox", env)).toBe(true);
		expect(readRelayHosts(env)).toEqual(["mybox", "work"]);
	});

	it("still reads the single-host file earlier versions wrote", () => {
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(remotesPath(env), '{"host":"mybox"}', "utf8");
		expect(readRelayHosts(env)).toEqual(["mybox"]);
		// And adding to it migrates rather than dropping what was there.
		expect(addRelayHost("work", env)).toBe(true);
		expect(readRelayHosts(env)).toEqual(["work", "mybox"]);
	});

	it("drops the entries it cannot use and keeps the rest", () => {
		// A file with one bad name in it should still relay to the good ones —
		// but never to the bad one, and never to a host that is not a host.
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(
			remotesPath(env),
			JSON.stringify({ hosts: ["good", "a b", 5, null, "good", "evil;id"], host: "legacy" }),
			"utf8",
		);
		expect(readRelayHosts(env)).toEqual(["good", "legacy"]);
		// `hosts` of the wrong type is not a list at all, and says nothing about
		// `host` beside it.
		writeFileSync(remotesPath(env), JSON.stringify({ hosts: "mybox", host: "legacy" }), "utf8");
		expect(readRelayHosts(env)).toEqual(["legacy"]);
	});



	it("reads nothing out of a malformed or hostile file", () => {
		mkdirSync(join(home, "agent"), { recursive: true });
		const path = remotesPath(env);
		for (const body of ["", "{", "[]", "null", '{"host":5}', '{"host":"a b"}', '{"nope":"x"}']) {
			writeFileSync(path, body, "utf8");
			expect(readRelayHosts(env), body).toEqual([]);
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
			expect(readRelayHosts(env), body).toEqual([]);
		}
	});

	it("clears a list that was never written, without complaining", () => {
		// Clearing is idempotent: the state the user asked for is the state they
		// are already in, and a missing file is not a failure to report.
		expect(addRelayHost("", env)).toBe(true);
		expect(readRelayHosts(env)).toEqual([]);
	});

	it("refuses to record a host the handler would refuse to use", () => {
		// Checked on the way in as well as on the way out — a value that cannot
		// be relayed to should never reach the file in the first place.
		expect(addRelayHost("mybox; id", env)).toBe(false);
		expect(readRelayHosts(env)).toEqual([]);
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
			expect(relay("pisnip://a1b2c3d4/0f3e2a91/c3").status).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(lines.join("")).toBe("0f3e2a91/c3\n");
			// A session that is gone is a quiet non-zero, same as everywhere else.
			expect(relay("pisnip://deadbeef/0f3e2a91/c3").status).toBe(1);
		} finally {
			server.close();
			rmSync(sockDir, { recursive: true, force: true });
		}
	});
});

describe("the server's memory of a client", () => {
	/**
	 * The evidence a remote session paints chip URLs on: a stamp this host
	 * keeps for every client that has set relaying up with it. Written by the
	 * client, over ssh — which is the point, since only a connection from the
	 * client proves the relay can be made.
	 */
	const stamp = (address: string): void => {
		mkdirSync(relayClientsDir(env), { recursive: true });
		writeFileSync(join(relayClientsDir(env), address), "", "utf8");
	};

	it("knows a client that stamped this host, and nobody else", () => {
		expect(relayClientSeen("10.1.0.7", env)).toBe(false);
		stamp("10.1.0.7");
		expect(relayClientSeen("10.1.0.7", env)).toBe(true);
		expect(relayClientSeen("10.1.0.8", env)).toBe(false);
	});

	it("looks up nothing that is not an address", () => {
		// The stamp is a file name, so a value that is not an address is never
		// turned into a path — not even to ask whether it exists.
		for (const address of ["", "../../etc/passwd", "a b", "host;id", "x".repeat(46)]) {
			expect(relayClientSeen(address, env), JSON.stringify(address)).toBe(false);
		}
		for (const address of ["::1", "fe80::1c2b:3d4e", "::ffff:10.1.0.7"]) {
			stamp(address);
			expect(relayClientSeen(address, env), address).toBe(true);
		}
	});

	it("honours PI_SNIPPET_RELAY_CLIENTS over the agent directory", () => {
		expect(relayClientsDir(env)).toBe(join(home, "agent", "pi-snippet-relay-clients"));
		const explicit = join(home, "elsewhere");
		expect(relayClientsDir({ ...env, PI_SNIPPET_RELAY_CLIENTS: explicit })).toBe(explicit);
		// Exported-but-empty is the ordinary shape of "unset" in a shell.
		expect(relayClientsDir({ ...env, PI_SNIPPET_RELAY_CLIENTS: "" })).toBe(
			join(home, "agent", "pi-snippet-relay-clients"),
		);
	});
});

describe("the bootstrap line the client runs", () => {
	/** What its first half writes, read the way the handler reads it. */
	const onFile = (): unknown => {
		try {
			return JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-snippet-remotes.json"), "utf8"));
		} catch {
			return null;
		}
	};
	const run = (host: string) =>
		spawnSync("bash", ["-c", relayBootstrapLine(host, env).line.split(" && ssh ")[0]!], {
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

	it("carries the address to record and the ssh-back that records it here", () => {
		const { line, stamps } = relayBootstrapLine("mybox", env);
		expect(stamps).toBe(true);
		expect(line).toContain("pi-snippet-remotes.json");
		expect(line).toContain("&& ssh mybox 'mkdir -p ");
		expect(line).toContain(`cd ${relayClientsDir(env)} &&`);
		// Single-quoted, so it is the *remote* shell that expands it — the
		// client cannot name itself, which is the whole story of this stamp.
		expect(line).toContain('touch "${SSH_CONNECTION%% *}"');
		// And it is generatable before this host knows its own address, or the
		// automatic half vanishes for the sessions that most need explaining.
		expect(relayBootstrapLine(HOST_PLACEHOLDER, env).line).toContain(HOST_PLACEHOLDER);
	});

	it("drops the ssh-back rather than pasting a line that will not parse", () => {
		const odd = relayBootstrapLine("mybox", { ...env, PI_SNIPPET_RELAY_CLIENTS: "/tmp/a b" });
		expect(odd.stamps).toBe(false);
		expect(odd.line).not.toContain("ssh mybox");
		expect(odd.line).toContain("pi-snippet-remotes.json");
	});

	it.skipIf(!hasPython)("stamps the address the connection arrived from, run for real", () => {
		// What the remote shell would run, run in a shell: the quoting is the
		// thing under test, so the command is not reassembled here.
		const remote = relayBootstrapLine("mybox", env).line.split("&& ssh mybox ")[1]!.slice(1, -1);
		expect(
			spawnSync("bash", ["-c", remote], {
				env: { ...process.env, HOME: home, SSH_CONNECTION: "10.1.0.7 51234 10.1.0.9 22" },
				encoding: "utf8",
			}).status,
		).toBe(0);
		expect(relayClientSeen("10.1.0.7", env)).toBe(true);
	});

	it.skipIf(!hasPython)("adds each host named, keeping the ones already there", () => {
		// Run as the user runs it: this is a line pasted into a shell, and the
		// merge in it is the reason a second remote costs nothing.
		expect(run("mybox").status).toBe(0);
		expect(onFile()).toEqual({ hosts: ["mybox"] });
		expect(run("work").status).toBe(0);
		expect(onFile()).toEqual({ hosts: ["work", "mybox"] });
		// Twice for the same host is not two entries.
		expect(run("mybox").status).toBe(0);
		expect(onFile()).toEqual({ hosts: ["mybox", "work"] });
	});

	it.skipIf(!hasPython)("migrates the single-host file earlier versions wrote", () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "pi-snippet-remotes.json"), '{"host":"work"}', "utf8");
		expect(run("mybox").status).toBe(0);
		expect(onFile()).toEqual({ hosts: ["mybox", "work"] });
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
		addRelayHost("mybox", env);
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
		addRelayHost("mybox", env);
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
		addRelayHost("mybox", env);
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
		addRelayHost("mybox", env);
		writeFileSync(join(binDir, "ssh"), "#!/bin/sh\nexit 255\n", "utf8");
		chmodSync(join(binDir, "ssh"), 0o755);
		const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		// Configured but unreachable is the same situation as dead scrollback:
		// nothing to say, nothing to configure.
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	describe("more than one remote", () => {
		/** A list on file, in the order the handler should walk it. */
		const hostsOnFile = (hosts: string[]): void => {
			mkdirSync(join(home, "agent"), { recursive: true });
			writeFileSync(remotesPath(env), JSON.stringify({ hosts }), "utf8");
		};
		/** An `ssh` that answers for one host only, and records every attempt. */
		const sshAnswering = (host: string, mode = 0o755): void => {
			// One line per attempt, naming the host only: the argv is asserted
			// against the plain stub above, and the relay command in it spans
			// lines, which no line-oriented log survives.
			writeFileSync(
				join(binDir, "ssh"),
				`#!/usr/bin/env python3\nimport sys\n`
					+ `open(${JSON.stringify(sshLog)}, "a").write(sys.argv[5] + "\\n")\n`
					+ `sys.exit(0 if sys.argv[5] == ${JSON.stringify(host)} else 255)\n`,
				"utf8",
			);
			chmodSync(join(binDir, "ssh"), mode);
		};
		/** The host each recorded attempt went to, in order. */
		const tried = (): string[] => {
			try {
				return readFileSync(sshLog, "utf8").split("\n").filter((line) => line !== "");
			} catch {
				return [];
			}
		};
		/** Where the handler remembers which host answered for this session. */
		const cache = () => join(runtime, "pi-snippet-relay-a1b2c3d4");

		it("walks the list until a session answers, then goes straight there", () => {
			// The list is what makes a second remote free to add; the memory is
			// what stops every click on it paying for the dead hosts ahead of it.
			hostsOnFile(["dark", "good"]);
			sshAnswering("good");
			expect(runHandler("pisnip://a1b2c3d4/0f3e2a91/c3").status).toBe(0);
			expect(tried()).toEqual(["dark", "good"]);
			expect(readFileSync(cache(), "utf8")).toBe("good");

			rmSync(sshLog);
			expect(runHandler("pisnip://a1b2c3d4/0f3e2a91/c4").status).toBe(0);
			expect(tried()).toEqual(["good"]);
		});

		it("never relays anywhere the file does not name, whatever it remembers", () => {
			// The memory is a hint about order and nothing more: the file stays
			// the allowlist, so a tampered cache buys no new destination.
			hostsOnFile(["good"]);
			writeFileSync(cache(), "evil", "utf8");
			sshAnswering("good");
			expect(runHandler("pisnip://a1b2c3d4/0f3e2a91/c3").status).toBe(0);
			expect(tried()).toEqual(["good"]);
		});

		it("stays quiet when none of them answers, and remembers nothing", () => {
			hostsOnFile(["dark", "darker"]);
			sshAnswering("nobody");
			const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(tried()).toEqual(["dark", "darker"]);
			expect(existsSync(cache())).toBe(false);
		});

		it("carries on past an ssh it could not run at all", () => {
			// An `ssh` the OS refuses to exec is one host that cannot be reached,
			// not an answer about any of the others — and not a traceback.
			hostsOnFile(["dark", "good"]);
			sshAnswering("good", 0o644);
			const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
			expect(result.status).toBe(1);
			expect(result.stderr).toBe("");
			expect(tried()).toEqual([]);
		});
	});

	it("ignores a host the file should never have carried", () => {
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(remotesPath(env), '{"hosts":["mybox; id"]}', "utf8");
		const result = runHandler("pisnip://a1b2c3d4/0f3e2a91/c3");
		expect(result.status).toBe(1);
		expect(sshArgv()).toBeNull();
	});
});
