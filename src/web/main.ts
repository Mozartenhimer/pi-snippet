/**
 * pi-snippet web client.
 *
 * Talks to the pi-snippet server over a WebSocket that bridges pi's RPC mode
 * (JSONL commands in, JSONL responses/events out). Renders the transcript,
 * streams assistant text with suggestion-safe buffering, and turns
 * <pi:snippet> spans into clickable chips that insert into the composer.
 */
import { DigitChord } from "../shared/digit-chord.js";
import { parseSuggestions } from "../shared/suggestions.js";
import { renderAssistantMarkdown } from "./chips.js";
import { insertSuggestion } from "./composer.js";

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	[k: string]: unknown;
}

interface ChatMessage {
	role: string;
	content?: ContentBlock[] | string;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	isError?: boolean;
	[k: string]: unknown;
}

interface AppState {
	messages: ChatMessage[];
	finalized: boolean[];
	visited: Map<number, Set<number>>;
	/** Index of the most recent finalized assistant message (hotkey target). */
	liveIndex: number;
	liveSuggestions: string[];
	isStreaming: boolean;
	streamingIndex: number;
	chipsEnabled: boolean;
	hotkeysEnabled: boolean;
}

const state: AppState = {
	messages: [],
	finalized: [],
	visited: new Map(),
	liveIndex: -1,
	liveSuggestions: [],
	isStreaming: false,
	streamingIndex: -1,
	chipsEnabled: loadSetting("pi-snippet.chips", true),
	hotkeysEnabled: loadSetting("pi-snippet.hotkeys", true),
};

function loadSetting(key: string, fallback: boolean): boolean {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === "true";
	} catch {
		return fallback;
	}
}
function saveSetting(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		/* private mode etc. */
	}
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const messagesEl = $("messages");
const composerEl = $<HTMLTextAreaElement>("composer");
const statusEl = $("status");
const modelEl = $("model-name");
const sendBtn = $<HTMLButtonElement>("send-btn");
const abortBtn = $<HTMLButtonElement>("abort-btn");

// ---------------------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;

function connect(): void {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	ws = new WebSocket(`${proto}://${location.host}/ws`);
	ws.onopen = () => {
		setStatus("");
		send({ type: "get_state" });
		send({ type: "get_messages" });
	};
	ws.onmessage = (ev) => {
		let msg: any;
		try {
			msg = JSON.parse(String(ev.data));
		} catch {
			return;
		}
		handleServerMessage(msg);
	};
	ws.onclose = () => {
		setStatus("disconnected — retrying…");
		setTimeout(connect, 2000);
	};
}

