import { collection, host, project } from '../../core/ipc/config.fixture';
import type { Host } from '../../core/ipc/config.models';
import { scopeTree } from '../project-tree/node-tree';
import {
  countText,
  filterGroups,
  hostGroups,
  projectMatches,
  projectSummary,
  statsText,
  type BoardLookups,
} from './board';

const NODES = [
  collection('b', 'Backend', 'p1'),
  collection('l', 'Legacy', 'p1', 'b'),
  collection('o', 'Only folders', 'p1'),
  collection('d', 'Deep', 'p1', 'o'),
  host('h1', 'api-1', 'p1', 'b'),
  host('h2', 'api-2', 'p1', 'b'),
  host('h3', 'old', 'p1', 'l'),
  host('h4', 'bastion', 'p1'),
  host('h5', 'cache', 'p1', 'd'),
];

const lookups: BoardLookups = {
  address: (h: Host) => `deploy@${h.hostname}:22`,
  connected: (h: Host) => h.id === 'h2' || h.id === 'h4',
};

describe('board', () => {
  const groups = () => hostGroups(scopeTree(NODES, 'p1'), 'Payments');

  it('groups hosts by the container holding them, root first then depth-first', () => {
    expect(groups().map((g) => g.label)).toEqual([
      'Payments (top level)',
      'Backend',
      'Backend / Legacy',
      'Only folders / Deep',
    ]);
    expect(groups().map((g) => g.testId)).toEqual([
      'host-group-Payments',
      'host-group-Payments/Backend',
      'host-group-Payments/Backend/Legacy',
      'host-group-Payments/Only folders/Deep',
    ]);
    expect(groups()[1].hosts.map((h) => h.name)).toEqual(['api-1', 'api-2']);
  });

  it('searches names, addresses and collection names, and drops empty groups', () => {
    const search = (query: string, connectedOnly = false) =>
      filterGroups(groups(), { query, connectedOnly }, lookups).map((g) => [
        g.label,
        g.hosts.map((h) => h.id),
      ]);
    expect(search('API')).toEqual([['Backend', ['h1', 'h2']]]);
    expect(search('old.example')).toEqual([['Backend / Legacy', ['h3']]]);
    expect(search('legacy')).toEqual([['Backend / Legacy', ['h3']]]);
    expect(search('', true)).toEqual([
      ['Payments (top level)', ['h4']],
      ['Backend', ['h2']],
    ]);
    expect(search('api', true)).toEqual([['Backend', ['h2']]]);
    expect(search('nothing')).toEqual([]);
  });

  it('filters project cards by name and open connections', () => {
    const payments = project('p1', 'Payments');
    expect(projectMatches(payments, { query: 'pay', connectedOnly: false }, 0)).toBe(true);
    expect(projectMatches(payments, { query: '', connectedOnly: true }, 0)).toBe(false);
    expect(projectMatches(payments, { query: 'x', connectedOnly: false }, 2)).toBe(false);
  });

  it('writes stats, counts and summaries', () => {
    expect(statsText({ hosts: 12, collections: 3, connected: 2 })).toBe(
      '12 hosts · 3 collections · 2 connected',
    );
    expect(statsText({ hosts: 1, collections: 1, connected: 0 })).toBe('1 host · 1 collection');
    expect(statsText({ hosts: 0, collections: 2, connected: 0 })).toBe(
      'No hosts yet · 2 collections',
    );
    expect(statsText({ hosts: 3, collections: 1, connected: 1, projects: 2 })).toBe(
      '3 hosts · 1 collection · 1 connected · 2 projects',
    );
    expect(statsText({ hosts: 0, collections: 0, connected: 0, projects: 1 })).toBe(
      'No hosts yet · 1 project',
    );
    expect(countText(5, 12)).toBe('5 of 12 hosts');
    expect(projectSummary(20, 2)).toBe('20 hosts · 2 connected');
    expect(projectSummary(1, 0)).toBe('1 host');
  });
});
