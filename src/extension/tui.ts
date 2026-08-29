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
}
