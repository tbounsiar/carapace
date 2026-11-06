import { Component, inject, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiDataList } from '@taiga-ui/core';
import { CurrentScope } from '../../../shared/current-scope';
import { ProjectActions } from '../../project-tree/project-actions';

/** The New menu of the scope root: the aside "+" button and the sidebar's empty area. */
@Component({
  imports: [TranslocoPipe, TuiDataList],
  selector: 'app-new-menu',
  templateUrl: './new-menu.html',
})
export class NewMenu {
  private readonly scope = inject(CurrentScope);
  private readonly actions = inject(ProjectActions);

  /** Set when the list is a context menu: its `data-surface` test hook. */
  readonly surface = input<string | null>(null);
  /** Emitted before an entry runs, so the opener closes its dropdown. */
  readonly chosen = output();

  protected readonly isHome = this.scope.isHome;

  protected newHost(): void {
    this.chosen.emit();
    this.actions.addHost({ projectId: this.scope.projectId(), parentId: null });
  }

  protected newCollection(): void {
    this.chosen.emit();
    this.actions.addCollection({ projectId: this.scope.projectId(), parentId: null });
  }

  protected newProject(): void {
    this.chosen.emit();
    this.actions.createProject();
  }
}
