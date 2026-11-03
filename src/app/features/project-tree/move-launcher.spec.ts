import { TestBed } from '@angular/core/testing';
import { ConfigService } from '../../core/ipc/config';
import { collection, fakeConfig, host } from '../../core/ipc/config.fixture';
import { MoveActions } from './move-actions';
import { MoveLauncher } from './move-launcher';

describe('MoveLauncher', () => {
  const actions = {
    openDialog: vi.fn(() => Promise.resolve()),
    drop: vi.fn(() => Promise.resolve()),
  };
  let launcher: MoveLauncher;
  let config: ReturnType<typeof fakeConfig>;

  beforeEach(() => {
    config = fakeConfig();
    config.nodes.set([
      collection('c1', 'Backend'),
      collection('c2', 'Old', null, 'c1'),
      host('h1', 'a'),
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: MoveActions, useValue: actions },
      ],
    });
    launcher = TestBed.inject(MoveLauncher);
  });

  it('refuses drops on the current parent, on itself or into a descendant', () => {
    const backend = config.findNode('c1')!;
    expect(launcher.canDrop(backend, { projectId: null, parentId: null })).toBe(false);
    expect(launcher.canDrop(backend, { projectId: null, parentId: 'c2' })).toBe(false);
    expect(launcher.canDrop(config.findNode('h1')!, { projectId: null, parentId: 'c2' })).toBe(
      true,
    );
  });

  it('forwards to the move flows once loaded', async () => {
    const node = config.findNode('h1')!;
    await launcher.openDialog(node);
    await launcher.drop(node, { projectId: null, parentId: 'c1' });
    expect(actions.openDialog).toHaveBeenCalledWith(node);
    expect(actions.drop).toHaveBeenCalledWith(node, { projectId: null, parentId: 'c1' });
  });
});
