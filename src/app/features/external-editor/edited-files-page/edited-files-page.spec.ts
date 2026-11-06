import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { LanguageService } from '../../../core/i18n/language';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { EditedFiles } from '../../../core/ipc/edited-files';
import type { EditedFile } from '../../../core/ipc/external-edits';
import { editedFile } from '../../../core/ipc/external-edits.fixture';
import { SshService } from '../../../core/ipc/ssh';
import { EditedActions } from '../edited-actions';
import { clockTime, dayTime } from '../edited-view';
import { EditedFilesPage } from './edited-files-page';

@Component({
  imports: [TuiRoot, EditedFilesPage],
  template: '<tui-root><app-edited-files-page /></tui-root>',
})
class Host {}

describe('EditedFilesPage', () => {
  let state: string;
  const actions = {
    reopen: vi.fn(() => Promise.resolve()),
    resolve: vi.fn(() => Promise.resolve()),
    upload: vi.fn(() => Promise.resolve()),
    reconnect: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve(true)),
    discard: vi.fn(() => Promise.resolve(true)),
    reveal: vi.fn(() => Promise.resolve()),
    openBuiltIn: vi.fn(() => Promise.resolve()),
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  const conflict = editedFile('e1', 'h1', '/etc/nginx/nginx.conf', {
    state: 'conflict',
    conflict: 'changed',
    notUploaded: true,
    needsAttention: true,
  });
  const failed = editedFile('e2', 'h2', '/srv/app.env', {
    state: 'failed',
    error: { code: 'permission_denied', message: 'denied' },
    notUploaded: true,
    needsAttention: true,
  });
  const synced = editedFile('e3', 'h2', '/var/www/logo.png', {
    lastUploadedAt: new Date(2026, 10, 4, 14, 2).getTime(),
  });
  const recovered = editedFile('e4', 'h1', '/opt/backup.sh', {
    state: 'recovered',
    recoveredAt: new Date(2026, 10, 3, 23, 10).getTime(),
    notUploaded: true,
    needsAttention: true,
    watched: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state = 'connected';
    const config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([host('h1', 'vps', 'p1'), host('h2', 'db-1')]);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { stateOf: () => state } },
        { provide: EditedActions, useValue: actions },
      ],
    });
  });

  async function render(files: EditedFile[], loaded = true) {
    const store = TestBed.inject(EditedFiles);
    store.reset(files);
    store.loaded.set(loaded);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const doc = document.body;
    const byId = (id: string, root: ParentNode = doc) =>
      root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const row = (id: string) => byId(id)!;
    return { fixture, store, byId, row };
  }

  async function openMenu(fixture: { whenStable(): Promise<unknown> }, row: HTMLElement) {
    row.querySelector<HTMLButtonElement>('[data-testid="edited-row-menu"]')!.click();
    await fixture.whenStable();
    await settle();
  }

  it('shows a loader until the list is loaded, then the empty state with Settings', async () => {
    const { fixture, store, byId } = await render([], false);
    expect(document.body.querySelector('tui-loader')).not.toBeNull();
    expect(byId('edited-empty')).toBeNull();
    store.loaded.set(true);
    await fixture.whenStable();
    expect(byId('edited-empty')?.textContent).toContain('No edited files');
    expect(byId('edited-empty')?.querySelector('button')?.textContent).toContain('Settings');
    expect(byId('edited-empty')?.textContent).toContain(
      'Open a remote file from a Files tab: row menu (…) → Open in external editor, or Shift+Enter.',
    );
    expect(byId('edited-note')).toBeNull();
  });

  it('lists attention first with the state word, the location and the row action', async () => {
    const { byId, row } = await render([synced, recovered, failed, conflict]);
    expect(byId('edited-note')?.textContent).toContain('a copy of each file is stored');
    expect(byId('edited-note')?.textContent).not.toContain('in use');
    expect(document.body.querySelector('[tuiSubtitle]')?.textContent).toContain(
      'If your editor briefly says the file is in use, save again.',
    );
    expect(document.body.querySelector('th.col-actions')?.classList).toContain('_wide');
    const rows = [...document.body.querySelectorAll('tbody tr')].map((r) =>
      r.getAttribute('data-testid'),
    );
    expect(rows).toEqual([
      'edited-row-vps-nginx.conf',
      'edited-row-db-1-app.env',
      'edited-row-vps-backup.sh',
      'edited-row-db-1-logo.png',
    ]);
    const first = row('edited-row-vps-nginx.conf');
    expect(first.getAttribute('data-state')).toBe('conflict');
    expect(first.textContent).toContain('vps (Payments):/etc/nginx/nginx.conf');
    expect(byId('edited-state', first)?.textContent).toContain('Changed on server');
    expect(byId('edited-action', first)?.getAttribute('data-action')).toBe('resolve');
    expect(byId('edited-open', first)?.getAttribute('aria-label')).toBe(
      'Open nginx.conf in the external editor',
    );
    const second = row('edited-row-db-1-app.env');
    expect(byId('edited-reason', second)?.textContent).toContain('Permission denied on db-1.');
    expect(byId('edited-reason', second)?.querySelector('.negative')?.textContent).toBe(
      'Permission denied on db-1.',
    );
    expect(second.querySelector('[tuiBadge]')?.getAttribute('data-size')).toBe('m');
    expect(second.querySelector('.location > .path')?.textContent).toBe('db-1:/srv/app.env');
    expect(byId('edited-action', second)?.textContent).toContain('Retry');
    const third = row('edited-row-vps-backup.sh');
    expect(byId('edited-state', third)?.textContent).toContain(
      `Not uploaded (from ${dayTime(new Date(2026, 10, 3, 23, 10).getTime())})`,
    );
    expect(byId('edited-action', third)?.textContent).toContain('Upload');
    const last = row('edited-row-db-1-logo.png');
    expect(byId('edited-state', last)?.textContent).toContain(
      `Uploaded ${clockTime(new Date(2026, 10, 4, 14, 2).getTime())}`,
    );
    expect(byId('edited-action', last)).toBeNull();
    expect(byId('edited-state', last)?.closest('td')?.getAttribute('aria-live')).toBe('polite');
  });

  it('follows a switch to French', async () => {
    const { fixture, byId, row } = await render([synced, recovered]);
    TestBed.inject(LanguageService).apply('fr');
    await fixture.whenStable();
    expect(byId('edited-title')?.textContent).toContain('Fichiers édités');
    const recoveredRow = row('edited-row-vps-backup.sh');
    expect(byId('edited-state', recoveredRow)?.textContent).toContain(
      `Non envoyé (du ${dayTime(new Date(2026, 10, 3, 23, 10).getTime(), 'fr-FR')})`,
    );
    expect(byId('edited-action', recoveredRow)?.textContent).toContain('Envoyer');
    TestBed.inject(LanguageService).apply('en');
  });

  it('keeps the actions column narrow when no row has a row action', async () => {
    await render([synced]);
    expect(document.body.querySelector('th.col-actions')?.classList).not.toContain('_wide');
  });

  it('runs the row actions', async () => {
    const waiting = editedFile('e5', 'h1', '/w', { state: 'waiting', notUploaded: true });
    const { byId, row } = await render([conflict, failed, recovered, waiting]);
    byId('edited-action', row('edited-row-vps-nginx.conf'))!.click();
    expect(actions.resolve).toHaveBeenCalledWith(conflict);
    byId('edited-action', row('edited-row-db-1-app.env'))!.click();
    byId('edited-action', row('edited-row-vps-backup.sh'))!.click();
    expect(actions.upload.mock.calls).toEqual([[failed], [recovered]]);
    byId('edited-action', row('edited-row-vps-w'))!.click();
    expect(actions.reconnect).toHaveBeenCalledWith(waiting);
    byId('edited-open', row('edited-row-vps-nginx.conf'))!.click();
    expect(actions.reopen).toHaveBeenCalledWith(conflict);
  });

  it('disables Upload now with nothing to upload and the built-in editor on a modified copy', async () => {
    state = 'idle';
    const { fixture, byId, row } = await render([synced, conflict]);
    await openMenu(fixture, row('edited-row-db-1-logo.png'));
    const upload = byId('edited-upload') as HTMLButtonElement;
    expect(upload.getAttribute('aria-disabled')).toBe('true');
    upload.click();
    expect(actions.upload).not.toHaveBeenCalled();
    expect(upload.textContent).toContain('No changes to upload');
    expect(byId('edited-reconnect')?.textContent).toContain('Reconnect db-1');
    expect(byId('edited-stop')).not.toBeNull();
    byId('edited-reveal')!.click();
    expect(actions.reveal).toHaveBeenCalledWith(synced);
    await fixture.whenStable();
    await settle();
    await openMenu(fixture, row('edited-row-vps-nginx.conf'));
    const builtin = byId('edited-builtin') as HTMLButtonElement;
    expect(builtin.getAttribute('aria-disabled')).toBe('true');
    expect(builtin.textContent).toContain('Upload or discard your changes first');
    expect(byId('edited-upload')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('blocks Upload and Open for a recovered file whose host no longer exists', async () => {
    const orphan = { ...recovered, canUpload: false };
    const { fixture, byId, row } = await render([orphan]);
    const line = row('edited-row-vps-backup.sh');
    expect(byId('edited-reason', line)?.textContent).toContain('vps no longer exists');
    expect(byId('edited-action', line)).toBeNull();
    expect((byId('edited-open', line) as HTMLButtonElement).disabled).toBe(true);
    await openMenu(fixture, line);
    for (const id of ['edited-upload', 'edited-reopen', 'edited-builtin']) {
      const option = byId(id) as HTMLButtonElement;
      expect(option.getAttribute('aria-disabled')).toBe('true');
      expect(option.textContent).toContain('vps no longer exists');
    }
    expect(byId('edited-reveal')?.getAttribute('aria-disabled')).toBeNull();
    expect(byId('edited-discard')).not.toBeNull();
  });

  it('never offers Retry for a file opened from another server', async () => {
    state = 'idle';
    const changed = editedFile('e6', 'h2', '/srv/app.env', {
      state: 'failed',
      error: { code: 'host_changed', message: 'x' },
      notUploaded: true,
      needsAttention: true,
    });
    const { fixture, byId, row } = await render([changed]);
    const line = row('edited-row-db-1-app.env');
    expect(byId('edited-reason', line)?.textContent).toContain(
      'db-1 now points to another server. Nothing was sent. Copy your changes out with Show in folder, then stop editing.',
    );
    expect(byId('edited-action', line)).toBeNull();
    await openMenu(fixture, line);
    expect(byId('edited-upload')?.getAttribute('aria-disabled')).toBe('true');
    expect(byId('edited-upload')?.textContent).toContain('db-1 now points to another server');
    expect(byId('edited-reconnect')).toBeNull();
    expect(byId('edited-stop')).not.toBeNull();
  });

  it('offers only Show in folder and Stop editing when the server copy would be run', async () => {
    const blocked = editedFile('e7', 'h1', '/srv/run.bat', {
      state: 'failed',
      error: { code: 'blocked_type', message: 'x' },
      notUploaded: true,
      needsAttention: true,
    });
    const { fixture, byId, row } = await render([blocked]);
    const line = row('edited-row-vps-run.bat');
    expect(byId('edited-reason', line)?.textContent).toContain(
      'Your system would run this file. Choose an editor app in Settings.',
    );
    expect(byId('edited-action', line)).toBeNull();
    await openMenu(fixture, line);
    for (const id of ['edited-upload', 'edited-reopen', 'edited-builtin']) {
      expect(byId(id)?.getAttribute('aria-disabled')).toBe('true');
    }
    expect(byId('edited-reveal')?.getAttribute('aria-disabled')).toBeNull();
    expect(byId('edited-stop')).not.toBeNull();
  });

  it('offers Discard instead of Stop editing for a recovered file', async () => {
    const { fixture, byId, row } = await render([recovered]);
    await openMenu(fixture, row('edited-row-vps-backup.sh'));
    expect(byId('edited-stop')).toBeNull();
    byId('edited-discard')!.click();
    await settle();
    expect(actions.discard).toHaveBeenCalledWith(recovered);
  });

  it('stops with Delete on a row control and moves the focus to the next row', async () => {
    const { fixture, store, byId, row } = await render([conflict, synced]);
    actions.stop.mockImplementationOnce(() => {
      store.remove(['e1']);
      return Promise.resolve(true);
    });
    const link = byId('edited-open', row('edited-row-vps-nginx.conf'))!;
    link.focus();
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await fixture.whenStable();
    await settle();
    expect(actions.stop).toHaveBeenCalledWith(conflict);
    expect(document.activeElement).toBe(byId('edited-open', row('edited-row-db-1-logo.png')));
  });

  describe('context menu', () => {
    const rightClick = async (
      fixture: { whenStable(): Promise<unknown> },
      target: Element,
    ): Promise<MouseEvent> => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      });
      target.dispatchEvent(event);
      await fixture.whenStable();
      await settle();
      await fixture.whenStable();
      return event;
    };
    const entries = (root: Element | null): string[] =>
      Array.from(root?.querySelectorAll('[tuiOption]') ?? []).map((o) =>
        o.getAttribute('data-testid')!,
      );
    const menu = () => document.querySelector<HTMLElement>('[data-testid="context-menu"]');

    afterEach(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
    });

    it('shows the same entries as the row "…" and runs them on that file', async () => {
      const { fixture, row } = await render([conflict, recovered]);
      await openMenu(fixture, row('edited-row-vps-backup.sh'));
      const button = entries(document.querySelector('tui-data-list'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();

      const event = await rightClick(
        fixture,
        row('edited-row-vps-backup.sh').querySelector('[data-testid="edited-state"]')!,
      );
      expect(event.defaultPrevented).toBe(true);
      expect(menu()!.getAttribute('data-surface')).toBe('edited');
      expect(menu()!.getAttribute('aria-label')).toBe('Actions for backup.sh');
      expect(entries(menu())).toEqual(button);
      expect(entries(menu())).toContain('edited-discard');
      expect(row('edited-row-vps-backup.sh').classList).toContain('_menu');
      menu()!.querySelector<HTMLElement>('[data-testid="edited-reveal"]')!.click();
      await settle();
      expect(actions.reveal).toHaveBeenCalledWith(recovered);
    });

    it('opens nothing off the rows', async () => {
      const { fixture } = await render([conflict]);
      const event = await rightClick(fixture, document.querySelector('thead th')!);
      expect(event.defaultPrevented).toBe(true);
      expect(menu()).toBeNull();
    });

    it('closes an open "…" when a row is right-clicked', async () => {
      const { fixture, row } = await render([conflict]);
      await openMenu(fixture, row('edited-row-vps-nginx.conf'));
      await rightClick(fixture, row('edited-row-vps-nginx.conf'));
      expect(document.querySelectorAll('tui-data-list').length).toBe(1);
      expect(menu()).not.toBeNull();
    });
  });

  it('focuses the row action asked by a Review', async () => {
    const { fixture, store, byId, row } = await render([synced, failed]);
    store.focusRequest.set({ id: 'e2' });
    await fixture.whenStable();
    await settle();
    expect(document.activeElement).toBe(byId('edited-action', row('edited-row-db-1-app.env')));
    expect(store.focusRequest()).toBeNull();
  });
});
