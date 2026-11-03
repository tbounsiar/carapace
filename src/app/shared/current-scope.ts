import { computed, effect, inject, linkedSignal, Service } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { ConfigService } from '../core/ipc/config';
import type { ConfigNode, Project } from '../core/ipc/config.models';

const STORAGE_KEY = 'carapace.scope';
const HOME_KEY = 'home';

export type ScopeRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'project'; readonly projectId: string; readonly variables: boolean }
  | { readonly kind: 'host'; readonly hostId: string }
  | { readonly kind: 'other'; readonly path: string };

export function parseScopeRoute(url: string): ScopeRoute {
  const path = url.split(/[?#]/)[0];
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) {
    return { kind: 'home' };
  }
  if (segments[0] === 'projects' && segments[1] && segments.length <= 3) {
    return { kind: 'project', projectId: segments[1], variables: segments[2] === 'variables' };
  }
  if (segments[0] === 'hosts' && segments[1] && segments.length === 2) {
    return { kind: 'host', hostId: segments[1] };
  }
  return { kind: 'other', path: `/${segments.join('/')}` };
}

function readStored(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && value !== HOME_KEY ? value : null;
  } catch {
    return null;
  }
}

/**
 * Home (null) or the project the user is in. Follows the route when the route implies a scope
 * (`/`, `/projects/:id`, `/hosts/:id`), keeps the last one otherwise.
 */
@Service()
export class CurrentScope {
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);
  private readonly stored = readStored();

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly route = computed(() => parseScopeRoute(this.url()));

  private readonly scopeId = linkedSignal<
    {
      route: ScopeRoute;
      loaded: boolean;
      nodes: readonly ConfigNode[];
      projects: readonly Project[];
    },
    string | null
  >({
    source: () => ({
      route: this.route(),
      loaded: this.config.loaded(),
      // Nodes too: a host moved to another scope takes the sidebar along.
      nodes: this.config.nodes(),
      projects: this.config.projects(),
    }),
    computation: ({ route, loaded }, previous) => {
      const kept = previous === undefined ? this.stored : previous.value;
      switch (route.kind) {
        case 'home':
          return null;
        case 'project':
          if (!loaded) {
            return kept;
          }
          return this.config.findProject(route.projectId) ? route.projectId : null;
        case 'host': {
          const host = this.config.findNode(route.hostId);
          return host?.kind === 'host' ? host.projectId : kept;
        }
        default:
          return kept;
      }
    },
  });

  readonly project = computed<Project | null>(() => {
    const id = this.scopeId();
    return id ? this.config.findProject(id) : null;
  });
  readonly projectId = computed(() => this.project()?.id ?? null);
  readonly isHome = computed(() => this.project() === null);

  constructor() {
    effect(() => {
      if (!this.config.loaded()) {
        return;
      }
      const id = this.projectId();
      try {
        localStorage.setItem(STORAGE_KEY, id ?? HOME_KEY);
      } catch {
        // The scope is then remembered for the session only.
      }
    });
  }

  /** On start at `/`, goes back into the project the user was last in, if it still exists. */
  restore(): void {
    const route = parseScopeRoute(this.router.url);
    if (route.kind === 'home' && this.stored && this.config.findProject(this.stored)) {
      void this.router.navigate(['/projects', this.stored]);
    }
  }
}