function send(cmd: Record<string, unknown>): void {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

function setStatus(text: string): void {
	statusEl.textContent = text;
}

// ---------------------------------------------------------------------------
// RPC event handling
// ---------------------------------------------------------------------------

function handleServerMessage(msg: any): void {
	switch (msg.type) {
		case "response":
			handleResponse(msg);
			break;
		case "agent_start":
			state.isStreaming = true;
			updateStreamingUi();
			break;
		case "agent_end":
			state.isStreaming = false;
			state.streamingIndex = -1;
			updateStreamingUi();
			break;
		case "message_start":
			onMessageStart(msg.message as ChatMessage);
			break;
		case "message_update":
			onMessageUpdate(msg.assistantMessageEvent);
			break;
		case "message_end":
			onMessageEnd(msg.message as ChatMessage);
			break;
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			break;
		case "pi-snippet":
			if (msg.event === "proc-exit") {
				setStatus("pi process exited");
				addSystemNote("The pi process exited. Restart the server to continue.");
			}
			break;
		default:
			break;
	}
}

function handleResponse(msg: any): void {
	if (!msg.success) {
		if (msg.error) addSystemNote(`Error: ${msg.error}`);
		return;
	}
	if (msg.command === "get_state" && msg.data) {
		modelEl.textContent = msg.data.model ? `${msg.data.model.name ?? msg.data.model.id}` : "";
		state.isStreaming = Boolean(msg.data.isStreaming);
		updateStreamingUi();
	}
	if (msg.command === "get_messages") {
		const list = Array.isArray(msg.data) ? msg.data : msg.data?.messages;
		if (Array.isArray(list)) hydrate(list as ChatMessage[]);
	}
}

function hydrate(messages: ChatMessage[]): void {
	state.messages = messages;
	state.finalized = messages.map(() => true);
	state.visited = new Map(); // Visited state does not persist across reload (OQ2).
	state.streamingIndex = -1;
	recomputeLive();
	renderAll();
	scrollToBottom(true);
}

function onMessageStart(message: ChatMessage): void {
	state.messages.push(message);
	state.finalized.push(false);
	if (message.role === "assistant") {
		state.streamingIndex = state.messages.length - 1;
	}
	appendMessageEl(state.messages.length - 1);
	scrollToBottom(false);
}

function onMessageUpdate(ev: any): void {
	if (!ev || state.streamingIndex < 0) return;
	const message = state.messages[state.streamingIndex];
	if (!message) return;
	if (!Array.isArray(message.content)) message.content = [];
	const content = message.content as ContentBlock[];
	const idx: number = ev.contentIndex ?? 0;
	switch (ev.type) {
		case "text_start":
			content[idx] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (content[idx]?.type === "text") content[idx]!.text = (content[idx]!.text ?? "") + ev.delta;
			break;
		case "text_end":
			if (content[idx]?.type === "text") content[idx]!.text = ev.content ?? content[idx]!.text;
			break;
		case "thinking_start":
			content[idx] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			if (content[idx]?.type === "thinking")
				content[idx]!.thinking = (content[idx]!.thinking ?? "") + ev.delta;
			break;
		case "thinking_end":
			if (content[idx]?.type === "thinking") content[idx]!.thinking = ev.content ?? content[idx]!.thinking;
			break;
		default:
			return;
	}
	scheduleStreamRender();
}

function onMessageEnd(message: ChatMessage): void {
	// The final message is authoritative (streaming accumulation may lag).
	let idx = state.streamingIndex;
	if (idx < 0 || state.messages[idx]?.role !== message.role) {
		idx = state.messages.length - 1;
		if (idx < 0 || state.messages[idx]?.role !== message.role || state.finalized[idx]) {
			state.messages.push(message);
			state.finalized.push(false);
			idx = state.messages.length - 1;
			appendMessageEl(idx);
		}
	}
	state.messages[idx] = message;
	state.finalized[idx] = true;
	if (message.role === "assistant") state.streamingIndex = -1;
	recomputeLive();
	rerenderMessage(idx);
	scrollToBottom(false);
}

/** Derive the hotkey-addressable suggestion set (PRD §5.2: outside render). */
function recomputeLive(): void {
	state.liveIndex = -1;
	state.liveSuggestions = [];
	if (!state.chipsEnabled) return;
	for (let i = state.messages.length - 1; i >= 0; i--) {
		if (state.messages[i]?.role === "assistant" && state.finalized[i]) {
			state.liveIndex = i;
			state.liveSuggestions = collectSuggestions(state.messages[i]!);
			return;
		}
	}
}

function collectSuggestions(message: ChatMessage): string[] {
	const out: string[] = [];
	for (const block of textBlocks(message)) {
		const res = parseSuggestions(block, { acceptedSoFar: out.length });
		out.push(...res.suggestions);
	}
	return out;
}

function textBlocks(message: ChatMessage): string[] {
	if (typeof message.content === "string") return [message.content];
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((b) => b.type === "text").map((b) => b.text ?? "");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const messageEls: HTMLElement[] = [];
let streamRenderScheduled = false;

function scheduleStreamRender(): void {
	if (streamRenderScheduled) return;
	streamRenderScheduled = true;
	requestAnimationFrame(() => {
		streamRenderScheduled = false;
		if (state.streamingIndex >= 0) rerenderMessage(state.streamingIndex);
		scrollToBottom(false);
	});
}

function renderAll(): void {
	messagesEl.textContent = "";
	messageEls.length = 0;
	for (let i = 0; i < state.messages.length; i++) appendMessageEl(i);
}

function appendMessageEl(idx: number): void {
	const el = document.createElement("div");
	el.dataset.idx = String(idx);
	messageEls[idx] = el;
	fillMessageEl(el, idx);
	messagesEl.appendChild(el);
}

function rerenderMessage(idx: number): void {
	const el = messageEls[idx];
	if (el) fillMessageEl(el, idx);
}

function fillMessageEl(el: HTMLElement, idx: number): void {
	const message = state.messages[idx];
	el.textContent = "";
	el.className = "";
	if (!message) return;
	const finalized = state.finalized[idx] === true;

	if (message.role === "user") {
		el.className = "message message-user";
		el.appendChild(roleLabel("You"));
		const body = document.createElement("div");
		body.className = "message-body";
		body.textContent = textBlocks(message).join("\n") || plainText(message);
		el.appendChild(body);
		return;
	}

	if (message.role === "assistant") {
		el.className = "message message-assistant";
		el.appendChild(roleLabel("Agent"));
		const blocks = Array.isArray(message.content) ? message.content : [];
		let accepted = 0;
		for (const block of blocks) {
			if (block.type === "thinking") {
				el.appendChild(renderThinking(block.thinking ?? ""));
			} else if (block.type === "text") {
				const streamingThis = !finalized && idx === state.streamingIndex;
				const rendered = renderAssistantMarkdown(block.text ?? "", {
					live: finalized,
					streaming: streamingThis,
					chipsEnabled: state.chipsEnabled,
					visited: state.visited.get(idx),
					parse: { acceptedSoFar: accepted },
					onInsert: (text, chipIndex) => onChipInsert(idx, chipIndex, text),
				});
				accepted += parseSuggestions(block.text ?? "", { acceptedSoFar: accepted }).suggestions.length;
				el.appendChild(rendered);
			} else if (block.type === "toolCall") {
				el.appendChild(renderToolCall(block));
			}
		}
		if (message.stopReason === "aborted") {
			const note = document.createElement("div");
			note.className = "aborted-note";
			note.textContent = "(response aborted)";
			el.appendChild(note);
		}
		if (message.errorMessage) {
			const note = document.createElement("div");
			note.className = "error-note";
			note.textContent = message.errorMessage;
			el.appendChild(note);
		}
		return;
	}

	if (message.role === "toolResult") {
		el.className = "message message-tool-result";
		el.appendChild(renderToolResult(message));
		return;
	}

	// Custom / unknown roles: unobtrusive note with any text content.
	const text = plainText(message);
	if (text) {
		el.className = "sys-note";
		el.textContent = text.length > 200 ? `${text.slice(0, 200)}…` : text;
	}
}

function plainText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((b) => b.text ?? "")
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function roleLabel(text: string): HTMLElement {
	const label = document.createElement("div");
	label.className = "message-role";
	label.textContent = text;
	return label;
}

function renderThinking(text: string): HTMLElement {
	const details = document.createElement("details");
	details.className = "thinking-block";
	const summary = document.createElement("summary");
	summary.textContent = "thinking…";
	const body = document.createElement("div");
	body.className = "thinking-body";
	body.textContent = text;
	details.append(summary, body);
	return details;
}

function renderToolCall(block: ContentBlock): HTMLElement {
	const row = document.createElement("details");
	row.className = "tool-row";
	const summary = document.createElement("summary");
	let args = "";
	try {
		args = block.arguments === undefined ? "" : JSON.stringify(block.arguments);
	} catch {
		args = "";
	}
	if (args.length > 120) args = `${args.slice(0, 120)}…`;
	summary.textContent = `⚙ ${block.name ?? "tool"} ${args}`;
	row.appendChild(summary);
	const pre = document.createElement("pre");
	try {
		pre.textContent = JSON.stringify(block.arguments, null, 2) ?? "";
	} catch {
		pre.textContent = String(block.arguments);
	}
	row.appendChild(pre);
	return row;
}

function renderToolResult(message: ChatMessage): HTMLElement {
	const row = document.createElement("details");
	row.className = "tool-row";
	const summary = document.createElement("summary");
	const ok = message.isError ? "✖" : "✔";
	summary.textContent = `${ok} ${(message as { toolName?: string }).toolName ?? "tool result"}`;
	row.appendChild(summary);
	const pre = document.createElement("pre");
	let text = plainText(message);
	if (text.length > 4000) text = `${text.slice(0, 4000)}\n… (truncated)`;
	pre.textContent = text;
	row.appendChild(pre);
	return row;
}

function addSystemNote(text: string): void {
	const el = document.createElement("div");
	el.className = "sys-note";
	el.textContent = text;
	messagesEl.appendChild(el);
	scrollToBottom(false);
}

// ---------------------------------------------------------------------------
// Insertion (PRD §8)
// ---------------------------------------------------------------------------

function onChipInsert(msgIdx: number, chipIndex: number, text: string): void {
	insertSuggestion(composerEl, text);
	let set = state.visited.get(msgIdx);
	if (!set) {
		set = new Set();
		state.visited.set(msgIdx, set);
	}
	set.add(chipIndex);
	const chip = messageEls[msgIdx]?.querySelector<HTMLElement>(
		`.chip[data-suggestion-index="${chipIndex}"]`,
	);
	if (chip) {
		chip.classList.add("chip-visited", "chip-flash");
		chip.addEventListener("animationend", () => chip.classList.remove("chip-flash"), { once: true });
	}
	composerEl.scrollIntoView({ block: "nearest" });
}

// Alt+N inserts the Nth suggestion of the live message (PRD D1). Holding Alt
// and typing two digits reaches 10 and above; releasing Alt settles it.
const chord = new DigitChord({
	onCommit: (value) => {
		const text = state.liveSuggestions[value - 1];
		if (text !== undefined) onChipInsert(state.liveIndex, value - 1, text);
	},
	onPending: (digits) => {
		document.body.dataset.chord = digits;
	},
});

window.addEventListener("keydown", (e) => {
	if (!state.hotkeysEnabled || !state.chipsEnabled) return;
	if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	const match = /^Digit([0-9])$/.exec(e.code);
	if (!match) return;
	e.preventDefault();
	chord.press(Number(match[1]), state.liveSuggestions.length);
});

// The browser reports the modifier lifting, so a two-digit chord commits the
// moment the user lets go instead of waiting out the timeout.
window.addEventListener("keyup", (e) => {
	if (e.key === "Alt") chord.release(state.liveSuggestions.length);
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function sendPrompt(): void {
	const text = composerEl.value.trim();
	if (!text) return;
	if (state.isStreaming) {
		send({ type: "steer", message: text });
	} else {
		send({ type: "prompt", message: text });
	}
	composerEl.value = "";
	composerEl.focus();
}

sendBtn.addEventListener("click", sendPrompt);
abortBtn.addEventListener("click", () => send({ type: "abort" }));
composerEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendPrompt();
	}
});

function updateStreamingUi(): void {
	abortBtn.hidden = !state.isStreaming;
	setStatus(state.isStreaming ? "thinking…" : "");
}

// ---------------------------------------------------------------------------
// Settings (PRD H1, H2)
// ---------------------------------------------------------------------------

const settingsPanel = $("settings-panel");
const toggleChips = $<HTMLInputElement>("toggle-chips");
const toggleHotkeys = $<HTMLInputElement>("toggle-hotkeys");
toggleChips.checked = state.chipsEnabled;
toggleHotkeys.checked = state.hotkeysEnabled;

$("settings-btn").addEventListener("click", () => {
	settingsPanel.hidden = !settingsPanel.hidden;
});
toggleChips.addEventListener("change", () => {
	state.chipsEnabled = toggleChips.checked;
	saveSetting("pi-snippet.chips", state.chipsEnabled);
	recomputeLive();
	renderAll();
});
toggleHotkeys.addEventListener("change", () => {
	state.hotkeysEnabled = toggleHotkeys.checked;
	saveSetting("pi-snippet.hotkeys", state.hotkeysEnabled);
});

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

function scrollToBottom(force: boolean): void {
	const nearBottom =
		messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
	if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------

composerEl.focus();
connect();
