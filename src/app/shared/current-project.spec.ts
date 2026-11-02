import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfigService } from '../core/ipc/config';
import type { Project } from '../core/ipc/config.models';
import { CurrentProject } from './current-project';

const project = (id: string, active: string | null): Project => ({
  id,
  name: id,
  variables: [],
  environments: [{ id: `${id}-dev`, name: 'Dev', variables: [] }],
  hosts: [],
  activeEnvironmentId: active,
});

describe('CurrentProject', () => {
  const projects = signal<Project[]>([]);
  let current: CurrentProject;

  beforeEach(() => {
    projects.set([project('a', null), project('b', 'b-dev')]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConfigService, useValue: { projects } }],
    });
    current = TestBed.inject(CurrentProject);
  });

  it('defaults to the first project', () => {
    expect(current.project()?.id).toBe('a');
    expect(current.environment()).toBeNull();
  });

  it('follows the selected project and its active environment', () => {
    current.select('b');
    expect(current.project()?.id).toBe('b');
    expect(current.environment()?.name).toBe('Dev');
  });

  it('falls back to the first project when the selected one is deleted', () => {
    current.select('b');
    projects.set([project('a', null)]);
    expect(current.project()?.id).toBe('a');
    projects.set([]);
    expect(current.project()).toBeNull();
  });
});
