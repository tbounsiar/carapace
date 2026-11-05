import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../core/ipc/config';
import { EditedFiles } from '../../core/ipc/edited-files';
import { type DeleteTarget, ExternalEditsIpc } from '../../core/ipc/external-edits';
import type {
  Collection,
  ConfigNode,
  Host,
  HostInput,
  Project,
} from '../../core/ipc/config.models';
import { CurrentScope } from '../../shared/current-scope';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { deleteLines } from '../external-editor/edited-view';
import { SidebarState } from '../sidebar/sidebar-state';
import { Workspace } from '../workspace/workspace';
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
import { notifyError } from '../../shared/save-error';
import { uiText } from '../../shared/ui-text';

const T = 'projectTree.actions';

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
  private readonly workspace = inject(Workspace);
  private readonly external = inject(ExternalEditsIpc);
  private readonly edited = inject(EditedFiles);

  createProject(): void {
    void this.openNameDialog({
      label: uiText(`${T}.newProject`),
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
      label: uiText(`${T}.renameProject`),
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
      ? uiText(`${T}.deleteProject.full`, {
          name: project.name,
          content: countText(countNodes(nodes)),
        })
      : uiText(`${T}.deleteProject.empty`, { name: project.name });
    const inside = this.scope.projectId() === project.id;
    const ids = new Set(nodes.map((n) => n.id));
    const affected = await this.affected({ kind: 'project', id: project.id });
    const deleted = await this.confirmDelete(
      uiText(`${T}.deleteProject.label`),
      content + this.tabLines(ids) + deleteLines(affected),
      uiText(`${T}.deleteProject.failed`),
      () => this.config.deleteProject(project.id),
    );
    if (deleted && inside) {
      await this.router.navigate(['/']);
    }
    if (deleted) {
      this.closeTabs(ids);
    }
    return deleted;
  }

  addCollection(container: Container): void {
    void this.openNameDialog({
      label: uiText(`${T}.newCollection`),
      noun: 'collection',
      initial: '',
      placeholder: uiText(`${T}.collectionPlaceholder`),
      conflictMessage: uiText(`${T}.collectionConflict`),
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
      label: uiText(`${T}.renameCollection`),
      noun: 'collection',
      initial: collection.name,
      conflictMessage: uiText(`${T}.collectionConflict`),
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
      ? uiText(`${T}.deleteCollection.full`, {
          name: collection.name,
          content: countText(countNodes(inside)),
        })
      : uiText(`${T}.deleteCollection.empty`, { name: collection.name });
    const next = this.focusAfterDelete(collection);
    const ids = new Set([collection.id, ...inside.map((n) => n.id)]);
    const affected = await this.affected({ kind: 'collection', id: collection.id });
    const deleted = await this.confirmDelete(
      uiText(`${T}.deleteCollection.label`),
      content + this.tabLines(ids) + deleteLines(affected),
      uiText(`${T}.deleteCollection.failed`),
      async () => {
        await this.config.deleteCollection(collection.id);
      },
    );
    if (deleted) {
      await this.leaveDeleted(ids, collection.projectId);
      if (next) {
        this.sidebar.focus(next);
      }
    }
    return deleted;
  }

  addHost(container: Container): void {
    void this.openHostDialog(uiText(`${T}.newHost`), container, null, async (input) => {
      const host = await this.config.createHost(container.projectId, container.parentId, input);
      this.reveal(host, false);
      void this.router.navigate(['/hosts', host.id]);
      return host;
    });
  }

  editHost(host: Host, { sidebarFocus = true }: HostActionOptions = {}): void {
    const { name, hostname, port, username, auth } = host;
    void this.openHostDialog(
      uiText(`${T}.editHost`),
      host,
      { name, hostname, port, username, auth },
      async (input) => {
        const updated = await this.config.updateHost(host.id, input);
        if (sidebarFocus) {
          this.sidebar.focus(host.id);
        }
        return updated;
      },
      host.id,
    );
  }

  /** Resolves true when the host was deleted. */
  async deleteHost(host: Host, { sidebarFocus = true }: HostActionOptions = {}): Promise<boolean> {
    const next = this.focusAfterDelete(host);
    const affected = await this.affected({ kind: 'host', id: host.id });
    const deleted = await this.confirmDelete(
      uiText(`${T}.deleteHost.label`),
      uiText(`${T}.deleteHost.content`, { name: host.name }) +
        this.tabLines(new Set([host.id])) +
        deleteLines(affected),
      uiText(`${T}.deleteHost.failed`),
      () => this.config.deleteHost(host.id),
    );
    if (deleted) {
      await this.leaveDeleted(new Set([host.id]), host.projectId);
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

  /** The open host page or tab was inside what was deleted: go to the scope home. */
  private async leaveDeleted(ids: ReadonlySet<string>, projectId: string | null): Promise<void> {
    const hostId = this.scope.hostId();
    if (hostId && ids.has(hostId)) {
      await this.router.navigate(projectId ? ['/projects', projectId] : ['/']);
    }
    this.closeTabs(ids);
  }

  /** " 2 open tabs will be closed. Unsaved changes in nginx.conf will be lost." for a confirm. */
  private tabLines(ids: ReadonlySet<string>): string {
    const tabs = this.workspace.tabs().filter((t) => ids.has(t.hostId));
    if (!tabs.length) {
      return '';
    }
    const modified = tabs.filter((t) => t.modified()).map((t) => t.label);
    const lost = modified.length
      ? ` ${uiText(`${T}.unsaved`, { names: modified.join(', ') })}`
      : '';
    return ` ${uiText(`${T}.tabs`, { count: tabs.length })}${lost}`;
  }

  private closeTabs(ids: ReadonlySet<string>): void {
    // The backend deleted their copies with the hosts.
    this.edited.remove(
      this.edited
        .files()
        .filter((f) => ids.has(f.hostId))
        .map((f) => f.id),
    );
    const tabs = this.workspace.tabs().filter((t) => ids.has(t.hostId));
    if (tabs.length) {
      this.workspace.drop(tabs.map((t) => t.id));
    }
  }

  /** Files open in an external editor that a delete would stop; none when the query fails. */
  private affected(target: DeleteTarget) {
    return this.external.affected(target).catch(() => []);
  }

  private async confirmDelete(
    label: string,
    content: string,
    failure: string,
    run: () => Promise<void>,
  ): Promise<boolean> {
    const confirmed = await confirmDestructive(this.dialogs, label, {
      content,
      yes: uiText('common.delete'),
      no: uiText('common.cancel'),
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
    hostId: string | null = null,
  ): Promise<void> {
    const { HostDialog } = await import('./host-dialog/host-dialog');
    this.dialogs
      .open<void>(new PolymorpheusComponent(HostDialog), {
        label,
        size: 'm',
        data: {
          projectId: container.projectId,
          hostId,
          location: this.locationText(container),
          initial,
          save,
        } satisfies HostDialogData,
      })
      .subscribe();
  }
}
