import { of } from 'rxjs';
import type { TuiNotificationService } from '@taiga-ui/core';
import { IpcError } from '../core/ipc/ipc-error';
import {
  errorText,
  importApplyError,
  importFileError,
  missingVariableNames,
  notifyError,
} from './save-error';
import { TranslocoService } from '@jsverse/transloco';
import { TestBed } from '@angular/core/testing';

describe('missingVariableNames', () => {
  it('reads the names and their count from the keyed error only', () => {
    const keyed = (names: unknown) =>
      new IpcError('missing_variables', 'missing variables', {
        key: 'errors.config.missingVariables',
        params: { names },
      });
    expect(missingVariableNames(keyed('a'))).toEqual({ names: 'a', count: 1 });
    expect(missingVariableNames(keyed('a, b'))).toEqual({ names: 'a, b', count: 2 });
    expect(missingVariableNames(keyed(''))).toBeNull();
    expect(
      missingVariableNames(new IpcError('missing_variables', 'missing variables: a')),
    ).toBeNull();
    expect(missingVariableNames(new IpcError('busy', 'busy'))).toBeNull();
  });
});

describe('errorText', () => {
  beforeEach(() => TestBed.inject(TranslocoService));

  it('says what happened, then what to do', () => {
    expect(errorText(new IpcError('timeout', 'the connection timed out'))).toBe(
      'The connection timed out. Check that the host is reachable, then try again.',
    );
    expect(errorText(new IpcError('missing_variables', 'missing variables: a, b'))).toBe(
      'Missing variables: a, b. Define them in the global or project variables.',
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

  it('translates a keyed backend text, from an error or an event payload', () => {
    const open = vi.fn(() => of(undefined));
    const err = new IpcError('not_found', '/srv/a was not found', {
      key: 'errors.files.notFound',
      params: { path: '/srv/a' },
    });
    TestBed.inject(TranslocoService).setActiveLang('fr');
    notifyError({ open } as unknown as TuiNotificationService, err, 'Non supprimé');
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^\/srv\/a est introuvable\. /u), {
      label: 'Non supprimé',
      appearance: 'negative',
    });
    expect(
      errorText({
        code: 'not_connected',
        key: 'errors.files.notConnected',
        message: 'the host is not connected',
      }),
    ).toMatch(/^L’hôte n’est pas connecté\. /u);
    TestBed.inject(TranslocoService).setActiveLang('en');
  });

  it('keeps the English message when the key is malformed', () => {
    expect(errorText({ code: 'io', key: 3, params: 'x', message: 'disk' })).toBe(
      'Disk. Check that the disk is available and not full, then try again.',
    );
  });

  it('writes its own texts in French, the backend message as is', () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    expect(errorText(new IpcError('busy', 'the host is busy'))).toBe(
      'The host is busy. Patientez un instant, puis réessayez.',
    );
    expect(errorText(null)).toBe(
      'Une erreur inattendue s’est produite. Réessayez. Redémarrez l’application si le problème persiste.',
    );
  });
});

describe('importFileError', () => {
  const dt = (name: string, params?: Record<string, unknown>) => ({
    key: `errors.dataTransfer.${name}`,
    message: name,
    ...(params ? { params } : {}),
  });
  const inFile = (code: 'import_invalid' | 'import_version', error: unknown) =>
    new IpcError(code, 'file “notes.json”: …', {
      key: 'errors.dataTransfer.inFile',
      params: { file: 'notes.json', error },
    });

  beforeEach(() => TestBed.inject(TranslocoService));
  afterEach(() => TestBed.inject(TranslocoService).setActiveLang('en'));

  it('reads the version from the params', () => {
    const view = importFileError(
      inFile('import_version', dt('newerVersion', { version: 4, supported: 1 })),
    );
    expect(view.fileName).toBe('notes.json');
    expect(view.lines).toEqual([
      'It was exported in data format 4. Update Carapace, then import it again.',
    ]);
  });

  it('translates the invalid data lines into French', () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    const who = dt('itemNamed', { kind: 'collection', name: 'Backend' });
    const view = importFileError(
      inFile('import_invalid', dt('invalidFile', { errors: [dt('ownParent', { who })] })),
    );
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatch(
      /^Collection «\sBackend\s»\s:\sl’élément est son propre parent\.$/u,
    );
  });

  it('keeps the count of a partial keychain failure, in French', () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    const err = new IpcError('keychain_unavailable', 'english', {
      key: 'errors.dataTransfer.keychainPartlyRemoved',
      params: { count: 1 },
    });
    expect(importApplyError(err)).toContain('1 valeur secrète a déjà été supprimée');
  });
});
