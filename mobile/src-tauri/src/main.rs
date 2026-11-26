//! The desktop entry point: `tauri dev` on a Mac opens the app in a phone-sized window against the
//! local workspace (`pnpm run app:dev`). iPhone and Android start the app through lib.rs.

// A release build on Windows opens no console beside its window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workspace_mobile_lib::run();
}
