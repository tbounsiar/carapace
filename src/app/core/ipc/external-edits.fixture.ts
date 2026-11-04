import type { EditedFile } from './external-edits';

/** An edited file for specs: synced, nothing uploaded yet. */
export function editedFile(
  id: string,
  hostId: string,
  remotePath: string,
  patch: Partial<EditedFile> = {},
): EditedFile {
  return {
    id,
    hostId,
    remotePath,
    name: remotePath.split('/').pop() ?? remotePath,
    state: 'synced',
    conflict: null,
    error: null,
    openedAt: 0,
    lastSyncedAt: 0,
    lastUploadedAt: null,
    recoveredAt: null,
    size: 10,
    notUploaded: false,
    needsAttention: false,
    watched: true,
    canUpload: true,
    ...patch,
  };
}
