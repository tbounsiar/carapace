import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiAvatar, TuiButtonLoading } from '@taiga-ui/kit';
import { TuiBlockStatus } from '@taiga-ui/layout';
import type { ConnectionTarget } from '../../../core/ipc/connection';
import { FileSources, type FileSide } from '../../../core/ipc/files';
import { SshService } from '../../../core/ipc/ssh';
import { connectionStatus } from '../../../shared/connection-status';
import { HostConnector } from '../../host-connection/host-connector';
import { TransferPanel } from '../../transfers/transfer-panel/transfer-panel';
import { paneRevisions, TransferQueue } from '../../transfers/transfer-queue';
import { FilePane, type PaneTransfer } from '../file-pane/file-pane';
import { PanePaths } from '../pane-paths';

@Component({
  imports: [FilePane, TransferPanel, TuiAvatar, TuiBlockStatus, TuiButton, TuiButtonLoading],
  selector: 'app-files-panel',
  styleUrl: './files-panel.scss',
  templateUrl: './files-panel.html',
  host: { 'data-testid': 'files-panel' },
})
export class FilesPanel {
  private readonly sources = inject(FileSources);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly paths = inject(PanePaths);
  private readonly queue = inject(TransferQueue);

  readonly target = input.required<ConnectionTarget>();

  protected readonly local = this.sources.local;
  protected readonly remote = computed(() => this.sources.remote(this.target().connectionId));
  private readonly state = computed(() => this.ssh.states()[this.target().connectionId] ?? 'idle');
  protected readonly connected = computed(() => this.state() === 'connected');
  protected readonly busy = computed(() => connectionStatus(this.state()).busy);

  private readonly current = linkedSignal<string, Record<FileSide, string | null>>({
    source: () => this.target().connectionId,
    computation: () => ({ local: null, remote: null }),
  });
  protected readonly uploadTarget = computed(() =>
    this.connected() ? this.current().remote : null,
  );
  protected readonly downloadTarget = computed(() =>
    this.connected() ? this.current().local : null,
  );
  protected readonly localRevisions = computed(() =>
    paneRevisions(this.queue.revisions(), this.target().connectionId, 'local'),
  );
  protected readonly remoteRevisions = computed(() =>
    paneRevisions(this.queue.revisions(), this.target().connectionId, 'remote'),
  );

  protected startPath(side: FileSide): string | null {
    return this.paths.get(this.target().connectionId, side);
  }

  protected remember(side: FileSide, path: string): void {
    this.paths.set(this.target().connectionId, side, path);
    this.current.update((c) => ({ ...c, [side]: path }));
  }

  protected connect(): void {
    void this.connector.connect(this.target());
  }

  protected upload(request: PaneTransfer): void {
    void this.queue.enqueue(
      this.target().connectionId,
      'upload',
      request.sources,
      request.targetDir,
    );
  }

  protected download(request: PaneTransfer): void {
    void this.queue.enqueue(
      this.target().connectionId,
      'download',
      request.sources,
      request.targetDir,
    );
  }
}
