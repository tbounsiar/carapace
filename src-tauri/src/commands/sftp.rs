use tauri::State;

use super::error::CommandError;
use crate::analytics::Analytics;
use crate::files::{FileEntry, FsError, Listing};
use crate::sftp::{Eol, Saved, SftpManager, TextFile, WriteText};
use crate::ssh::SshManager;

type Res<T> = Result<T, CommandError>;

fn required(value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(FsError::invalid(crate::text!(
            "errors.files.required",
            "{name} is required",
            name = "connectionId"
        ))
        .into());
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

#[tauri::command]
pub async fn sftp_read_text(
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    connection_id: String,
    path: String,
) -> Res<TextFile> {
    required(&connection_id)?;
    Ok(sftp.read_text(&ssh, &connection_id, &path).await?)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_write_text(
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    connection_id: String,
    path: String,
    text: String,
    expected_version: Option<String>,
    expected_target: Option<String>,
    line_ending: Eol,
    bom: bool,
) -> Res<Saved> {
    required(&connection_id)?;
    let req = WriteText {
        path: &path,
        text: &text,
        expected: expected_version.as_deref(),
        expected_target: expected_target.as_deref(),
        eol: line_ending,
        bom,
    };
    Ok(sftp.write_text(&ssh, &connection_id, req).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_connection_id_is_invalid_input() {
        assert_eq!(required("  ").unwrap_err().code, "invalid_input");
        assert!(required("h").is_ok());
    }

    #[test]
    fn editor_errors_map_to_stable_codes() {
        let e = CommandError::from(FsError::Changed("/etc/a".into()));
        assert_eq!(
            (e.code, e.message.as_str()),
            (
                "conflict",
                "/etc/a changed on the server since it was opened"
            )
        );
        let e = CommandError::from(FsError::Deleted("/etc/a".into()));
        assert_eq!(
            (e.code, e.message.as_str()),
            ("conflict", "/etc/a no longer exists on the server")
        );
        assert_eq!(
            CommandError::from(FsError::NotText("/b".into())).code,
            "not_text"
        );
    }
}
