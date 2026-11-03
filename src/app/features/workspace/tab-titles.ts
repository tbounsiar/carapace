import type { Host, Project } from '../../core/ipc/config.models';
import type { WorkspaceTab } from './workspace';

export interface TabTitle {
  readonly host: string;
  readonly label: string;
  /** `{host} · {label}`. */
  readonly title: string;
  /** Title, status word, and for editors `host:/path`; the scope when host names repeat. */
  readonly hint: string;
  /** Hint plus modified / read-only. */
  readonly aria: string;
}

function parentName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

/** Titles of all tabs; editors of one host with the same file name show their parent folder. */
export function tabTitles(
  tabs: readonly WorkspaceTab[],
  hosts: readonly Host[],
  projects: readonly Project[],
): ReadonlyMap<string, TabTitle> {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const nameCount = new Map<string, number>();
  for (const host of new Set(tabs.map((t) => byId.get(t.hostId)).filter((h) => !!h))) {
    nameCount.set(host.name, (nameCount.get(host.name) ?? 0) + 1);
  }
  const editorNames = new Map<string, number>();
  for (const tab of tabs) {
    if (tab.kind === 'edit') {
      const key = `${tab.hostId}\n${tab.label}`;
      editorNames.set(key, (editorNames.get(key) ?? 0) + 1);
    }
  }
  const titles = new Map<string, TabTitle>();
  for (const tab of tabs) {
    const host = byId.get(tab.hostId);
    const hostName = host?.name ?? 'Unknown host';
    const repeated = (editorNames.get(`${tab.hostId}\n${tab.label}`) ?? 0) > 1;
    const parent = tab.path ? parentName(tab.path) : '';
    const label = tab.kind === 'edit' && repeated && parent ? `${parent}/${tab.label}` : tab.label;
    const title = `${hostName} · ${label}`;
    let scoped = hostName;
    if (host && (nameCount.get(hostName) ?? 0) > 1) {
      const scope = host.projectId
        ? (projects.find((p) => p.id === host.projectId)?.name ?? 'Unknown project')
        : 'Home';
      scoped = `${hostName} (${scope})`;
    }
    const where = tab.path ? `, ${hostName}:${tab.path}` : '';
    const hint = `${scoped} · ${label} — ${tab.status().word}${where}`;
    const extra = `${tab.modified() ? ', modified' : ''}${tab.readOnly() ? ', read-only' : ''}`;
    titles.set(tab.id, { host: hostName, label, title, hint, aria: `${hint}${extra}` });
  }
  return titles;
}

/** "nginx.conf (vps), app.env (db-1)", at most five names, then "and N more". */
export function unsavedNames(
  tabs: readonly WorkspaceTab[],
  hostName: (hostId: string) => string,
): string {
  const names = tabs.map((t) => `${t.label} (${hostName(t.hostId)})`);
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}
