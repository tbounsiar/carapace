import { Component, computed, inject, signal } from '@angular/core';
import {
  type AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
} from '@angular/forms';
import { type TuiStringHandler, TuiValidationError } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCheckbox,
  TuiDataList,
  TuiError,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiChevron, TuiSelect } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import type { Host, Project } from '../../../core/ipc/config.models';
import type { KeyView } from '../../../core/ipc/keys';

export interface KeyDeployDialogData {
  readonly key: Pick<KeyView, 'name' | 'path'>;
  /** Resolves true when the key was deployed; failures are notified by the callee. */
  readonly deploy: (hostId: string, useKey: boolean) => Promise<boolean>;
}

/** `UI · Dev`, or the host name alone when its project has no active environment. */
export function deployTargetLabel(project: Project, host: Host): string {
  const env = project.environments.find((e) => e.id === project.activeEnvironmentId);
  return env ? `${host.name} · ${env.name}` : host.name;
}

function required(control: AbstractControl): ValidationErrors | null {
  return control.value ? null : { invalid: new TuiValidationError('Pick a host') };
}

@Component({
  imports: [
    ReactiveFormsModule,
    TuiButton,
    TuiButtonLoading,
    TuiCheckbox,
    TuiChevron,
    TuiDataList,
    TuiError,
    TuiForm,
    TuiSelect,
    TuiTextfield,
  ],
  selector: 'app-key-deploy-dialog',
  styleUrl: './key-deploy-dialog.scss',
  templateUrl: './key-deploy-dialog.html',
})
export class KeyDeployDialog {
  private readonly config = inject(ConfigService);
  protected readonly context = injectContext<TuiDialogContext<void, KeyDeployDialogData>>();
  protected readonly key = this.context.data.key;

  protected readonly busy = signal(false);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    hostId: this.fb.control<string | null>(null, required),
    useKey: [false],
  });

  protected readonly projects = computed(() =>
    this.config.projects().filter((p) => p.hosts.length > 0),
  );
  private readonly labels = computed(() => {
    const map = new Map<string, string>();
    for (const project of this.config.projects()) {
      for (const host of project.hosts) {
        map.set(host.id, deployTargetLabel(project, host));
      }
    }
    return map;
  });
  protected readonly stringify: TuiStringHandler<string | null> = (id) =>
    (id && this.labels().get(id)) || '';

  protected label(project: Project, host: Host): string {
    return deployTargetLabel(project, host);
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    const { hostId, useKey } = this.form.getRawValue();
    if (this.form.invalid || !hostId || this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      if (await this.context.data.deploy(hostId, useKey)) {
        this.context.completeWith();
      }
    } finally {
      this.busy.set(false);
    }
  }
}
