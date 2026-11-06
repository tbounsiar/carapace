import type { ConfigNode, Host, Project } from '../../core/ipc/config.models';
import { ancestors } from '../project-tree/node-tree';
import { uiText } from '../../shared/ui-text';
import { statusWord } from './tab-status';
import type { WorkspaceTab } from './workspace';

/** The number of a terminal tab, from its key `terminal:{hostId}:{n}`. */
export function terminalNumber(tab: WorkspaceTab): string | null {
  return tab.kind === 'terminal' ? (/:(\d+)$/.exec(tab.key)?.[1] ?? null) : null;
}

/** "Terminal 2" and "Files" in the active language; an editor tab is its file name. */
export function tabLabel(tab: WorkspaceTab): string {
  if (tab.kind === 'files') {
    return uiText('workspace.tab.files');
  }
  const n = terminalNumber(tab);
  return n === null ? tab.label : uiText('workspace.tab.terminal', { n });
}

export interface TabTitle {
  /** Collections above the host, `a / b`; empty at the scope root. */
  readonly path: string;
  readonly host: string;
  readonly label: string;
  /** `{path} / {host} · {label}`. */
  readonly title: string;
  /** Scope, path, title, status word, and for editors `host:/path`. */
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
  nodes: readonly ConfigNode[],
): ReadonlyMap<string, TabTitle> {
  const byId = new Map(hosts.map((h) => [h.id, h]));
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
    const hostName = host?.name ?? uiText('workspace.tab.unknownHost');
    const repeated = (editorNames.get(`${tab.hostId}\n${tab.label}`) ?? 0) > 1;
    const parent = tab.path ? parentName(tab.path) : '';
    const label =
      tab.kind === 'edit' && repeated && parent ? `${parent}/${tab.label}` : tabLabel(tab);
    const path = host
      ? ancestors(nodes, host.id)
          .map((c) => c.name)
          .join(' / ')
      : '';
    const title = `${path ? `${path} / ` : ''}${hostName} · ${label}`;
    const scope = !host
      ? ''
      : host.projectId
        ? (projects.find((p) => p.id === host.projectId)?.name ??
          uiText('workspace.tab.unknownProject'))
        : uiText('common.home');
    const where = tab.path ? `, ${hostName}:${tab.path}` : '';
    const hint = `${scope ? `${scope} / ` : ''}${title} — ${statusWord(tab.status())}${where}`;
    const extra = [
      tab.modified() ? uiText('workspace.tab.modified') : '',
      tab.readOnly() ? uiText('workspace.tab.readOnly') : '',
    ]
      .filter(Boolean)
      .map((part) => `, ${part}`)
      .join('');
    titles.set(tab.id, { path, host: hostName, label, title, hint, aria: `${hint}${extra}` });
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
  return names.length > 5
    ? uiText('workspace.unsaved.names', { shown, more: names.length - 5 })
    : shown;
}
