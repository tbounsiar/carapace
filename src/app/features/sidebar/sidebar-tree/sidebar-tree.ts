import { NgTemplateOutlet } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  linkedSignal,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiLoader,
  TuiNotificationService,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiChevron, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiNavigation } from '@taiga-ui/layout';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConfigService } from '../../../core/ipc/config';
import type { Collection, ConfigNode, Host, Project } from '../../../core/ipc/config.models';
import { hostTarget, type ConnectionTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import {
  connectedCounts,
  connectionStatus,
  type ConnectionStatus,
} from '../../../shared/connection-status';
import { CurrentScope } from '../../../shared/current-scope';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ancestors, type Container, type TreeItem } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { errorText, notifyError } from '../../../shared/save-error';
import { uiText } from '../../../shared/ui-text';
import { isTreeKey, treeKeyAction, type VisibleRow } from '../../project-tree/tree-keys';
import { SIDEBAR_DRAG_PLACEHOLDER, SIDEBAR_DRAG_TYPE, SidebarDrag } from '../sidebar-drag';
import { SidebarFilter } from '../sidebar-filter';
import { SidebarState } from '../sidebar-state';

/** Collections deeper than this are not indented further, so labels keep their width. */
const MAX_INDENT_DEPTH = 6;
const EXPAND_ON_HOVER_MS = 700;
const ROOT_DROP = 'root';

interface Row extends VisibleRow {
  readonly key: string;
  readonly node: ConfigNode | null;
  readonly project: Project | null;
}

type MenuTarget =
  | { readonly kind: 'collection'; readonly collection: Collection }
  | { readonly kind: 'host'; readonly host: Host }
  | { readonly kind: 'project'; readonly project: Project };

interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly separated?: boolean;
}

export function projectKey(projectId: string): string {
  return `project:${projectId}`;
}

