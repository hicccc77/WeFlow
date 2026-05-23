use libloading::Library;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io::{self, BufRead, BufWriter, Write};
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type WcdbHandle = i64;
type WcdbCursor = i64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequestEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    session_ids: Vec<String>,
    output_dir: String,
    options: ExportOptions,
    account_dir: String,
    decrypt_key: String,
    my_wxid: String,
    resources_path: String,
    log_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriterRequestEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    output_dir: String,
    options: ExportOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriterInputEvent {
    #[serde(rename = "type")]
    event_type: String,
    session_id: Option<String>,
    display_name: Option<String>,
    session: Option<Value>,
    row: Option<WriterMessageRow>,
    sender_name: Option<String>,
    json_message: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriterMessageRow {
    local_id: i64,
    server_id: Option<i64>,
    server_id_raw: Option<String>,
    create_time: i64,
    local_type: i64,
    content: String,
    sender_username: String,
    is_send: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportOptions {
    format: String,
    content_type: Option<String>,
    date_range: Option<DateRange>,
    sender_username: Option<String>,
    file_name_suffix: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DateRange {
    start: Option<i64>,
    end: Option<i64>,
}

#[derive(Debug, Serialize)]
struct ExportResult {
    #[serde(rename = "type")]
    event_type: &'static str,
    success: bool,
    #[serde(rename = "successCount")]
    success_count: usize,
    #[serde(rename = "failCount")]
    fail_count: usize,
    #[serde(rename = "successSessionIds")]
    success_session_ids: Vec<String>,
    #[serde(rename = "failedSessionIds")]
    failed_session_ids: Vec<String>,
    #[serde(rename = "failedSessionErrors")]
    failed_session_errors: HashMap<String, String>,
    #[serde(rename = "sessionOutputPaths")]
    session_output_paths: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct ControlState {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

struct WcdbApi {
    _lib: Library,
    _deps: Vec<Library>,
    init_protection: unsafe extern "C" fn(*const c_char) -> c_int,
    init: unsafe extern "C" fn() -> c_int,
    shutdown: unsafe extern "C" fn() -> c_int,
    open_account: unsafe extern "C" fn(*const c_char, *const c_char, *mut WcdbHandle) -> c_int,
    close_account: unsafe extern "C" fn(WcdbHandle) -> c_int,
    set_my_wxid: Option<unsafe extern "C" fn(WcdbHandle, *const c_char) -> c_int>,
    free_string: unsafe extern "C" fn(*mut c_void),
    get_display_names: unsafe extern "C" fn(WcdbHandle, *const c_char, *mut *mut c_void) -> c_int,
    open_cursor: unsafe extern "C" fn(
        WcdbHandle,
        *const c_char,
        c_int,
        c_int,
        c_int,
        c_int,
        *mut WcdbCursor,
    ) -> c_int,
    open_cursor_lite: Option<
        unsafe extern "C" fn(
            WcdbHandle,
            *const c_char,
            c_int,
            c_int,
            c_int,
            c_int,
            *mut WcdbCursor,
        ) -> c_int,
    >,
    fetch_batch:
        unsafe extern "C" fn(WcdbHandle, WcdbCursor, *mut *mut c_void, *mut c_int) -> c_int,
    close_cursor: unsafe extern "C" fn(WcdbHandle, WcdbCursor) -> c_int,
}

#[derive(Clone)]
struct MessageRow {
    index: usize,
    local_id: i64,
    server_id: String,
    create_time: i64,
    local_type: i64,
    content: String,
    sender_username: String,
    is_send: bool,
}

fn main() {
    if let Err(error) = run() {
        emit_json(&json!({ "type": "error", "error": error.to_string() }));
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut first_line = String::new();
    io::stdin().read_line(&mut first_line)?;
    let first_value: Value = serde_json::from_str(first_line.trim())?;
    let event_type = first_value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if event_type == "writerRequest" {
        let request: WriterRequestEnvelope = serde_json::from_value(first_value)?;
        return run_writer_mode(request);
    }
    let request: ExportRequestEnvelope = serde_json::from_value(first_value)?;
    if request.event_type != "request" {
        return Err("first stdin line must be a request or writerRequest envelope".into());
    }
    validate_request(&request)?;
    if request.log_enabled.unwrap_or(false) {
        eprintln!(
            "[weflow-exporter] starting export for {} session(s)",
            request.session_ids.len()
        );
    }

    let control = Arc::new(ControlState {
        paused: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
    });
    spawn_control_reader(control.clone());

    let api = unsafe { WcdbApi::load(&request.resources_path)? };
    let session_db_path = resolve_session_db_path(&request.account_dir)?;
    let account_c = CString::new(session_db_path.to_string_lossy().as_bytes())?;
    let key_c = CString::new(request.decrypt_key.clone())?;
    unsafe {
        let protection_path = init_protection_with_candidates(&api, &request.resources_path)?;
        let init_code = (api.init)();
        if init_code != 0 && init_code != -1006 {
            return Err(format!(
                "wcdb_init failed with status {init_code} after InitProtection path={}",
                protection_path.display()
            )
            .into());
        }
        if request.log_enabled.unwrap_or(false) && init_code == -1006 {
            eprintln!(
                "[weflow-exporter] wcdb_init returned -1006 after InitProtection path={}, continuing to open account",
                protection_path.display()
            );
        }
    }

    let mut handle: WcdbHandle = 0;
    unsafe {
        status(
            (api.open_account)(account_c.as_ptr(), key_c.as_ptr(), &mut handle),
            "wcdb_open_account",
        )?;
        if let Some(set_my_wxid) = api.set_my_wxid {
            let my_wxid_c = CString::new(request.my_wxid.clone())?;
            let _ = set_my_wxid(handle, my_wxid_c.as_ptr());
        }
    }

    let result = export_sessions(&api, handle, &request, &control);

    unsafe {
        let _ = (api.close_account)(handle);
        let _ = (api.shutdown)();
    }

    emit_json(&result);
    Ok(())
}

struct ActiveWriterSession {
    session_id: String,
    display_name: String,
    output_path: String,
    json_temp_path: Option<String>,
    writer: Option<BufWriter<File>>,
    message_count: usize,
    first_time: Option<i64>,
    last_time: Option<i64>,
    session_payload: Option<Value>,
}

struct FinishedWriterSession {
    session_id: String,
    display_name: String,
    output_path: String,
    message_count: usize,
}

fn run_writer_mode(request: WriterRequestEnvelope) -> Result<(), Box<dyn std::error::Error>> {
    if request.event_type != "writerRequest" {
        return Err("first stdin line must be a writerRequest envelope".into());
    }
    validate_writer_request(&request)?;

    fs::create_dir_all(&request.output_dir)?;
    emit_json(&json!({ "type": "createdDir", "path": &request.output_dir }));

    let mut active: Option<ActiveWriterSession> = None;
    let mut success_session_ids = Vec::new();
    let failed_session_ids = Vec::new();
    let failed_session_errors: HashMap<String, String> = HashMap::new();
    let mut session_output_paths = HashMap::new();

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: WriterInputEvent = serde_json::from_str(&line)?;
        match event.event_type.as_str() {
            "beginSession" => {
                if active.is_some() {
                    return Err("writer session already active".into());
                }
                let session_id = event.session_id.unwrap_or_default();
                let display_name = event.display_name.unwrap_or_else(|| session_id.clone());
                let ext = extension_for_format(&request.options.format)?;
                let safe_name = sanitize_file_name(&display_name);
                let suffix = request.options.file_name_suffix.as_deref().unwrap_or("");
                let output_path =
                    unique_output_path(&request.output_dir, &format!("{safe_name}{suffix}"), ext);
                emit_json(&json!({ "type": "createdFile", "path": &output_path }));

                let json_temp_path = if request.options.format == "json" {
                    let temp_path = format!("{output_path}.messages.tmp");
                    emit_json(&json!({ "type": "createdFile", "path": &temp_path }));
                    Some(temp_path)
                } else {
                    None
                };
                let writer_path = json_temp_path.as_deref().unwrap_or(&output_path);
                let mut writer = BufWriter::new(File::create(writer_path)?);
                if request.options.format != "json" {
                    begin_writer(
                        &mut writer,
                        &request.options.format,
                        &session_id,
                        &display_name,
                    )?;
                }
                active = Some(ActiveWriterSession {
                    session_id,
                    display_name,
                    output_path,
                    json_temp_path,
                    writer: Some(writer),
                    message_count: 0,
                    first_time: None,
                    last_time: None,
                    session_payload: event.session,
                });
            }
            "message" => {
                let Some(active_session) = active.as_mut() else {
                    return Err("message received before beginSession".into());
                };
                let Some(input_row) = event.row else {
                    return Err("message.row is required".into());
                };
                let sender_name = event
                    .sender_name
                    .unwrap_or_else(|| input_row.sender_username.clone());
                let row = MessageRow {
                    index: active_session.message_count + 1,
                    local_id: input_row.local_id,
                    server_id: input_row
                        .server_id_raw
                        .unwrap_or_else(|| input_row.server_id.unwrap_or(0).to_string()),
                    create_time: input_row.create_time,
                    local_type: input_row.local_type,
                    content: input_row.content,
                    sender_username: input_row.sender_username,
                    is_send: input_row.is_send,
                };
                let writer = active_session
                    .writer
                    .as_mut()
                    .ok_or("writer session has no active file")?;
                write_message(
                    writer,
                    &request.options.format,
                    &row,
                    &sender_name,
                    event.json_message.as_ref(),
                )?;
                active_session.message_count += 1;
                observe_timestamp(
                    &mut active_session.first_time,
                    &mut active_session.last_time,
                    row.create_time,
                );
                if active_session.message_count % 1000 == 0 {
                    emit_progress(
                        0,
                        1,
                        &active_session.display_name,
                        &active_session.session_id,
                        "exporting",
                        active_session.message_count as i64,
                        0,
                        Some(active_session.message_count),
                    );
                }
            }
            "endSession" => {
                if let Some(active_session) = active.take() {
                    let finished =
                        finish_active_writer_session(active_session, &request.options.format)?;
                    emit_progress(
                        1,
                        1,
                        &finished.display_name,
                        &finished.session_id,
                        "complete",
                        100,
                        100,
                        Some(finished.message_count),
                    );
                    session_output_paths
                        .insert(finished.session_id.clone(), finished.output_path.clone());
                    success_session_ids.push(finished.session_id);
                }
            }
            "finish" => break,
            "cancel" => return Err("export cancelled".into()),
            other => return Err(format!("unknown writer event: {other}").into()),
        }
    }

    if let Some(active_session) = active.take() {
        let finished = finish_active_writer_session(active_session, &request.options.format)?;
        session_output_paths.insert(finished.session_id.clone(), finished.output_path.clone());
        success_session_ids.push(finished.session_id);
    }

    let success_count = success_session_ids.len();
    let fail_count = failed_session_ids.len();
    emit_json(&serde_json::to_value(ExportResult {
        event_type: "result",
        success: success_count > 0 || fail_count == 0,
        success_count,
        fail_count,
        success_session_ids,
        failed_session_ids,
        failed_session_errors,
        session_output_paths,
        error: None,
    })?);
    Ok(())
}

fn finish_active_writer_session(
    mut active_session: ActiveWriterSession,
    format: &str,
) -> Result<FinishedWriterSession, Box<dyn std::error::Error>> {
    let mut writer = active_session
        .writer
        .take()
        .ok_or("writer session has no active file")?;
    if format == "json" {
        writer.flush()?;
        drop(writer);
        write_final_detailed_json_output(&active_session)?;
        if let Some(temp_path) = active_session.json_temp_path.as_deref() {
            let _ = fs::remove_file(temp_path);
        }
    } else {
        end_writer(
            &mut writer,
            format,
            &active_session.session_id,
            &active_session.display_name,
            active_session.message_count,
            active_session.first_time,
            active_session.last_time,
            active_session.session_payload.as_ref(),
        )?;
        writer.flush()?;
    }

    Ok(FinishedWriterSession {
        session_id: active_session.session_id,
        display_name: active_session.display_name,
        output_path: active_session.output_path,
        message_count: active_session.message_count,
    })
}

fn write_final_detailed_json_output(
    active_session: &ActiveWriterSession,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut session = active_session.session_payload.clone().unwrap_or_else(|| {
        default_json_session(
            &active_session.session_id,
            &active_session.display_name,
            active_session.last_time,
            active_session.message_count,
        )
    });
    if let Some(object) = session.as_object_mut() {
        object.insert("lastTimestamp".to_string(), json!(active_session.last_time));
        object.insert(
            "messageCount".to_string(),
            json!(active_session.message_count),
        );
    }
    let weflow = json!({
        "version": "1.0.3",
        "exportedAt": current_unix_timestamp(),
        "generator": "WeFlow"
    });

    let mut writer = BufWriter::new(File::create(&active_session.output_path)?);
    writeln!(writer, "{{")?;
    writeln!(
        writer,
        "  \"weflow\": {},",
        pretty_json_at_indent(&weflow, 2)?
    )?;
    writeln!(
        writer,
        "  \"session\": {},",
        pretty_json_at_indent(&session, 2)?
    )?;
    writeln!(writer, "  \"messages\": [")?;
    if let Some(temp_path) = active_session.json_temp_path.as_deref() {
        let mut temp_file = File::open(temp_path)?;
        io::copy(&mut temp_file, &mut writer)?;
        if active_session.message_count > 0 {
            writeln!(writer)?;
        }
    }
    writeln!(writer, "  ]")?;
    writeln!(writer, "}}")?;
    writer.flush()?;
    Ok(())
}

unsafe fn init_protection_with_candidates(
    api: &WcdbApi,
    resources_path: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut best_failure: Option<(PathBuf, c_int)> = None;
    for resource_path in init_protection_candidate_paths(resources_path) {
        let Ok(resource_c) = CString::new(resource_path.to_string_lossy().as_bytes()) else {
            continue;
        };
        let code = (api.init_protection)(resource_c.as_ptr());
        if code == 0 {
            return Ok(resource_path);
        }
        if best_failure.as_ref().is_none_or(|(_, best_code)| {
            init_protection_failure_score(code) < init_protection_failure_score(*best_code)
        }) {
            best_failure = Some((resource_path, code));
        }
    }

    let (path, code) = best_failure.unwrap_or_else(|| (PathBuf::from(resources_path), -1));
    Err(format!(
        "InitProtection failed with status {code} path={}",
        path.display()
    )
    .into())
}

fn init_protection_candidate_paths(resources_path: &str) -> Vec<PathBuf> {
    let resources = Path::new(resources_path);
    let wcdb_dir = wcdb_api_path(resources_path)
        .parent()
        .map(Path::to_path_buf);
    let mut candidates = Vec::new();
    if let Some(dir) = wcdb_dir {
        candidates.push(dir.clone());
        if let Some(parent) = dir.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    candidates.push(resources.to_path_buf());
    if let Some(parent) = resources.parent() {
        candidates.push(parent.to_path_buf());
    }
    candidates.push(
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("resources"),
    );

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| {
            let key = path.to_string_lossy().to_lowercase();
            seen.insert(key)
        })
        .collect()
}

fn init_protection_failure_score(code: c_int) -> i32 {
    if (-2212..=-2201).contains(&code) {
        0
    } else if matches!(code, -102 | -101 | -1006) {
        1
    } else {
        2
    }
}

fn resolve_session_db_path(account_dir: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let db_storage = Path::new(account_dir).join("db_storage");
    if !db_storage.exists() {
        return Err(format!("db_storage not found under accountDir={account_dir}").into());
    }
    find_session_db(&db_storage, 0)
        .ok_or_else(|| format!("session.db not found under {}", db_storage.display()).into())
}

fn find_session_db(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 5 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name == "session.db" && path.is_file() {
            return Some(path);
        }
        if path.is_dir() {
            dirs.push(path);
        }
    }
    for path in dirs {
        if let Some(found) = find_session_db(&path, depth + 1) {
            return Some(found);
        }
    }
    None
}

unsafe impl Send for WcdbApi {}
unsafe impl Sync for WcdbApi {}

impl WcdbApi {
    unsafe fn load(resources_path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        configure_dll_search_path(resources_path);
        let lib_path = wcdb_api_path(resources_path);
        let deps = preload_wcdb_dependencies(resources_path)?;
        let lib = Library::new(&lib_path)
            .map_err(|error| format!("failed to load {}: {error}", lib_path.display()))?;

        let init_protection =
            *lib.get::<unsafe extern "C" fn(*const c_char) -> c_int>(b"InitProtection")?;
        let init = *lib.get::<unsafe extern "C" fn() -> c_int>(b"wcdb_init")?;
        let shutdown = *lib.get::<unsafe extern "C" fn() -> c_int>(b"wcdb_shutdown")?;
        let open_account = *lib.get::<unsafe extern "C" fn(
            *const c_char,
            *const c_char,
            *mut WcdbHandle,
        ) -> c_int>(b"wcdb_open_account")?;
        let close_account =
            *lib.get::<unsafe extern "C" fn(WcdbHandle) -> c_int>(b"wcdb_close_account")?;
        let free_string = *lib.get::<unsafe extern "C" fn(*mut c_void)>(b"wcdb_free_string")?;
        let get_display_names =
            *lib.get::<unsafe extern "C" fn(WcdbHandle, *const c_char, *mut *mut c_void) -> c_int>(
                b"wcdb_get_display_names",
            )?;
        let open_cursor = *lib.get::<unsafe extern "C" fn(
            WcdbHandle,
            *const c_char,
            c_int,
            c_int,
            c_int,
            c_int,
            *mut WcdbCursor,
        ) -> c_int>(b"wcdb_open_message_cursor")?;
        let fetch_batch = *lib.get::<unsafe extern "C" fn(
            WcdbHandle,
            WcdbCursor,
            *mut *mut c_void,
            *mut c_int,
        ) -> c_int>(b"wcdb_fetch_message_batch")?;
        let close_cursor = *lib.get::<unsafe extern "C" fn(WcdbHandle, WcdbCursor) -> c_int>(
            b"wcdb_close_message_cursor",
        )?;
        let set_my_wxid = optional_symbol::<unsafe extern "C" fn(WcdbHandle, *const c_char) -> c_int>(
            &lib,
            b"wcdb_set_my_wxid",
        );
        let open_cursor_lite = optional_symbol::<
            unsafe extern "C" fn(
                WcdbHandle,
                *const c_char,
                c_int,
                c_int,
                c_int,
                c_int,
                *mut WcdbCursor,
            ) -> c_int,
        >(&lib, b"wcdb_open_message_cursor_lite");

        Ok(Self {
            _lib: lib,
            _deps: deps,
            init_protection,
            init,
            shutdown,
            open_account,
            close_account,
            set_my_wxid,
            free_string,
            get_display_names,
            open_cursor,
            open_cursor_lite,
            fetch_batch,
            close_cursor,
        })
    }
}

fn preload_wcdb_dependencies(
    resources_path: &str,
) -> Result<Vec<Library>, Box<dyn std::error::Error>> {
    let mut deps = Vec::new();
    for dep_path in wcdb_dependency_paths(resources_path) {
        if !dep_path.exists() {
            continue;
        }
        unsafe {
            let lib = Library::new(&dep_path).map_err(|error| {
                format!("failed to load dependency {}: {error}", dep_path.display())
            })?;
            deps.push(lib);
        }
    }
    Ok(deps)
}

fn configure_dll_search_path(resources_path: &str) {
    #[cfg(target_os = "windows")]
    {
        let mut dirs = Vec::new();
        let resources = Path::new(resources_path);
        dirs.push(resources.join("runtime").join("win32"));
        dirs.push(
            resources
                .join("wcdb")
                .join("win32")
                .join(resource_arch_dir()),
        );
        if let Some(parent) = resources.parent() {
            dirs.push(parent.to_path_buf());
        }
        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts: Vec<PathBuf> = dirs.into_iter().filter(|dir| dir.exists()).collect();
        parts.extend(std::env::split_paths(&old_path));
        if let Ok(joined) = std::env::join_paths(parts) {
            std::env::set_var("PATH", joined);
        }
    }
}

fn wcdb_dependency_paths(resources_path: &str) -> Vec<PathBuf> {
    let base = Path::new(resources_path).join("wcdb");
    #[cfg(target_os = "windows")]
    {
        let runtime = Path::new(resources_path).join("runtime").join("win32");
        let dir = base.join("win32").join(resource_arch_dir());
        return vec![
            runtime.join("vcruntime140.dll"),
            runtime.join("vcruntime140_1.dll"),
            runtime.join("msvcp140.dll"),
            runtime.join("msvcp140_1.dll"),
            dir.join("WCDB.dll"),
            dir.join("SDL2.dll"),
        ];
    }
    #[cfg(target_os = "macos")]
    {
        return vec![base.join("macos").join("universal").join("libWCDB.dylib")];
    }
    #[cfg(target_os = "linux")]
    {
        Vec::new()
    }
}

unsafe fn optional_symbol<T: Copy>(lib: &Library, name: &[u8]) -> Option<T> {
    lib.get::<T>(name).ok().map(|symbol| *symbol)
}

fn export_sessions(
    api: &WcdbApi,
    handle: WcdbHandle,
    request: &ExportRequestEnvelope,
    control: &Arc<ControlState>,
) -> Value {
    let mut success_session_ids = Vec::new();
    let mut failed_session_ids = Vec::new();
    let mut failed_session_errors = HashMap::new();
    let mut session_output_paths = HashMap::new();

    let display_names = get_display_names(api, handle, &request.session_ids).unwrap_or_default();

    for (session_index, session_id) in request.session_ids.iter().enumerate() {
        if control.cancelled.load(Ordering::Relaxed) {
            break;
        }
        let display_name = display_names
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| session_id.clone());
        emit_progress(
            session_index,
            request.session_ids.len(),
            &display_name,
            session_id,
            "preparing",
            0,
            100,
            None,
        );

        match export_one_session(api, handle, request, session_id, &display_name, control) {
            Ok(output_path) => {
                success_session_ids.push(session_id.clone());
                session_output_paths.insert(session_id.clone(), output_path);
            }
            Err(error) => {
                failed_session_ids.push(session_id.clone());
                failed_session_errors.insert(session_id.clone(), error.to_string());
            }
        }
    }

    let fail_count = failed_session_ids.len();
    let success_count = success_session_ids.len();
    let result = ExportResult {
        event_type: "result",
        success: success_count > 0 || fail_count == 0,
        success_count,
        fail_count,
        success_session_ids,
        failed_session_ids,
        failed_session_errors,
        session_output_paths,
        error: if success_count == 0 && fail_count > 0 {
            Some("all sessions failed".to_string())
        } else {
            None
        },
    };
    serde_json::to_value(result).unwrap_or_else(|error| {
        json!({
            "type": "result",
            "success": false,
            "successCount": 0,
            "failCount": 0,
            "error": error.to_string()
        })
    })
}

fn export_one_session(
    api: &WcdbApi,
    handle: WcdbHandle,
    request: &ExportRequestEnvelope,
    session_id: &str,
    display_name: &str,
    control: &Arc<ControlState>,
) -> Result<String, Box<dyn std::error::Error>> {
    wait_if_paused(control)?;
    let ext = match request.options.format.as_str() {
        "txt" => "txt",
        "html" => "html",
        "weclone" => "csv",
        "chatlab-jsonl" => "jsonl",
        "json" => "json",
        other => return Err(format!("unsupported Rust export format: {other}").into()),
    };
    let safe_name = sanitize_file_name(display_name);
    fs::create_dir_all(&request.output_dir)?;
    emit_json(&json!({ "type": "createdDir", "path": &request.output_dir }));
    let suffix = request.options.file_name_suffix.as_deref().unwrap_or("");
    let output_path = unique_output_path(&request.output_dir, &format!("{safe_name}{suffix}"), ext);
    emit_json(&json!({ "type": "createdFile", "path": &output_path }));

    let mut writer = BufWriter::new(File::create(&output_path)?);
    let mut sender_cache: HashMap<String, String> = HashMap::new();
    let begin = request
        .options
        .date_range
        .as_ref()
        .and_then(|r| r.start)
        .unwrap_or(0) as c_int;
    let end = request
        .options
        .date_range
        .as_ref()
        .and_then(|r| r.end)
        .unwrap_or(0) as c_int;
    let sender_filter = request
        .options
        .sender_username
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();

    begin_writer(
        &mut writer,
        &request.options.format,
        session_id,
        display_name,
    )?;

    let session_c = CString::new(session_id)?;
    let mut cursor: WcdbCursor = 0;
    unsafe {
        let opener = api.open_cursor_lite.unwrap_or(api.open_cursor);
        status(
            opener(handle, session_c.as_ptr(), 2000, 1, begin, end, &mut cursor),
            "wcdb_open_message_cursor",
        )?;
    }

    let mut row_index = 0usize;
    let mut exported = 0usize;
    let mut first_time: Option<i64> = None;
    let mut last_time: Option<i64> = None;
    let mut has_more = true;
    while has_more {
        wait_if_paused(control)?;
        let mut out_json: *mut c_void = std::ptr::null_mut();
        let mut out_has_more: c_int = 0;
        unsafe {
            status(
                (api.fetch_batch)(handle, cursor, &mut out_json, &mut out_has_more),
                "wcdb_fetch_message_batch",
            )?;
        }
        let batch_text = unsafe { take_wcdb_string(api, out_json) };
        let rows: Vec<Value> = serde_json::from_str(&batch_text).unwrap_or_default();
        has_more = out_has_more == 1;

        for value in rows {
            wait_if_paused(control)?;
            let mut row = normalize_row(&value, &request.my_wxid, session_id);
            if !sender_filter.is_empty() && row.sender_username != sender_filter {
                continue;
            }
            row_index += 1;
            row.index = row_index;
            let sender_name = resolve_sender_name(
                api,
                handle,
                &row,
                session_id,
                display_name,
                &request.my_wxid,
                &mut sender_cache,
            );
            write_message(
                &mut writer,
                &request.options.format,
                &row,
                &sender_name,
                None,
            )?;
            observe_timestamp(&mut first_time, &mut last_time, row.create_time);
            exported += 1;
            if exported % 1000 == 0 {
                emit_progress(
                    0,
                    request.session_ids.len(),
                    display_name,
                    session_id,
                    "exporting",
                    exported as i64,
                    0,
                    Some(exported),
                );
            }
        }
    }

    unsafe {
        let _ = (api.close_cursor)(handle, cursor);
    }
    end_writer(
        &mut writer,
        &request.options.format,
        session_id,
        display_name,
        exported,
        first_time,
        last_time,
        None,
    )?;
    writer.flush()?;
    emit_progress(
        1,
        1,
        display_name,
        session_id,
        "complete",
        100,
        100,
        Some(exported),
    );
    Ok(output_path)
}

fn begin_writer<W: Write>(
    writer: &mut W,
    format: &str,
    session_id: &str,
    display_name: &str,
) -> io::Result<()> {
    match format {
        "html" => write!(
            writer,
            "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><title>{}</title></head><body><h1>{}</h1><div class=\"messages\">\n",
            escape_html(display_name),
            escape_html(display_name)
        ),
        "weclone" => writer.write_all("\u{FEFF}id,MsgSvrID,type_name,is_sender,talker,msg,src,CreateTime\r\n".as_bytes()),
        "chatlab-jsonl" => {
            writeln!(writer, "{}", json!({ "_type": "chatlab", "version": "1.0", "generator": "WeFlow Rust Exporter" }))?;
            writeln!(writer, "{}", json!({ "_type": "meta", "name": display_name, "platform": "wechat", "type": if session_id.contains("@chatroom") { "group" } else { "private" } }))
        }
        "json" => write!(
            writer,
            "{{\n  \"weflow\": {},\n  \"messages\": [\n",
            json!({
                "version": "1.0.3",
                "exportedAt": current_unix_timestamp(),
                "generator": "WeFlow"
            })
        ),
        _ => Ok(()),
    }
}

fn write_message<W: Write>(
    writer: &mut W,
    format: &str,
    row: &MessageRow,
    sender_name: &str,
    json_message: Option<&Value>,
) -> io::Result<()> {
    let platform_message_id = if row.server_id.is_empty() {
        row.local_id.to_string()
    } else {
        row.server_id.clone()
    };
    match format {
        "txt" => writeln!(
            writer,
            "{} '{}'\n{}\n",
            format_timestamp(row.create_time),
            sender_name,
            row.content
        ),
        "html" => writeln!(
            writer,
            "<div class=\"message {}\"><time>{}</time><b>{}</b><p>{}</p></div>",
            if row.is_send { "sent" } else { "received" },
            escape_html(&format_timestamp(row.create_time)),
            escape_html(sender_name),
            escape_html(&row.content).replace('\n', "<br>")
        ),
        "weclone" => {
            let cells = [
                row.index.to_string(),
                platform_message_id.clone(),
                type_name(row.local_type).to_string(),
                if row.is_send {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
                sender_name.to_string(),
                row.content.clone(),
                String::new(),
                format_iso_timestamp(row.create_time),
            ];
            writeln!(
                writer,
                "{}",
                cells
                    .iter()
                    .map(|v| escape_csv(v))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        "chatlab-jsonl" => writeln!(
            writer,
            "{}",
            json!({
                "_type": "message",
                "sender": row.sender_username,
                "accountName": sender_name,
                "timestamp": row.create_time,
                "type": chatlab_type(row.local_type),
                "content": row.content,
                "platformMessageId": platform_message_id,
            })
        ),
        "json" => {
            if row.index > 1 {
                writer.write_all(b",\n")?;
            }
            let message = json_message
                .cloned()
                .unwrap_or_else(|| detailed_json_message(row, sender_name, &platform_message_id));
            write!(writer, "{}", indented_pretty_json(&message, 4)?)
        }
        _ => Ok(()),
    }
}

fn end_writer<W: Write>(
    writer: &mut W,
    format: &str,
    session_id: &str,
    display_name: &str,
    message_count: usize,
    _first_time: Option<i64>,
    last_time: Option<i64>,
    session_payload: Option<&Value>,
) -> io::Result<()> {
    match format {
        "html" => writer.write_all(b"</div></body></html>\n")?,
        "json" => {
            let mut session = session_payload.cloned().unwrap_or_else(|| {
                default_json_session(session_id, display_name, last_time, message_count)
            });
            if let Some(object) = session.as_object_mut() {
                object.insert("lastTimestamp".to_string(), json!(last_time));
                object.insert("messageCount".to_string(), json!(message_count));
            }
            write!(writer, "\n  ],\n  \"session\": {}\n}}\n", session)?;
        }
        _ => {}
    }
    Ok(())
}

fn default_json_session(
    session_id: &str,
    display_name: &str,
    last_time: Option<i64>,
    message_count: usize,
) -> Value {
    json!({
        "wxid": session_id,
        "nickname": display_name,
        "remark": "",
        "displayName": display_name,
        "type": if session_id.contains("@chatroom") { "群聊" } else { "私聊" },
        "lastTimestamp": last_time,
        "messageCount": message_count,
    })
}

fn detailed_json_message(row: &MessageRow, sender_name: &str, platform_message_id: &str) -> Value {
    let mut message = json!({
        "localId": row.index,
        "createTime": row.create_time,
        "formattedTime": format_timestamp(row.create_time),
        "type": message_type_name(row.local_type),
        "localType": row.local_type,
        "content": row.content,
        "isSend": if row.is_send { 1 } else { 0 },
        "senderUsername": row.sender_username,
        "senderDisplayName": sender_name,
        "source": "",
        "senderAvatarKey": row.sender_username,
    });
    if !platform_message_id.is_empty() && platform_message_id != "0" {
        message["platformMessageId"] = json!(platform_message_id);
    }
    message
}

fn pretty_json_at_indent(value: &Value, indent: usize) -> io::Result<String> {
    let text = serde_json::to_string_pretty(value).map_err(json_to_io_error)?;
    Ok(text.replace('\n', &format!("\n{}", " ".repeat(indent))))
}

fn indented_pretty_json(value: &Value, indent: usize) -> io::Result<String> {
    let prefix = " ".repeat(indent);
    let text = serde_json::to_string_pretty(value).map_err(json_to_io_error)?;
    Ok(text
        .lines()
        .map(|line| format!("{prefix}{line}"))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn json_to_io_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn observe_timestamp(first_time: &mut Option<i64>, last_time: &mut Option<i64>, timestamp: i64) {
    if timestamp <= 0 {
        return;
    }
    if first_time.map_or(true, |value| timestamp < value) {
        *first_time = Some(timestamp);
    }
    if last_time.map_or(true, |value| timestamp > value) {
        *last_time = Some(timestamp);
    }
}

fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn normalize_row(value: &Value, my_wxid: &str, session_id: &str) -> MessageRow {
    let local_type = int_field(
        value,
        &["local_type", "localType", "type", "msg_type", "msgType"],
    )
    .unwrap_or(1);
    let create_time = int_field(
        value,
        &["create_time", "createTime", "timestamp", "msgCreateTime"],
    )
    .unwrap_or(0);
    let local_id = int_field(value, &["local_id", "localId", "id"]).unwrap_or(0);
    let server_id =
        string_field(value, &["server_id", "serverId", "svr_id", "svrId"]).unwrap_or_default();
    let raw_sender =
        string_field(value, &["sender_username", "senderUsername"]).unwrap_or_default();
    let is_send = int_field(value, &["computed_is_send", "is_send", "isSend"]).unwrap_or(0) == 1;
    let sender_username = if is_send {
        my_wxid.to_string()
    } else if raw_sender.is_empty() {
        session_id.to_string()
    } else {
        raw_sender
    };
    let content = decode_message_content(
        string_field(
            value,
            &["message_content", "messageContent", "content", "text"],
        )
        .as_deref(),
        string_field(value, &["compress_content", "compressContent"]).as_deref(),
    );
    MessageRow {
        index: 0,
        local_id,
        server_id,
        create_time,
        local_type,
        content,
        sender_username,
        is_send,
    }
}

fn resolve_sender_name(
    api: &WcdbApi,
    handle: WcdbHandle,
    row: &MessageRow,
    session_id: &str,
    display_name: &str,
    my_wxid: &str,
    cache: &mut HashMap<String, String>,
) -> String {
    if row.is_send {
        return "我".to_string();
    }
    if !session_id.contains("@chatroom") {
        return display_name.to_string();
    }
    if let Some(name) = cache.get(&row.sender_username) {
        return name.clone();
    }
    let names = get_display_names(api, handle, &[row.sender_username.clone()]).unwrap_or_default();
    let name = names
        .get(&row.sender_username)
        .cloned()
        .unwrap_or_else(|| row.sender_username.clone());
    cache.insert(row.sender_username.clone(), name.clone());
    if name.is_empty() {
        my_wxid.to_string()
    } else {
        name
    }
}

fn get_display_names(
    api: &WcdbApi,
    handle: WcdbHandle,
    usernames: &[String],
) -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
    if usernames.is_empty() {
        return Ok(HashMap::new());
    }
    let unique: Vec<String> = usernames
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let payload = CString::new(serde_json::to_string(&unique)?)?;
    let mut out_json: *mut c_void = std::ptr::null_mut();
    unsafe {
        status(
            (api.get_display_names)(handle, payload.as_ptr(), &mut out_json),
            "wcdb_get_display_names",
        )?;
        let text = take_wcdb_string(api, out_json);
        let value: Value = serde_json::from_str(&text)?;
        if let Some(map) = value.get("map").and_then(Value::as_object) {
            return Ok(map
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or(k).to_string()))
                .collect());
        }
        if let Some(map) = value.as_object() {
            return Ok(map
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or(k).to_string()))
                .collect());
        }
    }
    Ok(HashMap::new())
}

unsafe fn take_wcdb_string(api: &WcdbApi, ptr: *mut c_void) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let text = CStr::from_ptr(ptr as *const c_char)
        .to_string_lossy()
        .into_owned();
    (api.free_string)(ptr);
    text
}

fn wcdb_api_path(resources_path: &str) -> PathBuf {
    let base = Path::new(resources_path).join("wcdb");
    #[cfg(target_os = "windows")]
    {
        base.join("win32")
            .join(resource_arch_dir())
            .join("wcdb_api.dll")
    }
    #[cfg(target_os = "macos")]
    {
        base.join("macos")
            .join("universal")
            .join("libwcdb_api.dylib")
    }
    #[cfg(target_os = "linux")]
    {
        base.join("linux")
            .join(resource_arch_dir())
            .join("libwcdb_api.so")
    }
}

fn resource_arch_dir() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn validate_request(request: &ExportRequestEnvelope) -> Result<(), Box<dyn std::error::Error>> {
    let supported = matches!(
        request.options.format.as_str(),
        "txt" | "html" | "weclone" | "chatlab-jsonl" | "json"
    );
    if !supported {
        return Err(format!("unsupported Rust export format: {}", request.options.format).into());
    }
    if request
        .options
        .content_type
        .as_deref()
        .is_some_and(|v| v != "text")
    {
        return Err("Rust exporter only supports text content exports".into());
    }
    if request.session_ids.is_empty() {
        return Err("sessionIds is required".into());
    }
    if request.account_dir.trim().is_empty() || request.decrypt_key.trim().is_empty() {
        return Err("accountDir and decryptKey are required".into());
    }
    Ok(())
}

fn validate_writer_request(
    request: &WriterRequestEnvelope,
) -> Result<(), Box<dyn std::error::Error>> {
    let supported = matches!(
        request.options.format.as_str(),
        "txt" | "html" | "weclone" | "chatlab-jsonl" | "json"
    );
    if !supported {
        return Err(format!("unsupported Rust writer format: {}", request.options.format).into());
    }
    if request
        .options
        .content_type
        .as_deref()
        .is_some_and(|v| v != "text")
    {
        return Err("Rust writer only supports text content exports".into());
    }
    if request.output_dir.trim().is_empty() {
        return Err("outputDir is required".into());
    }
    Ok(())
}

fn extension_for_format(format: &str) -> Result<&'static str, Box<dyn std::error::Error>> {
    match format {
        "txt" => Ok("txt"),
        "html" => Ok("html"),
        "weclone" => Ok("csv"),
        "chatlab-jsonl" => Ok("jsonl"),
        "json" => Ok("json"),
        other => Err(format!("unsupported Rust writer format: {other}").into()),
    }
}

fn spawn_control_reader(control: Arc<ControlState>) {
    thread::spawn(move || {
        for line in io::stdin().lock().lines().flatten() {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str).unwrap_or("") {
                "pause" => control.paused.store(true, Ordering::Relaxed),
                "resume" => control.paused.store(false, Ordering::Relaxed),
                "cancel" => {
                    control.paused.store(false, Ordering::Relaxed);
                    control.cancelled.store(true, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }
    });
}

fn wait_if_paused(control: &Arc<ControlState>) -> Result<(), Box<dyn std::error::Error>> {
    while control.paused.load(Ordering::Relaxed) {
        if control.cancelled.load(Ordering::Relaxed) {
            return Err("export cancelled".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    if control.cancelled.load(Ordering::Relaxed) {
        return Err("export cancelled".into());
    }
    Ok(())
}

fn emit_progress(
    current: usize,
    total: usize,
    current_session: &str,
    current_session_id: &str,
    phase: &str,
    phase_progress: i64,
    phase_total: i64,
    exported: Option<usize>,
) {
    let mut data = json!({
        "current": current,
        "total": total,
        "currentSession": current_session,
        "currentSessionId": current_session_id,
        "phase": phase,
        "phaseProgress": phase_progress,
        "phaseTotal": phase_total,
    });
    if let Some(count) = exported {
        data["exportedMessages"] = json!(count);
    }
    emit_json(&json!({ "type": "progress", "data": data }));
}

fn emit_json(value: &Value) {
    let _ = writeln!(io::stdout(), "{}", value);
    let _ = io::stdout().flush();
}

fn status(code: c_int, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("{name} failed with status {code}").into())
    }
}

fn int_field(value: &Value, names: &[&str]) -> Option<i64> {
    for name in names {
        let Some(field) = value.get(*name) else {
            continue;
        };
        if let Some(n) = field.as_i64() {
            return Some(n);
        }
        if let Some(s) = field.as_str().and_then(|s| s.parse::<i64>().ok()) {
            return Some(s);
        }
    }
    None
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    for name in names {
        let Some(field) = value.get(*name) else {
            continue;
        };
        if let Some(s) = field.as_str() {
            return Some(s.to_string());
        }
        if field.is_number() {
            return Some(field.to_string());
        }
    }
    None
}

fn sanitize_file_name(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

fn unique_output_path(output_dir: &str, base_name: &str, ext: &str) -> String {
    let mut path = Path::new(output_dir).join(format!("{base_name}.{ext}"));
    let mut index = 1usize;
    while path.exists() {
        path = Path::new(output_dir).join(format!("{base_name} ({index}).{ext}"));
        index += 1;
    }
    path.to_string_lossy().into_owned()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_csv(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn format_timestamp(timestamp: i64) -> String {
    timestamp.to_string()
}

fn format_iso_timestamp(timestamp: i64) -> String {
    timestamp.to_string()
}

fn type_name(local_type: i64) -> &'static str {
    match local_type {
        1 => "文本",
        3 => "图片",
        34 => "语音",
        43 => "视频",
        47 => "表情",
        48 => "位置",
        10000 => "系统",
        _ => "其他",
    }
}

fn message_type_name(local_type: i64) -> &'static str {
    match local_type {
        1 => "文本消息",
        3 => "图片消息",
        34 => "语音消息",
        42 => "名片消息",
        43 => "视频消息",
        47 => "动画表情",
        48 => "位置消息",
        49 => "链接消息",
        50 => "通话消息",
        10000 => "系统消息",
        244813135921 => "引用消息",
        _ => "其他消息",
    }
}

fn chatlab_type(local_type: i64) -> i64 {
    match local_type {
        1 => 0,
        3 => 1,
        34 => 2,
        43 => 3,
        47 => 5,
        48 => 8,
        10000 => 80,
        _ => 99,
    }
}

fn decode_message_content(message_content: Option<&str>, compress_content: Option<&str>) -> String {
    let compressed = decode_maybe_encoded(compress_content.unwrap_or(""));
    if !compressed.is_empty() {
        return compressed;
    }
    decode_maybe_encoded(message_content.unwrap_or(""))
}

fn decode_maybe_encoded(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().all(|ch| ch.is_ascii_digit()) {
        return value.to_string();
    }
    if value.len() > 16 && looks_like_hex(value) {
        if let Some(bytes) = decode_hex(value) {
            return decode_binary_content(&bytes);
        }
    }
    if value.len() > 16 && looks_like_base64(value) {
        use base64::Engine;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(value) {
            return decode_binary_content(&bytes);
        }
    }
    value.to_string()
}

fn decode_binary_content(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if bytes.len() >= 4 && bytes[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
        if let Ok(decoded) = zstd::stream::decode_all(bytes) {
            return String::from_utf8_lossy(&decoded).into_owned();
        }
    }
    String::from_utf8_lossy(bytes).replace('\u{FFFD}', "")
}

fn looks_like_hex(value: &str) -> bool {
    value.len() % 2 == 0 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let chars: Vec<u8> = value.bytes().collect();
    for chunk in chars.chunks(2) {
        let high = hex_value(chunk[0])?;
        let low = hex_value(chunk[1])?;
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn looks_like_base64(value: &str) -> bool {
    value.len() % 4 == 0
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_file_name("a<b>c:d"), "a_b_c_d");
        assert_eq!(sanitize_file_name("..."), "session");
    }

    #[test]
    fn reads_fields_without_stopping_on_missing_aliases() {
        let value = json!({
            "localType": 1,
            "senderUsername": "wxid_a"
        });
        assert_eq!(int_field(&value, &["local_type", "localType"]), Some(1));
        assert_eq!(
            string_field(&value, &["sender_username", "senderUsername"]),
            Some("wxid_a".to_string())
        );
    }

    #[test]
    fn maps_resource_arch_names() {
        if std::env::consts::ARCH == "x86_64" {
            assert_eq!(resource_arch_dir(), "x64");
        }
    }

    #[test]
    fn escapes_csv_cells() {
        assert_eq!(escape_csv("plain"), "plain");
        assert_eq!(escape_csv("a,b"), "\"a,b\"");
        assert_eq!(escape_csv("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn resolves_session_db_from_account_dir() {
        let root = std::env::temp_dir().join(format!("weflow-rust-account-{}", std::process::id()));
        let session_dir = root.join("db_storage").join("session");
        fs::create_dir_all(&session_dir).unwrap();
        let session_db = session_dir.join("session.db");
        File::create(&session_db).unwrap();

        let resolved = resolve_session_db_path(&root.to_string_lossy()).unwrap();
        let _ = fs::remove_dir_all(&root);
        assert_eq!(resolved, session_db);
    }

    #[test]
    fn decodes_plain_hex_base64_and_zstd_content() {
        assert_eq!(
            decode_message_content(Some("plain text"), None),
            "plain text"
        );
        assert_eq!(
            decode_message_content(Some("68656c6c6f2068657821"), None),
            "hello hex!"
        );
        assert_eq!(
            decode_message_content(Some("aGVsbG8gYmFzZTY0IQ=="), None),
            "hello base64!"
        );

        let encoded = zstd::stream::encode_all("hello zstd!".as_bytes(), 0).unwrap();
        let hex = encoded
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            decode_message_content(Some("fallback"), Some(&hex)),
            "hello zstd!"
        );
    }

    #[test]
    fn writes_550k_mock_txt_rows_without_collecting() {
        let total = 550_000usize;
        let path = std::env::temp_dir().join(format!(
            "weflow-rust-stream-{}-{}.txt",
            std::process::id(),
            total
        ));
        let file = File::create(&path).unwrap();
        let mut writer = BufWriter::new(file);

        for i in 1..=total {
            let row = MessageRow {
                index: i,
                local_id: i as i64,
                server_id: i.to_string(),
                create_time: 1_700_000_000 + i as i64,
                local_type: 1,
                content: format!("message {i}"),
                sender_username: if i % 2 == 0 {
                    "me".to_string()
                } else {
                    "friend".to_string()
                },
                is_send: i % 2 == 0,
            };
            write_message(
                &mut writer,
                "txt",
                &row,
                if row.is_send { "我" } else { "friend" },
                None,
            )
            .unwrap();
        }
        writer.flush().unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert!(metadata.len() > 10 * 1024 * 1024);
    }

    #[test]
    fn writes_valid_detailed_json_stream() {
        let mut writer = Vec::new();
        begin_writer(&mut writer, "json", "room@chatroom", "测试群").unwrap();
        let first = MessageRow {
            index: 1,
            local_id: 101,
            server_id: "9001".to_string(),
            create_time: 1_779_500_001,
            local_type: 1,
            content: "hello".to_string(),
            sender_username: "wxid_a".to_string(),
            is_send: false,
        };
        let second = MessageRow {
            index: 2,
            local_id: 102,
            server_id: "9002".to_string(),
            create_time: 1_779_500_002,
            local_type: 10000,
            content: "system".to_string(),
            sender_username: "room@chatroom".to_string(),
            is_send: false,
        };
        write_message(&mut writer, "json", &first, "Alice", None).unwrap();
        write_message(&mut writer, "json", &second, "系统", None).unwrap();
        end_writer(
            &mut writer,
            "json",
            "room@chatroom",
            "测试群",
            2,
            Some(first.create_time),
            Some(second.create_time),
            None,
        )
        .unwrap();

        let value: Value = serde_json::from_slice(&writer).unwrap();
        assert_eq!(value["weflow"]["generator"], "WeFlow");
        assert_eq!(value["session"]["wxid"], "room@chatroom");
        assert_eq!(value["session"]["type"], "群聊");
        assert_eq!(value["session"]["messageCount"], 2);
        assert_eq!(value["session"]["lastTimestamp"], second.create_time);
        assert_eq!(value["messages"].as_array().unwrap().len(), 2);
        assert_eq!(value["messages"][0]["senderDisplayName"], "Alice");
        assert_eq!(value["messages"][0]["platformMessageId"], "9001");
        assert_eq!(value["messages"][1]["type"], "系统消息");
    }

    #[test]
    fn detailed_json_uses_supplied_ts_payload() {
        let mut writer = Vec::new();
        begin_writer(&mut writer, "json", "room@chatroom", "测试群").unwrap();
        let row = MessageRow {
            index: 1,
            local_id: 101,
            server_id: "9001".to_string(),
            create_time: 1_779_500_001,
            local_type: 1,
            content: "raw".to_string(),
            sender_username: "wxid_a".to_string(),
            is_send: false,
        };
        let message = json!({
            "localId": 1,
            "createTime": 1_779_500_001,
            "formattedTime": "2026-05-23 12:13:21",
            "type": "文本消息",
            "localType": 1,
            "content": "TS parsed",
            "isSend": 0,
            "senderUsername": "wxid_a",
            "senderDisplayName": "Alice",
            "source": "",
            "senderAvatarKey": "wxid_a",
            "platformMessageId": "9001"
        });
        let session = json!({
            "wxid": "room@chatroom",
            "nickname": "测试群昵称",
            "remark": "",
            "displayName": "测试群昵称",
            "type": "群聊",
            "lastTimestamp": null,
            "messageCount": 0
        });
        write_message(&mut writer, "json", &row, "fallback", Some(&message)).unwrap();
        end_writer(
            &mut writer,
            "json",
            "room@chatroom",
            "测试群",
            1,
            Some(row.create_time),
            Some(row.create_time),
            Some(&session),
        )
        .unwrap();

        let value: Value = serde_json::from_slice(&writer).unwrap();
        assert_eq!(value["session"]["nickname"], "测试群昵称");
        assert_eq!(value["session"]["messageCount"], 1);
        assert_eq!(value["messages"][0]["formattedTime"], "2026-05-23 12:13:21");
        assert_eq!(value["messages"][0]["content"], "TS parsed");
        assert_eq!(value["messages"][0]["senderDisplayName"], "Alice");
    }
}
