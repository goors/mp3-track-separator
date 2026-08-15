use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, Emitter, Listener};
use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection};
use tauri_plugin_shell::ShellExt;
use std::fs::File;
use std::io::Write;
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
pub struct ProcessPayload {
    pub video_id: String,
    pub status: String,
    pub progress: f32,
}

// Helper to emit consistent progress events to the frontend
fn emit_progress(app: &tauri::AppHandle, id: &str, msg: &str, prog: f32) {
    let _ = app.emit("dl-progress", ProcessPayload {
        video_id: id.to_string(),
        status: msg.to_string(),
        progress: prog,
    });
}
#[tauri::command]
async fn download_youtube_to_mp3(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let bin_dir = app.path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;

    let yt_dlp_path = bin_dir.join("yt-dlp");
    let ffmpeg_path = bin_dir.join("ffmpeg");

    // 1. Get Metadata immediately
    let meta_output = app.shell()
        .command(yt_dlp_path.to_string_lossy().as_ref())
        .args(["--quiet", "--print-json", "--skip-download", &url])
        .output()
        .await
        .map_err(|e| format!("Metadata fetch failed: {}", e))?;

    let meta_json: serde_json::Value = serde_json::from_slice(&meta_output.stdout)
        .map_err(|e| format!("Failed to parse metadata: {}", e))?;

    let video_id = meta_json["id"].as_str().ok_or("Could not find video ID")?;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let output_dir = app_dir.join(video_id);

    // --- SETUP DEBUG LOG ---
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let log_path = output_dir.join("download_debug.log");
    let mut log_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
    use std::io::Write;
    let _ = writeln!(log_file, "\n--- DOWNLOAD START: {} ---", video_id);
    let _ = writeln!(log_file, "BIN_DIR: {}", bin_dir.display());
    let _ = writeln!(log_file, "FFMPEG_EXISTS: {}", ffmpeg_path.exists());

    let output_path = output_dir.join("source.mp3");
    let output_str = output_path.to_string_lossy().to_string();

    let emit_shred_status = |status: &str, progress: f64| {
        let _ = app.emit("processing-shred", serde_json::json!({
            "video_id": video_id,
            "status": status,
            "progress": progress,
            "meta": {
                "title": meta_json["title"].as_str().unwrap_or(video_id),
                "thumbnail": meta_json["thumbnail"].as_str().unwrap_or(""),
                "uploader": meta_json["uploader"].as_str().unwrap_or("Unknown"),
                "duration": meta_json["duration"].as_u64().unwrap_or(0)
            }
        }));
    };

    if output_path.exists() {
        emit_shred_status("Source exists, skipping...", 100.0);
        return Ok(output_str);
    }

    // Save Metadata
    let mut file = std::fs::File::create(output_dir.join("meta.json")).map_err(|e| e.to_string())?;
    file.write_all(&meta_output.stdout).map_err(|e| e.to_string())?;

    // --- FIX PATH FOR FFMPEG ---
    let mut new_path = bin_dir.as_os_str().to_owned();
    #[cfg(not(target_os = "windows"))] new_path.push(":");
    #[cfg(target_os = "windows")] new_path.push(";");
    new_path.push(std::env::var_os("PATH").unwrap_or_default());

    emit_shred_status("Downloading & Converting...", 10.0);

    let (mut rx, _child) = app.shell()
        .command(yt_dlp_path.to_string_lossy().as_ref())
        .args([
            "--ffmpeg-location", bin_dir.to_string_lossy().as_ref(), // EXPLICIT FFMPEG LOC
            "-x",
            "--audio-format", "mp3",
            "-o", &output_str,
            &url
        ])
        .env("PATH", new_path) // INJECT PATH
        .spawn()
        .map_err(|e| format!("Failed to spawn download: {}", e))?;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let out = String::from_utf8_lossy(&line).trim().to_string();
                let _ = writeln!(log_file, "STDOUT: {}", out);
                emit_shred_status(&out, 40.0);
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let err = String::from_utf8_lossy(&line).trim().to_string();
                let _ = writeln!(log_file, "STDERR: {}", err);
            }
            _ => {}
        }
    }

    // Final Validation
    if !output_path.exists() {
        let _ = writeln!(log_file, "CRITICAL: source.mp3 was NOT created.");
        return Err("Download finished but source.mp3 is missing. Check download_debug.log".into());
    }

    Ok(output_str)
}


