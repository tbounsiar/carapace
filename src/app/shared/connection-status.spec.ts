import { connectionStatus } from './connection-status';

describe('connectionStatus', () => {
  it('pairs every state with a word, not only a color', () => {
    expect(connectionStatus('idle')).toEqual({
      label: 'Not connected',
      color: 'var(--tui-status-neutral)',
      busy: false,
      loading: false,
    });
    expect(connectionStatus('connected').color).toBe('var(--tui-status-positive)');
    expect(connectionStatus('error').label).toBe('Connection failed');
  });

  it('marks in-progress states as busy', () => {
    expect(connectionStatus('connecting').busy).toBe(true);
    expect(connectionStatus('authenticating').busy).toBe(true);
    expect(connectionStatus('awaitingHostKey').busy).toBe(true);
    expect(connectionStatus('connected').busy).toBe(false);
    expect(connectionStatus('connecting').loading).toBe(true);
    expect(connectionStatus('awaitingHostKey').loading).toBe(false);
  });
});
