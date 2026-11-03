import { computed, inject, linkedSignal, Service, signal } from '@angular/core';
import { ConfigService } from '../../core/ipc/config';
import { CurrentScope } from '../../shared/current-scope';
import { byName, filterTree, firstHost, hostMatches, scopeTree } from '../project-tree/node-tree';

/** The sidebar filter query and what the tree shows with it: matching hosts and their collections. */
@Service()
export class SidebarFilter {
  private readonly config = inject(ConfigService);
  private readonly scope = inject(CurrentScope);

  /** Reset when the scope changes: the sidebar shows one scope at a time. */
  readonly query = linkedSignal({ source: this.scope.projectId, computation: () => '' });
  readonly active = computed(() => this.query().trim() !== '');

  readonly items = computed(() => scopeTree(this.config.nodes(), this.scope.projectId()));
  readonly projects = computed(() => [...this.config.projects()].sort(byName));

  readonly visibleItems = computed(() => {
    const query = this.query();
    return this.active() ? filterTree(this.items(), (h) => hostMatches(h, query)) : this.items();
  });
  /** Projects listed at Home; filtered by name. */
  readonly visibleProjects = computed(() => {
    if (!this.scope.isHome()) {
      return [];
    }
    const q = this.query().trim().toLowerCase();
    return this.projects().filter((p) => p.name.toLowerCase().includes(q));
  });
  readonly noMatch = computed(
    () => this.active() && !this.visibleItems().length && !this.visibleProjects().length,
  );
  readonly firstMatch = computed(() => firstHost(this.visibleItems()));

  /** Disabled while loading, and when the scope holds neither a host nor (at Home) a project. */
  readonly enabled = computed(() => {
    const projectId = this.scope.projectId();
    return (
      this.config.loaded() &&
      (this.config.hosts().some((h) => h.projectId === projectId) ||
        (this.scope.isHome() && this.projects().length > 0))
    );
  });

  private readonly _fieldFocus = signal(0);
  private readonly _treeFocus = signal(0);
  /** Bumped to ask the aside header to focus the field. */
  readonly fieldFocus = this._fieldFocus.asReadonly();
  /** Bumped to ask the tree to focus its first visible row. */
  readonly treeFocus = this._treeFocus.asReadonly();

  set(query: string): void {
    this.query.set(query);
  }

  clear(): void {
    this.query.set('');
  }

  focusField(): void {
    this._fieldFocus.update((n) => n + 1);
  }

  focusTree(): void {
    this._treeFocus.update((n) => n + 1);
  }
}
