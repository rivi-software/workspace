//! The workspace the app opens: the address the person named on the start page, kept in a file of
//! the app's own, or else the one the build names (`plugins.workspace.url`, workspace.rs), or else
//! none, and the start page asks for it.
//!
//! The start page alone reads and changes it, through the two commands here: capabilities/
//! start-page.json grants them to the app's own pages and to no remote origin, so no page of a
//! workspace, nor anything it frames or links, can point the app at another site.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::workspace::Workspace;

/// The file in the app's configuration folder that holds the address the person named.
const FILE: &str = "workspace.json";

#[derive(Debug)]
pub struct Endpoint {
    /// The address the build names, which the app opens while the person has named none.
    configured: Option<Workspace>,
    /// The address the person named.
    chosen: RwLock<Option<Workspace>>,
    /// Where the person's choice is kept; `None` when the app has no configuration folder, and
    /// the choice then lasts until the app quits.
    file: Option<PathBuf>,
}

impl Endpoint {
    /// The workspace from the build's configuration and the file the app kept, if any.
    pub fn load<R: Runtime>(app: &AppHandle<R>, configured: Option<Workspace>) -> Self {
        let file = app
            .path()
            .app_config_dir()
            .ok()
            .map(|folder| folder.join(FILE));
        Self::from_file(configured, file)
    }

    fn from_file(configured: Option<Workspace>, file: Option<PathBuf>) -> Self {
        let chosen = file.as_deref().and_then(read);
        Self {
            configured,
            chosen: RwLock::new(chosen),
            file,
        }
    }

    /// The workspace the app opens now.
    pub fn current(&self) -> Option<Workspace> {
        self.chosen
            .read()
            .ok()
            .and_then(|chosen| chosen.clone())
            .or_else(|| self.configured.clone())
    }

    /// Opens `workspace` from now on, and on every launch after this one.
    fn choose(&self, workspace: Workspace) -> Result<(), String> {
        if let Some(file) = &self.file {
            write(file, &workspace)?;
        }
        let mut chosen = self
            .chosen
            .write()
            .map_err(|_| "The app could not keep the address.".to_owned())?;
        *chosen = Some(workspace);
        Ok(())
    }
}

/// The address kept in `file`. A file that is missing, unreadable or names an address the app
/// would refuse now counts as none, so the start page asks again rather than open it.
fn read(file: &Path) -> Option<Workspace> {
    let text = fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Workspace::parse(value.get("url")?.as_str()?).ok()
}

fn write(file: &Path, workspace: &Workspace) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("The app could not keep the address: {error}");
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder).map_err(failed)?;
    }
    let text = json!({ "url": workspace.start().as_str() }).to_string();
    fs::write(file, text).map_err(failed)
}

/// The workspace the app opens now, for the start page: its address, or `null` when the person
/// has to name one.
#[tauri::command]
pub fn workspace_address(endpoint: State<'_, Endpoint>) -> Option<String> {
    endpoint
        .current()
        .map(|workspace| workspace.start().to_string())
}

/// The workspace's start page for `address` as the person typed it on the start page, without
/// keeping it: the start page checks that a workspace answers there first. Answers the reason it
/// was refused, in words for the person. A debug build also takes a development workspace over
/// plain HTTP.
#[tauri::command]
pub fn parse_workspace_address(address: String) -> Result<String, String> {
    Workspace::from_input(&address, cfg!(debug_assertions))
        .map(|workspace| workspace.start().to_string())
}

/// Opens the workspace at `address`, as the person typed it on the start page, from now on.
/// Answers the address the start page goes on to, or the reason it was refused, in words for the
/// person. A debug build also takes a development workspace over plain HTTP.
#[tauri::command]
pub fn set_workspace_address(
    endpoint: State<'_, Endpoint>,
    address: String,
) -> Result<String, String> {
    let workspace = Workspace::from_input(&address, cfg!(debug_assertions))?;
    let start = workspace.start().to_string();
    endpoint.choose(workspace)?;
    Ok(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "workspace-mobile-endpoint-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&folder);
        folder
    }

    fn workspace(address: &str) -> Workspace {
        Workspace::parse(address).unwrap()
    }

    #[test]
    fn without_a_choice_the_app_opens_what_the_build_names_or_nothing() {
        let file = folder("none").join(FILE);
        assert_eq!(
            Endpoint::from_file(None, Some(file.clone())).current(),
            None
        );
        let local = workspace("http://localhost:5174/");
        assert_eq!(
            Endpoint::from_file(Some(local.clone()), Some(file)).current(),
            Some(local)
        );
    }

    #[test]
    fn a_choice_wins_over_the_build_and_outlasts_the_launch() {
        let folder = folder("chosen");
        let file = folder.join(FILE);
        let local = workspace("http://localhost:5174/");
        let endpoint = Endpoint::from_file(Some(local.clone()), Some(file.clone()));
        let chosen = workspace("https://workspace.example.com/");
        endpoint.choose(chosen.clone()).unwrap();
        assert_eq!(endpoint.current(), Some(chosen.clone()));

        let next_launch = Endpoint::from_file(Some(local), Some(file));
        assert_eq!(next_launch.current(), Some(chosen));
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_kept_file_the_app_would_refuse_counts_as_none() {
        let folder = folder("broken");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join(FILE);
        for text in [
            "not json",
            "{}",
            r#"{"url":42}"#,
            r#"{"url":"http://workspace.example.com/"}"#,
            r#"{"url":"file:///etc/passwd"}"#,
        ] {
            fs::write(&file, text).unwrap();
            assert_eq!(
                Endpoint::from_file(None, Some(file.clone())).current(),
                None,
                "{text}"
            );
        }
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn without_a_folder_the_choice_lasts_the_launch() {
        let endpoint = Endpoint::from_file(None, None);
        let chosen = workspace("https://workspace.example.com/");
        endpoint.choose(chosen.clone()).unwrap();
        assert_eq!(endpoint.current(), Some(chosen));
    }
}
