use super::error::CommandError;
use crate::files::{FileEntry, FsError, Listing};
use crate::localfs;

type Res<T> = Result<T, CommandError>;

/// Filesystem calls block, so they run off the async runtime's worker threads.
async fn blocking<T, F>(f: F) -> Res<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FsError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| {
            CommandError::new(
                "io",
                crate::text!(
                    "errors.local.interrupted",
                    "the file operation was interrupted"
                ),
            )
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn local_home() -> Res<String> {
    blocking(localfs::home).await
}

#[tauri::command]
pub async fn local_list(path: String) -> Res<Listing> {
    blocking(move || localfs::list(&path)).await
}

#[tauri::command]
pub async fn local_mkdir(parent: String, name: String) -> Res<FileEntry> {
    blocking(move || localfs::mkdir(&parent, &name)).await
}

#[tauri::command]
pub async fn local_rename(path: String, new_name: String) -> Res<FileEntry> {
    blocking(move || localfs::rename(&path, &new_name)).await
}

#[tauri::command]
pub async fn local_delete(path: String, recursive: bool) -> Res<()> {
    blocking(move || localfs::delete(&path, recursive)).await
}