#[tauri::command]
async fn run_ai_separation(app: tauri::AppHandle, input_path: String) -> Result<Vec<String>, String> {
    let input_p = std::path::Path::new(&input_path);
    let output_dir = input_p.parent().ok_or("Invalid path")?;
    let video_id = output_dir.file_name().ok_or("No video id")?.to_string_lossy().to_string();
    let db_path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("shredder.db");

    // --- 1. SETUP DEBUG LOG ---
    let log_path = output_dir.join("debug.log");
    let mut log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log: {}", e))?;

    use std::io::Write;
    let _ = writeln!(log_file, "\n--- SHREDDER RUN: {} ---", video_id);
    // --------------------------

    let meta_path = output_dir.join("meta.json");
    let meta_json_str = std::fs::read_to_string(&meta_path).unwrap_or_else(|_| "{}".to_string());
    let meta_val: serde_json::Value = serde_json::from_str(&meta_json_str).unwrap_or_default();

    let emit_shred_status = |status: &str, progress: f64| {
        let _ = app.emit("processing-shred", serde_json::json!({
            "video_id": video_id,
            "status": status,
            "progress": progress,
            "meta": {
                "title": meta_val["title"].as_str().unwrap_or(&video_id),
                "thumbnail": meta_val["thumbnail"].as_str().unwrap_or(""),
                "uploader": meta_val["uploader"].as_str().unwrap_or("Unknown"),
                "view_count": meta_val["view_count"].as_u64().unwrap_or(0),
                "like_count": meta_val["like_count"].as_u64().unwrap_or(0),
                "duration": meta_val["duration"].as_u64().unwrap_or(0),
                "comment_count": meta_val["comment_count"].as_u64().unwrap_or(0)
            }
        }));
    };

    // --- 2. CACHE CHECK ---
    {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT stems FROM shreds WHERE video_id = ?1").map_err(|e| e.to_string())?;

        if let Ok(stems_json) = stmt.query_row(rusqlite::params![video_id], |row| row.get::<_, String>(0)) {
            let paths: Vec<String> = serde_json::from_str(&stems_json).unwrap_or_default();
            if paths.iter().all(|p| std::path::Path::new(p).exists()) && !paths.is_empty() {
                let _ = writeln!(log_file, "Result found in cache.");
                emit_shred_status("Ready (Cached)", 100.0);
                return Ok(paths);
            }
        }
    }

    // --- 3. PATH DIAGNOSTICS ---
    let ffmpeg_bin_dir = app.path().resolve("binaries", tauri::path::BaseDirectory::Resource).map_err(|e| e.to_string())?;
    let shredder_path = ffmpeg_bin_dir.join("shredder");

    let _ = writeln!(log_file, "BIN_DIR: {}", ffmpeg_bin_dir.display());
    let _ = writeln!(log_file, "SHREDDER_PATH: {}", shredder_path.display());
    let _ = writeln!(log_file, "INPUT: {}", input_path);
    let _ = writeln!(log_file, "OUTPUT: {}", output_dir.display());
    let _ = writeln!(log_file, "SHREDDER_EXISTS: {}", shredder_path.exists());

    // Fix PATH: Force binaries folder to the front so it finds ffprobe
    let mut new_path = ffmpeg_bin_dir.as_os_str().to_owned();
    #[cfg(not(target_os = "windows"))] new_path.push(":");
    #[cfg(target_os = "windows")] new_path.push(";");
    new_path.push(std::env::var_os("PATH").unwrap_or_default());

    // --- 4. RUN AI ENGINE ---
    let (mut rx, _child) = app.shell()
        .command(shredder_path.to_string_lossy().as_ref())
        .args([&input_path, output_dir.to_string_lossy().as_ref()])
        .current_dir(&ffmpeg_bin_dir) // Force CWD for ffprobe visibility
        .env("PATH", new_path)
        .spawn().map_err(|e| {
        let _ = writeln!(log_file, "SPAWN ERROR: {}", e);
        e.to_string()
    })?;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let out = String::from_utf8_lossy(&line).trim().to_string();
                let _ = writeln!(log_file, "STDOUT: {}", out);
                emit_shred_status(&out, 70.0);
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let err = String::from_utf8_lossy(&line).trim().to_string();
                let _ = writeln!(log_file, "STDERR: {}", err);
                emit_shred_status(&format!("Log: {}", err), 70.0);
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                let _ = writeln!(log_file, "PROCESS FINISHED. Code: {:?}", payload.code);
            }
            _ => {}
        }
    }

    // --- 5. GATHER RESULTS ---
    let stem_files = vec!["vocals.mp3", "drums.mp3", "bass.mp3", "other.mp3", "guitar.mp3", "piano.mp3"];
    let mut found_paths = Vec::new();
    for stem in stem_files {
        let p = output_dir.join(stem);
        if p.exists() {
            found_paths.push(p.to_string_lossy().to_string());
        } else {
            let _ = writeln!(log_file, "FILE NOT FOUND: {}", stem);
        }
    }

    if found_paths.is_empty() {
        let _ = writeln!(log_file, "FAIL: Engine finished but directory is empty.");
        return Err("AI finished but no stems found. Check debug.log in song folder.".into());
    }

    // --- 6. PERSIST TO SQLITE ---
    let stems_json = serde_json::to_string(&found_paths).map_err(|e| e.to_string())?;
    {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO shreds (video_id, metadata, stems) VALUES (?1, ?2, ?3)",
            rusqlite::params![video_id, meta_json_str, stems_json]
        ).map_err(|e| e.to_string())?;
    }

    let _ = writeln!(log_file, "SUCCESS: Paths saved to DB.");
    emit_shred_status("Ready", 100.0);
    Ok(found_paths)
}
#[tauri::command]
async fn process_local_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcessingState>, // The managed HashMap
    path: String,
) -> Result<Vec<String>, String> {
    let input_p = std::path::Path::new(&path);

    // 1. Extract filename and extension
    let file_name = input_p.file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy()
        .to_string();

    let extension = input_p.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp3");

    // 2. Create a Unique ID (Matches your React tempId logic)
    let video_id = format!("local_{}", file_name.replace(|c: char| !c.is_alphanumeric(), "_"));

    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let output_dir = app_dir.join(&video_id);
    let target_source_file = output_dir.join(format!("source.{}", extension));

    // 3. Prepare Metadata for UI
    let meta_val = serde_json::json!({
        "title": file_name,
        "uploader": "Local File",
        "thumbnail": "local_asset",
        "duration": 0,
        "is_local": true,
        "original_extension": extension
    });

    // --- CRITICAL: REGISTER JOB START ---
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(video_id.clone(), meta_val.clone());
    }

    // 4. File Operations
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    if !target_source_file.exists() {
        std::fs::copy(&path, &target_source_file).map_err(|e| e.to_string())?;
    }

    let meta_json_str = serde_json::to_string_pretty(&meta_val).map_err(|e| e.to_string())?;
    std::fs::write(output_dir.join("meta.json"), &meta_json_str).map_err(|e| e.to_string())?;

    // 5. Run the AI Engine (Awaited)
    // Use a match or result capture so we can clean up the map even if this fails
    let engine_result = run_shredder_engine(
        &app,
        &target_source_file.to_string_lossy(),
        &output_dir,
        &video_id,
        &meta_val
    ).await;

    // --- CRITICAL: UNREGISTER JOB END ---
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.remove(&video_id);
    }

    // 6. Handle engine failure
    let stems = engine_result?;

    // 7. Finalize Database
    let db_path = app_dir.join("shredder.db");
    let stems_json = serde_json::to_string(&stems).map_err(|e| e.to_string())?;
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR REPLACE INTO shreds (video_id, metadata, stems) VALUES (?1, ?2, ?3)",
        rusqlite::params![video_id, meta_json_str, stems_json]
    ).map_err(|e| e.to_string())?;

    Ok(stems)
}

