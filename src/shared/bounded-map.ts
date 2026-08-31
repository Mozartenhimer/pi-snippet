/**
 * One bounded map insert, shared by everything in this extension that
 * remembers answers about recent messages.
 *
 * Four maps had their own copy of this loop — the inference cache
 * (`extension/infer.ts`), and the click targets, the inferred anchors and their
 * per-form index (`extension/pi-snippet-tui.ts`). They all bound the same kind
 * of thing for the same reason: a session that runs for hours must not grow a
 * map entry per message forever, but the recent past is worth keeping, because
 * a chip in old scrollback is still clickable and a message revisited by
 * `/tree` should not pay for a second inference.
 *
 * **Eviction is by insertion order, not by use.** A `Map` keeps the order keys
 * were first set, and re-setting an existing key does not move it to the end —
 * so a message written to repeatedly (an anchor list that grows one anchor at a
 * time) ages from when it was first seen, not from when it was last touched.
 * That is the behavior all four call sites already had; it is written down here
 * because "bounded map" reads like an LRU and this deliberately is not one.
 * Nothing here depends on the distinction: the bound exists to stop unbounded
 * growth, and both disciplines keep the recent past.
 */
export function putBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
	map.set(key, value);
	while (map.size > limit) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}
