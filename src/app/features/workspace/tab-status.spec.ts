import { connectionTabStatus, editorTabStatus, terminalTabStatus } from './tab-status';

describe('tab status', () => {
  it('follows the connection for files and editors', () => {
    expect(connectionTabStatus('connected', undefined).kind).toBe('connected');
    expect(connectionTabStatus('authenticating', undefined)).toEqual({
      kind: 'connecting',
      word: 'Connecting…',
    });
    expect(connectionTabStatus('idle', 'lost')).toEqual({ kind: 'lost', word: 'Connection lost' });
    expect(connectionTabStatus('idle', 'user')).toEqual({ kind: 'ended', word: 'Disconnected' });
    expect(connectionTabStatus('error', undefined).kind).toBe('ended');
  });

  it('tells a lost terminal from an ended one', () => {
    expect(terminalTabStatus('opening', null, undefined).kind).toBe('connecting');
    expect(terminalTabStatus('open', null, undefined).kind).toBe('connected');
    expect(terminalTabStatus('ended', 'connectionLost', undefined).kind).toBe('lost');
    expect(terminalTabStatus('ended', 'closed', 'lost').kind).toBe('lost');
    expect(terminalTabStatus('ended', 'closed', 'user')).toEqual({
      kind: 'ended',
      word: 'Disconnected',
    });
    expect(terminalTabStatus('ended', 'exited', undefined)).toEqual({
      kind: 'ended',
      word: 'Session ended',
    });
  });

  it('shows editor loading and saving', () => {
    expect(editorTabStatus('loading', 'connected', undefined).word).toBe('Loading…');
    expect(editorTabStatus('saving', 'connected', undefined).word).toBe('Saving…');
    expect(editorTabStatus('ready', 'idle', 'lost').kind).toBe('lost');
  });
});
