//! Workspace for iPhone and Android: a workspace in an app of its own, a web view on the
//! workspace the person names, with the phone's own navigation. See ../../AGENTS.md.

mod endpoint;
mod window;
mod workspace;

use tauri::Manager;

/// Starts the app. iPhone and Android call it from the projects under `gen/`
/// (`tauri::mobile_entry_point`), and `tauri dev` on a Mac through main.rs.
///
/// # Panics
///
/// When the app cannot start at all: the web view could not be made, or the configuration named a
/// workspace address it refuses (`plugins.workspace.url`, workspace.rs).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Without the plugin's click script, which cancels a click on a `target="_blank"` link and
        // asks the page to open it over IPC: the workspace may call nothing (no capability names a
        // remote origin), so the link would never open. The click goes on to `on_new_window` in
        // window.rs instead, which opens it in the phone's browser.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // The start page's alone: capabilities/start-page.json grants them to no remote page.
        .invoke_handler(tauri::generate_handler![
            endpoint::workspace_address,
            endpoint::parse_workspace_address,
            endpoint::set_workspace_address
        ])
        .setup(|app| {
            let configured = workspace::Workspace::from_config(&app.config().plugins.0);
            app.manage(endpoint::Endpoint::load(app.handle(), configured));
            window::open_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Workspace could not start");
}
