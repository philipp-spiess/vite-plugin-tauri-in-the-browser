use std::{path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};

use dirs::home_dir;
use serde::Serialize;
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

const CPU_EVENT: &str = "cpu-usage";

#[derive(Serialize, Clone)]
struct CpuUsagePayload {
    usage: f32,
    timestamp_ms: u128,
}

// Lists up to 32 entries from the user's home directory for the RPC demo.
#[tauri::command]
fn list_home_files() -> Result<Vec<String>, String> {
    let home: PathBuf = home_dir().ok_or_else(|| "Unable to locate home directory".to_string())?;
    let entries = std::fs::read_dir(&home)
        .map_err(|err| format!("Failed to read {}: {err}", home.display()))?;

    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .take(100)
        .map(|entry| {
            let raw = entry.file_name();
            raw.into_string()
                .unwrap_or_else(|os| os.to_string_lossy().into_owned())
        })
        .collect();

    names.sort();
    names.truncate(32);
    Ok(names)
}

fn spawn_cpu_usage_stream(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut system = System::new_all();
        loop {
            system.refresh_cpu_usage();
            let usage = system.global_cpu_info().cpu_usage();
            let payload = CpuUsagePayload {
                usage,
                timestamp_ms: current_millis(),
            };

            if let Err(err) = app.emit(CPU_EVENT, &payload) {
                eprintln!("failed to emit {CPU_EVENT}: {err}");
            }

            sleep(Duration::from_secs(2)).await;
        }
    });
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis())
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_home_files])
        .setup(|app| {
            spawn_cpu_usage_stream(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
