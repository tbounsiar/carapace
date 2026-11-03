import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  input,
  output,
  viewChildren,
} from '@angular/core';
import { TuiHint, TuiIcon, TuiTitle } from '@taiga-ui/core';
import { TuiHeader } from '@taiga-ui/layout';
import type { Host } from '../../../core/ipc/config.models';
import type { HostGroup } from '../board';
import { HostCard } from '../host-card/host-card';

let boards = 0;

/** Host cards in one section per collection path. */
@Component({
  imports: [HostCard, TuiHeader, TuiHint, TuiIcon, TuiTitle],
  selector: 'app-host-groups',
  styleUrl: './host-groups.scss',
  templateUrl: './host-groups.html',
})
export class HostGroups {
  private readonly injector = inject(Injector);

  readonly groups = input.required<readonly HostGroup[]>();
  /** The last visible card was deleted: focus belongs elsewhere (the search). */
  readonly lastRemoved = output();

  private readonly cards = viewChildren(HostCard);
  protected readonly uid = ++boards;
  private readonly order = computed(() => this.groups().flatMap((g) => g.hosts.map((h) => h.id)));

  protected headingId(index: number): string {
    return `host-group-${this.uid}-${index}`;
  }

  /** Focus moves to the card that took the deleted one's place, else the previous one. */
  protected onDeleted(host: Host): void {
    const index = this.order().indexOf(host.id);
    afterNextRender(
      () => {
        const cards = this.cards();
        const next = cards[index] ?? cards[index - 1];
        if (next) {
          next.focus();
        } else {
          this.lastRemoved.emit();
        }
      },
      { injector: this.injector },
    );
  }
}
