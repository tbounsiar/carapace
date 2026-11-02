import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ConfigService } from './config';
import type { Environment, Host, HostInput, Project } from './config.models';
import { IpcError } from './ipc-error';

const hostInput: HostInput = {
  name: 'web',
  hostname: 'example.com',
  port: 22,
  username: 'deploy',
  auth: { kind: 'key', keyPath: '/home/u/.ssh/id_ed25519' },
};
const host: Host = { id: 'h1', ...hostInput };
const env: Environment = { id: 'e1', name: 'dev', hosts: [host] };
const project: Project = { id: 'p1', name: 'Alpha', environments: [env] };

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
    handler = () => [project];
    await service.load();
    calls = [];
  }

  it('loads projects and toggles loading', async () => {
    handler = () => [project];
    const pending = service.load();
    expect(service.loading()).toBe(true);
    await pending;
    expect(service.loading()).toBe(false);
    expect(service.projects()).toEqual([project]);
    expect(calls[0].cmd).toBe('list_projects');
  });

  it('creates, renames and deletes a project', async () => {
    handler = () => ({ id: 'p2', name: 'Beta', environments: [] });
    await service.createProject('Beta');
    expect(calls[0]).toEqual({ cmd: 'create_project', args: { name: 'Beta' } });
    expect(service.projects().map((p) => p.name)).toEqual(['Beta']);

    handler = () => ({ id: 'p2', name: 'Gamma', environments: [] });
    await service.renameProject('p2', 'Gamma');
    expect(calls[1]).toEqual({
      cmd: 'rename_project',
      args: { projectId: 'p2', name: 'Gamma' },
    });
    expect(service.projects()[0].name).toBe('Gamma');

    handler = () => null;
    await service.deleteProject('p2');
    expect(calls[2]).toEqual({ cmd: 'delete_project', args: { projectId: 'p2' } });
    expect(service.projects()).toEqual([]);
  });

  it('creates, renames and deletes an environment', async () => {
    await seed();
    handler = () => ({ id: 'e2', name: 'prod', hosts: [] });
    await service.createEnvironment('p1', 'prod');
    expect(calls[0]).toEqual({
      cmd: 'create_environment',
      args: { projectId: 'p1', name: 'prod' },
    });
    expect(service.projects()[0].environments.map((e) => e.id)).toEqual(['e1', 'e2']);

    handler = () => ({ id: 'e2', name: 'live', hosts: [] });
    await service.renameEnvironment('p1', 'e2', 'live');
    expect(calls[1]).toEqual({
      cmd: 'rename_environment',
      args: { projectId: 'p1', environmentId: 'e2', name: 'live' },
    });
    expect(service.projects()[0].environments[1].name).toBe('live');

    handler = () => null;
    await service.deleteEnvironment('p1', 'e2');
    expect(calls[2]).toEqual({
      cmd: 'delete_environment',
      args: { projectId: 'p1', environmentId: 'e2' },
    });
    expect(service.projects()[0].environments.map((e) => e.id)).toEqual(['e1']);
  });

  it('creates, updates and deletes a host', async () => {
    await seed();
    const added: Host = { ...hostInput, id: 'h2', name: 'db' };
    handler = () => added;
    await service.createHost('p1', 'e1', { ...hostInput, name: 'db' });
    expect(calls[0]).toEqual({
      cmd: 'create_host',
      args: { projectId: 'p1', environmentId: 'e1', host: { ...hostInput, name: 'db' } },
    });
    expect(service.projects()[0].environments[0].hosts.map((h) => h.id)).toEqual(['h1', 'h2']);

    handler = () => ({ ...added, port: 2222 });
    await service.updateHost('p1', 'e1', 'h2', { ...hostInput, name: 'db', port: 2222 });
    expect(calls[1].cmd).toBe('update_host');
    expect(calls[1].args).toMatchObject({ projectId: 'p1', environmentId: 'e1', hostId: 'h2' });
    expect(service.projects()[0].environments[0].hosts[1].port).toBe(2222);

    handler = () => null;
    await service.deleteHost('p1', 'e1', 'h2');
    expect(calls[2]).toEqual({
      cmd: 'delete_host',
      args: { projectId: 'p1', environmentId: 'e1', hostId: 'h2' },
    });
    expect(service.projects()[0].environments[0].hosts.map((h) => h.id)).toEqual(['h1']);
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

  it('maps unknown error shapes to code unknown', async () => {
    handler = () => {
      throw 'boom';
    };
    const err = await service.deleteProject('p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('unknown');
    expect((err as IpcError).message).not.toContain('boom');
  });
});
