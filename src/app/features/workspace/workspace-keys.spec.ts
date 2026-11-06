import {
  inTerminal,
  isTerminalMenuKey,
  isTerminalReserved,
  terminalKey,
  workspaceKey,
} from './workspace-keys';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('workspaceKey', () => {
  it('maps the workspace shortcuts', () => {
    expect(workspaceKey(key({ key: 'Tab', ctrlKey: true }))).toEqual({ kind: 'next' });
    expect(workspaceKey(key({ key: 'Tab', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'previous',
    });
    expect(workspaceKey(key({ key: '&', code: 'Digit1', ctrlKey: true }))).toEqual({
      kind: 'index',
      index: 0,
    });
    expect(workspaceKey(key({ key: '8', code: 'Digit8', ctrlKey: true }))).toEqual({
      kind: 'index',
      index: 7,
    });
    expect(workspaceKey(key({ key: '9', code: 'Digit9', ctrlKey: true }))).toEqual({
      kind: 'last',
    });
    expect(workspaceKey(key({ key: 'W', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'close',
    });
    expect(workspaceKey(key({ key: 'w', ctrlKey: true }))).toEqual({
      kind: 'closeOutsideTerminal',
    });
    expect(workspaceKey(key({ key: 'T', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'newTerminal',
    });
  });

  it('ignores everything else, AltGr and Ctrl+K included', () => {
    expect(workspaceKey(key({ key: 'k', ctrlKey: true }))).toBeNull();
    expect(workspaceKey(key({ key: 'c', ctrlKey: true }))).toBeNull();
    expect(workspaceKey(key({ key: '@', code: 'Digit0', ctrlKey: true, altKey: true }))).toBeNull();
    expect(workspaceKey(key({ key: '{', code: 'Digit4', ctrlKey: true, altKey: true }))).toBeNull();
    expect(workspaceKey(key({ key: 'Tab' }))).toBeNull();
    expect(workspaceKey(key({ key: 't', ctrlKey: true }))).toBeNull();
  });

  it('keeps Ctrl+W for the shell in a terminal', () => {
    expect(isTerminalReserved(key({ key: 'w', ctrlKey: true }))).toBe(false);
    expect(isTerminalReserved(key({ key: 'Tab', ctrlKey: true }))).toBe(true);
    const host = document.createElement('div');
    host.className = 'terminal-host';
    const inner = document.createElement('textarea');
    host.append(inner);
    expect(inTerminal(inner)).toBe(true);
    expect(inTerminal(document.body)).toBe(false);
  });

  it('reserves the terminal copy, paste and select all keys, not Ctrl+C or Ctrl+V', () => {
    const ctrlShift = (k: string) => key({ key: k, ctrlKey: true, shiftKey: true });
    expect(terminalKey(ctrlShift('C'), false)).toBe('copy');
    expect(terminalKey(ctrlShift('V'), false)).toBe('paste');
    expect(terminalKey(ctrlShift('A'), false)).toBe('selectAll');
    for (const k of ['C', 'V', 'A']) {
      expect(isTerminalReserved(ctrlShift(k), false)).toBe(true);
    }
    expect(terminalKey(key({ key: 'c', ctrlKey: true }), false)).toBeNull();
    expect(isTerminalReserved(key({ key: 'c', ctrlKey: true }), false)).toBe(false);
    expect(isTerminalReserved(key({ key: 'v', ctrlKey: true }), false)).toBe(false);
    expect(terminalKey(key({ key: 'c', metaKey: true }), false)).toBeNull();
    expect(
      terminalKey(key({ key: 'C', ctrlKey: true, shiftKey: true, altKey: true }), false),
    ).toBeNull();
  });

  it('uses the Command key on Apple systems', () => {
    expect(terminalKey(key({ key: 'c', metaKey: true }), true)).toBe('copy');
    expect(terminalKey(key({ key: 'v', metaKey: true }), true)).toBe('paste');
    expect(terminalKey(key({ key: 'a', metaKey: true }), true)).toBe('selectAll');
    expect(terminalKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(isTerminalReserved(key({ key: 'c', ctrlKey: true }), true)).toBe(false);
  });
});

describe('isTerminalMenuKey', () => {
  const key = (init: KeyboardEventInit): boolean =>
    isTerminalMenuKey(new KeyboardEvent('keydown', init));

  it('takes the ContextMenu key alone and leaves Shift+F10 to the shell', () => {
    expect(key({ key: 'ContextMenu' })).toBe(true);
    expect(key({ key: 'ContextMenu', shiftKey: true })).toBe(false);
    expect(key({ key: 'ContextMenu', ctrlKey: true })).toBe(false);
    expect(key({ key: 'F10', shiftKey: true })).toBe(false);
  });
});
