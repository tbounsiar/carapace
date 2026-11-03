import type { ConnectionState, EndReason } from '../../core/ipc/ssh.models';

export type TabStatusKind = 'connecting' | 'connected' | 'lost' | 'ended';

export interface TabStatus {
  readonly kind: TabStatusKind;
  /** The word read in hints and aria labels. */
  readonly word: string;
}

export type TerminalRunState = 'opening' | 'open' | 'ended';
export type TerminalEndReason = 'exited' | 'closed' | 'connectionLost';
export type EditorPhase = 'loading' | 'saving' | 'ready';

const LOST: TabStatus = { kind: 'lost', word: 'Connection lost' };
const CONNECTED: TabStatus = { kind: 'connected', word: 'Connected' };

function opening(state: ConnectionState): boolean {
  return state === 'connecting' || state === 'authenticating' || state === 'awaitingHostKey';
}

/** Files and editor tabs show their host's connection. */
export function connectionTabStatus(state: ConnectionState, end: EndReason | undefined): TabStatus {
  if (state === 'connected') {
    return CONNECTED;
  }
  if (opening(state)) {
    return { kind: 'connecting', word: 'Connecting…' };
  }
  return end === 'lost' ? LOST : { kind: 'ended', word: 'Disconnected' };
}

export function terminalTabStatus(
  run: TerminalRunState,
  reason: TerminalEndReason | null,
  end: EndReason | undefined,
): TabStatus {
  if (run === 'opening') {
    return { kind: 'connecting', word: 'Connecting…' };
  }
  if (run === 'open') {
    return CONNECTED;
  }
  if (reason === 'connectionLost' || (reason === 'closed' && end === 'lost')) {
    return LOST;
  }
  return { kind: 'ended', word: end === 'user' ? 'Disconnected' : 'Session ended' };
}

export function editorTabStatus(
  phase: EditorPhase,
  state: ConnectionState,
  end: EndReason | undefined,
): TabStatus {
  if (phase === 'loading') {
    return { kind: 'connecting', word: 'Loading…' };
  }
  if (phase === 'saving') {
    return { kind: 'connecting', word: 'Saving…' };
  }
  return connectionTabStatus(state, end);
}
