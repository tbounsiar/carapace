import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../core/ipc/config';
import type {
  Collection,
  ConfigNode,
  Host,
  HostInput,
  Project,
} from '../../core/ipc/config.models';
import { CurrentScope } from '../../shared/current-scope';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { SidebarState } from '../sidebar/sidebar-state';
import type { HostDialogData } from './host-dialog/host-dialog';
import type { NameDialogData } from './name-dialog/name-dialog';
import {
  ancestors,
  byName,
  containerPath,
  countNodes,
  countText,
  descendants,
  type Container,
} from './node-tree';
import { notifyError } from './save-error';

/** `sidebarFocus: false` when the action comes from outside the sidebar, which keeps its own focus. */
export interface HostActionOptions {
  readonly sidebarFocus?: boolean;
}

/** Create, edit and delete flows for projects, collections and hosts. */
@Service()
export class ProjectActions {
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly router = inject(Router);
  private readonly scope = inject(CurrentScope);
  private readonly sidebar = inject(SidebarState);

  createProject(): void {
    void this.openNameDialog({
      label: 'New project',
      noun: 'project',
      initial: '',
      save: async (name) => {
        const project = await this.config.createProject(name);
        void this.router.navigate(['/projects', project.id]);
      },
    });
  }

  renameProject(project: Project): void {
    void this.openNameDialog({
      label: 'Rename project',
      noun: 'project',
      initial: project.name,
      save: (name) =>
        name === project.name ? Promise.resolve() : this.config.renameProject(project.id, name),
    });
  }

  /** Resolves true when the project was deleted. */
  async deleteProject(project: Project): Promise<boolean> {
    const nodes = this.config.nodes().filter((n) => n.projectId === project.id);
    const content = nodes.length
      ? `“${project.name}” contains ${countText(countNodes(nodes))}. Everything in it will be deleted, with its variables and saved passwords. Open connections are closed. This cannot be undone.`
      : `“${project.name}” is empty. It will be deleted with its variables. This cannot be undone.`;
    const inside = this.scope.projectId() === project.id;
    const deleted = await this.confirmDelete(
      'Delete project?',
      content,
      'Project not deleted',
      () => this.config.deleteProject(project.id),
    );
    if (deleted && inside) {
      void this.router.navigate(['/']);
    }
    return deleted;
  }

  addCollection(container: Container): void {
    void this.openNameDialog({
      label: 'New collection',
      noun: 'collection',
      initial: '',
      placeholder: 'Backend',
      conflictMessage: 'A collection with this name already exists here.',
      save: async (name) => {
        const created = await this.config.createCollection(
          container.projectId,
          container.parentId,
          name,
        );
        this.reveal(created, true);
      },
    });
  }

  renameCollection(collection: Collection): void {
    void this.openNameDialog({
      label: 'Rename collection',
      noun: 'collection',
      initial: collection.name,
      conflictMessage: 'A collection with this name already exists here.',
      save: async (name) => {
        if (name !== collection.name) {
          await this.config.renameCollection(collection.id, name);
        }
        this.sidebar.focus(collection.id);
      },
    });
  }

  /** Resolves true when the collection and everything in it was deleted. */
  async deleteCollection(collection: Collection): Promise<boolean> {
    const inside = descendants(this.config.nodes(), collection.id);
    const content = inside.length
      ? `“${collection.name}” contains ${countText(countNodes(inside))}. They will all be deleted, with their saved passwords. Open connections to these hosts are closed. This cannot be undone. To keep the hosts, move them out first.`
      : `“${collection.name}” is empty.`;
    const next = this.focusAfterDelete(collection);
    const deleted = await this.confirmDelete(
      'Delete collection?',
      content,
      'Collection not deleted',
      async () => {
        await this.config.deleteCollection(collection.id);
      },
    );
    if (deleted) {
      this.leaveDeleted(new Set([collection.id, ...inside.map((n) => n.id)]), collection.projectId);
      if (next) {
        this.sidebar.focus(next);
      }
    }
    return deleted;
  }

