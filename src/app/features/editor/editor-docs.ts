import { computed, inject, Service, signal } from '@angular/core';
import { translate } from '@jsverse/transloco';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { LanguageService } from '../../core/i18n/language';
import { ConfigService } from '../../core/ipc/config';
import type { Host } from '../../core/ipc/config.models';
import { connectionId, connectionTarget, hostTarget } from '../../core/ipc/connection';
import { EditorFiles, type LineEnding, MAX_EDIT_BYTES } from '../../core/ipc/editor-files';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { formatSize } from '../files/file-list';
import { HostConnector } from '../host-connection/host-connector';
import { errorText, notifyError } from '../../shared/save-error';
import { editorTabStatus, type EditorPhase } from '../workspace/tab-status';
import { tabKey, Workspace } from '../workspace/workspace';
import { askEditorChoice } from './editor-choice';
import { type CodeEditor, EditorFactory, type EditorStats } from './editor-factory';
import { HIGHLIGHT_LIMIT, initialLanguage, type LanguageId } from './language';

export type EditorBanner = 'lost' | 'ended' | null;

const EMPTY_STATS: EditorStats = {
  line: 1,
  col: 1,
  selected: 0,
  bytes: 0,
  lines: 1,
  modified: false,
};

function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

const t = (key: string, params?: Record<string, unknown>): string =>
  translate(`editor.docs.${key}`, params);

/** CodeMirror's own texts (search panel, go to line), keyed by its English phrases. */
export function editorPhrases(): Record<string, string> {
  const s = (key: string) => translate(`editor.search.${key}`);
  return {
    Find: s('find'),
    Replace: s('replace'),
    next: s('next'),
    previous: s('previous'),
    all: s('all'),
    'match case': s('matchCase'),
    regexp: s('regexp'),
    'by word': s('byWord'),
    replace: s('replaceOne'),
    'replace all': s('replaceAll'),
    close: s('close'),
    'current match': s('currentMatch'),
    'on line': s('onLine'),
    'replaced $ matches': s('replacedMatches'),
    'replaced match on line $': s('replacedOnLine'),
    'Go to line': s('goToLine'),
    go: s('go'),
    'Selection deleted': s('selectionDeleted'),
    'Control character': s('controlCharacter'),
  };
}

/** A mixed file is saved with LF; the status line says so. */
function saveEnding(stored: LineEnding | 'mixed'): LineEnding {
  return stored === 'mixed' ? 'lf' : stored;
}

interface Deps {
  readonly files: EditorFiles;
  readonly ssh: SshService;
  readonly connector: HostConnector;
  readonly config: ConfigService;
  readonly alerts: TuiNotificationService;
  readonly dialogs: TuiDialogService;
  readonly factory: EditorFactory;
}

/** One remote file in an editor tab. The buffer lives here (in memory only) until the tab closes. */
export class EditorDoc {
  readonly name: string;
  readonly connectionId: string;
  readonly phase = signal<EditorPhase>('loading');
  readonly readOnly = signal(false);
  readonly language = signal<LanguageId>('plain');
  readonly wrap = signal(false);
  readonly savedAt = signal<Date | null>(null);
  readonly error = signal<string | null>(null);
  readonly stats = signal<EditorStats>(EMPTY_STATS);
  readonly lineEnding = signal<LineEnding>('lf');
  readonly mixedEndings = signal(false);
  readonly bom = signal(false);
  /** Where a symlinked path really points; saves write that file. */
  readonly target = signal<string | null>(null);
  /** The last save failed mid-write: the server copy may be damaged. */
  readonly partial = signal(false);
  /** Opened over the highlighting limit, so it started as plain text. */
  readonly large = signal(false);
  readonly modified = computed(() => this.stats().modified);
  readonly status = computed(() =>
    editorTabStatus(
      this.phase(),
      this.deps.ssh.stateOf(this.connectionId),
      this.deps.ssh.endReasons()[this.connectionId],
    ),
  );
  readonly banner = computed<EditorBanner>(() => {
    if (this.phase() === 'loading' || this.deps.ssh.stateOf(this.connectionId) === 'connected') {
      return null;
    }
    return this.deps.ssh.endReasons()[this.connectionId] === 'lost' ? 'lost' : 'ended';
  });
  readonly reconnecting = signal(false);

