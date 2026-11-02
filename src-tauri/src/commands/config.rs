use tauri::State;

use super::error::CommandError;
use crate::config::{ConfigStore, Environment, Host, HostInput, Project};

type Res<T> = Result<T, CommandError>;

#[tauri::command]
pub async fn list_projects(store: State<'_, ConfigStore>) -> Res<Vec<Project>> {
    Ok(store.list_projects()?)
}

#[tauri::command]
pub async fn create_project(store: State<'_, ConfigStore>, name: String) -> Res<Project> {
    Ok(store.create_project(&name)?)
}

#[tauri::command]
pub async fn rename_project(
    store: State<'_, ConfigStore>,
    project_id: String,
    name: String,
) -> Res<Project> {
    Ok(store.rename_project(&project_id, &name)?)
}

#[tauri::command]
pub async fn delete_project(store: State<'_, ConfigStore>, project_id: String) -> Res<()> {
    Ok(store.delete_project(&project_id)?)
}

#[tauri::command]
pub async fn create_environment(
    store: State<'_, ConfigStore>,
    project_id: String,
    name: String,
) -> Res<Environment> {
    Ok(store.create_environment(&project_id, &name)?)
}

#[tauri::command]
pub async fn rename_environment(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
    name: String,
) -> Res<Environment> {
    Ok(store.rename_environment(&project_id, &environment_id, &name)?)
}

#[tauri::command]
pub async fn delete_environment(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
) -> Res<()> {
    Ok(store.delete_environment(&project_id, &environment_id)?)
}

#[tauri::command]
pub async fn create_host(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
    host: HostInput,
) -> Res<Host> {
    Ok(store.create_host(&project_id, &environment_id, &host)?)
}

#[tauri::command]
pub async fn update_host(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
    host_id: String,
    host: HostInput,
) -> Res<Host> {
    Ok(store.update_host(&project_id, &environment_id, &host_id, &host)?)
}

#[tauri::command]
pub async fn delete_host(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
    host_id: String,
) -> Res<()> {
    Ok(store.delete_host(&project_id, &environment_id, &host_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ConfigStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = ConfigStore::new(dir.path().to_path_buf());
        (dir, s)
    }

    #[test]
    fn store_errors_map_to_contract_codes() {
        let (_d, s) = store();
        s.create_project("A").unwrap();
        let code = |r: Result<_, crate::config::ConfigError>| -> &'static str {
            let r: Res<()> = r.map(|_: Project| ()).map_err(CommandError::from);
            r.unwrap_err().code
        };
        assert_eq!(code(s.create_project("a")), "conflict");
        assert_eq!(code(s.create_project(" ")), "invalid_input");
        assert_eq!(code(s.rename_project("nope", "x")), "not_found");
    }

    #[test]
    fn corrupt_file_maps_to_corrupt_config() {
        let (d, s) = store();
        std::fs::write(d.path().join("config.json"), "garbage").unwrap();
        let err = s.list_projects().map_err(CommandError::from).unwrap_err();
        assert_eq!(err.code, "corrupt_config");
        assert!(!err.message.contains("garbage"));
    }
}
