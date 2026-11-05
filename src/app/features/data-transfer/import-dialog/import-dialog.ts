import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiTable } from '@taiga-ui/addon-table';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCell,
  TuiCheckbox,
  TuiDialogService,
  type TuiDialogContext,
  TuiGroup,
  TuiHint,
  TuiIcon,
  TuiLink,
  TuiNotification,
  TuiNotificationService,
  TuiRadio,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiAccordion, TuiBadge, TuiBlock, TuiButtonLoading } from '@taiga-ui/kit';
import { TuiForm, TuiHeader } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import {
  DataTransferIpc,
  type ImportPlan,
  type ImportPreview,
  type ImportResult,
  type NeedsSecret,
  STRATEGIES,
  type Strategy,
} from '../../../core/ipc/data-transfer';
import { IpcError } from '../../../core/ipc/ipc-error';
import { LanguageService } from '../../../core/i18n/language';
import { textOf } from '../../../shared/backend-text';
import { confirmDestructive } from '../../../shared/destructive-confirm/confirm-destructive';
import {
  importApplyError,
  importFileError,
  type ImportFileError,
} from '../../../shared/save-error';
import {
  deletedSecretsText,
  detailViews,
  fileMeta,
  hasDeletions,
  listNames,
  needsSecretLine,
  nothingToImport,
  PICKER_BUSY,
  replaceConfirmText,
  replaceSubtitle,
  secretScopeName,
  secretsSentLines,
  strategyLabel,
  summaryItems,
  summarySentence,
  tableView,
  type Translate,
  undefinedLine,
} from '../import-view';

export type ImportStart =
  | { readonly kind: 'preview'; readonly preview: ImportPreview }
  | { readonly kind: 'error'; readonly error: unknown };

export interface ImportDialogData {
  readonly start: ImportStart;
  /** True while applying or undoing; the dialog cannot close then. */
  readonly busy: WritableSignal<boolean>;
  /** Opens the OS picker again ("Choose another file"). */
  readonly pick: () => Promise<ImportPreview | null>;
  /** Workspace sentences (tabs, edited files) for the hosts a plan removes. */
  readonly workspaceLines: (plan: ImportPlan) => string;
  /** Reloads the app state after an apply (with its plan) or an undo (null). */
  readonly changed: (plan: ImportPlan | null) => Promise<void>;
}

type View =
  | ({ readonly kind: 'error' } & ImportFileError)
  | { readonly kind: 'preview'; readonly preview: ImportPreview }
  | {
      readonly kind: 'summary';
      readonly result: ImportResult;
      readonly undone: boolean;
      readonly undoError: string | null;
    };

const DETAILS_OPEN_MAX = 10;

/** Result: route commands to open after closing (a "Secrets to set" link), or nothing. */
@Component({
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    TuiAccordion,
    TuiAutoFocus,
    TuiBadge,
    TuiBlock,
    TuiButton,
    TuiButtonLoading,
    TuiCell,
    TuiCheckbox,
    TuiForm,
    TuiGroup,
    TuiHeader,
    TuiHint,
    TuiIcon,
    TuiLink,
    TuiNotification,
    TuiRadio,
    TuiTable,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-import-dialog',
  templateUrl: './import-dialog.html',
  styleUrl: './import-dialog.scss',
})
export class ImportDialog {
  private readonly ipc = inject(DataTransferIpc);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly injector = inject(Injector);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  /** Read in computeds so they follow a language switch once its translations are loaded. */
  private readonly translation = toSignal(this.transloco.selectTranslation());
  private readonly t: Translate = (key, params) => {
    this.translation();
    return this.transloco.translate(key, params);
  };
  protected readonly context =
    injectContext<TuiDialogContext<readonly string[] | undefined, ImportDialogData>>();
  private readonly data = this.context.data;
  protected readonly busy = this.data.busy;

  protected readonly view = signal<View>(this.initialView());
  protected readonly picking = signal(false);
  protected readonly undoing = signal(false);
  protected readonly applyError = signal<string | null>(null);
  protected readonly refreshed = signal(false);
  protected readonly secretsTitleId = 'import-secrets-title';

  protected readonly strategyControl = new FormControl<Strategy>('merge', { nonNullable: true });
  protected readonly ackControl = new FormControl(false, { nonNullable: true });
  protected readonly form = new FormGroup({
    strategy: this.strategyControl,
    secretsAck: this.ackControl,
  });
  protected readonly acknowledged = toSignal(this.ackControl.valueChanges, {
    initialValue: false,
  });
  protected readonly strategy = toSignal(this.strategyControl.valueChanges, {
    initialValue: 'merge' as Strategy,
  });
  protected readonly strategies = STRATEGIES;

