import { Component, computed, inject, signal } from '@angular/core';
import {
  type AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
} from '@angular/forms';
import { TranslocoPipe, translate } from '@jsverse/transloco';
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
import type { ConfigNode, Host, Project } from '../../../core/ipc/config.models';
import type { KeyView } from '../../../core/ipc/keys';
import { ErrorLink } from '../../../shared/error-link';
import { mono, type Part, translateParts } from '../../host-test/host-test-view';
import { ancestors, byName } from '../../project-tree/node-tree';

interface HostGroup {
  readonly label: string;
  readonly project: Project | null;
  readonly hosts: readonly Host[];
}

export interface KeyDeployDialogData {
  readonly key: Pick<KeyView, 'name' | 'path'>;
  /** Resolves true when the key was deployed; failures are notified by the callee. */
  readonly deploy: (hostId: string, useKey: boolean) => Promise<boolean>;
}

/** The host's path inside its scope: `Backend / UI`, or `UI` at the scope root. */
export function deployTargetLabel(nodes: readonly ConfigNode[], host: Host): string {
  return [...ancestors(nodes, host.id).map((c) => c.name), host.name].join(' / ');
}

function required(control: AbstractControl): ValidationErrors | null {
  return control.value
    ? null
    : { invalid: new TuiValidationError(translate<string>('keys.deploy.pickHost')) };
}

@Component({
  imports: [
    ErrorLink,
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
    TranslocoPipe,
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

  /** Home first, then each project with hosts; hosts sorted by name. */
  protected readonly groups = computed<HostGroup[]>(() => {
    const hosts = [...this.config.hosts()].sort(byName);
    const scopes: (Project | null)[] = [null, ...[...this.config.projects()].sort(byName)];
    return scopes
      .map((project) => ({
        label: project?.name ?? translate<string>('common.home'),
        project,
        hosts: hosts.filter((h) => h.projectId === (project?.id ?? null)),
      }))
      .filter((group) => group.hosts.length > 0);
  });
  private readonly labels = computed(() => {
    const map = new Map<string, string>();
    for (const group of this.groups()) {
      for (const host of group.hosts) {
        map.set(host.id, deployTargetLabel(this.config.nodes(), host));
      }
    }
    return map;
  });
  protected readonly stringify: TuiStringHandler<string | null> = (id) =>
    (id && this.labels().get(id)) || '';

  protected intro(): Part[] {
    return translateParts('keys.deploy.intro', {
      name: { text: this.key.name, strong: true },
      file: mono('~/.ssh/authorized_keys'),
    });
  }

  protected useKeyNote(): Part[] {
    return translateParts('keys.deploy.useKeyNote', { path: mono(this.key.path) });
  }

  protected label(host: Host): string {
    return this.labels().get(host.id) ?? host.name;
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
