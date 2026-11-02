import { Service } from '@angular/core';
import { invokeCommand } from './ipc-error';

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number | null;
  /** Unix seconds. */
  modified: number | null;
  permissions: string | null;
  hidden: boolean;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export type FileSide = 'local' | 'remote';

export interface FileSource {
  readonly side: FileSide;
  /** `""` lists the start location: the user's home remotely, the roots locally. */
  list(path: string): Promise<Listing>;
  mkdir(parent: string, name: string): Promise<FileEntry>;
  rename(path: string, newName: string): Promise<FileEntry>;
  delete(path: string, recursive: boolean): Promise<void>;
  /** A path to pass to `list` for the user's home. */
  home(): Promise<string>;
}

export class LocalFiles implements FileSource {
  readonly side = 'local';

  list(path: string): Promise<Listing> {
    return invokeCommand<Listing>('local_list', { path });
  }

  mkdir(parent: string, name: string): Promise<FileEntry> {
    return invokeCommand<FileEntry>('local_mkdir', { parent, name });
  }

  rename(path: string, newName: string): Promise<FileEntry> {
    return invokeCommand<FileEntry>('local_rename', { path, newName });
  }

  async delete(path: string, recursive: boolean): Promise<void> {
    await invokeCommand<null>('local_delete', { path, recursive });
  }

  home(): Promise<string> {
    return invokeCommand<string>('local_home');
  }
}

export class RemoteFiles implements FileSource {
  readonly side = 'remote';

  constructor(readonly connectionId: string) {}

  list(path: string): Promise<Listing> {
    return invokeCommand<Listing>('sftp_list', { connectionId: this.connectionId, path });
  }

  mkdir(parent: string, name: string): Promise<FileEntry> {
    return invokeCommand<FileEntry>('sftp_mkdir', {
      connectionId: this.connectionId,
      parent,
      name,
    });
  }

  rename(path: string, newName: string): Promise<FileEntry> {
    return invokeCommand<FileEntry>('sftp_rename', {
      connectionId: this.connectionId,
      path,
      newName,
    });
  }

  async delete(path: string, recursive: boolean): Promise<void> {
    await invokeCommand<null>('sftp_delete', { connectionId: this.connectionId, path, recursive });
  }

  /** The server resolves `""` to the home directory, so no round trip is needed. */
  home(): Promise<string> {
    return Promise.resolve('');
  }
}

@Service()
export class FileSources {
  readonly local: FileSource = new LocalFiles();
  private readonly remotes = new Map<string, FileSource>();

  remote(connectionId: string): FileSource {
    let source = this.remotes.get(connectionId);
    if (!source) {
      source = new RemoteFiles(connectionId);
      this.remotes.set(connectionId, source);
    }
    return source;
  }
}
