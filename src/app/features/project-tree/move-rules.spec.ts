import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { collection, host, project } from '../../core/ipc/config.fixture';
import type { VariableView } from '../../core/ipc/config.models';
import { crossScopeWarning, moveDestination, moveTargets } from './move-rules';

const plain = (name: string): VariableView => ({ name, kind: 'plain', value: 'x', hasValue: true });

const api = { ...host('h1', 'api', 'p1', 'c1'), hostname: '${db_host}', username: '${user}' };
const NODES = [
  collection('c1', 'Backend', 'p1'),
  collection('c2', 'Legacy', 'p1', 'c1'),
  api,
  collection('c3', 'Lab', null),
];
const PROJECTS = [
  project('p2', 'Shop', { variables: [plain('db_host')] }),
  project('p1', 'Payments'),
];
const GLOBALS = [plain('user')];

describe('move-rules', () => {
  // The global `translate` behind `uiText` needs the service to exist.
  beforeEach(() => TestBed.inject(TranslocoService));

  it('lists Home then projects by name, with the current parent marked', () => {
    const groups = moveTargets(NODES, PROJECTS, api);
    expect(groups.map((g) => g.label)).toEqual(['Home', 'Payments', 'Shop']);
    expect(groups[0].targets.map((t) => t.path.join('/'))).toEqual(['Home', 'Home/Lab']);
    const payments = groups[1].targets;
    expect(payments.map((t) => t.path.join('/'))).toEqual([
      'Payments',
      'Payments/Backend',
      'Payments/Backend/Legacy',
    ]);
    expect(payments.find((t) => t.current)?.path.join('/')).toBe('Payments/Backend');
  });

  it('never lists a moved collection or its descendants', () => {
    const groups = moveTargets(NODES, PROJECTS, NODES[0]);
    expect(groups[1].targets.map((t) => t.path.join('/'))).toEqual(['Payments']);
    expect(groups[1].targets[0].current).toBe(true);
  });

  it('warns only across scopes and lists references the target cannot resolve', () => {
    expect(
      crossScopeWarning(NODES, PROJECTS, GLOBALS, api, { projectId: 'p1', parentId: null }),
    ).toBeNull();
    const toShop = crossScopeWarning(NODES, PROJECTS, GLOBALS, api, {
      projectId: 'p2',
      parentId: null,
    });
    expect(toShop?.title).toBe('Moving to another project');
    expect(toShop?.body).toContain('api will use the variables of Shop.');
    expect(toShop?.missing).toBe('');
    const toHome = crossScopeWarning(NODES, PROJECTS, GLOBALS, NODES[0], {
      projectId: null,
      parentId: null,
    });
    expect(toHome?.question).toBe('Move out of the project?');
    expect(toHome?.body).toContain('The 1 host in Backend will use global variables only');
    expect(toHome?.missing).toBe('Not defined in Home: db_host.');
  });

  it('labels a move into a project from Home', () => {
    const vps = host('h9', 'vps', null);
    expect(
      crossScopeWarning([vps], PROJECTS, GLOBALS, vps, { projectId: 'p1', parentId: null })?.title,
    ).toBe('Moving into a project');
  });

  it('names the destination, with the scope only across scopes', () => {
    const legacy = { projectId: 'p1', parentId: 'c2' };
    expect(moveDestination(NODES, PROJECTS, legacy, false)).toBe('Backend / Legacy');
    expect(moveDestination(NODES, PROJECTS, legacy, true)).toBe('Payments / Backend / Legacy');
    expect(moveDestination(NODES, PROJECTS, { projectId: 'p1', parentId: null }, false)).toBe(
      'Payments (top level)',
    );
    expect(moveDestination(NODES, PROJECTS, { projectId: null, parentId: 'c3' }, true)).toBe(
      'Home / Lab',
    );
    expect(moveDestination(NODES, PROJECTS, { projectId: null, parentId: null }, true)).toBe(
      'Home (top level)',
    );
  });

  it('writes the warning and the destination in French', () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    const toHome = crossScopeWarning(NODES, PROJECTS, GLOBALS, NODES[0], {
      projectId: null,
      parentId: null,
    });
    expect(toHome?.title).toBe('Sortie du projet');
    expect(toHome?.body).toContain('L’hôte de Backend n’utilisera que les variables globales.');
    expect(toHome?.missing).toBe('Non défini dans Accueil : db_host.');
    expect(moveDestination(NODES, PROJECTS, { projectId: null, parentId: null }, true)).toBe(
      'Accueil (racine)',
    );
    expect(moveTargets(NODES, PROJECTS, api)[0].targets.map((t) => t.path.join('/'))).toEqual([
      'Home',
      'Home/Lab',
    ]);
  });
});
