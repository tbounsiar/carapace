import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { EditedFiles } from '../../../core/ipc/edited-files';
import type { EditedFile } from '../../../core/ipc/external-edits';
import { editedFile } from '../../../core/ipc/external-edits.fixture';
import { SshService } from '../../../core/ipc/ssh';
import { EditedActions } from '../edited-actions';
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
    expect(byId('edited-note')).toBeNull();
  });

  it('lists attention first with the state word, the location and the row action', async () => {
    const { byId, row } = await render([synced, recovered, failed, conflict]);
    expect(byId('edited-note')?.textContent).toContain('a copy of each file is stored');
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
    expect(byId('edited-action', second)?.textContent).toContain('Retry');
    const third = row('edited-row-vps-backup.sh');
    expect(byId('edited-state', third)?.textContent).toContain('Not uploaded (from 3 Nov 23:10)');
    expect(byId('edited-action', third)?.textContent).toContain('Upload');
    const last = row('edited-row-db-1-logo.png');
    expect(byId('edited-state', last)?.textContent).toContain('Uploaded 14:02');
    expect(byId('edited-action', last)).toBeNull();
    expect(byId('edited-state', last)?.closest('td')?.getAttribute('aria-live')).toBe('polite');
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
    expect(upload.disabled).toBe(true);
    expect(upload.textContent).toContain('No changes to upload');
    expect(byId('edited-reconnect')?.textContent).toContain('Reconnect db-1');
    expect(byId('edited-stop')).not.toBeNull();
    byId('edited-reveal')!.click();
    expect(actions.reveal).toHaveBeenCalledWith(synced);
    await fixture.whenStable();
    await settle();
    await openMenu(fixture, row('edited-row-vps-nginx.conf'));
    const builtin = byId('edited-builtin') as HTMLButtonElement;
    expect(builtin.disabled).toBe(true);
    expect(builtin.textContent).toContain('Upload or discard your changes first');
    expect((byId('edited-upload') as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks Upload and Open for a recovered file whose host no longer exists', async () => {
    const orphan = { ...recovered, canUpload: false };
    const { fixture, byId, row } = await render([orphan]);
    const line = row('edited-row-vps-backup.sh');
    expect(byId('edited-reason', line)?.textContent).toContain('vps no longer exists');
    expect((byId('edited-action', line) as HTMLButtonElement).disabled).toBe(true);
    expect((byId('edited-open', line) as HTMLButtonElement).disabled).toBe(true);
    await openMenu(fixture, line);
    for (const id of ['edited-upload', 'edited-reopen', 'edited-builtin']) {
      const option = byId(id) as HTMLButtonElement;
      expect(option.disabled).toBe(true);
      expect(option.textContent).toContain('vps no longer exists');
    }
    expect((byId('edited-reveal') as HTMLButtonElement).disabled).toBe(false);
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
      'Opened from another server; nothing was sent.',
    );
    expect(byId('edited-action', line)).toBeNull();
    await openMenu(fixture, line);
    expect((byId('edited-upload') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('edited-upload')?.textContent).toContain('Opened from another server');
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
    expect(byId('edited-reason', line)?.textContent).toContain('run.bat would be run, not opened');
    expect(byId('edited-action', line)).toBeNull();
    await openMenu(fixture, line);
    for (const id of ['edited-upload', 'edited-reopen', 'edited-builtin']) {
      expect((byId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((byId('edited-reveal') as HTMLButtonElement).disabled).toBe(false);
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

  it('focuses the row action asked by a Review', async () => {
    const { fixture, store, byId, row } = await render([synced, failed]);
    store.focusRequest.set({ id: 'e2' });
    await fixture.whenStable();
    await settle();
    expect(document.activeElement).toBe(byId('edited-action', row('edited-row-db-1-app.env')));
    expect(store.focusRequest()).toBeNull();
  });
});
