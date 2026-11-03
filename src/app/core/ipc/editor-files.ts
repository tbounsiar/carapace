import { Service } from '@angular/core';
import { invokeCommand } from './ipc-error';

export type LineEnding = 'lf' | 'crlf';

export interface TextFile {
  /** LF line breaks and no BOM, whatever the file stores (see `lineEnding`, `bom`). */
  readonly text: string;
  readonly size: number;
  readonly writable: boolean;
  /** Opaque token of the server file the text came from, sent back with a save. */
  readonly version: string;
  readonly lineEnding: LineEnding | 'mixed';
  readonly bom: boolean;
  /** The real file when the opened path is a symlink to another file; saves write there. */
  readonly target: string | null;
}

export interface SavedFile {
  readonly version: string;
  readonly size: number;
}

export interface TextWrite {
  /** LF line breaks; the backend writes `lineEnding` and the BOM. */
  readonly text: string;
  /** null overwrites whatever the server holds. */
  readonly expectedVersion: string | null;
  readonly lineEnding: LineEnding;
  readonly bom: boolean;
  /** The link target of the last read; the backend refuses the save if the link moved. */
  readonly expectedTarget: string | null;
}

/** Biggest file the editor opens; the backend refuses larger ones with `too_large`. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

/** Remote text files for the editor. File contents are user data: callers never log them. */
@Service()
export class EditorFiles {
  read(connectionId: string, path: string): Promise<TextFile> {
    return invokeCommand<TextFile>('sftp_read_text', { connectionId, path });
  }

  write(connectionId: string, path: string, file: TextWrite): Promise<SavedFile> {
    return invokeCommand<SavedFile>('sftp_write_text', { connectionId, path, ...file });
  }
}
