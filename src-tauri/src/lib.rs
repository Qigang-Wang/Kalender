use std::{
    collections::HashMap,
    fs,
    net::{TcpStream, ToSocketAddrs},
    path::PathBuf,
    sync::Mutex,
    thread,
    time::Duration,
};

use chrono::{Days, Local, TimeZone, Utc};
use notify_rust::Notification;
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use url::Url;

const TRAY_ID: &str = "kalender-tray";
const STATE_FILE: &str = "desktop-reminders.json";
const REMINDER_CHECK_INTERVAL: Duration = Duration::from_secs(10);
const SERVER_CONNECTION_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const SERVER_CONNECTION_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_SERVER_URL: &str = "http://localhost:3000/";
const MAX_SERVER_URL_LENGTH: usize = 2_048;

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
            launch_at_login: false,
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
    server_url: Option<String>,
    #[serde(skip)]
    server_connected: Option<bool>,
}

struct DesktopRuntime {
    state: Mutex<PersistedState>,
    state_path: PathBuf,
    server_status_item: Mutex<Option<IconMenuItem<tauri::Wry>>>,
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
    let autostart = app.autolaunch();
    if settings.launch_at_login {
        autostart
            .enable()
            .map_err(|error| format!("无法启用开机启动：{error}"))?;
    } else {
        autostart
            .disable()
            .map_err(|error| format!("无法关闭开机启动：{error}"))?;
    }

    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "桌面提醒状态暂时不可用".to_string())?;
    state.settings = settings;
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
        state.server_connected = None;
        save_state(&runtime.state_path, &state)?;
        update_tray_tooltip(&app, &state);
        update_server_connection_menu(&app, None);
        server_config_from_state(&state)
    };

    let target = Url::parse(&normalized).map_err(|_| "保存后的服务器地址无效".to_string())?;
    if let Some(main) = app.get_webview_window("main") {
        main.navigate(target)
            .map_err(|error| format!("无法打开服务器地址：{error}"))?;
        show_main_window(&app);
    } else {
        create_main_window(&app, &normalized)?;
    }
    let connection_app = app.clone();
    thread::spawn(move || check_server_connection(&connection_app));
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
            show_main_window(app);
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
            let persisted = load_state(&state_path);
            let server_url = configured_server_url(&persisted).to_string();
            app.manage(DesktopRuntime {
                state: Mutex::new(persisted),
                state_path,
                server_status_item: Mutex::new(None),
            });
            create_main_window(app.handle(), &server_url)?;
            build_tray(app)?;
            start_reminder_scheduler(app.handle().clone());
            start_server_connection_monitor(app.handle().clone());
            if let Ok(state) = app.state::<DesktopRuntime>().state.lock() {
                update_tray_tooltip(app.handle(), &state);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
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
        })
        .run(tauri::generate_context!())
        .expect("error while running Kalender desktop client");
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Kalender", true, None::<&str>)?;
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

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .expect("application icon is required")
                .clone(),
        )
        .tooltip("Kalender\n正在同步今日日程")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "pause-30" => set_pause(app, Some(Utc::now().timestamp_millis() + 30 * 60_000)),
            "pause-120" => set_pause(app, Some(Utc::now().timestamp_millis() + 120 * 60_000)),
            "pause-today" => set_pause(app, end_of_local_day()),
            "resume" => set_pause(app, None),
            "sync" => dispatch_web_event(app, "kalender:desktop-sync-requested"),
            "settings" => open_route(app, "/settings?tab=desktop"),
            "server-config" => open_server_config(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
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
    let connected = probe_server_connection(&server_url);
    let should_publish = runtime
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
    if should_publish {
        update_server_connection_menu(app, Some(connected));
    }
}

fn probe_server_connection(server_url: &str) -> bool {
    let Ok((host, port)) = server_socket_target(server_url) else {
        return false;
    };
    let Ok(addresses) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    addresses
        .take(4)
        .any(|address| TcpStream::connect_timeout(&address, SERVER_CONNECTION_TIMEOUT).is_ok())
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_route(app: &AppHandle, route: &str) {
    show_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let runtime = app.state::<DesktopRuntime>();
        if let Ok(state) = runtime.state.lock() {
            if let Ok(target) = server_route_url(configured_server_url(&state), route) {
                let _ = window.navigate(target);
            }
        };
    }
}

fn create_main_window(app: &AppHandle, server_url: &str) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let normalized = normalize_server_url(server_url).unwrap_or_else(|_| DEFAULT_SERVER_URL.into());
    let url = Url::parse(&normalized).map_err(|error| format!("服务器地址无效：{error}"))?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Kalender")
        .decorations(false)
        .inner_size(1360.0, 860.0)
        .min_inner_size(980.0, 640.0)
        .center()
        .build()
        .map_err(|error| format!("无法创建 Kalender 窗口：{error}"))?;
    Ok(())
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
        Some(true) => "服务器连接正常",
        Some(false) => "服务器连接断开",
        None => "正在检查服务器连接",
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
    if let Some(error) = state.last_sync_error.as_deref() {
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
    }
}

fn configured_server_url(state: &PersistedState) -> &str {
    state
        .server_url
        .as_deref()
        .filter(|value| normalize_server_url(value).is_ok())
        .unwrap_or(DEFAULT_SERVER_URL)
}

fn server_socket_target(server_url: &str) -> Result<(String, u16), String> {
    let url = Url::parse(server_url).map_err(|_| "服务器地址无效".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "服务器地址缺少域名或 IP 地址".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "服务器地址缺少端口".to_string())?;
    Ok((host.to_string(), port))
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
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        assert!(validate_settings(&DesktopSettings::default()).is_ok());
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
    fn resolves_server_socket_targets() {
        assert_eq!(
            server_socket_target("https://kalender.example.com/calendar").unwrap(),
            ("kalender.example.com".to_string(), 443)
        );
        assert_eq!(
            server_socket_target("http://localhost:3000/").unwrap(),
            ("localhost".to_string(), 3000)
        );
    }

    #[test]
    fn connection_labels_cover_all_states() {
        assert_eq!(server_connection_label(None), "正在检查服务器连接");
        assert_eq!(server_connection_label(Some(true)), "服务器连接正常");
        assert_eq!(server_connection_label(Some(false)), "服务器连接断开");
    }

    #[test]
    fn detects_a_reachable_server_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        assert!(probe_server_connection(&format!("http://{address}/")));
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
}
