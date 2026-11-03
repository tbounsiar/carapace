import { Component } from '@angular/core';
import { type TuiPortalContext } from '@taiga-ui/cdk';
import { TuiLink, type TuiNotificationOptions } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';

export interface MoveUndoData {
  readonly text: string;
  readonly undo: () => void;
}

/** Toast content of a move within a scope, with its Undo action. */
@Component({
  imports: [TuiLink],
  selector: 'app-move-undo',
  templateUrl: './move-undo.html',
  styleUrl: './move-undo.scss',
})
export class MoveUndo {
  protected readonly context =
    injectContext<TuiPortalContext<TuiNotificationOptions<MoveUndoData>, void>>();

  protected undo(): void {
    this.context.data.undo();
    this.context.$implicit.complete();
  }
}
