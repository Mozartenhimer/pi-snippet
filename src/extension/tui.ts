/**
 * The slice of pi-tui's TUI instance this extension touches.
 *
 * Kept to the minimum the link path needs: an input tap for the Alt-release
 * watcher and a repaint request, so text inserted from outside pi's render
 * pass (a socket callback, a committed chord) becomes visible immediately.
 *
 * The wider shape the mouse-reporting path needed — terminal writes for DECSET
 * and DSR, `render` wrapping for hit-testing, `hardwareCursorRow` anchoring —
 * went with mouse reporting. Terminal-resolved clicking never touches any of
 * it: the terminal does the hit-testing, and pi-tui paints the URLs itself.
 */
export interface TuiLike {
	addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void;
	requestRender?(force?: boolean): void;
	/**
	 * Drops every component's rendered-output cache, so the next render
	 * re-transforms messages whose *inputs* did not change but whose painted
	 * form has — a second-model chip arriving for a message that finished
	 * streaming long ago. Without it, requestRender alone walks the render
	 * loop straight back into pi-tui's per-component caches.
	 */
	invalidate?(): void;
}