  private readonly summaryHeading = viewChild<ElementRef<HTMLElement>>('summaryHeading');

  protected readonly preview = computed(() => {
    const view = this.view();
    return view.kind === 'preview' ? view.preview : null;
  });
  protected readonly plan = computed(() => this.preview()?.plans[this.strategy()] ?? null);
  protected readonly meta = computed(() => {
    const preview = this.preview();
    return preview ? fileMeta(this.t, this.language.locale(), preview.file) : '';
  });
  protected readonly replaceNote = computed(() => {
    const preview = this.preview();
    return preview ? replaceSubtitle(this.t, preview.file.scope) : '';
  });
  protected readonly table = computed(() => {
    const plan = this.plan();
    return plan ? tableView(this.t, plan, this.strategy()) : null;
  });
  protected readonly nothing = computed(() => {
    const plan = this.plan();
    return !!plan && nothingToImport(plan);
  });
  protected readonly blocked = computed(() => !!this.plan()?.blocking.length);
  protected readonly blockingText = computed(() => {
    const plan = this.plan();
    return plan?.blocking.length
      ? this.t('dataTransfer.import.blocking', {
          strategy: strategyLabel(this.t, this.strategy()),
          reasons: plan.blocking.map(textOf).join('; '),
        })
      : '';
  });
  protected readonly details = computed(() => {
    const plan = this.plan();
    return plan ? detailViews(this.t, plan.items) : [];
  });
  protected readonly moreItems = computed(() => this.plan()?.moreItems ?? 0);
  protected readonly detailsCount = computed(() => this.details().length + this.moreItems());
  protected readonly detailsOpen = computed(
    () => this.detailsCount() > 0 && this.detailsCount() <= DETAILS_OPEN_MAX,
  );
  protected readonly connections = computed(() => {
    const plan = this.plan();
    if (!plan) {
      return null;
    }
    const names = plan.affectedConnectedHosts;
    const workspace = this.data.workspaceLines(plan).trim();
    if (!names.length && !workspace) {
      return null;
    }
    return {
      title: names.length
        ? this.t('dataTransfer.import.connectionsTitle', { count: names.length })
        : this.t('dataTransfer.import.tabsTitle'),
      body: [
        names.length
          ? this.t('dataTransfer.import.connectionsBody', {
              names: listNames(this.t, names),
              count: names.length,
            })
          : '',
        workspace,
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
  protected readonly deletedSecrets = computed(() => {
    const plan = this.plan();
    return plan ? deletedSecretsText(this.t, plan, this.strategy()) : null;
  });
  protected readonly secretLines = computed(() =>
    (this.plan()?.needsSecret ?? []).map((entry) => needsSecretLine(this.t, entry)),
  );
  protected readonly undefinedText = computed(() => {
    const list = this.plan()?.undefinedVariables ?? [];
    return list.length ? undefinedLine(this.t, list) : null;
  });
  protected readonly destructive = computed(
    () => this.strategy() === 'replace' && !!this.plan() && hasDeletions(this.plan()!),
  );
  protected readonly submitLabel = computed(() =>
    this.destructive() ? 'dataTransfer.import.submitReplace' : 'dataTransfer.import.submit',
  );
  protected readonly secretsSent = computed(() =>
    secretsSentLines(this.t, this.plan()?.secretsSentTo),
  );
  protected readonly canImport = computed(
    () =>
      !!this.plan() &&
      !this.blocked() &&
      !this.nothing() &&
      (!this.secretsSent().length || this.acknowledged()),
  );

  protected readonly summary = computed(() => {
    const view = this.view();
    if (view.kind !== 'summary') {
      return null;
    }
    const { result } = view;
    return {
      undone: view.undone,
      undoError: view.undoError,
      sentence: summarySentence(this.t, result.rows),
      details: detailViews(this.t, summaryItems(result)),
      disconnected: listNames(this.t, result.disconnected, 20),
      secrets: groupSecrets(this.t, result.needsSecret),
      backupName: result.backupName,
      lostSecrets: result.secretValuesDeleted > 0,
    };
  });

  private importId: string | null =
    this.data.start.kind === 'preview' ? this.data.start.preview.importId : null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancelPending());
    // The trust given to one plan's servers does not carry over to another plan.
    this.strategyControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.ackControl.setValue(false));
  }

  protected async chooseAnother(): Promise<void> {
    if (this.picking()) {
      return;
    }
    this.picking.set(true);
    try {
      const preview = await this.data.pick();
      if (preview) {
        this.showPreview(preview);
      }
    } catch (err) {
      if (err instanceof IpcError && err.code === 'busy') {
        this.alerts.open(this.t(PICKER_BUSY), { appearance: 'warning' }).subscribe();
      } else {
        this.view.set({ kind: 'error', ...importFileError(err) });
      }
    } finally {
      this.picking.set(false);
    }
  }

  protected async submit(): Promise<void> {
    const preview = this.preview();
    const plan = this.plan();
    if (!preview || !plan || !this.canImport() || this.busy()) {
      return;
    }
    const strategy = this.strategy();
    if (this.destructive()) {
      const confirmed = await confirmDestructive(
        this.dialogs,
        this.t('dataTransfer.import.confirmTitle'),
        {
          content: replaceConfirmText(this.t, plan, this.data.workspaceLines(plan)),
          yes: this.t('dataTransfer.import.confirmYes'),
          no: this.t('common.cancel'),
        },
      );
      if (!confirmed) {
        return;
      }
    }
    this.applyError.set(null);
    this.refreshed.set(false);
    this.busy.set(true);
    try {
      const result = await this.ipc.applyImport(preview.importId, strategy);
      await this.data.changed(plan);
      this.view.set({ kind: 'summary', result, undone: false, undoError: null });
      this.focusSummary();
    } catch (err) {
      await this.applyFailed(err, preview.importId);
    } finally {
      this.busy.set(false);
    }
  }

  protected async undo(): Promise<void> {
    const view = this.view();
    if (view.kind !== 'summary' || view.undone || !this.importId || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.undoing.set(true);
    try {
      await this.ipc.undoImport(this.importId);
      await this.data.changed(null);
      this.view.set({ ...view, undone: true, undoError: null });
      this.focusSummary();
    } catch {
      this.view.set({
        ...view,
        undoError: 'dataTransfer.summary.undoError',
      });
    } finally {
      this.undoing.set(false);
      this.busy.set(false);
    }
  }

  protected openVariables(entry: SecretGroup): void {
    this.context.completeWith(
      entry.projectId ? ['/projects', entry.projectId, 'variables'] : ['/variables'],
    );
  }

  protected cancel(): void {
    if (!this.busy()) {
      this.context.$implicit.complete();
    }
  }

  private async applyFailed(err: unknown, importId: string): Promise<void> {
    if (err instanceof IpcError && err.code === 'conflict') {
      try {
        this.showPreview(await this.ipc.refreshImport(importId), true);
        this.refreshed.set(true);
      } catch (refreshErr) {
        this.applyError.set(this.expiredOr(refreshErr));
      }
      return;
    }
    this.applyError.set(this.expiredOr(err));
  }

  private expiredOr(err: unknown): string {
    return err instanceof IpcError && err.code === 'not_found'
      ? this.t('dataTransfer.import.expired')
      : importApplyError(err);
  }

  private showPreview(preview: ImportPreview, keepStrategy = false): void {
    this.importId = preview.importId;
    this.ackControl.setValue(false);
    this.applyError.set(null);
    this.refreshed.set(false);
    if (!keepStrategy) {
      this.strategyControl.setValue('merge');
    }
    this.view.set({ kind: 'preview', preview });
  }

  private initialView(): View {
    const { start } = this.context.data;
    return start.kind === 'preview'
      ? { kind: 'preview', preview: start.preview }
      : { kind: 'error', ...importFileError(start.error) };
  }

  private focusSummary(): void {
    afterNextRender(() => this.summaryHeading()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private cancelPending(): void {
    if (this.importId) {
      this.ipc.cancelImport(this.importId).catch(() => undefined);
    }
  }
}

export interface SecretGroup {
  readonly key: string;
  readonly projectId: string | null;
  readonly link: string;
  readonly lines: readonly string[];
}

/** One link per scope, with the variables of that scope. */
function groupSecrets(t: Translate, list: readonly NeedsSecret[]): SecretGroup[] {
  const groups = new Map<string, SecretGroup & { lines: string[] }>();
  for (const entry of list) {
    const projectId = entry.scope.kind === 'project' ? entry.scope.projectId : null;
    const key = entry.scope.kind === 'project' ? entry.scope.projectName : 'global';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        projectId,
        link: projectId
          ? t('dataTransfer.summary.openProjectVariables', { name: key })
          : t('dataTransfer.summary.openGlobalVariables'),
        lines: [],
      };
      groups.set(key, group);
    }
    group.lines.push(
      t('dataTransfer.summary.secretLine', {
        name: entry.name,
        scope: secretScopeName(t, entry),
        count: entry.hostCount,
      }),
    );
  }
  return [...groups.values()];
}
