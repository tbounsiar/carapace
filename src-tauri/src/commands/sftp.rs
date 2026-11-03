use tauri::State;

use super::error::CommandError;
use crate::analytics::Analytics;
use crate::files::{FileEntry, FsError, Listing};
use crate::sftp::SftpManager;
use crate::ssh::SshManager;

type Res<T> = Result<T, CommandError>;

fn required(value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(FsError::invalid("connectionId is required").into());
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_list(
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    analytics: State<'_, Analytics>,
    connection_id: String,
    path: String,
) -> Res<Listing> {
    list_in(&ssh, &sftp, &analytics, &connection_id, &path).await
}

pub(super) async fn list_in(
    ssh: &SshManager,
    sftp: &SftpManager,
    analytics: &Analytics,
    connection_id: &str,
    path: &str,
) -> Res<Listing> {
    required(connection_id)?;
    let listing = sftp.list(ssh, connection_id, path).await?;
    analytics.files_listed(connection_id);
    Ok(listing)
}

#[tauri::command]
pub async fn sftp_mkdir(
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    connection_id: String,
    parent: String,
    name: String,
) -> Res<FileEntry> {
    required(&connection_id)?;
    Ok(sftp.mkdir(&ssh, &connection_id, &parent, &name).await?)
}

#[tauri::command]
pub async fn sftp_rename(
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    connection_id: String,
    path: String,
    new_name: String,
) -> Res<FileEntry> {
    required(&connection_id)?;
    Ok(sftp.rename(&ssh, &connection_id, &path, &new_name).await?)
}

#[tauri::command]
pub async fn sftp_delete(
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    connection_id: String,
    path: String,
    recursive: bool,
) -> Res<()> {
    required(&connection_id)?;
    Ok(sftp.delete(&ssh, &connection_id, &path, recursive).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_connection_id_is_invalid_input() {
        assert_eq!(required("  ").unwrap_err().code, "invalid_input");
        assert!(required("h").is_ok());
    }
}
