import { TestBed } from '@angular/core/testing';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../core/ipc/config.fixture';
import { IpcError } from '../../core/ipc/ipc-error';
import { SidebarState } from '../sidebar/sidebar-state';
import { conflictText, MoveActions } from './move-actions';
import type { MoveUndoData } from './move-undo/move-undo';

describe('MoveActions', () => {
  let config: ReturnType<typeof fakeConfig>;
  let moves: MoveActions;
  let confirm: boolean;
  const dialogs = { open: vi.fn(() => of(confirm)) };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const settle = () => new Promise((r) => setTimeout(r));

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    confirm = true;
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([
      collection('c1', 'Backend', 'p1'),
      collection('c2', 'Legacy', 'p1', 'c1'),
      host('h1', 'api', 'p1'),
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    await import('./move-undo/move-undo');
    moves = TestBed.inject(MoveActions);
  });

  it('refuses drops on the current parent, on itself or into a descendant', () => {
    const backend = config.findNode('c1')!;
    expect(moves.canDrop(backend, { projectId: 'p1', parentId: null })).toBe(false);
    expect(moves.canDrop(backend, { projectId: 'p1', parentId: 'c2' })).toBe(false);
    expect(moves.canDrop(config.findNode('h1')!, { projectId: 'p1', parentId: 'c2' })).toBe(true);
  });

  it('moves within a scope without confirmation and offers Undo', async () => {
    const move = vi.spyOn(config, 'moveNode');
    const api = config.findNode('h1')!;
    await moves.drop(api, { projectId: 'p1', parentId: 'c2' });
    await settle();
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledWith('h1', 'p1', 'c2');
    const options = (alerts.open.mock.calls[0] as unknown[])[1] as { data: MoveUndoData };
    expect(options.data.text).toBe('Moved “api” to Backend / Legacy');
    expect(TestBed.inject(SidebarState).focusRequest()).toBe('h1');

    options.data.undo();
    await settle();
    expect(move).toHaveBeenLastCalledWith('h1', 'p1', null);
    expect(alerts.open).toHaveBeenLastCalledWith('Move undone', expect.anything());
  });

  it('confirms a drop to another scope, and moves nothing when cancelled', async () => {
    confirm = false;
    const move = vi.spyOn(config, 'moveNode');
    await moves.drop(config.findNode('h1')!, { projectId: null, parentId: null });
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'Move out of the project?' }),
    );
    expect(move).not.toHaveBeenCalled();
  });

  it('toasts a cross-scope move without Undo', async () => {
    vi.spyOn(config, 'moveNode').mockResolvedValue({ nodes: [], scopeChanged: true });
    await moves.drop(config.findNode('h1')!, { projectId: null, parentId: null });
    expect(alerts.open).toHaveBeenCalledWith('Moved “api” to Home (top level)', expect.anything());
  });

  it('returns a conflict for the dialog and toasts it for a drop', async () => {
    const conflict = new IpcError('conflict', 'a host named "api" already exists in Home');
    vi.spyOn(config, 'moveNode').mockRejectedValue(conflict);
    const api = config.findNode('h1')!;
    await expect(moves.move(api, { projectId: null, parentId: null }, true)).resolves.toBe(
      'A host named "api" already exists in Home. Rename one of them first.',
    );
    expect(alerts.open).not.toHaveBeenCalled();
    await moves.move(api, { projectId: null, parentId: null }, false);
    expect(alerts.open).toHaveBeenCalledWith(
      conflictText(conflict),
      expect.objectContaining({ label: 'Host not moved' }),
    );
  });
});
