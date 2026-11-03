import { connectedCounts, connectionStatus } from './connection-status';

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

describe('connectedCounts', () => {
  it('counts connected hosts per scope', () => {
    const hosts = [
      { id: 'h1', projectId: 'p1' },
      { id: 'h2', projectId: null },
      { id: 'h4', projectId: 'p1' },
      { id: 'h5', projectId: 'p1' },
    ];
    const counts = connectedCounts(hosts, {
      h1: 'connected',
      h2: 'connected',
      h3: 'connected',
      h4: 'connected',
      h5: 'error',
    });
    expect(counts.get('p1')).toBe(2);
    expect(counts.get(null)).toBe(1);
  });
});
