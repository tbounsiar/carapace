import { Component, computed, inject, input } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiAvatar, TuiButtonLoading } from '@taiga-ui/kit';
import { TuiBlockStatus } from '@taiga-ui/layout';
import { FileSources, type FileSide } from '../../../core/ipc/files';
import { SshService } from '../../../core/ipc/ssh';
import { connectionStatus } from '../../../shared/connection-status';
import { HostConnector } from '../../host-connection/host-connector';
import { FilePane } from '../file-pane/file-pane';
import { PanePaths } from '../pane-paths';

@Component({
  imports: [FilePane, TuiAvatar, TuiBlockStatus, TuiButton, TuiButtonLoading],
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

  readonly hostId = input.required<string>();

  protected readonly local = this.sources.local;
  protected readonly remote = computed(() => this.sources.remote(this.hostId()));
  private readonly state = computed(() => this.ssh.states()[this.hostId()] ?? 'idle');
  protected readonly connected = computed(() => this.state() === 'connected');
  protected readonly busy = computed(() => connectionStatus(this.state()).busy);

  protected startPath(side: FileSide): string | null {
    return this.paths.get(this.hostId(), side);
  }

  protected remember(side: FileSide, path: string): void {
    this.paths.set(this.hostId(), side, path);
  }

  protected connect(): void {
    void this.connector.connect(this.hostId());
  }
}