async fn run_shredder_engine(app: &tauri::AppHandle, input_path: &str, output_dir: &std::path::PathBuf, video_id: &str, meta_val: &serde_json::Value) -> Result<Vec<String>, String> {
    let emit_status = |status: &str, progress: f64| {
        let _ = app.emit("processing-shred", serde_json::json!({
            "video_id": video_id,
            "status": status,
            "progress": progress,
            "meta": meta_val,
            "is_local": true
        }));
    };

    let ffmpeg_bin_dir = app.path().resolve("binaries", tauri::path::BaseDirectory::Resource).map_err(|e| e.to_string())?;
    let shredder_path = ffmpeg_bin_dir.join("shredder");

    let mut new_path = ffmpeg_bin_dir.as_os_str().to_owned();
    #[cfg(target_os = "windows")] new_path.push(";");
    #[cfg(not(target_os = "windows"))] new_path.push(":");
    new_path.push(std::env::var_os("PATH").unwrap_or_default());

    let (mut rx, _) = app.shell()
        .command(shredder_path.to_string_lossy().as_ref())
        .args([input_path, output_dir.to_string_lossy().as_ref()])
        .env("PATH", new_path)
        .spawn().map_err(|e| e.to_string())?;

    while let Some(event) = rx.recv().await {
        if let tauri_plugin_shell::process::CommandEvent::Stdout(line) = event {
            emit_status(&String::from_utf8_lossy(&line).trim(), 70.0);
        }
    }

    let stem_files = vec!["vocals.mp3", "drums.mp3", "bass.mp3", "other.mp3", "guitar.mp3", "piano.mp3"];
    let mut found_paths = Vec::new();
    for stem in stem_files {
        let p = output_dir.join(stem);
        if p.exists() { found_paths.push(p.to_string_lossy().to_string()); }
    }

    if found_paths.is_empty() { return Err("AI finished but no stems found.".into()); }
    Ok(found_paths)
}

