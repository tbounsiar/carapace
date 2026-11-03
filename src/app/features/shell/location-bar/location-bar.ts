import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiItem } from '@taiga-ui/cdk';
import { TuiButton, TuiDataList, TuiDropdown, TuiHint, TuiLink } from '@taiga-ui/core';
import { TuiBreadcrumbs, TuiFade } from '@taiga-ui/kit';
import { ConfigService } from '../../../core/ipc/config';
import type { Collection, Host, Project } from '../../../core/ipc/config.models';
import { CurrentScope } from '../../../shared/current-scope';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ancestors, HOME } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { SidebarState } from '../../sidebar/sidebar-state';
import { WorkspaceActions } from '../../workspace/workspace-actions';

const PAGES: Readonly<Record<string, string>> = {
  '/variables': 'Global variables',
  '/keys': 'SSH keys',
  '/settings': 'Settings',
};

interface Crumb {
  readonly id: string;
  readonly text: string;
  readonly link: readonly string[] | null;
  readonly collection: Collection | null;
}

interface PageMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly run: () => void;
  readonly separated?: boolean;
}

interface PageMenu {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly PageMenuEntry[];
}

interface Location {
  readonly project: Project | null;
  readonly collections: readonly Collection[];
  readonly current: string | null;
  readonly host: Host | null;
  /** On a tab route, the host crumb links to its page. */
  readonly hostCrumb: Host | null;
}

/** Breadcrumbs of the current route in the main subheader, with the page menu at its end. */
@Component({
  imports: [
    RouterLink,
    TuiBreadcrumbs,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiFade,
    TuiHint,
    TuiItem,
    TuiLink,
  ],
  selector: 'app-location-bar',
  templateUrl: './location-bar.html',
  styleUrl: './location-bar.scss',
})
export class LocationBar {
  private readonly config = inject(ConfigService);
  private readonly scope = inject(CurrentScope);
  private readonly actions = inject(ProjectActions);
  private readonly moves = inject(MoveLauncher);
  private readonly sidebar = inject(SidebarState);
  private readonly workspace = inject(WorkspaceActions);

  protected readonly menuOpen = signal(false);

  protected readonly location = computed<Location>(() => {
    const route = this.scope.route();
    const none: Location = {
      project: null,
      collections: [],
      current: null,
      host: null,
      hostCrumb: null,
    };
    switch (route.kind) {
      case 'home':
        return none;
      case 'project': {
        const project = this.config.findProject(route.projectId);
        if (!project) {
          return { ...none, current: this.config.loaded() ? 'Project not found' : null };
        }
        return route.variables
          ? { ...none, project, current: 'Variables' }
          : { ...none, current: project.name };
      }
      case 'host': {
        const found = this.config.findHost(route.hostId);
        if (!found) {
          return { ...none, current: this.config.loaded() ? 'Host not found' : null };
        }
        return {
          ...none,
          project: found.project,
          collections: ancestors(this.config.nodes(), found.host.id),
          current: found.host.name,
          host: found.host,
        };
      }
      case 'tab': {
        const tab = this.scope.tab();
        const found = tab ? this.config.findHost(tab.hostId) : null;
        if (!tab || !found) {
          return none;
        }
        return {
          ...none,
          project: found.project,
          collections: ancestors(this.config.nodes(), found.host.id),
          hostCrumb: found.host,
          current: tab.label,
        };
      }
      default:
        return { ...none, current: PAGES[route.path] ?? null };
    }
  });

  /** Home, the project, the collections, then the current page (the last one is not a link). */
  protected readonly crumbs = computed<Crumb[]>(() => {
    const { project, collections, current, hostCrumb } = this.location();
    const list: Crumb[] = [{ id: 'crumb-home', text: HOME, link: ['/'], collection: null }];
    if (project) {
      list.push({
        id: 'crumb-project',
        text: project.name,
        link: ['/projects', project.id],
        collection: null,
      });
    }
    for (const collection of collections) {
      list.push({
        id: `crumb-collection-${collection.name}`,
        text: collection.name,
        link: null,
        collection,
      });
    }
    if (hostCrumb) {
      list.push({
        id: 'crumb-host',
        text: hostCrumb.name,
        link: ['/hosts', hostCrumb.id],
        collection: null,
      });
    }
    if (current) {
      list.push({ id: 'crumb-current', text: current, link: null, collection: null });
    }
    return list;
  });

  protected reveal(collection: Collection): void {
    const path = ancestors(this.config.nodes(), collection.id).map((c) => c.id);
    this.sidebar.expand([...path, collection.id]);
    this.sidebar.focus(collection.id);
  }

  /** The "…" menu of a host page (the project dashboard has its own); its last entry deletes. */
  protected readonly pageMenu = computed<PageMenu | null>(() => {
    const tab = this.scope.tab();
    if (tab) {
      return {
        id: 'tab-page-menu',
        name: tab.label,
        entries: this.workspace.menu(tab),
      };
    }
    const { host } = this.location();
    if (host) {
      return {
        id: 'host-menu',
        name: host.name,
        entries: [
          {
            id: 'host-move',
            label: 'Move to…',
            icon: '@tui.folder-input',
            run: () => void this.moves.openDialog(host),
          },
          {
            id: 'host-delete',
            label: 'Delete host',
            icon: '@tui.trash',
            separated: true,
            run: () => void this.actions.deleteHost(host),
          },
        ],
      };
    }
    return null;
  });

  protected run(entry: PageMenuEntry): void {
    this.menuOpen.set(false);
    entry.run();
  }
}
