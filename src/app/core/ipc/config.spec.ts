import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ConfigService } from './config';
import type {
  Collection,
  ConfigView,
  Host,
  HostInput,
  Project,
  VariableView,
} from './config.models';
import { IpcError } from './ipc-error';

const hostInput: HostInput = {
  name: 'web',
  hostname: '${host}',
  port: '22',
  username: 'deploy',
  auth: { kind: 'key', keyPath: '/home/u/.ssh/id_ed25519', passphrase: null },
};
const host: Host = { kind: 'host', id: 'h1', projectId: 'p1', parentId: null, ...hostInput };
const homeHost: Host = { ...host, id: 'h9', name: 'vps', projectId: null };
const folder: Collection = {
  kind: 'collection',
  id: 'c1',
  name: 'Backend',
  projectId: 'p1',
  parentId: null,
};
const project: Project = { id: 'p1', name: 'Alpha', variables: [] };
const globalVar: VariableView = { name: 'user', kind: 'plain', value: 'me', hasValue: true };
const config: ConfigView = {
  variables: [globalVar],
  projects: [project],
  nodes: [folder, host, homeHost],
};

describe('ConfigService', () => {
  let service: ConfigService;
  let calls: { cmd: string; args: unknown }[];
  let handler: (cmd: string, args: Record<string, unknown>) => unknown;

  beforeEach(() => {
    calls = [];
    handler = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return handler(cmd, args as Record<string, unknown>);
    });
    service = TestBed.inject(ConfigService);
  });

  afterEach(() => clearMocks());

  async function seed(): Promise<void> {
    handler = () => config;
    await service.load();
    calls = [];
  }

  it('loads the configuration with get_config and toggles loading', async () => {
    handler = () => config;
    const pending = service.load();
    expect(service.loading()).toBe(true);
    await pending;
    expect(service.loading()).toBe(false);
    expect(service.projects()).toEqual([project]);
    expect(service.variables()).toEqual([globalVar]);
    expect(service.nodes()).toEqual([folder, host, homeHost]);
    expect(service.hosts()).toEqual([host, homeHost]);
    expect(calls[0].cmd).toBe('get_config');
  });

  it('finds a host and its project, null for a Home host', async () => {
    await seed();
    expect(service.findHost('h1')).toEqual({ project, host });
    expect(service.findHost('h9')).toEqual({ project: null, host: homeHost });
    expect(service.findHost('c1')).toBeNull();
    expect(service.findHost('nope')).toBeNull();
    expect(service.findNode('c1')).toEqual(folder);
  });

  it('creates, renames and deletes a project', async () => {
    handler = () => ({ ...project, id: 'p2', name: 'Beta' });
    await service.createProject('Beta');
    expect(calls[0]).toEqual({ cmd: 'create_project', args: { name: 'Beta' } });
    expect(service.projects().map((p) => p.name)).toEqual(['Beta']);

    handler = () => ({ ...project, id: 'p2', name: 'Gamma' });
    await service.renameProject('p2', 'Gamma');
    expect(calls[1]).toEqual({ cmd: 'rename_project', args: { projectId: 'p2', name: 'Gamma' } });
    expect(service.projects()[0].name).toBe('Gamma');

    handler = () => null;
    await service.deleteProject('p2');
    expect(calls[2]).toEqual({ cmd: 'delete_project', args: { projectId: 'p2' } });
    expect(service.projects()).toEqual([]);
  });

  it('removes the nodes of a deleted project', async () => {
    await seed();
    await service.deleteProject('p1');
    expect(service.nodes()).toEqual([homeHost]);
  });

  it('creates, renames and deletes a collection', async () => {
    await seed();
    const created: Collection = { ...folder, id: 'c2', name: 'Lab', projectId: null };
    handler = () => created;
    await service.createCollection(null, null, 'Lab');
    expect(calls[0]).toEqual({
      cmd: 'create_collection',
      args: { projectId: null, parentId: null, name: 'Lab' },
    });
    expect(service.findNode('c2')).toEqual(created);

    handler = () => ({ ...created, name: 'Home lab' });
    await service.renameCollection('c2', 'Home lab');
    expect(calls[1]).toEqual({
      cmd: 'rename_collection',
      args: { collectionId: 'c2', name: 'Home lab' },
    });
    expect(service.findNode('c2')?.name).toBe('Home lab');

    handler = () => ({ collectionIds: [], hostIds: ['h1'] });
    await expect(service.deleteCollection('c1')).resolves.toEqual({
      collectionIds: [],
      hostIds: ['h1'],
    });
    expect(calls[2]).toEqual({ cmd: 'delete_collection', args: { collectionId: 'c1' } });
    expect(service.nodes().map((n) => n.id)).toEqual(['h9', 'c2']);
  });

  it('moves a node and replaces its subtree', async () => {
    await seed();
    const moved: Host = { ...host, projectId: null, parentId: null };
    handler = () => ({ nodes: [moved], scopeChanged: true });
    await expect(service.moveNode('h1', null, null)).resolves.toEqual({
      nodes: [moved],
      scopeChanged: true,
    });
    expect(calls[0]).toEqual({
      cmd: 'move_node',
      args: { nodeId: 'h1', projectId: null, parentId: null },
    });
    expect(service.findHost('h1')).toEqual({ project: null, host: moved });
  });

  it('replaces the variables of each scope', async () => {
    await seed();
    const saved: VariableView[] = [{ name: 'pw', kind: 'secret', value: null, hasValue: true }];
    handler = () => saved;

    await service.setVariables({ kind: 'global' }, [
      { name: 'pw', kind: 'secret', secretValue: 's' },
    ]);
    expect(calls[0]).toEqual({
      cmd: 'set_variables',
      args: {
        scope: { kind: 'global' },
        variables: [{ name: 'pw', kind: 'secret', secretValue: 's' }],
      },
    });
    expect(service.variables()).toEqual(saved);

    await service.setVariables({ kind: 'project', projectId: 'p1' }, []);
    expect(service.projects()[0].variables).toEqual(saved);
  });

  it('creates, updates and deletes a host by id', async () => {
    await seed();
    const added: Host = { ...host, id: 'h2', name: 'db', parentId: 'c1' };
    handler = () => added;
    await service.createHost('p1', 'c1', { ...hostInput, name: 'db' });
    expect(calls[0]).toEqual({
      cmd: 'create_host',
      args: { projectId: 'p1', parentId: 'c1', host: { ...hostInput, name: 'db' } },
    });
    expect(service.hosts().map((h) => h.id)).toEqual(['h1', 'h9', 'h2']);

    handler = () => ({ ...added, port: '${port}' });
    await service.updateHost('h2', { ...hostInput, name: 'db', port: '${port}' });
    expect(calls[1]).toEqual({
      cmd: 'update_host',
      args: { hostId: 'h2', host: { ...hostInput, name: 'db', port: '${port}' } },
    });
    expect(service.findHost('h2')?.host.port).toBe('${port}');

    handler = () => null;
    await service.deleteHost('h2');
    expect(calls[2]).toEqual({ cmd: 'delete_host', args: { hostId: 'h2' } });
    expect(service.hosts().map((h) => h.id)).toEqual(['h1', 'h9']);
  });

  it('resolves a host', async () => {
    const resolved = {
      hostname: 'a',
      port: 22,
      username: 'u',
      keyPath: null,
      missing: [],
      errors: [],
    };
    handler = () => resolved;
    await expect(service.resolveHost('h1')).resolves.toEqual(resolved);
    expect(calls[0]).toEqual({ cmd: 'resolve_host', args: { hostId: 'h1' } });
  });

  it('maps backend errors to IpcError and keeps state', async () => {
    await seed();
    handler = () => {
      throw { code: 'conflict', message: 'Name already used' };
    };
    const err = await service.createProject('Alpha').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toMatchObject({ code: 'conflict', message: 'Name already used' });
    expect(service.projects()).toEqual([project]);
  });

  it('maps missing_variables and unknown error shapes', async () => {
    handler = () => {
      throw { code: 'missing_variables', message: 'Missing variables: host' };
    };
    await expect(service.load()).rejects.toMatchObject({ code: 'missing_variables' });
    expect(service.loadError()).toMatchObject({ code: 'missing_variables' });
    handler = () => {
      throw 'boom';
    };
    const err = await service.deleteProject('p1').catch((e: unknown) => e);
    expect((err as IpcError).code).toBe('unknown');
    expect((err as IpcError).message).not.toContain('boom');
  });
});
