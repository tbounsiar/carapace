import { inTerminal, isTerminalReserved, workspaceKey } from './workspace-keys';

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
});
