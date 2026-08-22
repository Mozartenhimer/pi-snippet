/**
 * pi-clik server.
 *
 * Spawns `pi --mode rpc` with the pi-clik extension loaded, serves the web
 * client, and bridges the RPC JSONL protocol to browsers over a WebSocket:
 * client messages go to pi's stdin verbatim, pi's stdout lines are broadcast
 * to every connected client verbatim.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));

interface Options {
	port: number;
	piBin: string;
	cwd: string;
	open: boolean;
	isolate: boolean;
	piArgs: string[];
}

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		port: 3141,
		piBin: "pi",
		cwd: process.cwd(),
		open: true,
		isolate: false,
		piArgs: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
		else if (a === "--pi-bin" && argv[i + 1]) opts.piBin = argv[++i]!;
		else if (a === "--cwd" && argv[i + 1]) opts.cwd = resolve(argv[++i]!);
		else if (a === "--no-open") opts.open = false;
		else if (a === "--isolate") opts.isolate = true;
		else if (a === "--help" || a === "-h") {
			console.log(
				"usage: pi-clik [--port 3141] [--cwd dir] [--pi-bin pi] [--no-open] [--isolate] [-- <extra pi args>]",
			);
			process.exit(0);
		} else if (a === "--") {
			opts.piArgs.push(...argv.slice(i + 1));
			break;
		} else {
			opts.piArgs.push(a);
		}
	}
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
const extensionPath = join(here, "extension", "pi-clik.js");

/**
 * Normal runs use pi's regular extension discovery plus the pi-clik
 * extension. `--isolate` instead runs pi with `--no-extensions` and re-adds
 * only the extension packages configured in ~/.pi/agent/settings.json
 * (keeping provider bridges working). Use it when a globally installed
 * extension interferes with the suggestion tags — e.g. a TUI suggestion
 * extension that rewrites <pi:suggest> spans in stored messages at
 * message_end, destroying them before the web client can render chips.
 */
function extensionArgs(): string[] {
	if (!opts.isolate) return ["-e", extensionPath];
	const args = ["--no-extensions", "-e", extensionPath];
	try {
		const settings = JSON.parse(
			readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
		) as { packages?: string[] };
		for (const pkg of settings.packages ?? []) args.push("-e", pkg);
	} catch {
		/* no settings file: nothing to re-add */
	}
	return args;
}

// ---------------------------------------------------------------------------
// pi process
// ---------------------------------------------------------------------------

let pi: ChildProcessWithoutNullStreams;
const clients = new Set<WebSocket>();

function broadcast(line: string): void {
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) client.send(line);
	}
}

function startPi(): void {
	const args = ["--mode", "rpc", ...extensionArgs(), ...opts.piArgs];
	console.log(`[pi-clik] starting: ${opts.piBin} ${args.join(" ")} (cwd: ${opts.cwd})`);
	pi = spawn(opts.piBin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });

	let buf = "";
	pi.stdout.setEncoding("utf8");
	pi.stdout.on("data", (chunk: string) => {
		buf += chunk;
		// Strict JSONL: records are separated by LF only.
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim().length > 0) broadcast(line);
		}
	});
	pi.stderr.setEncoding("utf8");
	pi.stderr.on("data", (chunk: string) => process.stderr.write(`[pi] ${chunk}`));
	pi.on("exit", (code) => {
		console.error(`[pi-clik] pi exited with code ${code}`);
		broadcast(JSON.stringify({ type: "pi-clik", event: "proc-exit", code }));
	});
	pi.on("error", (err) => {
		console.error(`[pi-clik] failed to start pi: ${err.message}`);
		broadcast(JSON.stringify({ type: "pi-clik", event: "proc-exit", code: -1 }));
	});
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const webRoot = join(here, "web");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json",
	".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
	const url = (req.url ?? "/").split("?")[0]!;
	const path = url === "/" ? "/index.html" : url;
	if (path.includes("..")) {
		res.writeHead(400).end();
		return;
	}
	try {
		const data = await readFile(join(webRoot, path));
		res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		res.writeHead(404).end("not found");
	}
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
	clients.add(socket);
	socket.on("message", (data) => {
		const line = data.toString();
		try {
			JSON.parse(line); // Only forward well-formed JSON commands.
		} catch {
			return;
		}
		if (pi.exitCode === null) pi.stdin.write(`${line}\n`);
	});
	socket.on("close", () => clients.delete(socket));
});

startPi();
server.listen(opts.port, () => {
	const url = `http://localhost:${opts.port}`;
	console.log(`[pi-clik] web client at ${url}`);
	if (opts.open) {
		const opener =
			process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		try {
			spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
		} catch {
			/* best effort */
		}
	}
});

process.on("SIGINT", () => {
	pi?.kill("SIGTERM");
	process.exit(0);
});
process.on("SIGTERM", () => {
	pi?.kill("SIGTERM");
	process.exit(0);
});