/** The hierarchy of the current scope as nested Taiga aside groups, plus the projects at Home. */
@Component({
  imports: [
    NgTemplateOutlet,
    RouterLink,
    TuiBlockStatus,
    TuiButton,
    TuiChevron,
    TuiDataList,
    TuiDropdown,
    TuiHint,
    TuiLoader,
    TuiNavigation,
    TuiStatus,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-sidebar-tree',
  host: {
    id: 'sidebar-tree',
    'data-testid': 'sidebar-tree',
    '[class._drop-root]': 'dropTarget() === rootDrop',
    '(keydown)': 'onKeydown($event)',
    '(focusin)': 'onFocusin($event)',
    '(dragover)': 'onDragover($event)',
    '(dragleave)': 'onDragleave($event)',
    '(drop)': 'onDrop($event)',
    '(dragend)': 'endDrag()',
  },
  templateUrl: './sidebar-tree.html',
  styleUrl: './sidebar-tree.scss',
})
export class SidebarTree implements OnInit {
  private readonly config = inject(ConfigService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly launcher = inject(HostLauncher);
  private readonly actions = inject(ProjectActions);
  private readonly moves = inject(MoveLauncher);
  private readonly scope = inject(CurrentScope);
  private readonly state = inject(SidebarState);
  private readonly drag = inject(SidebarDrag);
  protected readonly filter = inject(SidebarFilter);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly rootDrop = ROOT_DROP;
  protected readonly loading = computed(() => this.config.loading() && !this.config.loaded());
  private readonly failure = signal<string | null>(null);
  /** Cleared by any later successful load, including a retry from a dashboard. */
  protected readonly loadError = computed(() => (this.config.loaded() ? null : this.failure()));
  protected readonly isHome = this.scope.isHome;
  protected readonly items = this.filter.visibleItems;
  protected readonly empty = computed(
    () =>
      this.filter.items().length === 0 && (!this.isHome() || this.filter.projects().length === 0),
  );
  /** Collections the user collapsed while filtering; filtering shows every match's ancestors open. */
  private readonly collapsedWhileFiltering = linkedSignal<string, ReadonlySet<string>>({
    source: this.filter.query,
    computation: () => new Set(),
  });

  /** The row the menu entries are built for: the last "…", context or keyboard menu opened. */
  protected readonly menuKey = signal<string | null>(null);
  /** The row whose "…" dropdown is open; a right click opens its own dropdown at the pointer. */
  protected readonly buttonMenu = signal<string | null>(null);
  protected readonly selectedProject = signal<string | null>(null);
  protected readonly dropTarget = signal<string | null>(null);
  private readonly lastFocused = signal<string | null>(null);
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverKey: string | null = null;

  /** Projects at Home, with "2 open connections" when they have some. */
  protected readonly projectRows = computed(() => {
    const counts = connectedCounts(this.config.hosts(), this.ssh.states());
    return this.filter.visibleProjects().map((project) => {
      const open = counts.get(project.id) ?? 0;
      return {
        project,
        key: projectKey(project.id),
        connections: open ? uiText('sidebar.openConnections', { count: open }) : null,
      };
    });
  });

  /** The host of the host page or of the active tab: its row is marked selected. */
  protected readonly selectedHost = this.scope.hostId;

  /** Collections above the open host, so a collapsed one can show it holds the selection. */
  protected readonly activePath = computed(() => {
    const hostId = this.selectedHost();
    return new Set(hostId ? ancestors(this.config.nodes(), hostId).map((c) => c.id) : []);
  });

  /** Visible items in display order, for the keyboard and the single tab stop. */
  protected readonly rows = computed<Row[]>(() => {
    const rows: Row[] = [];
    this.state.expanded();
    this.collapsedWhileFiltering();
    const walk = (items: readonly TreeItem[], parent: number): void => {
      for (const item of items) {
        const index = rows.length;
        if (item.kind === 'collection') {
          const open = this.isOpen(item.id);
          rows.push({ key: item.id, node: item.collection, project: null, parent, expanded: open });
          if (open) {
            walk(item.children, index);
          }
        } else {
          rows.push({ key: item.id, node: item.host, project: null, parent, expanded: null });
        }
      }
    };
    walk(this.items(), -1);
    if (this.isHome()) {
      for (const project of this.filter.visibleProjects()) {
        rows.push({ key: projectKey(project.id), node: null, project, parent: -1, expanded: null });
      }
    }
    return rows;
  });

  protected readonly tabStop = computed(() => {
    const keys = new Set(this.rows().map((r) => r.key));
    const active = this.selectedHost();
    const selected = this.selectedProject();
    for (const key of [active, this.lastFocused(), selected && projectKey(selected)]) {
      if (key && keys.has(key)) {
        return key;
      }
    }
    return this.rows()[0]?.key ?? null;
  });

  protected readonly menuTarget = computed<MenuTarget | null>(() => {
    const row = this.rows().find((r) => r.key === this.menuKey());
    return row ? this.targetOf(row) : null;
  });

  /** The menu of the item whose "…" button or context menu was opened last. */
  protected readonly menuEntries = computed<MenuEntry[]>(() => {
    const target = this.menuTarget();
    if (!target) {
      return [];
    }
    const remove: MenuEntry = {
      id: 'menu-delete',
      label: uiText('common.delete'),
      icon: '@tui.trash',
      separated: true,
      run: () => this.remove(target),
    };
    const rename: MenuEntry = {
      id: 'menu-edit',
      label: uiText(target.kind === 'host' ? 'common.edit' : 'common.rename'),
      icon: '@tui.pencil',
      run: () => this.rename(target),
    };
    const move: MenuEntry = {
      id: 'menu-move',
      label: uiText('sidebar.menu.move'),
      icon: '@tui.folder-input',
      run: () => this.move(target),
    };
    switch (target.kind) {
      case 'project': {
        const { project } = target;
        return [
          {
            id: 'menu-open',
            label: uiText('sidebar.menu.openProject'),
            icon: '@tui.arrow-right',
            run: () => this.enterProject(project),
          },
          {
            id: 'menu-variables',
            label: uiText('sidebar.menu.variables'),
            icon: '@tui.variable',
            run: () => this.openVariables(project),
          },
          rename,
          remove,
        ];
      }
      case 'collection': {
        const inside = this.inside(target.collection);
        return [
          {
            id: 'menu-add',
            label: uiText('sidebar.menu.newHostHere'),
            icon: '@tui.server',
            run: () => this.addHost(inside),
          },
          {
            id: 'menu-add-collection',
            label: uiText('sidebar.menu.newCollectionHere'),
            icon: '@tui.folder-plus',
            run: () => this.addCollection(inside),
          },
          move,
          rename,
          remove,
        ];
      }
      default: {
        const { host } = target;
        const connection: MenuEntry = this.isConnected(host)
          ? {
              id: 'menu-disconnect',
              label: uiText('sidebar.disconnect'),
              icon: '@tui.unplug',
              run: () => this.disconnect(host),
            }
          : {
              id: 'menu-connect',
              label: uiText('sidebar.connect'),
              icon: '@tui.plug',
              disabled: this.status(host).busy,
              run: () => this.connect(host),
            };
        return [
          {
            id: 'menu-new-terminal',
            label: uiText('sidebar.menu.newTerminal'),
            icon: '@tui.square-terminal',
            run: () => void this.launcher.newTerminal(host),
          },
          {
            id: 'menu-open-files',
            label: uiText('sidebar.menu.openFiles'),
            icon: '@tui.folder-open',
            run: () => void this.launcher.openFiles(host),
          },
          connection,
          rename,
          move,
          remove,
        ];
      }
    }
  });

  constructor() {
    let previous: string | null | undefined;
    effect(() => {
      const current = this.scope.projectId();
      const route = this.scope.route();
      untracked(() => {
        if (previous !== undefined && previous !== current) {
          if (current === null && previous) {
            this.selectedProject.set(previous);
            this.state.focus(projectKey(previous));
          } else if (route.kind === 'project') {
            const first = this.rows()[0];
            if (first) {
              this.state.focus(first.key);
            }
          }
        }
        previous = current;
      });
    });

    effect(() => {
      const hostId = this.selectedHost();
      if (hostId) {
        const path = ancestors(this.config.nodes(), hostId).map((c) => c.id);
        untracked(() => this.state.expand(path));
      }
    });

    afterRenderEffect(() => {
      const key = this.state.focusRequest();
      if (!key) {
        return;
      }
      const el = this.itemElement(key);
      if (el) {
        el.focus();
        el.scrollIntoView?.({ block: 'nearest' });
        this.state.focusDone();
      } else if (!this.rows().some((r) => r.key === key)) {
        this.state.focusDone();
      }
    });

    let treeFocus = this.filter.treeFocus();
    effect(() => {
      const request = this.filter.treeFocus();
      if (request !== treeFocus) {
        treeFocus = request;
        const first = untracked(() => this.rows()[0]);
        if (first) {
          this.state.focus(first.key);
        }
      }
    });

    afterRenderEffect(() => {
      const hostId = this.selectedHost();
      if (hostId) {
        this.itemElement(hostId)?.scrollIntoView?.({ block: 'nearest' });
      }
    });
  }

  ngOnInit(): void {
    void this.reload();
    this.ssh
      .loadConnections()
      .catch((err: unknown) => notifyError(this.alerts, err, uiText('sidebar.connectionsFailed')));
  }

  protected async reload(): Promise<void> {
    this.failure.set(null);
    try {
      await this.config.load();
      this.scope.restore();
    } catch (err) {
      this.failure.set(errorText(err));
      notifyError(this.alerts, err, uiText('sidebar.hostsFailed'));
    }
  }

  protected isOpen(collectionId: string): boolean {
    return this.filter.active()
      ? !this.collapsedWhileFiltering().has(collectionId)
      : this.state.isOpen(collectionId);
  }

  /** While filtering, the saved expanded state is left untouched. */
  protected setOpen(collectionId: string, open: boolean): void {
    if (!this.filter.active()) {
      this.state.setOpen(collectionId, open);
      return;
    }
    if (this.isOpen(collectionId) !== open) {
      this.collapsedWhileFiltering.update((set) => {
        const next = new Set(set);
        if (open) {
          next.delete(collectionId);
        } else {
          next.add(collectionId);
        }
        return next;
      });
    }
  }

  protected clearFilter(): void {
    this.filter.clear();
    this.filter.focusField();
  }

  protected indented(depth: number): boolean {
    return depth > 0 && depth < MAX_INDENT_DEPTH;
  }

  protected tabindex(key: string): number {
    return this.tabStop() === key ? 0 : -1;
  }

  private target(host: Host): ConnectionTarget {
    return hostTarget(host);
  }

  private connectionState(host: Host): ConnectionState {
    return this.ssh.states()[this.target(host).connectionId] ?? 'idle';
  }

  protected status(host: Host): ConnectionStatus {
    return connectionStatus(this.connectionState(host));
  }

  protected isConnected(host: Host): boolean {
    return this.connectionState(host) === 'connected';
  }

  /**
   * The "…" button sits in a collection head, whose container toggles the group on any click, so
   * the click stops here and opens the menu itself instead of reaching the dropdown wrapper.
   */
  protected toggleMenu(event: Event, key: string): void {
    event.stopPropagation();
    this.setMenu(key, this.buttonMenu() !== key);
  }

  protected setMenu(key: string, open: boolean): void {
    if (open) {
      this.menuKey.set(key);
      this.buttonMenu.set(key);
    } else if (this.buttonMenu() === key) {
      this.buttonMenu.set(null);
    }
  }

  protected openContextMenu(key: string): void {
    this.menuKey.set(key);
    this.buttonMenu.set(null);
  }

  protected selectProject(project: Project): void {
    this.selectedProject.set(project.id);
  }

  protected enterProject(project: Project): void {
    void this.router.navigate(['/projects', project.id]);
  }

  protected openVariables(project: Project): void {
    void this.router.navigate(['/projects', project.id, 'variables']);
  }

  protected connect(host: Host): void {
    void this.connector.connect(this.target(host));
  }

  /** Double-click: the host's terminal, focused or opened (the first click opened its page). */
  protected openTerminal(host: Host): void {
    void this.launcher.openTerminal(host);
  }

  protected disconnect(host: Host): void {
    void this.connector.disconnect(this.target(host).connectionId);
  }

  protected createProject(): void {
    this.actions.createProject();
  }

  protected addHostAtRoot(): void {
    this.addHost({ projectId: this.scope.projectId(), parentId: null });
  }

  protected addHost(container: Container): void {
    this.actions.addHost(container);
  }

  protected addCollection(container: Container): void {
    this.actions.addCollection(container);
  }

  protected inside(collection: Collection): Container {
    return { projectId: collection.projectId, parentId: collection.id };
  }

  protected rename(target: MenuTarget): void {
    if (target.kind === 'project') {
      this.actions.renameProject(target.project);
    } else if (target.kind === 'collection') {
      this.actions.renameCollection(target.collection);
    } else {
      this.actions.editHost(target.host);
    }
  }

  protected remove(target: MenuTarget): void {
    if (target.kind === 'project') {
      void this.actions.deleteProject(target.project);
    } else if (target.kind === 'collection') {
      void this.actions.deleteCollection(target.collection);
    } else {
      void this.actions.deleteHost(target.host);
    }
  }

  protected move(target: MenuTarget): void {
    if (target.kind === 'collection') {
      void this.moves.openDialog(target.collection);
    } else if (target.kind === 'host') {
      void this.moves.openDialog(target.host);
    }
  }

  protected onFocusin(event: FocusEvent): void {
    const key = this.keyOf(event.target);
    if (key) {
      this.lastFocused.set(key);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const key = this.keyOf(event.target);
    const rows = this.rows();
    const current = rows.findIndex((r) => r.key === key);
    if (!key || current < 0) {
      return;
    }
    const row = rows[current];
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const target = this.targetOf(row);
    if (event.key === 'ArrowUp' && plain && current === 0) {
      event.preventDefault();
      this.filter.focusField();
      return;
    }
    if (isTreeKey(event.key) && plain) {
      event.preventDefault();
      const action = treeKeyAction(event.key, rows, current);
      if (action.kind === 'focus') {
        this.itemElement(rows[action.index].key)?.focus();
      } else if (action.kind === 'toggle') {
        const toggled = rows[action.index];
        this.setOpen(toggled.key, !toggled.expanded);
      }
      return;
    }
    const handled = this.shortcut(event, row, target, plain);
    if (handled) {
      event.preventDefault();
    }
  }

  private shortcut(event: KeyboardEvent, row: Row, target: MenuTarget, plain: boolean): boolean {
    const onlyAlt = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const ctrl = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (event.key === 'ArrowUp' && onlyAlt) {
      if (!this.isHome()) {
        void this.router.navigate(['/']);
      }
      return true;
    }
    if (ctrl && event.key.toLowerCase() === 'n') {
      const container = this.containerOf(row);
      if (event.shiftKey) {
        this.addCollection(container);
      } else {
        this.addHost(container);
      }
      return true;
    }
    if (
      (event.key === 'F10' && event.shiftKey && !ctrl) ||
      (event.key === 'ContextMenu' && plain)
    ) {
      this.setMenu(row.key, true);
      return true;
    }
    if (!plain) {
      return false;
    }
    switch (event.key) {
      case 'Enter':
        if (target.kind === 'project') {
          this.enterProject(target.project);
          return true;
        }
        return false;
      case 'F2':
        this.rename(target);
        return true;
      case 'Delete':
        this.remove(target);
        return true;
      case 'F6':
        this.move(target);
        return target.kind !== 'project';
      default:
        return false;
    }
  }

  private targetOf(row: Row): MenuTarget {
    if (row.project) {
      return { kind: 'project', project: row.project };
    }
    const node = row.node as ConfigNode;
    return node.kind === 'collection'
      ? { kind: 'collection', collection: node }
      : { kind: 'host', host: node };
  }

  /** The focused collection, else the focused item's container. */
  private containerOf(row: Row): Container {
    const node = row.node;
    if (!node) {
      return { projectId: null, parentId: null };
    }
    return node.kind === 'collection'
      ? { projectId: node.projectId, parentId: node.id }
      : { projectId: node.projectId, parentId: node.parentId };
  }

  protected startDrag(event: DragEvent, node: ConfigNode): void {
    event.stopPropagation();
    this.drag.start(node.id);
    event.dataTransfer?.setData(SIDEBAR_DRAG_TYPE, SIDEBAR_DRAG_PLACEHOLDER);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  protected onDragover(event: DragEvent): void {
    const node = this.draggedNode();
    if (!node) {
      return;
    }
    const { key, target } = this.dropAt(event.target);
    if (!this.moves.canDrop(node, target)) {
      this.dropTarget.set(null);
      this.clearHover();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dropTarget.set(key);
    this.expandOnHover(key, target);
  }

  protected onDragleave(event: DragEvent): void {
    if (!this.host.contains(event.relatedTarget as Node | null)) {
      this.dropTarget.set(null);
      this.clearHover();
    }
  }

  protected onDrop(event: DragEvent): void {
    const node = this.draggedNode();
    if (!node) {
      return;
    }
    const { target } = this.dropAt(event.target);
    event.preventDefault();
    this.endDrag();
    if (this.moves.canDrop(node, target)) {
      void this.moves.drop(node, target);
    }
  }

  protected endDrag(): void {
    this.drag.end();
    this.dropTarget.set(null);
    this.clearHover();
  }

  private draggedNode(): ConfigNode | null {
    const id = this.drag.nodeId();
    return id ? this.config.findNode(id) : null;
  }

  private dropAt(element: EventTarget | null): { key: string; target: Container } {
    const drop = (element as Element | null)?.closest?.('[data-drop]')?.getAttribute('data-drop');
    if (drop?.startsWith('collection:')) {
      const id = drop.slice('collection:'.length);
      return { key: id, target: { projectId: this.scope.projectId(), parentId: id } };
    }
    if (drop?.startsWith('project:')) {
      return { key: drop, target: { projectId: drop.slice('project:'.length), parentId: null } };
    }
    return { key: ROOT_DROP, target: { projectId: this.scope.projectId(), parentId: null } };
  }

  private expandOnHover(key: string, target: Container): void {
    if (key === this.hoverKey) {
      return;
    }
    this.clearHover();
    const collectionId = target.parentId;
    if (key === ROOT_DROP || !collectionId || this.isOpen(collectionId)) {
      return;
    }
    this.hoverKey = key;
    this.hoverTimer = setTimeout(() => this.setOpen(collectionId, true), EXPAND_ON_HOVER_MS);
  }

  private clearHover(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
    }
    this.hoverTimer = null;
    this.hoverKey = null;
  }

  private keyOf(element: EventTarget | null): string | null {
    const item = (element as Element | null)?.closest?.('[data-item]');
    return item && this.host.contains(item) ? item.getAttribute('data-item') : null;
  }

  private itemElement(key: string): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`);
  }
}
