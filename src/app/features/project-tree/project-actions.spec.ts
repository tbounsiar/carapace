import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../core/ipc/config.fixture';
import { IpcError } from '../../core/ipc/ipc-error';
import { SidebarState } from '../sidebar/sidebar-state';
import type { HostDialogData } from './host-dialog/host-dialog';
import type { NameDialogData } from './name-dialog/name-dialog';
import { ProjectActions } from './project-actions';

@Component({ template: '' })
class Blank {}

interface Opened {
  label: string;
  data: unknown;
}

describe('ProjectActions', () => {
  let config: ReturnType<typeof fakeConfig>;
  let actions: ProjectActions;
  let opened: Opened[];
  let answer: boolean;
  const alerts = { open: vi.fn(() => of(undefined)) };

  const dialogs = {
    open: vi.fn((_content: unknown, options: Opened) => {
      opened.push(options);
      return of(answer);
    }),
  };
  const settle = () => new Promise((r) => setTimeout(r));
  const lastData = <T>(): T => opened[opened.length - 1].data as T;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    opened = [];
    answer = true;
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([
      collection('c1', 'Backend', 'p1'),
      host('h1', 'api', 'p1', 'c1'),
      host('h2', 'web', 'p1', 'c1'),
      collection('c2', 'Legacy', 'p1', 'c1'),
      host('h9', 'vps', null),
    ]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    await import('./name-dialog/name-dialog');
    await import('./host-dialog/host-dialog');
    actions = TestBed.inject(ProjectActions);
  });

  it('creates a project and enters it', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    actions.createProject();
    await settle();
    await lastData<NameDialogData>().save('Blog');
    expect(navigate).toHaveBeenCalledWith(['/projects', 'new']);
  });

  it('creates a collection in a container, expanded and focused', async () => {
    const create = vi
      .spyOn(config, 'createCollection')
      .mockImplementation((projectId, parentId, name) => {
        const created = collection('new', name, projectId, parentId);
        config.nodes.update((list) => [...list, created]);
        return Promise.resolve(created);
      });
    actions.addCollection({ projectId: 'p1', parentId: 'c1' });
    await settle();
    expect(opened[0].label).toBe('New collection');
    const data = lastData<NameDialogData>();
    expect(data.placeholder).toBe('Backend');
    expect(data.conflictMessage).toBe('A collection with this name already exists here.');
    await data.save('Ops');
    expect(create).toHaveBeenCalledWith('p1', 'c1', 'Ops');
    const state = TestBed.inject(SidebarState);
    expect(state.isOpen('c1')).toBe(true);
    expect(state.isOpen('new')).toBe(true);
    expect(state.focusRequest()).toBe('new');
  });

  it('skips a same-name collection rename', async () => {
    const rename = vi.spyOn(config, 'renameCollection');
    actions.renameCollection(config.findNode('c1') as never);
    await settle();
    await lastData<NameDialogData>().save('Backend');
    expect(rename).not.toHaveBeenCalled();
  });

  it('opens the host dialog with the target scope and location', async () => {
    actions.addHost({ projectId: 'p1', parentId: 'c2' });
    await settle();
    const data = lastData<HostDialogData>();
    expect(data.projectId).toBe('p1');
    expect(data.location).toBe('Payments / Backend / Legacy');
    actions.addHost({ projectId: null, parentId: null });
    await settle();
    expect(lastData<HostDialogData>().location).toBe('Home');
  });

  it('describes the contents of a collection before deleting it', async () => {
    const remove = vi.spyOn(config, 'deleteCollection');
    await expect(actions.deleteCollection(config.findNode('c1') as never)).resolves.toBe(true);
    expect(opened[0].label).toBe('Delete collection?');
    expect((opened[0].data as { content: string }).content).toContain(
      '“Backend” contains 1 collection and 2 hosts.',
    );
    expect(remove).toHaveBeenCalledWith('c1');
  });

  it('says an empty collection is empty and leaves it when cancelled', async () => {
    answer = false;
    const remove = vi.spyOn(config, 'deleteCollection');
    await expect(actions.deleteCollection(config.findNode('c2') as never)).resolves.toBe(false);
    expect((opened[0].data as { content: string }).content).toBe('“Legacy” is empty.');
    expect(remove).not.toHaveBeenCalled();
  });

  it('counts a project contents and goes Home when deleting the current project', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/projects/p1');
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await actions.deleteProject(config.findProject('p1')!);
    expect((opened[0].data as { content: string }).content).toContain(
      'contains 2 collections and 2 hosts. Everything in it will be deleted',
    );
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('leaves the page of a deleted host for its scope home and focuses a sibling', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/hosts/h1');
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await actions.deleteHost(config.findHost('h1')!.host);
    expect(opened[0].label).toBe('Delete host?');
    expect(navigate).toHaveBeenCalledWith(['/projects', 'p1']);
    expect(TestBed.inject(SidebarState).focusRequest()).toBe('h2');
  });

  it('notifies a failed delete', async () => {
    vi.spyOn(config, 'deleteHost').mockRejectedValueOnce(new IpcError('io', 'disk'));
    await expect(actions.deleteHost(config.findHost('h9')!.host)).resolves.toBe(false);
    expect(alerts.open).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ label: 'Host not deleted' }),
    );
  });
});
