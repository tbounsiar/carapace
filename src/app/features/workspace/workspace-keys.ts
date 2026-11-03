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

/** Combos taken from xterm so the shell never receives them. */
export function isTerminalReserved(event: KeyboardEvent): boolean {
  const key = workspaceKey(event);
  return key !== null && key.kind !== 'closeOutsideTerminal';
}

export function inTerminal(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.('.terminal-host, .xterm');
}
