import { of } from 'rxjs';
import type { TuiNotificationService } from '@taiga-ui/core';
import { IpcError } from '../../core/ipc/ipc-error';
import { errorText, notifyError } from './save-error';

describe('errorText', () => {
  it('says what happened, then what to do', () => {
    expect(errorText(new IpcError('timeout', 'the connection timed out'))).toBe(
      'The connection timed out. Check that the host is reachable, then try again.',
    );
    expect(errorText(new IpcError('missing_variables', 'missing variables: a, b'))).toBe(
      'Missing variables: a, b. Define them in the global, project or environment variables.',
    );
  });

  it('does not double the final period', () => {
    expect(errorText(new IpcError('busy', 'Busy.'))).toBe('Busy. Wait a moment and try again.');
  });

  it('accepts a {code, message} event payload', () => {
    expect(errorText({ code: 'not_connected', message: 'the host is not connected' })).toBe(
      'The host is not connected. Connect to the host, then try again.',
    );
  });

  it('never shows a raw code or an empty message', () => {
    const unexpected =
      'Something unexpected went wrong. Try again. Restart the app if it keeps happening.';
    expect(errorText(new IpcError('unknown', 'Unexpected error'))).toBe(unexpected);
    expect(errorText(new Error('boom'))).toBe(unexpected);
    expect(errorText({ code: 'weird_code', message: 'x' })).toBe(unexpected);
    expect(errorText({ code: 'io', message: '  ' })).toBe(unexpected);
    expect(errorText(null)).toBe(unexpected);
  });

  it('notifies with the given label as title', () => {
    const open = vi.fn(() => of(undefined));
    notifyError(
      { open } as unknown as TuiNotificationService,
      new IpcError('io', 'disk'),
      'Not saved',
    );
    expect(open).toHaveBeenCalledWith(
      'Disk. Check that the disk is available and not full, then try again.',
      {
        label: 'Not saved',
        appearance: 'negative',
      },
    );
  });
});