  private editor: CodeEditor | null = null;
  private version: string | null = null;
  private destroyed = false;

  constructor(
    private readonly deps: Deps,
    readonly hostId: string,
    readonly path: string,
  ) {
    this.name = baseName(path);
    this.connectionId = connectionId(hostId);
  }

  hostName(): string {
    return this.deps.config.findHost(this.hostId)?.host.name ?? t('theHost');
  }

  /** Resolves null on success, else what to tell the user. */
  async load(): Promise<string | null> {
    let file;
    try {
      file = await this.deps.files.read(this.connectionId, this.path);
    } catch (err) {
      return this.openFailure(err);
    }
    const language = initialLanguage(this.path, file.size);
    this.large.set(file.size > HIGHLIGHT_LIMIT);
    this.language.set(language);
    this.readOnly.set(!file.writable);
    this.version = file.version;
    this.bom.set(file.bom);
    this.target.set(file.target ?? null);
    this.mixedEndings.set(file.lineEnding === 'mixed');
    this.lineEnding.set(saveEnding(file.lineEnding));
    try {
      this.editor = await this.deps.factory.create({
        text: file.text,
        language,
        readOnly: !file.writable,
        wrap: false,
        label: t('contents', { name: this.name }),
        phrases: editorPhrases(),
        onChange: (stats) => this.stats.set(stats),
        onSave: () => void this.save(),
        onToggleWrap: () => this.toggleWrap(),
      });
    } catch {
      return t('loadFailed');
    }
    if (this.destroyed) {
      this.editor.destroy();
      this.editor = null;
      return null;
    }
    this.phase.set('ready');
    return null;
  }

  attach(container: HTMLElement): void {
    this.editor?.attach(container);
  }

  detach(): void {
    this.editor?.detach();
  }

  focus(): void {
    this.editor?.focus();
  }

  setLanguage(language: LanguageId): void {
    this.language.set(language);
    this.editor?.setLanguage(language);
  }

  toggleWrap(): void {
    this.wrap.update((w) => !w);
    this.editor?.setWrap(this.wrap());
  }

  /** Resolves true once the buffer is saved (or was already clean). */
  async save(): Promise<boolean> {
    if (!this.editor || this.readOnly()) {
      return false;
    }
    if (this.phase() !== 'ready') {
      return false;
    }
    if (!this.modified()) {
      return true;
    }
    if (!(await this.ensureConnected())) {
      return false;
    }
    return this.write(this.version);
  }

  /** Reload from the server; asks first when the buffer has changes. */
  async reload(): Promise<void> {
    if (!this.editor || this.phase() !== 'ready') {
      return;
    }
    if (this.modified()) {
      const discard = await confirmDestructive(this.deps.dialogs, t('reloadTitle'), {
        content: t('reloadContent', { name: this.name, host: this.hostName() }),
        yes: t('reloadYes'),
        no: translate('common.cancel'),
      });
      if (!discard) {
        return;
      }
    }
    if (await this.ensureConnected()) {
      await this.fetch();
    }
  }

  /** Puts the editor's own texts in the current language. */
  relabel(): void {
    this.editor?.setTexts(t('contents', { name: this.name }), editorPhrases());
  }

  async reconnect(): Promise<void> {
    await this.ensureConnected();
  }

  destroy(): void {
    this.destroyed = true;
    this.editor?.destroy();
    this.editor = null;
  }

  private async fetch(): Promise<boolean> {
    const editor = this.editor;
    if (!editor) {
      return false;
    }
    this.phase.set('loading');
    try {
      const file = await this.deps.files.read(this.connectionId, this.path);
      editor.replace(file.text);
      this.version = file.version;
      this.readOnly.set(!file.writable);
      editor.setReadOnly(!file.writable);
      this.bom.set(file.bom);
      this.target.set(file.target ?? null);
      this.mixedEndings.set(file.lineEnding === 'mixed');
      this.lineEnding.set(saveEnding(file.lineEnding));
      this.error.set(null);
      return true;
    } catch (err) {
      notifyError(this.deps.alerts, err, t('notReloaded'));
      return false;
    } finally {
      this.phase.set('ready');
    }
  }

