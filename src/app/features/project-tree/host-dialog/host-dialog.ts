import { NgTemplateOutlet } from '@angular/common';
import { TuiActiveZone } from '@taiga-ui/cdk';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiDialogService,
  TuiDropdown,
  TuiError,
  TuiHint,
  TuiIcon,
  TuiInput,
  TuiLink,
  TuiLoader,
  TuiNotification,
  TuiNotificationService,
  TuiTextfield,
  TuiTitle,
  type TuiDialogContext,
} from '@taiga-ui/core';
import {
  TUI_CONFIRM,
  TuiButtonLoading,
  TuiChevron,
  type TuiConfirmData,
  TuiSegmented,
  TuiSelect,
  TuiTooltip,
} from '@taiga-ui/kit';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { TuiElasticContainer, TuiForm } from '@taiga-ui/layout';
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { AuthMethod, Host, HostInput } from '../../../core/ipc/config.models';
import { KeyFilePicker } from '../../../core/ipc/key-file-picker';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { escapeHtml, pathHtml } from '../../../shared/path-breaks';
import {
  hasReferences,
  parseTemplate,
  previewHost,
  resolveTemplate,
  secretVariableNames,
  variableLayers,
} from '../../../shared/template';
import { HostTester, type HostTestDraft, type HostTestRun } from '../../host-test/host-tester';
import {
  CANCELLED_VIEW,
  outcomeView,
  testingView,
  type HostTestView,
} from '../../host-test/host-test-view';
import { handleSaveError, notifyError } from '../save-error';
import {
  hostnameValidator,
  keyPathValidator,
  nameValidator,
  noWhitespaceValidator,
  portTemplateValidator,
  secretReferenceValidator,
  templated,
} from '../validators';
import { ErrorLink } from '../../../shared/error-link';

export interface HostDialogData {
  /** Scope of the host: null is Home (global variables only). */
  readonly projectId: string | null;
  /** The saved host being edited, null for a new one. */
  readonly hostId: string | null;
  /** "Home / Backend", shown read-only. */
  readonly location: string;
  readonly initial: HostInput | null;
  readonly save: (host: HostInput) => Promise<Host>;
}

export type AuthKind = AuthMethod['kind'];

