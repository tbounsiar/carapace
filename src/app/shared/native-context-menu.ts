/** Where the webview's own menu stays useful: copy, paste and spelling in editable text. */
const NATIVE_MENU_TARGETS =
  'input, textarea, [contenteditable]:not([contenteditable="false"]), .cm-editor, .xterm';

export function keepsNativeMenu(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(NATIVE_MENU_TARGETS);
}

/**
 * Hides the webview's page menu (Back, Refresh, Print…) outside editable text: a Refresh there
 * reloads the app and drops every terminal and SFTP session. Runs in the bubble phase, so app
 * context menus (which cancel the event at their element) are left alone.
 */
export function suppressNativeContextMenu(doc: Document): () => void {
  const listener = (event: MouseEvent): void => {
    if (!event.defaultPrevented && !keepsNativeMenu(event.target)) {
      event.preventDefault();
    }
  };
  doc.addEventListener('contextmenu', listener);
  return () => doc.removeEventListener('contextmenu', listener);
}
