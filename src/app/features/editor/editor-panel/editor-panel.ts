import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiLoader,
  TuiNotification,
} from '@taiga-ui/core';
import { TuiBadge, TuiButtonLoading, TuiChevron } from '@taiga-ui/kit';
import { LanguageService } from '../../../core/i18n/language';
import { ConfigService } from '../../../core/ipc/config';
import { Settings } from '../../../core/settings/settings';
import { formatSize } from '../../files/file-list';
import type { EditorDoc } from '../editor-docs';
import { LANGUAGES, type LanguageId, languageLabel } from '../language';

/** One editor tab: toolbar, banners, CodeMirror and the status line. */
@Component({
  imports: [
    TuiBadge,
    TuiButton,
    TuiButtonLoading,
    TuiChevron,
    TuiDataList,
    TuiDropdown,
    TuiHint,
    TuiLoader,
    TuiNotification,
    TranslocoPipe,
  ],
  selector: 'app-editor-panel',
  templateUrl: './editor-panel.html',
  styleUrl: './editor-panel.scss',
  host: {
    'data-testid': 'editor',
    '[style.--app-editor-font-size.px]': 'fontSize()',
  },
})
export class EditorPanel {
  private readonly config = inject(ConfigService);
  protected readonly fontSize = inject(Settings).terminalFontSize;
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  /** Read by computed texts so they follow a language switch once its translations are loaded. */
  private readonly translation = toSignal(this.transloco.selectTranslation());

  readonly doc = input.required<EditorDoc>();

  private readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private readonly languageButton = viewChild<ElementRef<HTMLElement>>('languageButton');
  private attached: EditorDoc | null = null;

  protected readonly languages = LANGUAGES;
  protected readonly languageOpen = signal(false);
  protected readonly loading = computed(() => this.doc().phase() === 'loading');
  protected readonly saving = computed(() => this.doc().phase() === 'saving');
  protected readonly hostName = computed(
    () => this.config.findHost(this.doc().hostId)?.host.name ?? this.t('host'),
  );
  protected readonly location = computed(() => `${this.hostName()}:${this.doc().path}`);
  protected readonly languageName = computed(() => {
    this.translation();
    return languageLabel(this.doc().language());
  });
  protected readonly languageHint = computed(() =>
    this.t(this.doc().large() && this.doc().language() === 'plain' ? 'highlightOff' : 'language'),
  );
  protected readonly position = computed(() => this.t('position', this.doc().stats()));
  protected readonly saved = computed(() => {
    const at = this.doc().savedAt();
    return at
      ? this.t('saved', {
          time: new Intl.DateTimeFormat(this.language.locale(), { timeStyle: 'short' }).format(at),
        })
      : null;
  });
  /** Bytes as saved: CRLF adds one per line break, a BOM three. */
  protected readonly size = computed(() => {
    const doc = this.doc();
    const { bytes, lines } = doc.stats();
    const crlf = doc.lineEnding() === 'crlf' ? lines - 1 : 0;
    return formatSize(bytes + crlf + (doc.bom() ? 3 : 0), this.language.locale());
  });
  protected readonly eol = computed(() => (this.doc().lineEnding() === 'crlf' ? 'CRLF' : 'LF'));
  protected readonly eolHint = computed(() =>
    this.doc().mixedEndings() ? this.t('mixedEndings', { eol: this.eol() }) : null,
  );

  constructor() {
    afterRenderEffect(() => {
      const container = this.content()?.nativeElement;
      const doc = this.doc();
      doc.phase();
      if (!container || this.attached === doc) {
        return;
      }
      this.attached?.detach();
      doc.attach(container);
      if (container.childElementCount) {
        this.attached = doc;
      }
    });
    effect(() => {
      this.translation();
      const doc = this.doc();
      untracked(() => doc.relabel());
    });
    inject(DestroyRef).onDestroy(() => this.attached?.detach());
  }

  focus(): void {
    this.doc().focus();
  }

  /** Reads `translation`, so a computed calling it follows the language. */
  private t(key: string, params?: object): string {
    this.translation();
    return this.transloco.translate(`editor.panel.${key}`, params as Record<string, unknown>);
  }

  protected save(): void {
    void this.doc().save();
  }

  protected reload(): void {
    void this.doc().reload();
  }

  protected reconnect(): void {
    void this.doc().reconnect();
  }

  protected toggleWrap(): void {
    this.doc().toggleWrap();
  }

  protected pick(language: LanguageId): void {
    this.languageOpen.set(false);
    this.doc().setLanguage(language);
    this.doc().focus();
  }

  protected onLanguageOpen(open: boolean): void {
    const closing = this.languageOpen() && !open;
    this.languageOpen.set(open);
    if (closing) {
      this.languageButton()?.nativeElement.focus();
    }
  }
}