/** Case-insensitive for Windows paths, which contain a backslash. */
export function sameKeyPath(a: string, b: string): boolean {
  return a.includes('\\') || b.includes('\\') ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function reference(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

@Component({
  imports: [
    ErrorLink,
    NgTemplateOutlet,
    TuiActiveZone,
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiChevron,
    TuiDataList,
    TuiDropdown,
    TuiElasticContainer,
    TuiError,
    TuiHint,
    TuiForm,
    TuiIcon,
    TuiInput,
    TuiLink,
    TuiLoader,
    TuiNotification,
    TuiSegmented,
    TuiSelect,
    TuiTextfield,
    TuiTitle,
    TuiTooltip,
  ],
  selector: 'app-host-dialog',
  styleUrl: './host-dialog.scss',
  templateUrl: './host-dialog.html',
})
export class HostDialog {
  private readonly alerts = inject(TuiNotificationService);
  private readonly config = inject(ConfigService);
  private readonly keyStore = inject(KeyStore);
  private readonly tester = inject(HostTester);
  private readonly picker = inject(KeyFilePicker);
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(Injector);
  protected readonly context = injectContext<TuiDialogContext<void, HostDialogData>>();

  protected readonly authKinds: readonly AuthKind[] = ['password', 'key', 'agent'];
  protected readonly example = '${host}';

  protected readonly saving = signal(false);
  protected readonly keys = this.keyStore.keys;
  protected readonly keyMenuOpen = signal(false);
  protected readonly picking = this.picker.picking;
  private readonly keyPathInput = viewChild('keyPathInput', { read: ElementRef });
  private readonly keyBrowse = viewChild('keyBrowse', { read: ElementRef });
  /** A browsed path that may need registering; cleared by any other edit of Key path. */
  private readonly browsedPath = signal<string | null>(null);
  private readonly initial = this.context.data.initial;
  private readonly initialAuth = this.initial?.auth;
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    name: [this.initial?.name ?? '', nameValidator('Name', 100)],
    hostname: [this.initial?.hostname ?? '', templated('Hostname', hostnameValidator(253))],
    port: [this.initial?.port ?? '22', portTemplateValidator],
    username: [
      this.initial?.username ?? '',
      templated('Username', noWhitespaceValidator('Username', 64)),
    ],
    authKind: [(this.initialAuth?.kind ?? 'password') as AuthKind],
    keyPath: [this.initialAuth?.kind === 'key' ? this.initialAuth.keyPath : ''],
    password: this.fb.control<string | null>(
      this.initialAuth?.kind === 'password' ? this.initialAuth.password : null,
      secretReferenceValidator('Password'),
    ),
    passphrase: this.fb.control<string | null>(
      this.initialAuth?.kind === 'key' ? this.initialAuth.passphrase : null,
      secretReferenceValidator('Passphrase'),
    ),
  });

  private readonly authKind = toSignal(this.form.controls.authKind.valueChanges, {
    initialValue: this.form.controls.authKind.value,
  });
  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.value });
  protected readonly isKey = computed(() => this.authKind() === 'key');
  protected readonly isPassword = computed(() => this.authKind() === 'password');

  private readonly project = computed(() => {
    const id = this.context.data.projectId;
    return id ? this.config.findProject(id) : null;
  });
  protected readonly askLabel: TuiStringHandler<string | null> = (value) =>
    value || 'Ask when connecting';

  /** Secret variables of both levels, plus the current references so a stale one stays visible. */
  protected readonly secretReferences = computed(() => {
    const project = this.project();
    const names = secretVariableNames(this.config.variables(), project);
    const refs = names.map((name) => `\${${name}}`);
    const { password, passphrase } = this.value();
    for (const current of [password, passphrase]) {
      if (current && !refs.includes(current)) {
        refs.push(current);
      }
    }
    return refs;
  });

  protected readonly showRegister = computed(() => {
    const path = this.browsedPath();
    if (path === null || !this.keyStore.loaded() || this.value().keyPath !== path) {
      return false;
    }
    return !this.keys().some((k) => sameKeyPath(k.path, path));
  });

  private readonly layers = computed(() => variableLayers(this.config.variables(), this.project()));

  protected readonly preview = computed(() => {
    this.value();
    if (this.context.data.projectId && !this.project()) {
      return null;
    }
    return previewHost(this.toHostInput(), this.layers());
  });

  /** Why the form cannot be tested yet; null when it can. */
  protected readonly testBlocker = computed(() => {
    this.value();
    const preview = this.preview();
    if (!preview) {
      return 'This project no longer exists.';
    }
    if (preview.missing.length) {
      return 'Define the missing variables to test the connection.';
    }
    const { hostname, port, username, keyPath } = this.form.controls;
    const fields = this.isKey() ? [hostname, port, username, keyPath] : [hostname, port, username];
    if (preview.errors.length || fields.some((field) => field.invalid)) {
      return 'Fix the highlighted fields to test the connection.';
    }
    return null;
  });

  protected readonly testView = signal<HostTestView | null>(null);
  protected readonly testing = computed(() => this.testView()?.state === 'testing');
  private run: HostTestRun | null = null;
  /** The form values a shown or running test belongs to. */
  private testedKey: string | null = null;
  private readonly draftKey = computed(() => {
    this.value();
    return JSON.stringify([this.toHostInput(), this.preview()]);
  });

  constructor() {
    // The picker is optional: without the key list the path is still typed by hand.
    this.keyStore.ensureLoaded().catch(() => undefined);
    effect(() => {
      const keyPath = this.form.controls.keyPath;
      keyPath.setValidators(this.isKey() ? templated('Key path', keyPathValidator) : []);
      keyPath.updateValueAndValidity();
    });
    effect(() => {
      const key = this.draftKey();
      untracked(() => {
        if (this.testedKey !== null && key !== this.testedKey) {
          this.resetTest();
        }
      });
    });
    const destroyRef = inject(DestroyRef);
    this.form.controls.keyPath.valueChanges
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe((path) => {
        if (path !== this.browsedPath()) {
          this.browsedPath.set(null);
        }
      });
    destroyRef.onDestroy(() => this.run?.abort());
  }

  protected toggleTest(): void {
    if (this.testing()) {
      this.run?.abort();
      this.run = null;
      this.testView.set(CANCELLED_VIEW);
      return;
    }
    const preview = this.preview();
    if (this.testBlocker() || !preview) {
      return;
    }
    const host = this.toHostInput();
    const draft: HostTestDraft = {
      host,
      projectId: this.context.data.projectId,
      hostId: this.context.data.hostId ?? null,
      address: preview.address,
      keyPath:
        host.auth.kind === 'key' ? resolveTemplate(host.auth.keyPath, this.layers()).value : '',
    };
    const run = this.tester.start(draft);
    this.run = run;
    this.testedKey = this.draftKey();
    this.testView.set(testingView(draft));
    void run.outcome.then((outcome) => {
      if (this.run === run) {
        this.run = null;
        this.testView.set(outcomeView(outcome, draft));
      }
    });
  }

  private resetTest(): void {
    this.run?.abort();
    this.run = null;
    this.testedKey = null;
    this.testView.set(null);
  }

  protected async pickKey(path: string): Promise<void> {
    this.keyMenuOpen.set(false);
    if (await this.replaceKeyPath(path)) {
      this.focusLater(this.keyPathInput());
    }
  }

  protected async browseKey(): Promise<void> {
    const current = this.form.controls.keyPath.value.trim();
    let picked: string | null;
    try {
      picked = await this.picker.pickFile(current && !hasReferences(current) ? current : null);
    } catch (err) {
      notifyError(this.alerts, err, 'File picker not opened');
      return;
    }
    if (picked === null || !(await this.replaceKeyPath(picked))) {
      this.focusLater(this.keyBrowse());
      return;
    }
    this.browsedPath.set(picked);
    this.focusLater(this.keyPathInput());
  }

  protected async registerKey(): Promise<void> {
    const path = this.browsedPath();
    if (path === null) {
      return;
    }
    const { KeyImportDialog } = await import('../../keys/key-import-dialog/key-import-dialog');
    const key = await firstValueFrom(
      this.dialogs.open<KeyView>(new PolymorpheusComponent(KeyImportDialog), {
        label: 'Import key',
        size: 'm',
        data: { path },
      }),
      { defaultValue: null },
    );
    if (key) {
      this.alerts.open(key.name, { label: 'Key registered', appearance: 'positive' }).subscribe();
      this.browsedPath.set(null);
    }
    this.focusLater(this.keyPathInput());
  }

  /** Asks first when the field holds a template; resolves false when the user keeps it. */
  private async replaceKeyPath(path: string): Promise<boolean> {
    const keyPath = this.form.controls.keyPath;
    const refs = parseTemplate(keyPath.value).flatMap((s) => ('ref' in s ? [`\${${s.ref}}`] : []));
    if (refs.length) {
      const code = (text: string): string => `<code>${escapeHtml(text)}</code>`;
      const data: TuiConfirmData = {
        content: `Key path uses ${refs.map(code).join(', ')}. Replace it with this file? The host will no longer follow the variable.<br /><code>${pathHtml(path)}</code>`,
        yes: 'Replace',
        no: 'Keep template',
        appearance: 'primary',
      };
      const replace = await firstValueFrom(
        this.dialogs.open<boolean>(TUI_CONFIRM, {
          label: 'Replace the template?',
          size: 's',
          data,
        }),
        { defaultValue: false },
      );
      if (!replace) {
        return false;
      }
    }
    keyPath.setValue(path);
    keyPath.markAsDirty();
    keyPath.markAsTouched();
    return true;
  }

  private focusLater(ref: ElementRef | undefined): void {
    afterNextRender(() => (ref?.nativeElement as HTMLElement | undefined)?.focus(), {
      injector: this.injector,
    });
  }

  protected label(kind: AuthKind): string {
    return AUTH_LABELS[kind];
  }

  protected async submit(): Promise<void> {
    if (this.testing()) {
      this.resetTest();
    }
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.context.data.save(this.toHostInput());
      this.context.completeWith();
    } catch (err) {
      handleSaveError(this.alerts, err, this.form.controls.name, 'host');
    } finally {
      this.saving.set(false);
    }
  }

  private toHostInput(): HostInput {
    const v = this.form.getRawValue();
    let auth: AuthMethod;
    if (v.authKind === 'key') {
      auth = { kind: 'key', keyPath: v.keyPath.trim(), passphrase: reference(v.passphrase) };
    } else if (v.authKind === 'password') {
      auth = { kind: 'password', password: reference(v.password) };
    } else {
      auth = { kind: 'agent' };
    }
    return {
      name: v.name.trim(),
      hostname: v.hostname.trim(),
      port: v.port.trim(),
      username: v.username.trim(),
      auth,
    };
  }
}
