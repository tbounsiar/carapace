import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiLoader,
  TuiNotification,
} from '@taiga-ui/core';
import { TuiBadge, TuiButtonLoading, TuiChevron } from '@taiga-ui/kit';
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

  readonly doc = input.required<EditorDoc>();

  private readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private readonly languageButton = viewChild<ElementRef<HTMLElement>>('languageButton');
  private attached: EditorDoc | null = null;

  protected readonly languages = LANGUAGES;
  protected readonly languageOpen = signal(false);
  protected readonly loading = computed(() => this.doc().phase() === 'loading');
  protected readonly saving = computed(() => this.doc().phase() === 'saving');
  protected readonly hostName = computed(
    () => this.config.findHost(this.doc().hostId)?.host.name ?? 'host',
  );
  protected readonly location = computed(() => `${this.hostName()}:${this.doc().path}`);
  protected readonly languageName = computed(() => languageLabel(this.doc().language()));
  protected readonly languageHint = computed(() =>
    this.doc().large() && this.doc().language() === 'plain'
      ? 'Highlighting off for files over 1 MiB'
      : 'Language',
  );
  protected readonly position = computed(() => {
    const { line, col, selected } = this.doc().stats();
    return `Ln ${line}, Col ${col}${selected ? `, ${selected} selected` : ''}`;
  });
  /** Bytes as saved: CRLF adds one per line break, a BOM three. */
  protected readonly size = computed(() => {
    const doc = this.doc();
    const { bytes, lines } = doc.stats();
    const crlf = doc.lineEnding() === 'crlf' ? lines - 1 : 0;
    return formatSize(bytes + crlf + (doc.bom() ? 3 : 0));
  });
  protected readonly eol = computed(() => (this.doc().lineEnding() === 'crlf' ? 'CRLF' : 'LF'));
  protected readonly eolHint = computed(() =>
    this.doc().mixedEndings() ? `Mixed line endings; saved as ${this.eol()}` : null,
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
    inject(DestroyRef).onDestroy(() => this.attached?.detach());
  }

  focus(): void {
    this.doc().focus();
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
