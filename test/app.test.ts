// @vitest-environment happy-dom
/**
 * Integration test: boots the real web client (src/web/main.ts) against a
 * fake WebSocket, streams an assistant message whose suggestion tag is split
 * across chunks (PRD 10.7), and verifies rendering, chip activation, and the
 * Alt+1 hotkey — asserting raw markup is never painted at any frame (B2/C1).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

class FakeWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static instances: FakeWebSocket[] = [];
	readyState = 1;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
	deliver(msg: object) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
}

let ws: FakeWebSocket;

function flushRaf(): Promise<void> {
	return new Promise((r) => requestAnimationFrame(() => r()));
}

beforeAll(async () => {
	const html = readFileSync(join(here, "..", "src", "web", "index.html"), "utf8");
	const body = html.slice(html.indexOf("<div id=\"app\">"), html.indexOf("<script"));
	document.body.innerHTML = body;
	(globalThis as any).WebSocket = FakeWebSocket;
	await import("../src/web/main.js");
	ws = FakeWebSocket.instances[0]!;
	ws.onopen?.();
});

describe("pi-clik app integration", () => {
	it("connects and hydrates on open", () => {
		const types = ws.sent.map((s) => JSON.parse(s).type);
		expect(types).toContain("get_state");
		expect(types).toContain("get_messages");
	});

	it("hydrates a restored session and renders live chips (C5)", () => {
		ws.deliver({
			type: "response",
			command: "get_messages",
			success: true,
			data: {
				messages: [
					{ role: "user", content: [{ type: "text", text: "which one?" }] },
					{
						role: "assistant",
						content: [{ type: "text", text: "Pick <pi:suggest>the first</pi:suggest>." }],
					},
				],
			},
		});
		const chip = document.querySelector("button.chip")!;
		expect(chip).toBeTruthy();
		expect(chip.textContent).toBe("the first");
		expect(chip.classList.contains("chip-inert")).toBe(false);
	});

	it("streams a split-tag message without ever painting raw markup", async () => {
		const messagesEl = document.getElementById("messages")!;
		ws.deliver({ type: "agent_start" });
		ws.deliver({
			type: "message_start",
			message: { role: "assistant", content: [] },
		});
		const chunks = ["Want me to <pi", ":suggest>rebuild</pi:sug", "gest> now?"];
		let acc = "";
		ws.deliver({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		for (const chunk of chunks) {
			acc += chunk;
			ws.deliver({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk },
			});
			await flushRaf();
			expect(messagesEl.textContent).not.toContain("<pi");
			expect(messagesEl.textContent).not.toContain("</");
		}
		// Mid-stream, the resolved tag renders as an inert chip.
		const streamedEl = messagesEl.lastElementChild as HTMLElement;
		const inert = streamedEl.querySelector("button.chip");
		expect(inert).toBeTruthy();
		expect(inert!.classList.contains("chip-inert")).toBe(true);

		ws.deliver({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: acc }] },
		});
		ws.deliver({ type: "agent_end" });
		await flushRaf();

		const chip = streamedEl.querySelector("button.chip")!;
		expect(chip.classList.contains("chip-inert")).toBe(false);
		expect(chip.textContent).toBe("rebuild");
		expect(messagesEl.textContent).toContain("Want me to");
		expect(messagesEl.textContent).toContain("now?");
		expect(messagesEl.textContent).not.toContain("<pi:suggest");
	});

	it("clicking the chip inserts into the composer and marks it visited", () => {
		const composer = document.getElementById("composer") as HTMLTextAreaElement;
		composer.value = "";
		const messagesEl = document.getElementById("messages")!;
		const chip = (messagesEl.lastElementChild as HTMLElement).querySelector(
			"button.chip",
		) as HTMLButtonElement;
		chip.click();
		expect(composer.value).toBe("rebuild");
		expect(chip.classList.contains("chip-visited")).toBe(true);
	});

	it("Alt+1 inserts the first suggestion of the latest message", () => {
		const composer = document.getElementById("composer") as HTMLTextAreaElement;
		composer.value = "";
		window.dispatchEvent(
			new KeyboardEvent("keydown", { code: "Digit1", altKey: true, bubbles: true }),
		);
		expect(composer.value).toBe("rebuild");
	});

	it("sending a prompt forwards it over the socket", () => {
		const composer = document.getElementById("composer") as HTMLTextAreaElement;
		composer.value = "run the tests";
		(document.getElementById("send-btn") as HTMLButtonElement).click();
		const last = JSON.parse(ws.sent[ws.sent.length - 1]!);
		expect(last).toMatchObject({ type: "prompt", message: "run the tests" });
		expect(composer.value).toBe("");
	});
});
