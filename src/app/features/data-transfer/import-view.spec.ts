import type { PlanItem } from '../../core/ipc/data-transfer';
import { plan, preview, result, row } from './import.fixture';
import {
  deletedSecretsText,
  detailLines,
  detailViews,
  exportCountsText,
  fileMeta,
  hasDeletions,
  listNames,
  needsSecretLine,
  nothingToImport,
  replaceConfirmText,
  replaceSubtitle,
  secretsSentLines,
  summaryItems,
  summarySentence,
  tableView,
  undefinedLine,
} from './import-view';

const item = (extra: Partial<PlanItem>): PlanItem => ({
  kind: 'host',
  action: 'update',
  name: 'api-1',
  newName: null,
  location: ['Payments'],
  reason: 'same_id',
  changes: [],
  ...extra,
});

describe('import view', () => {
  it('hides empty rows and columns and marks deleted counts', () => {
    const p = preview().plans;
    expect(tableView(p.merge, 'merge')).toEqual({
      columns: ['New', 'Updated', 'Unchanged'],
      rows: [
        {
          kind: 'collection',
          label: 'Collections',
          cells: [
            { value: 2, negative: false },
            { value: 0, negative: false },
            { value: 0, negative: false },
          ],
        },
        {
          kind: 'host',
          label: 'Hosts',
          cells: [
            { value: 4, negative: false },
            { value: 9, negative: false },
            { value: 7, negative: false },
          ],
        },
      ],
    });
    const replace = tableView(p.replace, 'replace');
    expect(replace.columns).toEqual(['New', 'Updated', 'Deleted']);
    expect(replace.rows[0].cells[2]).toEqual({ value: 3, negative: true });
    expect(tableView(p.duplicate, 'duplicate').columns).toEqual(['New', 'Copied']);
  });

  it('knows when nothing would change and when Replace deletes', () => {
    expect(nothingToImport(plan({ rows: [row('host', { unchanged: 3, skipped: 1 })] }))).toBe(true);
    expect(nothingToImport(preview().plans.merge)).toBe(false);
    expect(hasDeletions(preview().plans.replace)).toBe(true);
    expect(hasDeletions(preview().plans.merge)).toBe(false);
    expect(hasDeletions(plan({ secretValuesDeleted: 1 }))).toBe(true);
  });

  it('names what Replace makes like the file', () => {
    expect(replaceSubtitle({ kind: 'project', projectName: 'Payments' })).toBe(
      'Make Payments exactly like the file',
    );
    expect(replaceSubtitle({ kind: 'home' })).toBe(
      'Make Home and global variables exactly like the file',
    );
    expect(replaceSubtitle({ kind: 'all' })).toBe('Make all your data exactly like the file');
  });

  it('describes the file and leaves missing facts out', () => {
    const meta = fileMeta(preview().file);
    expect(meta.startsWith('Project “Payments” · exported ')).toBe(true);
    expect(meta.endsWith(' · Carapace 0.2.0')).toBe(true);
    expect(fileMeta({ scope: { kind: 'all' }, exportedAt: null, appVersion: null })).toBe(
      'Everything',
    );
    expect(fileMeta({ scope: { kind: 'home' }, exportedAt: 'nope', appVersion: null })).toBe(
      'Home',
    );
  });

  it('lists names with a remainder', () => {
    expect(listNames(['a', 'b'])).toBe('a, b');
    expect(listNames(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toBe('a, b, c, d, e and 3 more');
  });

  it('builds the counts sentence from non-zero parts', () => {
    expect(summarySentence(result().rows)).toBe(
      '4 hosts and 2 collections added, 9 hosts updated.',
    );
    expect(
      summarySentence([row('host', { removed: 3, copied: 1 }), row('key', { added: 1 })]),
    ).toBe('1 host copied, 3 hosts deleted, 1 SSH key registered.');
    expect(summarySentence([])).toBe('Nothing changed.');
  });

  it('writes the Replace confirmation with the workspace lines', () => {
    const p = plan({
      rows: [
        row('host', { removed: 12 }),
        row('collection', { removed: 2 }),
        row('variable', { removed: 3 }),
      ],
      affectedConnectedHosts: ['a', 'b'],
    });
    expect(replaceConfirmText(p, ' 1 open tab will be closed.')).toBe(
      '12 hosts, 2 collections and 3 variables will be deleted from this computer, with their saved passwords. 2 open connections are closed. A backup of your data is kept. 1 open tab will be closed.',
    );
    expect(replaceConfirmText(plan({ rows: [row('host', { removed: 1 })] }), '')).toBe(
      '1 host will be deleted from this computer, with its saved passwords. A backup of your data is kept.',
    );
    expect(
      replaceConfirmText(
        plan({ rows: [row('variable', { removed: 1 })], affectedConnectedHosts: ['a'] }),
        '',
      ),
    ).toBe(
      '1 variable will be deleted from this computer, with its saved passwords. 1 open connection is closed. A backup of your data is kept.',
    );
    expect(
      replaceConfirmText(
        plan({ rows: [row('host', { removed: 1 }), row('collection', { removed: 1 })] }),
        '',
      ),
    ).toBe(
      '1 host and 1 collection will be deleted from this computer, with their saved passwords. A backup of your data is kept.',
    );
  });

  it('counts deleted secrets', () => {
    expect(deletedSecretsText(preview().plans.replace, 'replace')).toBe(
      'Replace deletes 2 secret variable values and the saved passwords of 3 hosts from this computer.',
    );
    expect(deletedSecretsText(plan({ savedSecretHosts: 1 }), 'merge')).toBe(
      'This import deletes the saved passwords of 1 host from this computer.',
    );
    expect(deletedSecretsText(plan(), 'merge')).toBeNull();
  });

  it('writes secrets to set and undefined variables', () => {
    expect(
      needsSecretLine({
        scope: { kind: 'project', projectId: 'p1', projectName: 'Payments' },
        name: 'db_pw',
        hostCount: 4,
      }),
    ).toBe('db_pw (Payments) — used by 4 hosts');
    expect(needsSecretLine({ scope: { kind: 'global' }, name: 'root_pw', hostCount: 1 })).toBe(
      'root_pw (global) — used by 1 host',
    );
    expect(undefinedLine([{ name: 'db_port', hostCount: 2 }])).toBe(
      'Not defined anywhere: db_port (used by 2 hosts).',
    );
  });

  it('explains each detail item', () => {
    expect(
      detailLines(
        item({
          changes: [
            { field: 'address', from: 'a@h:22', to: 'a@k:22' },
            { field: 'location', from: 'Home', to: 'Payments' },
            { field: 'value', from: '1', to: '2' },
          ],
        }),
      ),
    ).toEqual([
      'Address: a@h:22 → a@k:22',
      'Moves from Home to Payments',
      'Value: 1 → 2',
      'Same id',
    ]);
    expect(
      detailLines(item({ action: 'rename', newName: 'api-1 (imported)', reason: 'name_taken' })),
    ).toEqual(['Renamed: api-1 → api-1 (imported)', 'Same name as a host here']);
    expect(detailLines(item({ kind: 'variable', reason: 'kept_secret' }))).toEqual([
      'Kept as secret on this computer',
    ]);
    expect(detailLines(item({ kind: 'variable', reason: 'becomes_secret' }))).toEqual([
      'Becomes secret, no value',
    ]);
    expect(detailLines(item({ action: 'remove', reason: 'not_in_file' }))).toEqual([
      'Deleted from this computer',
    ]);
    expect(
      detailLines(item({ action: 'skip', kind: 'variable', reason: 'variable_exists' })),
    ).toEqual(['Skipped: a variable with this name exists here']);
    expect(
      detailLines(
        item({ action: 'skip', kind: 'key', reason: 'key_file_missing', path: '~/.ssh/id_work' }),
      ),
    ).toEqual(['Key file not found on this computer: ~/.ssh/id_work']);
    expect(detailLines(item({ action: 'skip', kind: 'key', reason: 'key_file_missing' }))).toEqual([
      'Key file not found on this computer',
    ]);
    expect(
      detailLines(
        item({
          action: 'skip',
          kind: 'key',
          reason: 'key_file_mismatch',
          detail: 'ed25519',
        }),
      ),
    ).toEqual(['Key file does not match (ed25519)']);
  });

  it('explains a key outside the home folder and variables that move hosts', () => {
    expect(
      detailLines(
        item({
          action: 'skip',
          kind: 'key',
          reason: 'key_file_missing',
          detail: 'outside_home',
          path: 'D:/keys/id_work',
        }),
      ),
    ).toEqual(['Key file outside your home folder: D:/keys/id_work. Add it in SSH keys by hand.']);
    expect(
      detailLines(
        item({
          kind: 'variable',
          name: 'db_host',
          reason: 'redirects_hosts',
          changes: [{ field: 'value', from: '10.0.1.9', to: '10.9.9.9' }],
          redirects: ['api-1', 'api-2'],
        }),
      ),
    ).toEqual(['Value: 10.0.1.9 → 10.9.9.9', 'Changes the address of 2 hosts: api-1, api-2']);
    expect(
      detailLines(item({ kind: 'variable', reason: 'redirects_hosts', redirects: ['api-1'] })),
    ).toEqual(['Changes the address of 1 host: api-1']);
  });

  it('orders details, badges them and makes repeated names unique', () => {
    const views = detailViews([
      item({ action: 'skip', kind: 'key', name: 'work', reason: 'key_file_missing' }),
      item({ action: 'remove', name: 'web', location: ['Payments', 'A'], reason: 'not_in_file' }),
      item({ action: 'skip', kind: 'variable', name: 'user', reason: 'variable_exists' }),
      item({ action: 'remove', name: 'web', location: ['Payments', 'B'], reason: 'not_in_file' }),
      item({ action: 'update' }),
    ]);
    expect(views.map((v) => [v.testId, v.badge.label, v.badge.appearance])).toEqual([
      ['import-item-host-api-1', 'Updated', 'info'],
      ['import-item-host-web/Payments/A', 'Deleted', 'negative'],
      ['import-item-host-web/Payments/B', 'Deleted', 'negative'],
      ['import-item-variable-user', 'Skipped', 'neutral'],
      ['import-item-key-work', 'Skipped', 'neutral'],
    ]);
    expect(views[0].icon).toBe('@tui.server');
    expect(views[0].location).toBe('Payments');
  });

  it('lists renamed and skipped items in the summary', () => {
    const skipped = item({ action: 'skip', kind: 'key', name: 'work', reason: 'key_file_missing' });
    const items = summaryItems(
      result({
        renamed: [{ kind: 'host', from: 'api-1', to: 'api-1 (imported)' }],
        skipped: [skipped],
      }),
    );
    expect(items.map((i) => [i.action, i.name, i.newName])).toEqual([
      ['rename', 'api-1', 'api-1 (imported)'],
      ['skip', 'work', null],
    ]);
  });

  it('counts an export for its toast', () => {
    expect(
      exportCountsText({
        projects: 3,
        collections: 0,
        hosts: 40,
        variables: 25,
        secretVariables: 4,
        keys: 1,
      }),
    ).toBe('3 projects · 40 hosts · 25 variables · 1 SSH key');
  });

  it('lists secrets sent to new servers, at most 10', () => {
    const entry = (i: number) => ({
      host: `h${i}`,
      location: [],
      variable: 'pw',
      from: i === 0 ? 'a@old:22' : null,
      to: 'a@new:22',
    });
    expect(secretsSentLines(undefined)).toEqual([]);
    const lines = secretsSentLines(Array.from({ length: 12 }, (_, i) => entry(i)));
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('h0 will send pw to a@new:22 instead of a@old:22');
    expect(lines[1]).toBe('h1 will send pw to a@new:22');
    expect(lines[10]).toBe('and 2 more');
  });
});
