export type WorkspaceKey =
  | { readonly kind: 'next' }
  | { readonly kind: 'previous' }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'last' }
  | { readonly kind: 'close' }
  /** Ctrl+W: in a terminal it stays the shell's delete-word. */
  | { readonly kind: 'closeOutsideTerminal' }
  | { readonly kind: 'newTerminal' };

/** The workspace shortcuts; everything else (Ctrl+C, Ctrl+K, Ctrl+R, AltGr characters…) is not one. */
export function workspaceKey(event: KeyboardEvent): WorkspaceKey | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  if (event.key === 'Tab') {
    return { kind: event.shiftKey ? 'previous' : 'next' };
  }
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    if (key === 'w') {
      return { kind: 'close' };
    }
    return key === 't' ? { kind: 'newTerminal' } : null;
  }
  // Physical digit keys, so AZERTY layouts (where digits need Shift) work too.
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (digit) {
    const n = Number(digit[1]);
    return n === 9 ? { kind: 'last' } : { kind: 'index', index: n - 1 };
  }
  return key === 'w' ? { kind: 'closeOutsideTerminal' } : null;
}

export type TerminalKey = 'copy' | 'paste' | 'selectAll';

const TERMINAL_KEYS: Readonly<Record<string, TerminalKey>> = {
  c: 'copy',
  v: 'paste',
  a: 'selectAll',
};

export function onApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * Ctrl+Shift+C / V / A (⌘C / V / A on Apple systems), handled by the terminal itself. Ctrl+C stays
 * the shell's interrupt: copying on Ctrl+C when text is selected would swallow an interrupt.
 */
export function terminalKey(event: KeyboardEvent, apple = onApple()): TerminalKey | null {
  const combo = apple
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  return combo ? (TERMINAL_KEYS[event.key.toLowerCase()] ?? null) : null;
}

/** The ContextMenu key alone; Shift+F10 stays the shell's (Midnight Commander, htop). */
export function isTerminalMenuKey(event: KeyboardEvent): boolean {
  return (
    event.key === 'ContextMenu' &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** Combos taken from xterm so the shell never receives them. */
export function isTerminalReserved(event: KeyboardEvent, apple = onApple()): boolean {
  if (terminalKey(event, apple) || isTerminalMenuKey(event)) {
    return true;
  }
  const key = workspaceKey(event);
  return key !== null && key.kind !== 'closeOutsideTerminal';
}

export function inTerminal(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.('.terminal-host, .xterm');
}