  addHost(container: Container): void {
    void this.openHostDialog('New host', container, null, async (input) => {
      const host = await this.config.createHost(container.projectId, container.parentId, input);
      this.reveal(host, false);
      void this.router.navigate(['/hosts', host.id]);
      return host;
    });
  }

  editHost(host: Host, { sidebarFocus = true }: HostActionOptions = {}): void {
    const { name, hostname, port, username, auth } = host;
    void this.openHostDialog(
      'Edit host',
      host,
      { name, hostname, port, username, auth },
      async (input) => {
        const updated = await this.config.updateHost(host.id, input);
        if (sidebarFocus) {
          this.sidebar.focus(host.id);
        }
        return updated;
      },
    );
  }

  /** Resolves true when the host was deleted. */
  async deleteHost(host: Host, { sidebarFocus = true }: HostActionOptions = {}): Promise<boolean> {
    const next = this.focusAfterDelete(host);
    const deleted = await this.confirmDelete(
      'Delete host?',
      `“${host.name}” and its saved passwords will be deleted. Open connections to it are closed.`,
      'Host not deleted',
      () => this.config.deleteHost(host.id),
    );
    if (deleted) {
      this.leaveDeleted(new Set([host.id]), host.projectId);
      if (next && sidebarFocus) {
        this.sidebar.focus(next);
      }
    }
    return deleted;
  }

  /** "Home / Backend": where a new host or collection goes. */
  locationText(container: Container): string {
    return containerPath(this.config.nodes(), this.config.projects(), container).join(' / ');
  }

  private reveal(node: ConfigNode, expandSelf: boolean): void {
    const path = ancestors(this.config.nodes(), node.id).map((c) => c.id);
    this.sidebar.expand(expandSelf ? [...path, node.id] : path);
    this.sidebar.focus(node.id);
  }

  /** Next sibling, else the previous one, else the parent collection. */
  private focusAfterDelete(node: ConfigNode): string | null {
    const siblings = this.config
      .nodes()
      .filter((n) => n.projectId === node.projectId && n.parentId === node.parentId)
      .sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'collection' ? -1 : 1));
    const index = siblings.findIndex((n) => n.id === node.id);
    return siblings[index + 1]?.id ?? siblings[index - 1]?.id ?? node.parentId;
  }

  /** The open host page was inside what was deleted: go to the scope home. */
  private leaveDeleted(ids: ReadonlySet<string>, projectId: string | null): void {
    const route = this.scope.route();
    if (route.kind === 'host' && ids.has(route.hostId)) {
      void this.router.navigate(projectId ? ['/projects', projectId] : ['/']);
    }
  }

  private async confirmDelete(
    label: string,
    content: string,
    failure: string,
    run: () => Promise<void>,
  ): Promise<boolean> {
    const confirmed = await confirmDestructive(this.dialogs, label, {
      content,
      yes: 'Delete',
      no: 'Cancel',
    });
    if (!confirmed) {
      return false;
    }
    try {
      await run();
      return true;
    } catch (err) {
      notifyError(this.alerts, err, failure);
      return false;
    }
  }

  private async openNameDialog(data: NameDialogData & { label: string }): Promise<void> {
    const { NameDialog } = await import('./name-dialog/name-dialog');
    const { label, ...rest } = data;
    this.dialogs
      .open<void>(new PolymorpheusComponent(NameDialog), {
        label,
        size: 's',
        data: rest satisfies NameDialogData,
      })
      .subscribe();
  }

  private async openHostDialog(
    label: string,
    container: Container,
    initial: HostInput | null,
    save: HostDialogData['save'],
  ): Promise<void> {
    const { HostDialog } = await import('./host-dialog/host-dialog');
    this.dialogs
      .open<void>(new PolymorpheusComponent(HostDialog), {
        label,
        size: 'm',
        data: {
          projectId: container.projectId,
          location: this.locationText(container),
          initial,
          save,
        } satisfies HostDialogData,
      })
      .subscribe();
  }
}