#[tauri::command]
async fn delete_shred(app: tauri::AppHandle, video_id: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("shredder.db");
    let target_dir = app_dir.join(&video_id);

    // 1. Remove files from disk
    if target_dir.exists() {
        std::fs::remove_dir_all(target_dir).map_err(|e| e.to_string())?;
    }

    // 2. Remove from Database
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM shreds WHERE video_id = ?1", params![video_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}
fn init_db(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    let db_path = app_dir.join("shredder.db");

    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS shreds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT UNIQUE,
            metadata TEXT,
            stems TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

use std::path::Path;
use serde_json::{json};
#[tauri::command]
fn check_file_exists(path: String) -> bool {
    // This is a fast, non-blocking check on the OS level
    Path::new(&path).exists()
}
#[tauri::command]
async fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}


#[derive(Clone, Serialize, Deserialize)]
struct ShredPayload {
    video_id: String,
    title: String,
}
use std::sync::Mutex;
use std::collections::HashMap;

pub struct ProcessingState(pub Mutex<HashMap<String, serde_json::Value>>);

#[tauri::command]
async fn get_active_shreds(state: tauri::State<'_, ProcessingState>) -> Result<HashMap<String, serde_json::Value>, String> {
    let map = state.0.lock().unwrap();
    Ok(map.clone())
}
#[tauri::command]
async fn open_shred_window(
    handle: tauri::AppHandle,
    video_id: String,
    title: String,
) {
    let safe_id = video_id.replace(|c: char| !c.is_alphanumeric(), "");
    let label = format!("shred-{}", safe_id);

    if let Some(window) = handle.get_webview_window(&label) {
        let _ = window.set_focus();
        return;
    }

    let window = tauri::WebviewWindowBuilder::new(
        &handle,
        &label,
        tauri::WebviewUrl::App("/view".into())
    )
        .title(format!("Stems: {}", title))
        .inner_size(800.0, 500.0)
        .min_inner_size(600.0, 400.0)
        .resizable(true)
        .build()
        .expect("Failed to build shred window");

    let payload = ShredPayload { video_id, title };

    // --- THE FIX ---
    // Clone the window handle so the closure can "own" its own copy
    let window_clone = window.clone();

    window.once("view-ready", move |_| {
        // Use the clone inside the move closure
        let _ = window_clone.emit("shred-data", payload);
    });
}


#[tauri::command]
async fn get_shred_history(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("shredder.db");

    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT video_id, metadata, stems FROM shreds ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let stem_types = vec!["vocals.mp3", "drums.mp3", "bass.mp3", "other.mp3", "guitar.mp3", "piano.mp3"];

    let rows = stmt.query_map([], |row| {
        let video_id: String = row.get::<_, String>(0)?;
        let meta_str: String = row.get::<_, String>(1)?;

        let mut meta: Value = serde_json::from_str(&meta_str).unwrap_or_default();
        let item_dir = app_dir.join(&video_id);

        // 1. SOURCE FILE CHECK
        let source_path = item_dir.join("source.mp3");
        let source_exists = source_path.exists();
        let source_size = fs::metadata(&source_path).map(|m| m.len()).unwrap_or(0);

        // Update the main metadata object with the source size
        if let Some(meta_obj) = meta.as_object_mut() {
            meta_obj.insert("filesize_approx".to_string(), json!(source_size));
        }

        // 2. STEMS DISK CHECK
        // We create a map of "filename": size_in_bytes
        let mut stems_disk_info = serde_json::Map::new();
        for fileName in &stem_types {
            let stem_path = item_dir.join(fileName);
            let size = fs::metadata(&stem_path).map(|m| m.len()).unwrap_or(0);
            stems_disk_info.insert(fileName.to_string(), json!(size));
        }

        Ok(json!({
            "video_id": video_id,
            "meta": meta,
            "stems_sizes": stems_disk_info, // New field for stem sizes
            "isSourceReady": source_exists
        }))
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }

    Ok(results)
}
use tauri_plugin_dialog::DialogExt;
use std::fs;

#[tauri::command]
async fn download_source_file(app: tauri::AppHandle, video_id: String, suggested_name: String, file_name: String) -> Result<(), String> {
    // 1. Resolve the path to your AppData/videoId/source.mp3
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let source_path = app_dir.join(&video_id).join(file_name);

    if !source_path.exists() {
        return Err(format!("File does not exist at: {:?}", source_path));
    }

    // 2. Open Native Save Dialog (blocking is fine in an async command)
    // The DialogExt trait makes this .dialog() method appear on 'app'
    let file_path = app.dialog()
        .file()
        .set_file_name(&format!("{}.mp3", suggested_name))
        .blocking_save_file();

    // 3. Handle the result
    match file_path {
        Some(path) => {
            // Converts the tauri_plugin_dialog::FilePath to a string path
            let dest = path.to_string();
            fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Ok(()), // User hit cancel
    }
}

use std::io::{Read}; // Added Write for zip.write_all
use zip::write::FileOptions;

#[tauri::command]
async fn download_all_stems(
    app: tauri::AppHandle,
    video_id: String,
    suggested_name: String
) -> Result<(), String> {
    // 1. Resolve paths
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let stem_dir = app_dir.join(&video_id);

    if !stem_dir.exists() {
        return Err("Stem directory not found".into());
    }

    // 2. Open Save Dialog for the ZIP
    let file_path = app.dialog()
        .file()
        .set_file_name(&format!("{}_stems.zip", suggested_name))
        .add_filter("Archive", &["zip"])
        .blocking_save_file();

    let dest_path = match file_path {
        Some(path) => path.to_string(),
        None => return Ok(()), // User cancelled
    };

    // 3. Create the Zip Archive
    let zip_file = fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(zip_file);

    // Explicitly typed FileOptions<()> to solve the E0283 "type annotations needed" error
    let options: FileOptions<()> = FileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    let entries = fs::read_dir(&stem_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_file() {
            let file_name = path.file_name().unwrap().to_str().unwrap();

            // Skip the master source file; keep the zip focused on the separated stems
            if file_name.starts_with("source") {
                continue;
            }

            let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut buffer = Vec::new();
            f.read_to_end(&mut buffer).map_err(|e| e.to_string())?;

            zip.start_file(file_name, options).map_err(|e| e.to_string())?;
            zip.write_all(&buffer).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

use sysinfo::{System, Components};

#[derive(Serialize)]
struct SystemStats {
    cpu_model: String,
    cpu_usage: f32,
    memory_used: u64,
    memory_total: u64,
    has_gpu: bool,
    os_name: String,
}

#[tauri::command]
fn get_system_stats() -> SystemStats {
    // In 0.30, methods are direct. refresh_all() is now on System.
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu_usage = sys.global_cpu_info().cpu_usage();

    let cpu_model = sys.cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let memory_used = sys.used_memory() / 1024 / 1024;
    let memory_total = sys.total_memory() / 1024 / 1024;

    // GPU Check: Components is now a separate struct in 0.30
    let components = Components::new_with_refreshed_list();
    let has_gpu = components.iter().any(|c| {
        let label = c.label().to_lowercase();
        label.contains("gpu") || label.contains("nvidia") || label.contains("amd") || label.contains("radeon") || label.contains("apple")
    });

    SystemStats {
        cpu_model,
        cpu_usage,
        memory_used,
        memory_total,
        has_gpu,
        os_name: System::name().unwrap_or_else(|| "OSX".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProcessingState(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            download_youtube_to_mp3,
            run_ai_separation,
            get_shred_history,
            delete_shred,
            check_file_exists,
            read_audio_file,
            download_source_file,
            open_shred_window,
            get_system_stats,
            process_local_file,
            get_active_shreds,
            download_all_stems
        ])
        .setup(|app| {
            let handle = app.handle();
            init_db(handle).map_err(|e| e.to_string())?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Track Separator")
                .inner_size(1100.0, 850.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}