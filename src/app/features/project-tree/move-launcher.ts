import { EnvironmentInjector, inject, Service } from '@angular/core';
import { ConfigService } from '../../core/ipc/config';
import type { ConfigNode } from '../../core/ipc/config.models';
import type { MoveActions } from './move-actions';
import { canMoveInto, sameContainer, type Container } from './node-tree';

/** Shell entry point for moves; the move flows load on first use to keep the initial bundle small. */
@Service()
export class MoveLauncher {
  private readonly config = inject(ConfigService);
  private readonly injector = inject(EnvironmentInjector);
  private actions: Promise<MoveActions> | null = null;

  /** Not on itself, its current parent or one of its descendants. */
  canDrop(node: ConfigNode, target: Container): boolean {
    return !sameContainer(node, target) && canMoveInto(this.config.nodes(), node, target);
  }

  async openDialog(node: ConfigNode): Promise<void> {
    await (await this.load()).openDialog(node);
  }

  async drop(node: ConfigNode, target: Container): Promise<void> {
    await (await this.load()).drop(node, target);
  }

  private load(): Promise<MoveActions> {
    this.actions ??= import('./move-actions').then(
      ({ MoveActions }) => this.injector.get(MoveActions),
      (err: unknown) => {
        this.actions = null;
        throw err;
      },
    );
    return this.actions;
  }
}
