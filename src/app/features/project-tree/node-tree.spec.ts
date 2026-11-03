import { collection, host, project } from '../../core/ipc/config.fixture';
import {
  ancestors,
  canMoveInto,
  containerPath,
  countNodes,
  countText,
  descendants,
  filterTree,
  firstHost,
  hostMatches,
  hostsOf,
  scopeTree,
  type TreeCollection,
} from './node-tree';

const NODES = [
  host('h1', 'web-10', 'p1'),
  collection('c2', 'db', 'p1'),
  host('h2', 'web-9', 'p1'),
  collection('c1', 'Backend', 'p1'),
  host('h3', 'api', 'p1', 'c1'),
  collection('c3', 'Legacy', 'p1', 'c1'),
  host('h4', 'old', 'p1', 'c3'),
  host('h5', 'vps', null),
];
const PROJECTS = [project('p1', 'Payments')];

describe('node-tree', () => {
  it('builds one scope, collections first, names sorted numerically', () => {
    const tree = scopeTree(NODES, 'p1');
    expect(tree.map((i) => i.id)).toEqual(['c1', 'c2', 'h2', 'h1']);
    const backend = tree[0];
    expect(backend.kind === 'collection' && backend.children.map((i) => i.id)).toEqual([
      'c3',
      'h3',
    ]);
    expect(scopeTree(NODES, null).map((i) => i.id)).toEqual(['h5']);
  });

  it('walks ancestors and descendants', () => {
    expect(ancestors(NODES, 'h4').map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(ancestors(NODES, 'h1')).toEqual([]);
    expect(
      descendants(NODES, 'c1')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['c3', 'h3', 'h4']);
    expect(
      hostsOf(NODES, NODES[3])
        .map((h) => h.id)
        .sort(),
    ).toEqual(['h3', 'h4']);
  });

  it('counts with singular forms and leaves zero parts out', () => {
    expect(countText({ collections: 2, hosts: 12 })).toBe('2 collections and 12 hosts');
    expect(countText({ collections: 1, hosts: 0 })).toBe('1 collection');
    expect(countText({ collections: 0, hosts: 1 })).toBe('1 host');
    expect(countText({ collections: 0, hosts: 0 })).toBe('');
    expect(countNodes(descendants(NODES, 'c1'))).toEqual({ collections: 1, hosts: 2 });
  });

  it('names containers by scope then collections', () => {
    expect(containerPath(NODES, PROJECTS, { projectId: 'p1', parentId: 'c3' })).toEqual([
      'Payments',
      'Backend',
      'Legacy',
    ]);
    expect(containerPath(NODES, PROJECTS, { projectId: null, parentId: null })).toEqual(['Home']);
  });

  it('refuses a collection into itself or a descendant', () => {
    const backend = NODES[3];
    expect(canMoveInto(NODES, backend, { projectId: 'p1', parentId: 'c1' })).toBe(false);
    expect(canMoveInto(NODES, backend, { projectId: 'p1', parentId: 'c3' })).toBe(false);
    expect(canMoveInto(NODES, backend, { projectId: 'p1', parentId: 'c2' })).toBe(true);
    expect(canMoveInto(NODES, NODES[0], { projectId: 'p1', parentId: 'c1' })).toBe(true);
  });

  describe('filtering', () => {
    const nodes = [
      collection('b', 'Backend', 'p1'),
      collection('l', 'Legacy', 'p1', 'b'),
      collection('e', 'Empty', 'p1'),
      host('h1', 'api-1', 'p1', 'l'),
      host('h2', 'web', 'p1', 'b'),
      { ...host('h3', 'bastion', 'p1'), hostname: '10.0.0.1' },
    ];
    const tree = () => scopeTree(nodes, 'p1');

    it('matches the host name or the raw hostname, case-insensitively', () => {
      expect(hostMatches(nodes[3] as never, 'API')).toBe(true);
      expect(hostMatches(nodes[5] as never, '10.0')).toBe(true);
      expect(hostMatches(nodes[4] as never, 'api')).toBe(false);
    });

    it('keeps matches with their ancestors and drops empty collections', () => {
      const filtered = filterTree(tree(), (h) => hostMatches(h, 'api'));
      expect(filtered.map((i) => i.id)).toEqual(['b']);
      const backend = filtered[0] as TreeCollection;
      expect(backend.children.map((i) => i.id)).toEqual(['l']);
      expect((backend.children[0] as TreeCollection).children.map((i) => i.id)).toEqual(['h1']);
      expect(filterTree(tree(), () => false)).toEqual([]);
    });

    it('finds the first host in display order', () => {
      expect(firstHost(tree())?.id).toBe('h1');
      expect(firstHost(filterTree(tree(), (h) => h.id === 'h3'))?.id).toBe('h3');
      expect(firstHost([])).toBeNull();
    });
  });
});
