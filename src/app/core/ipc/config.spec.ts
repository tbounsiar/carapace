import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ConfigService } from './config';
import type {
  ConfigView,
  Environment,
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
const host: Host = { id: 'h1', ...hostInput };
const env: Environment = { id: 'e1', name: 'dev', variables: [] };
const project: Project = {
  id: 'p1',
  name: 'Alpha',
  variables: [],
  environments: [env],
  hosts: [host],
  activeEnvironmentId: 'e1',
};
const globalVar: VariableView = { name: 'user', kind: 'plain', value: 'me', hasValue: true };
const config: ConfigView = { variables: [globalVar], projects: [project] };

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
    expect(calls[0].cmd).toBe('get_config');
  });

  it('finds a host and its project', async () => {
    await seed();
    expect(service.findHost('h1')).toEqual({ project, host });
    expect(service.findHost('nope')).toBeNull();
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

  it('creates, renames and deletes an environment, clearing the active one', async () => {
    await seed();
    handler = () => ({ id: 'e2', name: 'prod', variables: [] });
    await service.createEnvironment('p1', 'prod');
    expect(calls[0]).toEqual({
      cmd: 'create_environment',
      args: { projectId: 'p1', name: 'prod' },
    });
    expect(service.projects()[0].environments.map((e) => e.id)).toEqual(['e1', 'e2']);

    handler = () => ({ id: 'e2', name: 'live', variables: [] });
    await service.renameEnvironment('p1', 'e2', 'live');
    expect(calls[1]).toEqual({
      cmd: 'rename_environment',
      args: { projectId: 'p1', environmentId: 'e2', name: 'live' },
    });
    expect(service.projects()[0].environments[1].name).toBe('live');

    handler = () => null;
    await service.deleteEnvironment('p1', 'e1');
    expect(calls[2]).toEqual({
      cmd: 'delete_environment',
      args: { projectId: 'p1', environmentId: 'e1' },
    });
    expect(service.projects()[0].environments.map((e) => e.id)).toEqual(['e2']);
    expect(service.projects()[0].activeEnvironmentId).toBeNull();
  });

  it('sets the active environment', async () => {
    await seed();
    await service.setActiveEnvironment('p1', null);
    expect(calls[0]).toEqual({
      cmd: 'set_active_environment',
      args: { projectId: 'p1', environmentId: null },
    });
    expect(service.projects()[0].activeEnvironmentId).toBeNull();
  });

  it('keeps the active environment when the backend refuses', async () => {
    await seed();
    handler = () => {
      throw { code: 'not_found', message: 'Environment not found' };
    };
    await expect(service.setActiveEnvironment('p1', 'zz')).rejects.toBeInstanceOf(IpcError);
    expect(service.projects()[0].activeEnvironmentId).toBe('e1');
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

    await service.setVariables({ kind: 'environment', projectId: 'p1', environmentId: 'e1' }, []);
    expect(service.projects()[0].environments[0].variables).toEqual(saved);
  });

  it('creates, updates and deletes a project host', async () => {
    await seed();
    const added: Host = { ...hostInput, id: 'h2', name: 'db' };
    handler = () => added;
    await service.createHost('p1', { ...hostInput, name: 'db' });
    expect(calls[0]).toEqual({
      cmd: 'create_host',
      args: { projectId: 'p1', host: { ...hostInput, name: 'db' } },
    });
    expect(service.projects()[0].hosts.map((h) => h.id)).toEqual(['h1', 'h2']);

    handler = () => ({ ...added, port: '${port}' });
    await service.updateHost('p1', 'h2', { ...hostInput, name: 'db', port: '${port}' });
    expect(calls[1].cmd).toBe('update_host');
    expect(calls[1].args).toMatchObject({ projectId: 'p1', hostId: 'h2' });
    expect(service.projects()[0].hosts[1].port).toBe('${port}');

    handler = () => null;
    await service.deleteHost('p1', 'h2');
    expect(calls[2]).toEqual({ cmd: 'delete_host', args: { projectId: 'p1', hostId: 'h2' } });
    expect(service.projects()[0].hosts.map((h) => h.id)).toEqual(['h1']);
  });

  it('resolves a host in an environment', async () => {
    const resolved = {
      hostname: 'a',
      port: 22,
      username: 'u',
      keyPath: null,
      missing: [],
      errors: [],
    };
    handler = () => resolved;
    await expect(service.resolveHost('p1', 'h1', null)).resolves.toEqual(resolved);
    expect(calls[0]).toEqual({
      cmd: 'resolve_host',
      args: { projectId: 'p1', hostId: 'h1', environmentId: null },
    });
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
    handler = () => {
      throw 'boom';
    };
    const err = await service.deleteProject('p1').catch((e: unknown) => e);
    expect((err as IpcError).code).toBe('unknown');
    expect((err as IpcError).message).not.toContain('boom');
  });
});
