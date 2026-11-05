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
  secretsSentLines,
  STRATEGY_LABELS,
  summaryItems,
  summarySentence,
  tableView,
  undefinedLine,
} from '../import-view';
import { plural } from '../../project-tree/node-tree';

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

const EXPIRED = 'This preview expired. Choose the file again.';
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
  protected readonly labels = STRATEGY_LABELS;
  protected readonly lostHint =
    'Restores your data as before the import. Deleted secret values cannot be restored.';

  private readonly summaryHeading = viewChild<ElementRef<HTMLElement>>('summaryHeading');

  protected readonly preview = computed(() => {
    const view = this.view();
    return view.kind === 'preview' ? view.preview : null;
  });
  protected readonly plan = computed(() => this.preview()?.plans[this.strategy()] ?? null);
  protected readonly meta = computed(() => {
    const preview = this.preview();
    return preview ? fileMeta(preview.file) : '';
  });
  protected readonly replaceNote = computed(() => {
    const preview = this.preview();
    return preview ? replaceSubtitle(preview.file.scope) : '';
  });
  protected readonly table = computed(() => {
    const plan = this.plan();
    return plan ? tableView(plan, this.strategy()) : null;
  });
  protected readonly nothing = computed(() => {
    const plan = this.plan();
    return !!plan && nothingToImport(plan);
  });
  protected readonly blocked = computed(() => !!this.plan()?.blocking.length);
  protected readonly blockingText = computed(() => {
    const plan = this.plan();
    return plan?.blocking.length
      ? `This import cannot be done with ${STRATEGY_LABELS[this.strategy()]}: ${plan.blocking.join('; ')}.`
      : '';
  });
  protected readonly details = computed(() => {
    const plan = this.plan();
    return plan ? detailViews(plan.items) : [];
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
        ? `${plural(names.length, 'connected host')} ${names.length === 1 ? 'is' : 'are'} affected`
        : 'Open tabs are affected',
      body: [
        names.length
          ? `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} deleted or moved to another project. ${names.length === 1 ? 'It is' : 'They are'} disconnected.`
          : '',
        workspace,
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
  protected readonly deletedSecrets = computed(() => {
    const plan = this.plan();
    return plan ? deletedSecretsText(plan, this.strategy()) : null;
  });
  protected readonly secretLines = computed(() =>
    (this.plan()?.needsSecret ?? []).map(needsSecretLine),
  );
  protected readonly undefinedText = computed(() => {
    const list = this.plan()?.undefinedVariables ?? [];
    return list.length ? undefinedLine(list) : null;
  });
  protected readonly destructive = computed(
    () => this.strategy() === 'replace' && !!this.plan() && hasDeletions(this.plan()!),
  );
  protected readonly submitLabel = computed(() => (this.destructive() ? 'Replace…' : 'Import'));
  protected readonly secretsSent = computed(() => secretsSentLines(this.plan()?.secretsSentTo));
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
      sentence: summarySentence(result.rows),
      details: detailViews(summaryItems(result)),
      disconnected: listNames(result.disconnected, 20),
      secrets: groupSecrets(result.needsSecret),
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
        this.alerts.open(PICKER_BUSY, { appearance: 'warning' }).subscribe();
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
      const confirmed = await confirmDestructive(this.dialogs, 'Replace data?', {
        content: replaceConfirmText(plan, this.data.workspaceLines(plan)),
        yes: 'Replace',
        no: 'Cancel',
      });
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
        undoError: `Could not undo the import. Your data before the import is in ${view.result.backupName} in the Carapace folder.`,
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
    return err instanceof IpcError && err.code === 'not_found' ? EXPIRED : importApplyError(err);
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
function groupSecrets(list: readonly NeedsSecret[]): SecretGroup[] {
  const groups = new Map<string, SecretGroup & { lines: string[] }>();
  for (const entry of list) {
    const projectId = entry.scope.kind === 'project' ? entry.scope.projectId : null;
    const key = entry.scope.kind === 'project' ? entry.scope.projectName : 'global';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        projectId,
        link: projectId ? `Open ${key} variables` : 'Open global variables',
        lines: [],
      };
      groups.set(key, group);
    }
    group.lines.push(`${entry.name} (${key}) — ${plural(entry.hostCount, 'host')}`);
  }
  return [...groups.values()];
}
