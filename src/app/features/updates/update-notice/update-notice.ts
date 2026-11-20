import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiButton, TuiLink, TuiTitle } from '@taiga-ui/core';
import { TuiProgress } from '@taiga-ui/kit';
import { LanguageService } from '../../../core/i18n/language';
import { uiText } from '../../../shared/ui-text';
import { UpdateFlow } from '../update-flow';
import { UpdateStore } from '../update-store';
import { impactLines, progressText } from '../update-text';

/** Content of the floating update notice; every action also exists in Settings > Updates. */
@Component({
  imports: [TranslocoPipe, TuiButton, TuiLink, TuiProgress, TuiTitle],
  selector: 'app-update-notice',
  styleUrl: './update-notice.scss',
  templateUrl: './update-notice.html',
  host: {
    'data-testid': 'update-notice',
    '[attr.data-state]': 'phase()',
    '[attr.data-mode]': 'store.state()?.installKind',
    '(focusin)': 'focusIn()',
    '(focusout)': 'focusOut($event)',
  },
})
export class UpdateNotice {
  protected readonly store = inject(UpdateStore);
  protected readonly flow = inject(UpdateFlow);
  private readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly phase = computed(() => this.store.phase() ?? 'available');
  protected readonly title = computed(() => {
    const version = this.store.offer()?.version ?? '';
    switch (this.phase()) {
      case 'downloading':
      case 'verifying':
        return uiText('updates.notice.downloadingTitle', { version });
      case 'ready':
        return uiText('updates.notice.readyTitle', { version });
      case 'installing':
        return uiText('updates.notice.installingTitle', { version });
      default:
        return uiText('updates.notice.availableTitle', { version });
    }
  });
  protected readonly progressText = computed(() =>
    progressText(this.store.progress(), this.language.locale()),
  );
  protected readonly impact = computed(() => impactLines(this.flow.impact()));
  protected readonly installingText = this.flow.windows
    ? 'updates.notice.installingWindows'
    : 'updates.notice.installingOther';
  /** Focus was inside; stays true when the focused button is removed by a state change. */
  private hadFocus = false;

  constructor() {
    afterRenderEffect(() => {
      this.phase();
      const root = this.host.nativeElement;
      const active = root.ownerDocument.activeElement;
      if (this.hadFocus && (!active || active === root.ownerDocument.body)) {
        (root.querySelector<HTMLElement>('button') ?? this.heading().nativeElement).focus();
      }
    });
  }

  protected focusIn(): void {
    this.hadFocus = true;
  }

  protected focusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && !this.host.nativeElement.contains(next)) {
      this.hadFocus = false;
    }
  }
}
