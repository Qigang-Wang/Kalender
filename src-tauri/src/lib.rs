use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex, thread, time::Duration};

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, SC_MINIMIZE, SWP_NOMOVE,
        SWP_NOSIZE, WINDOWPOS, WM_SYSCOMMAND, WM_WINDOWPOSCHANGING, WNDPROC,
    },
};

#[cfg(target_os = "windows")]
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
    RegKey,
};

use chrono::{Days, Local, TimeZone, Utc};
use notify_rust::Notification;
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager, Monitor, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use url::Url;

const TRAY_ID: &str = "kalender-tray";
const STATE_FILE: &str = "desktop-reminders.json";
const REMINDER_CHECK_INTERVAL: Duration = Duration::from_secs(10);
const SERVER_CONNECTION_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const SERVER_CONNECTION_TIMEOUT: Duration = Duration::from_secs(3);
const DESKTOP_WINDOW_GUARD_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_SERVER_URL: &str = "http://localhost:3000/";
const MAX_SERVER_URL_LENGTH: usize = 2_048;

#[cfg(target_os = "windows")]
static NATIVE_DESKTOP_GUARD_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
static ORIGINAL_MAIN_WNDPROCS: Mutex<Option<HashMap<isize, isize>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    enabled: bool,
    reminder_minutes_before: i64,
    all_day_reminder_hour: u32,
    launch_at_login: bool,
    minimize_to_tray: bool,
    show_event_title: bool,
    missed_reminder_window_minutes: i64,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            reminder_minutes_before: 10,
            all_day_reminder_hour: 9,
            launch_at_login: true,
            minimize_to_tray: true,
            show_event_title: true,
            missed_reminder_window_minutes: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderInput {
    id: String,
    title: String,
    start_at: i64,
    remind_at: i64,
    all_day: bool,
    route: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderItem {
    #[serde(flatten)]
    reminder: ReminderInput,
    delivered_at: Option<i64>,
}

impl ReminderItem {
    fn key(&self) -> String {
        reminder_key(&self.reminder)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSummary {
    today_count: usize,
    next_title: Option<String>,
    next_start_at: Option<i64>,
    synced_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopMonitorPreference {
    name: Option<String>,
    position_x: i32,
    position_y: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    #[serde(default)]
    settings: DesktopSettings,
    #[serde(default)]
    reminders: Vec<ReminderItem>,
    pause_until: Option<i64>,
    #[serde(default)]
    summary: DesktopSummary,
    #[serde(default)]
    last_sync_attempt_at: Option<i64>,
    #[serde(default)]
    last_sync_error: Option<String>,
    #[serde(default)]
    desktop_mode: bool,
    #[serde(default)]
    desktop_monitor: Option<DesktopMonitorPreference>,
    #[serde(default)]
    autostart_default_migrated: bool,
    server_url: Option<String>,
    #[serde(skip)]
    server_connected: Option<bool>,
}

struct DesktopRuntime {
    state: Mutex<PersistedState>,
    state_path: PathBuf,
    server_status_item: Mutex<Option<IconMenuItem<tauri::Wry>>>,
    desktop_monitor_items: Mutex<Vec<CheckMenuItem<tauri::Wry>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderSyncPayload {
    settings: DesktopSettings,
    reminders: Vec<ReminderInput>,
    summary: DesktopSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    available: bool,
    pause_until: Option<i64>,
    queued_reminder_count: usize,
    last_synced_at: Option<i64>,
    last_sync_attempt_at: Option<i64>,
    last_sync_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerConfig {
    url: String,
    is_default: bool,
    connected: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ServerHealthResponse {
    ok: bool,
    status: String,
}

#[tauri::command]
fn desktop_status(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<DesktopStatus, String> {
    ensure_main_caller(&window, &runtime)?;
    let state = runtime
        .state
        .lock()
        .map_err(|_| "桌面提醒状态暂时不可用".to_string())?;
    update_tray_tooltip(&app, &state);
    Ok(status_from_state(&state))
}

#[tauri::command]
fn update_desktop_settings(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
    settings: DesktopSettings,
) -> Result<DesktopStatus, String> {
    ensure_main_caller(&window, &runtime)?;
    validate_settings(&settings)?;
    apply_autostart_setting(&app, settings.launch_at_login)?;

    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "桌面提醒状态暂时不可用".to_string())?;
    state.settings = settings;
    state.autostart_default_migrated = true;
    save_state(&runtime.state_path, &state)?;
    update_tray_tooltip(&app, &state);
    Ok(status_from_state(&state))
}

#[tauri::command]
fn sync_reminders(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
    payload: ReminderSyncPayload,
) -> Result<DesktopStatus, String> {
    ensure_main_caller(&window, &runtime)?;
    validate_settings(&payload.settings)?;
    apply_autostart_setting(&app, payload.settings.launch_at_login)?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "桌面提醒状态暂时不可用".to_string())?;
    state.last_sync_attempt_at = Some(Utc::now().timestamp_millis());
    state.last_sync_error = None;
    let delivered = state
        .reminders
        .iter()
        .filter_map(|item| item.delivered_at.map(|timestamp| (item.key(), timestamp)))
        .collect::<HashMap<_, _>>();
    state.settings = payload.settings;
    state.autostart_default_migrated = true;
    state.summary = payload.summary;
    state.reminders = payload
        .reminders
        .into_iter()
        .map(|reminder| {
            let delivered_at = delivered.get(&reminder_key(&reminder)).copied();
            ReminderItem {
                reminder,
                delivered_at,
            }
        })
        .collect();
    state.reminders.sort_by_key(|item| item.reminder.remind_at);
    save_state(&runtime.state_path, &state)?;
    update_tray_tooltip(&app, &state);
    Ok(status_from_state(&state))
}

#[tauri::command]
fn report_sync_error(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
    message: String,
) -> Result<DesktopStatus, String> {
    ensure_main_caller(&window, &runtime)?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "桌面提醒状态暂时不可用".to_string())?;
    state.last_sync_attempt_at = Some(Utc::now().timestamp_millis());
    state.last_sync_error = Some(normalize_sync_error(&message));
    save_state(&runtime.state_path, &state)?;
    update_tray_tooltip(&app, &state);
    Ok(status_from_state(&state))
}

#[tauri::command]
fn get_server_config(
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<ServerConfig, String> {
    ensure_config_caller(&window)?;
    let state = runtime
        .state
        .lock()
        .map_err(|_| "服务器配置暂时不可用".to_string())?;
    Ok(server_config_from_state(&state))
}

#[tauri::command]
async fn save_server_config(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
    input: String,
) -> Result<ServerConfig, String> {
    ensure_config_caller(&window)?;
    let normalized = normalize_server_url(&input)?;
    let health_target = normalized.clone();
    let connected =
        tauri::async_runtime::spawn_blocking(move || probe_server_health(&health_target))
            .await
            .map_err(|error| format!("无法完成服务器健康检查：{error}"))?;
    let config = {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "服务器配置暂时不可用".to_string())?;
        state.server_url = Some(normalized.clone());
        state.reminders.clear();
        state.summary = DesktopSummary::default();
        state.last_sync_attempt_at = None;
        state.last_sync_error = None;
        state.server_connected = Some(connected);
        save_state(&runtime.state_path, &state)?;
        update_tray_tooltip(&app, &state);
        update_server_connection_menu(&app, Some(connected));
        server_config_from_state(&state)
    };

    if connected {
        let target = Url::parse(&normalized).map_err(|_| "保存后的服务器地址无效".to_string())?;
        if let Some(main) = app.get_webview_window("main") {
            main.navigate(target)
                .map_err(|error| format!("无法打开服务器地址：{error}"))?;
            show_main_window_unchecked(&app);
        } else {
            create_main_window(&app, &normalized, true)?;
        }
    } else {
        hide_main_window(&app);
    }
    Ok(config)
}

#[tauri::command]
async fn close_server_config(window: WebviewWindow) -> Result<(), String> {
    ensure_config_caller(&window)?;
    window
        .close()
        .map_err(|error| format!("无法关闭服务器配置窗口：{error}"))
}

#[tauri::command]
fn desktop_window_is_maximized(
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<bool, String> {
    ensure_main_caller(&window, &runtime)?;
    window
        .is_maximized()
        .map_err(|error| format!("无法读取窗口状态：{error}"))
}

#[tauri::command]
fn desktop_window_minimize(
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<(), String> {
    ensure_main_caller(&window, &runtime)?;
    ensure_windowed_mode(&runtime)?;
    window
        .minimize()
        .map_err(|error| format!("无法最小化窗口：{error}"))
}

#[tauri::command]
fn desktop_window_toggle_maximized(
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<bool, String> {
    ensure_main_caller(&window, &runtime)?;
    ensure_windowed_mode(&runtime)?;
    if window
        .is_maximized()
        .map_err(|error| format!("无法读取窗口状态：{error}"))?
    {
        window
            .unmaximize()
            .map_err(|error| format!("无法还原窗口：{error}"))?;
        Ok(false)
    } else {
        window
            .maximize()
            .map_err(|error| format!("无法最大化窗口：{error}"))?;
        Ok(true)
    }
}

#[tauri::command]
fn desktop_window_start_dragging(
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<(), String> {
    ensure_main_caller(&window, &runtime)?;
    ensure_windowed_mode(&runtime)?;
    window
        .start_dragging()
        .map_err(|error| format!("无法拖动窗口：{error}"))
}

#[tauri::command]
fn desktop_window_close(
    window: WebviewWindow,
    runtime: State<'_, DesktopRuntime>,
) -> Result<(), String> {
    ensure_main_caller(&window, &runtime)?;
    window
        .close()
        .map_err(|error| format!("无法关闭窗口：{error}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            request_main_window(app, None);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            update_desktop_settings,
            sync_reminders,
            report_sync_error,
            get_server_config,
            save_server_config,
            close_server_config,
            desktop_window_is_maximized,
            desktop_window_minimize,
            desktop_window_toggle_maximized,
            desktop_window_start_dragging,
            desktop_window_close
        ])
        .setup(|app| {
            let state_path = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法确定桌面数据目录：{error}"))?
                .join(STATE_FILE);
            let mut persisted = load_state(&state_path);
            if migrate_autostart_default(&mut persisted) {
                if let Err(error) = save_state(&state_path, &persisted) {
                    eprintln!("{error}");
                }
            }
            let server_url = configured_server_url(&persisted).to_string();
            let connected = probe_server_health(&server_url);
            persisted.server_connected = Some(connected);
            if let Err(error) =
                apply_autostart_setting(app.handle(), persisted.settings.launch_at_login)
            {
                eprintln!("{error}");
            }
            app.manage(DesktopRuntime {
                state: Mutex::new(persisted),
                state_path,
                server_status_item: Mutex::new(None),
                desktop_monitor_items: Mutex::new(Vec::new()),
            });
            build_tray(app)?;
            update_server_connection_menu(app.handle(), Some(connected));
            if connected {
                create_main_window(app.handle(), &server_url, true)?;
            } else {
                show_server_unavailable_notification(app.handle());
            }
            start_reminder_scheduler(app.handle().clone());
            start_server_connection_monitor(app.handle().clone());
            start_desktop_window_guard(app.handle().clone());
            if let Ok(state) = app.state::<DesktopRuntime>().state.lock() {
                update_tray_tooltip(app.handle(), &state);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let minimize = window
                        .app_handle()
                        .state::<DesktopRuntime>()
                        .state
                        .lock()
                        .map(|state| state.settings.minimize_to_tray)
                        .unwrap_or(true);
                    if minimize {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        window.app_handle().exit(0);
                    }
                }
                WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. } => {
                    let desktop_mode = window
                        .app_handle()
                        .state::<DesktopRuntime>()
                        .state
                        .lock()
                        .map(|state| state.desktop_mode)
                        .unwrap_or(false);
                    if desktop_mode {
                        if let Some(main) = window.app_handle().get_webview_window("main") {
                            let _ = fit_desktop_window(&main);
                        }
                    }
                }
                WindowEvent::Focused(false) => {
                    let desktop_mode = window
                        .app_handle()
                        .state::<DesktopRuntime>()
                        .state
                        .lock()
                        .map(|state| state.desktop_mode)
                        .unwrap_or(false);
                    if desktop_mode {
                        if let Some(main) = window.app_handle().get_webview_window("main") {
                            let _ = return_desktop_window_to_background(&main);
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Kalender desktop client");
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Kalender", true, None::<&str>)?;
    let (desktop_mode_enabled, selected_monitor) = app
        .state::<DesktopRuntime>()
        .state
        .lock()
        .map(|state| (state.desktop_mode, state.desktop_monitor.clone()))
        .unwrap_or((false, None));
    let desktop_menu = Submenu::with_id(app, "desktop-menu", "桌面模式", true)?;
    let monitors = app.available_monitors().unwrap_or_default();
    let mut desktop_monitor_items = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let preference = monitor_preference(monitor);
        let selected = desktop_mode_enabled
            && selected_monitor
                .as_ref()
                .is_some_and(|current| current == &preference);
        let item = CheckMenuItem::with_id(
            app,
            format!("desktop-monitor-{index}"),
            monitor_menu_label(index, monitor),
            true,
            selected,
            None::<&str>,
        )?;
        desktop_menu.append(&item)?;
        desktop_monitor_items.push(item);
    }
    if desktop_monitor_items.is_empty() {
        let unavailable = MenuItem::with_id(
            app,
            "desktop-monitor-unavailable",
            "没有检测到显示器",
            false,
            None::<&str>,
        )?;
        desktop_menu.append(&unavailable)?;
    }
    let desktop_separator = PredefinedMenuItem::separator(app)?;
    let leave_desktop =
        MenuItem::with_id(app, "desktop-mode-off", "退出桌面模式", true, None::<&str>)?;
    desktop_menu.append(&desktop_separator)?;
    desktop_menu.append(&leave_desktop)?;
    let pause_30 = MenuItem::with_id(app, "pause-30", "暂停 30 分钟", true, None::<&str>)?;
    let pause_120 = MenuItem::with_id(app, "pause-120", "暂停 2 小时", true, None::<&str>)?;
    let pause_today = MenuItem::with_id(app, "pause-today", "今天不再提醒", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "恢复提醒", true, None::<&str>)?;
    let pause_menu = Submenu::with_items(
        app,
        "暂停提醒",
        true,
        &[&pause_30, &pause_120, &pause_today, &resume],
    )?;
    let sync = MenuItem::with_id(app, "sync", "同步", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let server_status = IconMenuItem::with_id(
        app,
        "server-status",
        server_connection_label(None),
        true,
        Some(server_connection_icon(None)),
        None::<&str>,
    )?;
    let server_config = MenuItem::with_id(app, "server-config", "服务器地址…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &desktop_menu,
            &pause_menu,
            &sync,
            &settings,
            &server_status,
            &server_config,
            &separator,
            &quit,
        ],
    )?;

    if let Ok(mut item) = app.state::<DesktopRuntime>().server_status_item.lock() {
        *item = Some(server_status);
    }
    if let Ok(mut items) = app.state::<DesktopRuntime>().desktop_monitor_items.lock() {
        *items = desktop_monitor_items;
    }

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .expect("application icon is required")
                .clone(),
        )
        .tooltip("Kalender\n正在同步今日日程")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(index) = id
                .strip_prefix("desktop-monitor-")
                .and_then(|value| value.parse::<usize>().ok())
            {
                select_desktop_monitor(app, index);
                return;
            }
            match id {
                "open" => show_main_window_from_tray(app),
                "desktop-mode-off" => leave_desktop_mode(app),
                "pause-30" => set_pause(app, Some(Utc::now().timestamp_millis() + 30 * 60_000)),
                "pause-120" => set_pause(app, Some(Utc::now().timestamp_millis() + 120 * 60_000)),
                "pause-today" => set_pause(app, end_of_local_day()),
                "resume" => set_pause(app, None),
                "sync" => dispatch_web_event(app, "kalender:desktop-sync-requested"),
                "settings" => open_route(app, "/settings?tab=desktop"),
                "server-status" => open_server_config(app),
                "server-config" => open_server_config(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window_from_tray(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn apply_autostart_setting(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let autostart = app.autolaunch();

    #[cfg(target_os = "windows")]
    if enabled {
        // Refresh this on every launch so upgrades and reinstalls cannot leave
        // the registry entry pointing at an old executable. The plugin writes
        // an unquoted command, so replace it with a Windows-safe quoted path.
        autostart
            .enable()
            .map_err(|error| format!("无法启用开机启动：{error}"))?;
        return write_windows_autostart_command(app);
    }

    let current = autostart
        .is_enabled()
        .map_err(|error| format!("无法读取开机启动状态：{error}"))?;
    if current == enabled {
        return Ok(());
    }
    if enabled {
        autostart
            .enable()
            .map_err(|error| format!("无法启用开机启动：{error}"))
    } else {
        autostart
            .disable()
            .map_err(|error| format!("无法关闭开机启动：{error}"))
    }
}

#[cfg(target_os = "windows")]
fn write_windows_autostart_command(app: &AppHandle) -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法确定 Kalender 程序路径：{error}"))?;
    let command = format!("\"{}\"", executable.display());
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run = current_user
        .open_subkey_with_flags(
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_SET_VALUE,
        )
        .map_err(|error| format!("无法打开 Windows 启动项：{error}"))?;
    run.set_value(&app.package_info().name, &command)
        .map_err(|error| format!("无法写入 Windows 启动项：{error}"))
}

fn migrate_autostart_default(state: &mut PersistedState) -> bool {
    if state.autostart_default_migrated {
        return false;
    }
    state.settings.launch_at_login = true;
    state.autostart_default_migrated = true;
    true
}

fn ensure_windowed_mode(runtime: &State<'_, DesktopRuntime>) -> Result<(), String> {
    let desktop_mode = runtime
        .state
        .lock()
        .map_err(|_| "桌面窗口状态暂时不可用".to_string())?
        .desktop_mode;
    if desktop_mode {
        Err("桌面模式下窗口位置和大小已锁定".to_string())
    } else {
        Ok(())
    }
}

fn open_windowed_mode(app: &AppHandle, route: Option<&str>) {
    if let Err(error) = set_desktop_mode(app, false) {
        show_desktop_mode_error(&error);
        return;
    }
    request_main_window(app, route);
}

fn show_main_window_from_tray(app: &AppHandle) {
    let desktop_mode = app
        .state::<DesktopRuntime>()
        .state
        .lock()
        .map(|state| state.desktop_mode)
        .unwrap_or(false);
    if !desktop_mode {
        request_main_window(app, None);
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        request_main_window(app, None);
        return;
    };
    if let Err(error) = show_desktop_window_in_front(&window) {
        show_desktop_mode_error(&error);
    }
}

fn show_desktop_window_in_front(window: &WebviewWindow) -> Result<(), String> {
    if window
        .is_minimized()
        .map_err(|error| format!("无法读取 Kalender 桌面窗口状态：{error}"))?
    {
        window
            .unminimize()
            .map_err(|error| format!("无法恢复 Kalender 桌面窗口：{error}"))?;
    }
    window
        .show()
        .map_err(|error| format!("无法显示 Kalender 桌面窗口：{error}"))?;
    fit_desktop_window(window)?;
    window
        .set_always_on_bottom(false)
        .map_err(|error| format!("无法提升 Kalender 桌面窗口：{error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("无法将 Kalender 放到最前：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦 Kalender 桌面窗口：{error}"))
}

fn return_desktop_window_to_background(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_always_on_top(false)
        .map_err(|error| format!("无法恢复 Kalender 桌面窗口层级：{error}"))?;
    window
        .set_always_on_bottom(true)
        .map_err(|error| format!("无法将 Kalender 放回桌面层：{error}"))?;
    fit_desktop_window(window)
}

fn leave_desktop_mode(app: &AppHandle) {
    if let Err(error) = set_desktop_mode(app, false) {
        show_desktop_mode_error(&error);
    }
}

fn select_desktop_monitor(app: &AppHandle, index: usize) {
    let monitor = match app
        .available_monitors()
        .ok()
        .and_then(|monitors| monitors.into_iter().nth(index))
    {
        Some(monitor) => monitor,
        None => {
            show_desktop_mode_error("所选显示器已经不可用，请重新打开托盘菜单");
            return;
        }
    };
    let preference = monitor_preference(&monitor);
    let runtime = app.state::<DesktopRuntime>();
    let previous = match runtime.state.lock() {
        Ok(state) => state.desktop_monitor.clone(),
        Err(_) => {
            show_desktop_mode_error("桌面窗口状态暂时不可用");
            return;
        }
    };
    let persist_result = runtime
        .state
        .lock()
        .map_err(|_| "桌面窗口状态暂时不可用".to_string())
        .and_then(|mut state| {
            state.desktop_monitor = Some(preference);
            save_state(&runtime.state_path, &state)
        });
    if let Err(error) = persist_result {
        show_desktop_mode_error(&error);
        return;
    }

    if let Err(error) = set_desktop_mode(app, true) {
        if let Ok(mut state) = runtime.state.lock() {
            state.desktop_monitor = previous;
            let _ = save_state(&runtime.state_path, &state);
        }
        update_desktop_mode_menu(app, false);
        show_desktop_mode_error(&error);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = apply_window_mode(&window, true) {
            show_desktop_mode_error(&error);
        }
    }
    update_desktop_mode_menu(app, true);
}

fn set_desktop_mode(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let runtime = app.state::<DesktopRuntime>();
    let previous = runtime
        .state
        .lock()
        .map_err(|_| "桌面窗口状态暂时不可用".to_string())?
        .desktop_mode;
    let window = app.get_webview_window("main");

    if previous != enabled {
        if let Some(window) = window.as_ref() {
            if let Err(error) = apply_window_mode(window, enabled) {
                update_desktop_mode_menu(app, previous);
                return Err(error);
            }
        }
        let persist_result = runtime
            .state
            .lock()
            .map_err(|_| "桌面窗口状态暂时不可用".to_string())
            .and_then(|mut state| {
                state.desktop_mode = enabled;
                save_state(&runtime.state_path, &state)
            });
        if let Err(error) = persist_result {
            if let Some(window) = window.as_ref() {
                let _ = apply_window_mode(window, previous);
            }
            update_desktop_mode_menu(app, previous);
            return Err(error);
        }
    }
    update_desktop_mode_menu(app, enabled);

    if let Some(window) = window {
        window
            .unminimize()
            .map_err(|error| format!("无法恢复 Kalender 窗口：{error}"))?;
        window
            .show()
            .map_err(|error| format!("无法显示 Kalender 窗口：{error}"))?;
        if !enabled {
            window
                .set_focus()
                .map_err(|error| format!("无法聚焦 Kalender 窗口：{error}"))?;
        }
    } else if enabled {
        request_main_window(app, None);
    }
    Ok(())
}

fn update_desktop_mode_menu(app: &AppHandle, enabled: bool) {
    let (selected_monitor, items) = {
        let runtime = app.state::<DesktopRuntime>();
        let selected = runtime
            .state
            .lock()
            .ok()
            .and_then(|state| state.desktop_monitor.clone());
        let items = runtime
            .desktop_monitor_items
            .lock()
            .map(|items| items.clone())
            .unwrap_or_default();
        (selected, items)
    };
    let monitors = app.available_monitors().unwrap_or_default();
    for (index, item) in items.iter().enumerate() {
        let checked = enabled
            && monitors.get(index).is_some_and(|monitor| {
                selected_monitor
                    .as_ref()
                    .is_some_and(|selected| selected == &monitor_preference(monitor))
            });
        let _ = item.set_checked(checked);
    }
}

fn monitor_preference(monitor: &Monitor) -> DesktopMonitorPreference {
    DesktopMonitorPreference {
        name: monitor.name().cloned(),
        position_x: monitor.position().x,
        position_y: monitor.position().y,
    }
}

fn monitor_menu_label(index: usize, monitor: &Monitor) -> String {
    let name = monitor
        .name()
        .map(String::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("未命名显示器");
    let area = monitor.work_area();
    format!(
        "显示器 {} · {} · {}×{}",
        index + 1,
        name,
        area.size.width,
        area.size.height
    )
}

fn selected_monitor(window: &WebviewWindow) -> Result<Monitor, String> {
    let preference = window
        .state::<DesktopRuntime>()
        .state
        .lock()
        .map_err(|_| "桌面窗口状态暂时不可用".to_string())?
        .desktop_monitor
        .clone();
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("无法读取显示器列表：{error}"))?;
    if let Some(preference) = preference {
        if let Some(monitor) = monitors
            .iter()
            .find(|monitor| monitor_preference(monitor) == preference)
        {
            return Ok(monitor.clone());
        }
        if let Some(name) = preference.name.as_ref() {
            if let Some(monitor) = monitors
                .iter()
                .find(|monitor| monitor.name().is_some_and(|current| current == name))
            {
                return Ok(monitor.clone());
            }
        }
    }
    window
        .current_monitor()
        .map_err(|error| format!("无法读取当前显示器：{error}"))?
        .or(window
            .primary_monitor()
            .map_err(|error| format!("无法读取主显示器：{error}"))?)
        .ok_or_else(|| "没有找到可用显示器".to_string())
}

#[cfg(target_os = "windows")]
fn original_main_wndproc(hwnd: HWND) -> Option<WNDPROC> {
    ORIGINAL_MAIN_WNDPROCS
        .lock()
        .ok()
        .and_then(|procedures| {
            procedures
                .as_ref()
                .and_then(|items| items.get(&(hwnd.0 as isize)).copied())
        })
        .map(|pointer| unsafe { std::mem::transmute(pointer) })
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn native_desktop_wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if NATIVE_DESKTOP_GUARD_ACTIVE.load(Ordering::Acquire) {
        if message == WM_SYSCOMMAND && (wparam.0 as u32 & 0xfff0) == SC_MINIMIZE {
            return LRESULT(0);
        }
        if message == WM_WINDOWPOSCHANGING {
            let position = lparam.0 as *mut WINDOWPOS;
            if let Some(position) = position.as_mut() {
                // Explorer implements "Show desktop" by moving top-level windows to this
                // hidden coordinate instead of sending an ordinary minimize request.
                if position.x <= -30_000 || position.y <= -30_000 {
                    position.flags |= SWP_NOMOVE | SWP_NOSIZE;
                }
            }
        }
    }

    if let Some(original) = original_main_wndproc(hwnd) {
        CallWindowProcW(original, hwnd, message, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
}

#[cfg(target_os = "windows")]
fn install_native_desktop_guard(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("无法读取 Kalender 原生窗口：{error}"))?;
    let mut procedures = ORIGINAL_MAIN_WNDPROCS
        .lock()
        .map_err(|_| "Windows 桌面窗口保护状态暂时不可用".to_string())?;
    let items = procedures.get_or_insert_with(HashMap::new);
    if items.contains_key(&(hwnd.0 as isize)) {
        return Ok(());
    }
    let original = unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            native_desktop_wndproc as *const () as isize,
        )
    };
    if original == 0 {
        return Err("无法安装 Windows 桌面窗口保护".to_string());
    }
    items.insert(hwnd.0 as isize, original);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_native_desktop_guard(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_native_desktop_guard_active(enabled: bool) {
    NATIVE_DESKTOP_GUARD_ACTIVE.store(enabled, Ordering::Release);
}

#[cfg(not(target_os = "windows"))]
fn set_native_desktop_guard_active(_enabled: bool) {}

fn apply_window_mode(window: &WebviewWindow, desktop_mode: bool) -> Result<(), String> {
    if !desktop_mode {
        set_native_desktop_guard_active(false);
    }
    window
        .set_fullscreen(false)
        .map_err(|error| format!("无法退出全屏状态：{error}"))?;
    window
        .unmaximize()
        .map_err(|error| format!("无法还原窗口：{error}"))?;
    window
        .set_always_on_top(false)
        .map_err(|error| format!("无法更新窗口层级：{error}"))?;
    window
        .set_always_on_bottom(desktop_mode)
        .map_err(|error| format!("无法更新桌面窗口层级：{error}"))?;
    window
        .set_skip_taskbar(desktop_mode)
        .map_err(|error| format!("无法更新任务栏显示状态：{error}"))?;
    window
        .set_decorations(!desktop_mode)
        .map_err(|error| format!("无法更新窗口边框：{error}"))?;
    window
        .set_resizable(!desktop_mode)
        .map_err(|error| format!("无法更新窗口缩放状态：{error}"))?;
    window
        .set_minimizable(!desktop_mode)
        .map_err(|error| format!("无法更新窗口最小化状态：{error}"))?;

    if desktop_mode {
        window
            .set_min_size(None::<LogicalSize<f64>>)
            .map_err(|error| format!("无法清除桌面窗口最小尺寸：{error}"))?;
        fit_desktop_window(window)?;
        set_native_desktop_guard_active(true);
    } else {
        window
            .set_min_size(Some(LogicalSize::new(980.0, 640.0)))
            .map_err(|error| format!("无法恢复窗口最小尺寸：{error}"))?;
        window
            .set_size(LogicalSize::new(1360.0, 860.0))
            .map_err(|error| format!("无法恢复窗口尺寸：{error}"))?;
        window
            .center()
            .map_err(|error| format!("无法居中 Kalender 窗口：{error}"))?;
    }
    Ok(())
}

fn fit_desktop_window(window: &WebviewWindow) -> Result<(), String> {
    let monitor = selected_monitor(window)?;
    let work_area = monitor.work_area();
    let current_position = window
        .outer_position()
        .map_err(|error| format!("无法读取桌面窗口位置：{error}"))?;
    if current_position != work_area.position {
        window
            .set_position(work_area.position)
            .map_err(|error| format!("无法定位桌面窗口：{error}"))?;
    }
    let current_size = window
        .inner_size()
        .map_err(|error| format!("无法读取桌面窗口尺寸：{error}"))?;
    if current_size != work_area.size {
        window
            .set_size(work_area.size)
            .map_err(|error| format!("无法适配桌面工作区：{error}"))?;
    }
    Ok(())
}

fn show_desktop_mode_error(message: &str) {
    let _ = Notification::new()
        .appname("Kalender")
        .summary("无法切换桌面模式")
        .body(message)
        .show();
}

fn start_reminder_scheduler(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(REMINDER_CHECK_INTERVAL);
        let runtime = app.state::<DesktopRuntime>();
        let now = Utc::now().timestamp_millis();
        let mut due = Vec::new();
        let mut changed = false;
        if let Ok(mut state) = runtime.state.lock() {
            if state.pause_until.is_some_and(|until| until <= now) {
                state.pause_until = None;
                changed = true;
            }
            let paused = state.pause_until.is_some_and(|until| until > now);
            if state.settings.enabled && !paused {
                let missed_window = state.settings.missed_reminder_window_minutes * 60_000;
                let show_event_title = state.settings.show_event_title;
                for item in &mut state.reminders {
                    if item.delivered_at.is_some() || item.reminder.remind_at > now {
                        continue;
                    }
                    let is_recent_enough =
                        missed_window > 0 && now - item.reminder.remind_at <= missed_window;
                    let is_on_time = now - item.reminder.remind_at
                        <= REMINDER_CHECK_INTERVAL.as_millis() as i64 * 2;
                    item.delivered_at = Some(now);
                    changed = true;
                    if is_on_time || is_recent_enough {
                        due.push((item.reminder.clone(), show_event_title));
                    }
                }
            }
            if changed {
                let _ = save_state(&runtime.state_path, &state);
                update_tray_tooltip(&app, &state);
            }
        }
        for (reminder, show_title) in due {
            show_notification(app.clone(), reminder, show_title);
        }
    });
}

fn start_server_connection_monitor(app: AppHandle) {
    thread::spawn(move || loop {
        check_server_connection(&app);
        thread::sleep(SERVER_CONNECTION_CHECK_INTERVAL);
    });
}

fn start_desktop_window_guard(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(DESKTOP_WINDOW_GUARD_INTERVAL);
        let desktop_mode = app
            .state::<DesktopRuntime>()
            .state
            .lock()
            .map(|state| state.desktop_mode)
            .unwrap_or(false);
        if !desktop_mode {
            continue;
        }
        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        let mut restored = false;
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
            restored = true;
        }
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
            restored = true;
        }
        if restored {
            let _ = fit_desktop_window(&window);
        }
    });
}

fn check_server_connection(app: &AppHandle) {
    let runtime = app.state::<DesktopRuntime>();
    let server_url = match runtime
        .state
        .lock()
        .map(|state| configured_server_url(&state).to_string())
    {
        Ok(url) => url,
        Err(_) => return,
    };
    let connected = probe_server_health(&server_url);
    let previous = runtime
        .state
        .lock()
        .map(|mut state| {
            if configured_server_url(&state) != server_url {
                return None;
            }
            let previous = state.server_connected;
            state.server_connected = Some(connected);
            Some(previous)
        })
        .ok()
        .flatten();
    let Some(previous) = previous else {
        return;
    };
    update_server_connection_menu(app, Some(connected));
    if connected {
        if app.get_webview_window("main").is_none() {
            let _ = create_main_window(app, &server_url, false);
        } else if previous == Some(false) {
            if let Some(main) = app.get_webview_window("main") {
                if let Ok(target) = Url::parse(&server_url) {
                    let _ = main.navigate(target);
                }
            }
        }
        if previous == Some(false) {
            show_server_recovered_notification();
        }
    } else if previous == Some(true) {
        hide_main_window(app);
        show_server_unavailable_notification(app);
    }
}

fn probe_server_health(server_url: &str) -> bool {
    let Ok(health_url) = server_route_url(server_url, "/api/health") else {
        return false;
    };
    let Ok(client) = reqwest::blocking::Client::builder()
        .connect_timeout(SERVER_CONNECTION_TIMEOUT)
        .timeout(SERVER_CONNECTION_TIMEOUT)
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .get(health_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<ServerHealthResponse>()
        .is_ok_and(|health| health.ok && health.status.eq_ignore_ascii_case("healthy"))
}

fn show_notification(app: AppHandle, reminder: ReminderInput, show_title: bool) {
    let title = if show_title && !reminder.title.trim().is_empty() {
        reminder.title.clone()
    } else {
        "日程提醒".to_string()
    };
    let body = if reminder.all_day {
        "今天的全天日程".to_string()
    } else {
        format!("{} 开始", format_local_time(reminder.start_at))
    };
    let mut notification = Notification::new();
    notification
        .appname("Kalender")
        .summary(&title)
        .body(&body)
        .action("default", "打开 Kalender");
    if let Ok(handle) = notification.show() {
        let route = reminder.route;
        thread::spawn(move || {
            handle.wait_for_action(|action| {
                if action == "default" {
                    open_route(&app, &route);
                }
            });
        });
    }
}

fn set_pause(app: &AppHandle, until: Option<i64>) {
    let runtime = app.state::<DesktopRuntime>();
    if let Ok(mut state) = runtime.state.lock() {
        state.pause_until = until;
        let _ = save_state(&runtime.state_path, &state);
        update_tray_tooltip(app, &state);
    };
}

fn request_main_window(app: &AppHandle, route: Option<&str>) {
    let app = app.clone();
    let route = route.map(str::to_string);
    thread::spawn(move || {
        let runtime = app.state::<DesktopRuntime>();
        let server_url = match runtime
            .state
            .lock()
            .map(|state| configured_server_url(&state).to_string())
        {
            Ok(url) => url,
            Err(_) => return,
        };
        let connected = probe_server_health(&server_url);
        let current_server = runtime
            .state
            .lock()
            .map(|mut state| {
                if configured_server_url(&state) != server_url {
                    return false;
                }
                state.server_connected = Some(connected);
                true
            })
            .unwrap_or(false);
        if !current_server {
            return;
        }
        update_server_connection_menu(&app, Some(connected));
        if !connected {
            hide_main_window(&app);
            show_server_unavailable_notification(&app);
            open_server_config(&app);
            return;
        }

        if app.get_webview_window("main").is_none()
            && create_main_window(&app, &server_url, false).is_err()
        {
            return;
        }
        if let Some(route) = route.as_deref() {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(target) = server_route_url(&server_url, route) {
                    let _ = window.navigate(target);
                }
            }
        }
        show_main_window_unchecked(&app);
    });
}

fn show_main_window_unchecked(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let was_fullscreen = window.is_fullscreen().unwrap_or(false);
        let was_maximized = window.is_maximized().unwrap_or(false);
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let desktop_mode = app
            .state::<DesktopRuntime>()
            .state
            .lock()
            .map(|state| state.desktop_mode)
            .unwrap_or(false);
        if desktop_mode {
            let _ = apply_window_mode(&window, true);
        } else {
            if was_fullscreen {
                let _ = window.set_fullscreen(true);
            } else if was_maximized {
                let _ = window.maximize();
            }
            let _ = window.set_focus();
        }
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn open_route(app: &AppHandle, route: &str) {
    open_windowed_mode(app, Some(route));
}

fn create_main_window(app: &AppHandle, server_url: &str, visible: bool) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let normalized = normalize_server_url(server_url).unwrap_or_else(|_| DEFAULT_SERVER_URL.into());
    let url = Url::parse(&normalized).map_err(|error| format!("服务器地址无效：{error}"))?;
    let desktop_mode = app
        .state::<DesktopRuntime>()
        .state
        .lock()
        .map(|state| state.desktop_mode)
        .unwrap_or(false);
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Kalender")
        .disable_drag_drop_handler()
        .decorations(!desktop_mode)
        .resizable(!desktop_mode)
        .minimizable(!desktop_mode)
        .skip_taskbar(desktop_mode)
        .always_on_bottom(desktop_mode)
        .initialization_script("window.__KALENDER_NATIVE_FRAME__ = true;")
        .visible(visible)
        .inner_size(1360.0, 860.0)
        .min_inner_size(980.0, 640.0)
        .center()
        .build()
        .map_err(|error| format!("无法创建 Kalender 窗口：{error}"))?;
    install_native_desktop_guard(&window)?;
    if desktop_mode {
        apply_window_mode(&window, true)?;
    }
    Ok(())
}

fn show_server_unavailable_notification(app: &AppHandle) {
    let _ = Notification::new()
        .appname("Kalender")
        .summary("Kalender 服务器不可用")
        .body("健康检查失败，主窗口未打开。Kalender 将留在托盘中并自动重试。")
        .show();
    update_server_connection_menu(app, Some(false));
}

fn show_server_recovered_notification() {
    let _ = Notification::new()
        .appname("Kalender")
        .summary("Kalender 服务器已恢复")
        .body("后台同步已恢复，可从托盘打开 Kalender。")
        .show();
}

fn open_server_config(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("server-config") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let handle = app.clone();
    thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(
            &handle,
            "server-config",
            WebviewUrl::App("server-config.html".into()),
        )
        .title("Kalender · 服务器地址")
        .inner_size(560.0, 430.0)
        .min_inner_size(480.0, 390.0)
        .resizable(true)
        .center()
        .build();
    });
}

fn dispatch_web_event(app: &AppHandle, event_name: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(event_json) = serde_json::to_string(event_name) {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent({event_json}))"
            ));
        }
    }
}

fn update_tray_tooltip(app: &AppHandle, state: &PersistedState) {
    let tooltip = tray_tooltip_text(state, Utc::now().timestamp_millis());
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn update_server_connection_menu(app: &AppHandle, connected: Option<bool>) {
    let item = app
        .state::<DesktopRuntime>()
        .server_status_item
        .lock()
        .ok()
        .and_then(|item| item.clone());
    if let Some(item) = item {
        let _ = item.set_text(server_connection_label(connected));
        let _ = item.set_icon(Some(server_connection_icon(connected)));
    }
}

fn server_connection_label(connected: Option<bool>) -> &'static str {
    match connected {
        Some(true) => "服务器运行正常",
        Some(false) => "服务器健康检查失败",
        None => "正在检查服务器状态",
    }
}

fn server_connection_icon(connected: Option<bool>) -> Image<'static> {
    let color = match connected {
        Some(true) => [70, 181, 116],
        Some(false) => [224, 83, 83],
        None => [145, 152, 148],
    };
    let size = 16_u32;
    let center = (size as f32 - 1.0) / 2.0;
    let mut rgba = vec![0; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let distance = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            let alpha = if distance <= 5.0 {
                255
            } else if distance < 6.0 {
                ((6.0 - distance) * 255.0) as u8
            } else {
                0
            };
            let offset = ((y * size + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&[color[0], color[1], color[2], alpha]);
        }
    }
    Image::new_owned(rgba, size, size)
}

fn tray_tooltip_text(state: &PersistedState, now: i64) -> String {
    let mut lines = vec!["Kalender".to_string()];
    if state.server_connected == Some(false) {
        lines.push("服务器健康检查失败".to_string());
    } else if let Some(error) = state.last_sync_error.as_deref() {
        lines.push(format!("日历同步失败：{error}"));
    } else if state.summary.synced_at.is_none() {
        lines.push("等待日历同步".to_string());
    } else if state.summary.today_count == 0 {
        lines.push("今天暂无日程".to_string());
    } else {
        lines.push(format!("今天 {} 个日程", state.summary.today_count));
    }
    if let Some(until) = state.pause_until.filter(|until| *until > now) {
        lines.push(format!("提醒暂停至 {}", format_local_time(until)));
    } else {
        if state.last_sync_error.is_none() {
            if let Some(start_at) = state.summary.next_start_at {
                let title = state
                    .summary
                    .next_title
                    .as_deref()
                    .filter(|_| state.settings.show_event_title)
                    .unwrap_or("");
                lines.push(format!(
                    "下一项 {}{}",
                    format_local_time(start_at),
                    if title.is_empty() {
                        String::new()
                    } else {
                        format!(" {title}")
                    }
                ));
            }
        }
        lines.push(
            if state.settings.enabled {
                "提醒已开启"
            } else {
                "提醒已关闭"
            }
            .to_string(),
        );
    }
    lines.join("\n")
}

fn status_from_state(state: &PersistedState) -> DesktopStatus {
    DesktopStatus {
        available: true,
        pause_until: state.pause_until,
        queued_reminder_count: state
            .reminders
            .iter()
            .filter(|item| item.delivered_at.is_none())
            .count(),
        last_synced_at: state.summary.synced_at,
        last_sync_attempt_at: state.last_sync_attempt_at,
        last_sync_error: state.last_sync_error.clone(),
    }
}

fn normalize_sync_error(message: &str) -> String {
    let normalized = message.trim().chars().take(300).collect::<String>();
    if normalized.is_empty() {
        "未知错误".to_string()
    } else {
        normalized
    }
}

fn server_config_from_state(state: &PersistedState) -> ServerConfig {
    let url = configured_server_url(state).to_string();
    ServerConfig {
        is_default: url == DEFAULT_SERVER_URL,
        url,
        connected: state.server_connected,
    }
}

fn configured_server_url(state: &PersistedState) -> &str {
    state
        .server_url
        .as_deref()
        .filter(|value| normalize_server_url(value).is_ok())
        .unwrap_or(DEFAULT_SERVER_URL)
}

fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("请输入服务器域名或网址".to_string());
    }
    if trimmed.len() > MAX_SERVER_URL_LENGTH {
        return Err("服务器地址过长".to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let lower = trimmed.to_ascii_lowercase();
        let scheme = if lower == "localhost"
            || lower.starts_with("localhost:")
            || lower.starts_with("127.")
            || lower.starts_with("[::1]")
        {
            "http"
        } else {
            "https"
        };
        format!("{scheme}://{trimmed}")
    };

    let mut url = Url::parse(&candidate).map_err(|_| "服务器地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("服务器地址只支持 HTTP 或 HTTPS".to_string());
    }
    if url.host_str().is_none() {
        return Err("服务器地址缺少域名或 IP 地址".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("服务器地址不能包含用户名或密码".to_string());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

fn server_route_url(server_url: &str, route: &str) -> Result<Url, String> {
    let mut base = Url::parse(server_url).map_err(|_| "服务器地址无效".to_string())?;
    base.set_path("/");
    base.set_query(None);
    base.set_fragment(None);
    base.join(route.trim_start_matches('/'))
        .map_err(|_| "无法生成 Kalender 页面地址".to_string())
}

fn ensure_main_caller(
    window: &WebviewWindow,
    runtime: &State<'_, DesktopRuntime>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("这个窗口不能调用桌面提醒功能".to_string());
    }
    let current = window
        .url()
        .map_err(|_| "无法验证当前 Kalender 页面".to_string())?;
    let expected = {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "服务器配置暂时不可用".to_string())?;
        Url::parse(configured_server_url(&state)).map_err(|_| "保存的服务器地址无效".to_string())?
    };
    if current.origin() != expected.origin() {
        return Err("当前页面不是已配置的 Kalender 服务器".to_string());
    }
    Ok(())
}

fn ensure_config_caller(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "server-config" {
        Ok(())
    } else {
        Err("这个窗口不能修改服务器地址".to_string())
    }
}

fn validate_settings(settings: &DesktopSettings) -> Result<(), String> {
    if ![0, 5, 10, 15, 30, 60].contains(&settings.reminder_minutes_before)
        || ![7, 8, 9, 10, 12].contains(&settings.all_day_reminder_hour)
        || ![0, 15, 30, 60, 180].contains(&settings.missed_reminder_window_minutes)
    {
        return Err("桌面提醒设置包含不支持的值".to_string());
    }
    Ok(())
}

fn reminder_key(reminder: &ReminderInput) -> String {
    format!("{}:{}", reminder.id, reminder.start_at)
}

fn load_state(path: &PathBuf) -> PersistedState {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_state(path: &PathBuf, state: &PersistedState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建桌面提醒目录：{error}"))?;
    }
    let contents =
        serde_json::to_vec_pretty(state).map_err(|error| format!("无法序列化桌面提醒：{error}"))?;
    fs::write(path, contents).map_err(|error| format!("无法保存桌面提醒：{error}"))
}

fn format_local_time(timestamp: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .map(|value| value.format("%H:%M").to_string())
        .unwrap_or_else(|| "--:--".to_string())
}

fn end_of_local_day() -> Option<i64> {
    let tomorrow = Local::now().date_naive().checked_add_days(Days::new(1))?;
    let midnight = tomorrow.and_hms_opt(0, 0, 0)?;
    Local
        .from_local_datetime(&midnight)
        .earliest()
        .map(|value| value.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[test]
    fn reminder_key_keeps_recurring_instances_distinct() {
        let first = ReminderInput {
            id: "series".into(),
            title: "One".into(),
            start_at: 100,
            remind_at: 90,
            all_day: false,
            route: "/calendar".into(),
        };
        let second = ReminderInput {
            start_at: 200,
            ..first.clone()
        };
        assert_ne!(reminder_key(&first), reminder_key(&second));
    }

    #[test]
    fn default_settings_are_valid() {
        let settings = DesktopSettings::default();
        assert!(validate_settings(&settings).is_ok());
        assert!(settings.launch_at_login);
    }

    #[test]
    fn older_state_enables_autostart_once() {
        let mut state: PersistedState = serde_json::from_str(
            r#"{"settings":{"enabled":true,"reminderMinutesBefore":10,"allDayReminderHour":9,"launchAtLogin":false,"minimizeToTray":true,"showEventTitle":true,"missedReminderWindowMinutes":30}}"#,
        )
        .unwrap();

        assert!(migrate_autostart_default(&mut state));
        assert!(state.settings.launch_at_login);
        assert!(state.autostart_default_migrated);
        assert!(!migrate_autostart_default(&mut state));
    }

    #[test]
    fn migrated_state_respects_an_explicitly_disabled_autostart() {
        let mut state = PersistedState {
            autostart_default_migrated: true,
            ..PersistedState::default()
        };
        state.settings.launch_at_login = false;

        assert!(!migrate_autostart_default(&mut state));
        assert!(!state.settings.launch_at_login);
    }

    #[test]
    fn normalizes_domains_and_local_addresses() {
        assert_eq!(
            normalize_server_url("kalender.example.com").unwrap(),
            "https://kalender.example.com/"
        );
        assert_eq!(
            normalize_server_url("localhost:3000").unwrap(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_server_url("http://192.168.1.20:3000/today").unwrap(),
            "http://192.168.1.20:3000/today"
        );
    }

    #[test]
    fn rejects_unsafe_or_incomplete_server_urls() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("file:///tmp/kalender").is_err());
        assert!(normalize_server_url("javascript:alert(1)").is_err());
        assert!(normalize_server_url("https://user:secret@example.com").is_err());
    }

    #[test]
    fn server_routes_use_the_configured_origin() {
        let route = server_route_url(
            "https://kalender.example.com/start?source=desktop",
            "/calendar?event=123",
        )
        .unwrap();
        assert_eq!(
            route.as_str(),
            "https://kalender.example.com/calendar?event=123"
        );
    }

    #[test]
    fn connection_labels_cover_all_states() {
        assert_eq!(server_connection_label(None), "正在检查服务器状态");
        assert_eq!(server_connection_label(Some(true)), "服务器运行正常");
        assert_eq!(server_connection_label(Some(false)), "服务器健康检查失败");
    }

    #[test]
    fn health_probe_requires_a_healthy_kalender_response() {
        let (healthy_url, healthy_server) =
            health_server("200 OK", r#"{"ok":true,"status":"healthy"}"#);
        assert!(probe_server_health(&format!("{healthy_url}calendar")));
        healthy_server.join().unwrap();

        let (gateway_url, gateway_server) =
            health_server("502 Bad Gateway", "<html><title>Bad gateway</title></html>");
        assert!(!probe_server_health(&gateway_url));
        gateway_server.join().unwrap();

        let (wrong_app_url, wrong_app_server) = health_server("200 OK", r#"{"ok":true}"#);
        assert!(!probe_server_health(&wrong_app_url));
        wrong_app_server.join().unwrap();
    }

    #[test]
    fn server_url_survives_state_persistence() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kalender-desktop-server-config-{}-{suffix}.json",
            std::process::id()
        ));
        let state = PersistedState {
            server_url: Some("https://kalender.example.com/".into()),
            ..PersistedState::default()
        };
        save_state(&path, &state).unwrap();
        let loaded = load_state(&path);
        let _ = fs::remove_file(path);
        assert_eq!(
            configured_server_url(&loaded),
            "https://kalender.example.com/"
        );
    }

    #[test]
    fn older_state_files_keep_the_local_default() {
        let loaded: PersistedState = serde_json::from_str("{}").unwrap();
        assert_eq!(configured_server_url(&loaded), DEFAULT_SERVER_URL);
        assert!(!loaded.desktop_mode);
    }

    #[test]
    fn desktop_mode_survives_state_persistence() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kalender-desktop-window-mode-{}-{suffix}.json",
            std::process::id()
        ));
        let state = PersistedState {
            desktop_mode: true,
            ..PersistedState::default()
        };
        save_state(&path, &state).unwrap();
        let loaded = load_state(&path);
        let _ = fs::remove_file(path);
        assert!(loaded.desktop_mode);
    }

    #[test]
    fn unsynced_tooltip_does_not_claim_the_calendar_is_empty() {
        let tooltip = tray_tooltip_text(&PersistedState::default(), 0);
        assert!(tooltip.contains("等待日历同步"));
        assert!(!tooltip.contains("今天暂无日程"));
    }

    #[test]
    fn empty_calendar_is_only_shown_after_a_successful_sync() {
        let state = PersistedState {
            summary: DesktopSummary {
                synced_at: Some(1),
                ..DesktopSummary::default()
            },
            ..PersistedState::default()
        };
        assert!(tray_tooltip_text(&state, 1).contains("今天暂无日程"));
    }

    #[test]
    fn sync_failure_is_visible_in_the_tooltip() {
        let state = PersistedState {
            last_sync_error: Some("请先登录".into()),
            ..PersistedState::default()
        };
        assert!(tray_tooltip_text(&state, 1).contains("日历同步失败：请先登录"));
    }

    fn health_server(status: &'static str, body: &'static str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1_024];
            let bytes_read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..bytes_read]);
            assert!(request.starts_with("GET /api/health "));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{address}/"), handle)
    }
}