  private async write(expectedVersion: string | null): Promise<boolean> {
    const editor = this.editor;
    if (!editor) {
      return false;
    }
    const snapshot = editor.snapshot();
    const lineEnding = this.lineEnding();
    this.phase.set('saving');
    this.error.set(null);
    this.partial.set(false);
    try {
      const saved = await this.deps.files.write(this.connectionId, this.path, {
        text: snapshot.text,
        expectedVersion,
        lineEnding,
        bom: this.bom(),
        expectedTarget: this.target(),
      });
      this.version = saved.version;
      editor.markSaved(snapshot);
      this.savedAt.set(new Date());
      return true;
    } catch (err) {
      this.phase.set('ready');
      if (err instanceof IpcError && err.code === 'conflict') {
        return this.resolveConflict(err);
      }
      this.partial.set(err instanceof IpcError && err.code === 'partial_write');
      this.error.set(t('notSaved', { reason: errorText(err) }));
      return false;
    } finally {
      if (this.phase() === 'saving') {
        this.phase.set('ready');
      }
    }
  }

  private async resolveConflict(err: IpcError): Promise<boolean> {
    const kind =
      err.key === 'errors.files.deleted'
        ? 'deleted'
        : err.key === 'errors.files.retargeted'
          ? 'retargeted'
          : 'changed';
    const choice = await askEditorChoice(this.deps.dialogs, {
      kind,
      name: this.name,
      host: this.hostName(),
    });
    if (choice === 'overwrite' || choice === 'saveAnyway') {
      return this.write(null);
    }
    if (choice === 'reload') {
      await this.fetch();
    }
    return false;
  }

  private async ensureConnected(): Promise<boolean> {
    const id = this.connectionId;
    if (this.deps.ssh.stateOf(id) === 'connected') {
      return true;
    }
    const host = this.deps.config.findHost(this.hostId)?.host;
    this.reconnecting.set(true);
    try {
      await this.deps.connector.connect(host ? hostTarget(host) : connectionTarget(null, id));
    } finally {
      this.reconnecting.set(false);
    }
    return this.deps.ssh.stateOf(id) === 'connected';
  }

  private openFailure(err: unknown): string {
    if (err instanceof IpcError) {
      switch (err.code) {
        case 'too_large':
          return t('tooLarge', { name: this.name });
        case 'not_text':
          return t('notText', { name: this.name });
        case 'permission_denied':
          return t('permissionDenied', { name: this.name, host: this.hostName() });
      }
    }
    return errorText(err);
  }
}

/** Opens remote files in editor tabs (spec E1). */
@Service()
export class EditorDocs {
  private readonly workspace = inject(Workspace);
  private readonly alerts = inject(TuiNotificationService);
  private readonly language = inject(LanguageService);
  private readonly deps: Deps = {
    files: inject(EditorFiles),
    ssh: inject(SshService),
    connector: inject(HostConnector),
    config: inject(ConfigService),
    alerts: this.alerts,
    dialogs: inject(TuiDialogService),
    factory: inject(EditorFactory),
  };

  /** Focuses the file's tab if it is open, else opens it; `size` comes from the listing. */
  async open(host: Host, path: string, size: number | null): Promise<void> {
    const key = tabKey('edit', host.id, path);
    const existing = this.workspace.byKey(key);
    if (existing) {
      await this.workspace.activate(existing);
      return;
    }
    const name = baseName(path);
    if (size !== null && size > MAX_EDIT_BYTES) {
      this.fail(t('tooLargeSize', { name, size: formatSize(size, this.language.locale()) }));
      return;
    }
    const doc = new EditorDoc(this.deps, host.id, path);
    const tab = this.workspace.add({
      key,
      kind: 'edit',
      hostId: host.id,
      label: name,
      path,
      status: doc.status,
      modified: doc.modified,
      readOnly: doc.readOnly,
      doc,
      dispose: () => doc.destroy(),
    });
    void this.workspace.activate(tab);
    const failure = await doc.load();
    if (failure === null) {
      if (this.workspace.routedId() === tab.id) {
        this.workspace.focusRequest.update((n) => n + 1);
      }
      return;
    }
    const files = this.workspace.byKey(tabKey('files', host.id));
    if (files && this.workspace.routedId() === tab.id) {
      await this.workspace.activate(files);
      this.workspace.drop([tab.id]);
    } else {
      await this.workspace.remove(tab);
    }
    this.fail(failure);
  }

  private fail(message: string): void {
    this.alerts.open(message, { label: t('notOpened'), appearance: 'negative' }).subscribe();
  }
}
