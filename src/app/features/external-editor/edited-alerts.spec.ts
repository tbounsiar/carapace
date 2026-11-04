import { TestBed } from '@angular/core/testing';
import { TuiNotificationService } from '@taiga-ui/core';
import { Observable } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { fakeConfig, host } from '../../core/ipc/config.fixture';
import { EditedFiles } from '../../core/ipc/edited-files';
import type { EditedFile } from '../../core/ipc/external-edits';
import { editedFile } from '../../core/ipc/external-edits.fixture';
import { EditedActions } from './edited-actions';
import { EditedAlerts, GROUP_WINDOW_MS } from './edited-alerts';

describe('EditedAlerts', () => {
  /** Labels of the alerts closed by unsubscribing. */
  let closed: string[];
  const alerts = {
    open: vi.fn(
      (_content: unknown, options: { label: string }) =>
        new Observable<void>(() => () => closed.push(options.label)),
    ),
  };
  const actions = { review: vi.fn(() => Promise.resolve()) };
  let focused: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    focused = true;
    closed = [];
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const config = fakeConfig();
    config.nodes.set([host('h1', 'vps')]);
    TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: EditedActions, useValue: actions },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  function setup() {
    const store = TestBed.inject(EditedFiles);
    TestBed.inject(EditedAlerts).start();
    const enter = (file: EditedFile) => {
      const previous = store.find(file.id);
      store.upsert(file);
      store.changes.next({ previous, file });
    };
    return { store, enter };
  }

  const shown = () =>
    (alerts.open.mock.calls as unknown as [unknown, Record<string, unknown>][]).map(([, o]) => ({
      label: o['label'],
      appearance: o['appearance'],
      autoClose: o['autoClose'],
      text: (o['data'] as { text: string }).text,
    }));

  it('alerts a conflict once, after the grouping window, with Review', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/etc/nginx.conf'));
    enter(editedFile('e1', 'h1', '/etc/nginx.conf', { state: 'conflict' }));
    enter(editedFile('e1', 'h1', '/etc/nginx.conf', { state: 'conflict', lastSyncedAt: 1 }));
    expect(alerts.open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(shown()).toEqual([
      {
        label: 'nginx.conf changed on vps',
        appearance: 'warning',
        autoClose: 0,
        text: 'Your last save was not uploaded.',
      },
    ]);
    const data = (alerts.open.mock.calls[0] as unknown as [unknown, { data: { run(): void } }])[1]
      .data;
    data.run();
    expect(actions.review).toHaveBeenCalledWith('e1');
  });

  it('groups files of one host entering the same state within the window', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/a', { state: 'conflict' }));
    enter(editedFile('e2', 'h1', '/b', { state: 'conflict' }));
    enter(editedFile('e3', 'h1', '/c', { state: 'conflict' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(shown().map((s) => s.label)).toEqual(['3 files changed on vps']);
  });

  it('alerts a failure with its reason, but not the same failure twice in a row', () => {
    const { enter } = setup();
    const failed = editedFile('e1', 'h1', '/a', {
      state: 'failed',
      error: { code: 'permission_denied', message: 'denied' },
    });
    enter(failed);
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    enter({ ...failed, state: 'uploading', error: null });
    enter(failed);
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(shown()).toEqual([
      {
        label: 'a not uploaded',
        appearance: 'negative',
        autoClose: 0,
        text: 'Permission denied on vps.',
      },
    ]);
    enter({ ...failed, state: 'synced', error: null });
    enter(failed);
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(alerts.open).toHaveBeenCalledTimes(2);
  });

  it('announces waiting changes only while the window is in the background, once per disconnect', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/a', { state: 'waiting' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(alerts.open).not.toHaveBeenCalled();
    focused = false;
    enter(editedFile('e2', 'h1', '/b', { state: 'waiting' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    enter(editedFile('e3', 'h1', '/c', { state: 'waiting' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(shown()).toEqual([
      {
        label: 'Changes to b are waiting for vps',
        appearance: 'neutral',
        autoClose: undefined,
        text: 'Reconnect to upload them.',
      },
    ]);
    enter(editedFile('e2', 'h1', '/b'));
    enter(editedFile('e2', 'h1', '/b', { state: 'waiting' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(alerts.open).toHaveBeenCalledTimes(2);
  });

  it('drops an alert when the file left the state before the window ended', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/a', { state: 'conflict' }));
    enter(editedFile('e1', 'h1', '/a'));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it('alerts recovered leftovers found at startup', () => {
    const { store } = setup();
    store.snapshot.next([
      editedFile('e1', 'h1', '/a', { state: 'recovered' }),
      editedFile('e2', 'h1', '/b', { state: 'recovered' }),
      editedFile('e3', 'h1', '/c'),
    ]);
    expect(shown()).toEqual([
      {
        label: '2 edited files were not uploaded',
        appearance: 'warning',
        autoClose: 0,
        text: 'Carapace closed before the changes reached the server.',
      },
    ]);
  });

  it('closes a conflict alert when its file is fine again', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/a', { state: 'conflict' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    TestBed.tick();
    expect(closed).toEqual([]);
    enter(editedFile('e1', 'h1', '/a', { state: 'synced', lastUploadedAt: 1 }));
    TestBed.tick();
    expect(closed).toEqual(['a changed on vps']);
  });

  it('keeps a grouped alert until its last file leaves the state', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/a', { state: 'conflict' }));
    enter(editedFile('e2', 'h1', '/b', { state: 'conflict' }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    enter(editedFile('e1', 'h1', '/a'));
    TestBed.tick();
    expect(closed).toEqual([]);
    enter(editedFile('e2', 'h1', '/b', { state: 'uploading' }));
    TestBed.tick();
    expect(closed).toEqual(['2 files changed on vps']);
  });

  it('closes an alert when Review is used', () => {
    const { enter } = setup();
    enter(editedFile('e1', 'h1', '/a', { state: 'failed', error: { code: 'x', message: 'x' } }));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    const data = (alerts.open.mock.calls[0] as unknown as [unknown, { data: { run(): void } }])[1]
      .data;
    data.run();
    expect(closed).toEqual(['a not uploaded']);
    expect(actions.review).toHaveBeenCalledWith('e1');
  });

  it('closes the recovered alert when its files are discarded', () => {
    const { store } = setup();
    const leftovers = [
      editedFile('e1', 'h1', '/a', { state: 'recovered' }),
      editedFile('e2', 'h1', '/b', { state: 'recovered' }),
    ];
    store.reset(leftovers);
    store.snapshot.next(leftovers);
    TestBed.tick();
    store.remove(['e1']);
    TestBed.tick();
    expect(closed).toEqual([]);
    store.remove(['e2']);
    TestBed.tick();
    expect(closed).toEqual(['2 edited files were not uploaded']);
  });
});
