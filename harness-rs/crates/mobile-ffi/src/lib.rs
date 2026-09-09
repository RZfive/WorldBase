//! mobile-ffi：移动端进程内启动 harness 的 extern "C" 入口。
//!
//! iOS/Android 通过 FFI 调 `worldbase_start` 在进程内启动完整 harness
//! （loopback 端口上的 WS/HTTP server），返回实际端口；宿主用 WS 客户端
//! 以相同 JSON-RPC 协议接入，握手时声明移动端 capabilities。
//! 移动端能力隔离由握手后的 runtime capability gate 执行。

mod transport;

use std::ffi::{c_char, CStr};
use std::sync::OnceLock;
use worldbase_mcp_client::McpServerConfig;

#[derive(Default)]
struct Lifecycle {
    runtime: Option<tokio::runtime::Runtime>,
    auth_token: Option<String>,
    port: Option<u16>,
}

static LIFECYCLE: OnceLock<std::sync::Mutex<Lifecycle>> = OnceLock::new();

fn cell() -> &'static std::sync::Mutex<Lifecycle> {
    LIFECYCLE.get_or_init(|| std::sync::Mutex::new(Lifecycle::default()))
}

async fn bind_loopback_listener(port_hint: u32) -> std::io::Result<tokio::net::TcpListener> {
    if port_hint > u16::MAX as u32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "port hint exceeds 65535",
        ));
    }

    if port_hint != 0 {
        if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port_hint as u16)).await {
            return Ok(listener);
        }
    }
    tokio::net::TcpListener::bind(("127.0.0.1", 0)).await
}

fn generate_auth_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn catch_ffi<T>(operation: &'static str, fallback: T, callback: impl FnOnce() -> T) -> T {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback)) {
        Ok(value) => value,
        Err(_) => {
            // The process panic hook has already recorded the payload. Never
            // allow an unwind to cross the C ABI boundary.
            tracing::error!(operation, "mobile FFI entrypoint panicked");
            fallback
        }
    }
}

fn mobile_mcp_configs(value: Option<serde_json::Value>) -> Vec<McpServerConfig> {
    let Some(serde_json::Value::Array(entries)) = value else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<McpServerConfig>(entry).ok())
        .filter(|config| {
            config.enabled
                && matches!(
                    config.transport.as_str(),
                    "http" | "streamable-http" | "sse"
                )
        })
        .collect()
}

async fn restore_mobile_mcp_servers(hub: &std::sync::Arc<worldbase_core::Hub>) {
    let configs = mobile_mcp_configs(hub.store.get_setting("mcpServers").ok().flatten());
    hub.mcp.configure(configs).await;
}

/// 启动进程内 harness。
///
/// # Safety
/// `data_dir` 必须是合法的 UTF-8 C 字符串指针（可为 null 使用默认目录）。
/// 返回实际监听端口；失败返回 -1。重复调用返回当前实例的实际端口，供新的
/// Dart isolate / hot restart 恢复连接。
unsafe fn start_inner(data_dir: *const c_char, port_hint: u32) -> i32 {
    let mut guard = cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.runtime.is_some() {
        return guard.port.map(i32::from).unwrap_or(-1);
    }
    guard.auth_token = None;
    guard.port = None;

    if data_dir.is_null() {
        std::env::remove_var("WORLDBASE_HOME");
    } else {
        let dir = CStr::from_ptr(data_dir).to_string_lossy().into_owned();
        std::env::set_var("WORLDBASE_HOME", dir);
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return -1,
    };

    let store = match worldbase_memory::Store::open_default() {
        Ok(s) => s,
        Err(_) => {
            runtime.shutdown_timeout(std::time::Duration::from_millis(100));
            return -1;
        }
    };
    let hub = match worldbase_core::Hub::new(
        worldbase_memory::Store::default_dir().join("workspace"),
        std::sync::Arc::new(store),
    ) {
        Ok(h) => h,
        Err(_) => {
            runtime.shutdown_timeout(std::time::Duration::from_millis(100));
            return -1;
        }
    };
    let listener = match runtime.block_on(bind_loopback_listener(port_hint)) {
        Ok(listener) => listener,
        Err(_) => {
            runtime.shutdown_timeout(std::time::Duration::from_millis(100));
            return -1;
        }
    };
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(_) => {
            runtime.shutdown_timeout(std::time::Duration::from_millis(100));
            return -1;
        }
    };
    let caps = worldbase_protocol::types::Capabilities::mobile("mobile-ffi");
    let auth_token = generate_auth_token();
    let transport_token = auth_token.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    // start_background 需要 tokio 上下文，必须放进 runtime 任务内
    runtime.spawn(async move {
        hub.start_background();
        // Publish the persisted remote MCP catalog before transport readiness,
        // so the first initialize/chat cannot observe a transient empty set.
        // McpManager::configure only swaps in-memory state and does no network I/O.
        restore_mobile_mcp_servers(&hub).await;
        if let Err(error) = transport::run(hub, listener, caps, transport_token, ready_tx).await {
            tracing::error!(%error, "embedded harness transport stopped");
        }
    });

    // The bound listener is retained from selection through serving. Waiting
    // for the transport task removes both the port-selection race and the
    // possibility of treating an unrelated process as our readiness signal.
    if ready_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .is_err()
    {
        runtime.shutdown_timeout(std::time::Duration::from_millis(100));
        return -1;
    }

    guard.auth_token = Some(auth_token);
    guard.port = Some(port);
    guard.runtime = Some(runtime);
    port as i32
}

/// Starts the in-process harness and returns its loopback port, or `-1` on failure.
/// Repeated calls return the running instance's port so a new Dart isolate can reconnect.
///
/// # Safety
/// `data_dir` must be null or point to a valid NUL-terminated C string for the
/// duration of this call.
#[no_mangle]
pub unsafe extern "C" fn worldbase_start(data_dir: *const c_char, port_hint: u32) -> i32 {
    catch_ffi("worldbase_start", -1, || start_inner(data_dir, port_hint))
}

/// Copies the current loopback authentication token into `buffer`.
///
/// The positive return value is the required buffer size in bytes, including
/// the trailing NUL. Call with a null/short buffer to query that size. Returns
/// -1 while the embedded harness is not running.
///
/// # Safety
/// When non-null, `buffer` must be writable for at least `buffer_len` bytes.
unsafe fn get_auth_token_inner(buffer: *mut c_char, buffer_len: u32) -> i32 {
    let guard = cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(token) = guard.auth_token.as_deref() else {
        return -1;
    };
    let required = token.len() + 1;
    if buffer.is_null() || (buffer_len as usize) < required {
        return required as i32;
    }
    std::ptr::copy_nonoverlapping(token.as_ptr().cast::<c_char>(), buffer, token.len());
    *buffer.add(token.len()) = 0;
    required as i32
}

/// Copies the running harness's loopback authentication token into `buffer`.
///
/// # Safety
/// When non-null, `buffer` must be writable for at least `buffer_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn worldbase_get_auth_token(buffer: *mut c_char, buffer_len: u32) -> i32 {
    catch_ffi("worldbase_get_auth_token", -1, || {
        get_auth_token_inner(buffer, buffer_len)
    })
}

/// 停止进程内 harness。
fn stop_inner() {
    let mut guard = cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.auth_token = None;
    guard.port = None;
    if let Some(runtime) = guard.runtime.take() {
        runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    }
}

#[no_mangle]
pub extern "C" fn worldbase_stop() {
    catch_ffi("worldbase_stop", (), stop_inner);
}

#[cfg(test)]
mod tests {
    use super::{bind_loopback_listener, catch_ffi, generate_auth_token, mobile_mcp_configs};
    use serde_json::json;

    #[test]
    fn auth_tokens_are_random_256_bit_hex_values() {
        let first = generate_auth_token();
        let second = generate_auth_token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn ffi_panics_are_converted_to_the_contract_fallback() {
        let result = catch_ffi("test", -1, || -> i32 { panic!("test panic") });
        assert_eq!(result, -1);
    }

    #[tokio::test]
    async fn selected_loopback_port_remains_owned_until_listener_is_dropped() {
        let listener = bind_loopback_listener(0).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(std::net::TcpListener::bind(address).is_err());
        drop(listener);
        assert!(std::net::TcpListener::bind(address).is_ok());
    }

    #[tokio::test]
    async fn out_of_range_port_hint_is_rejected_instead_of_wrapping() {
        let error = bind_loopback_listener(u16::MAX as u32 + 1)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn mobile_mcp_restore_keeps_only_enabled_remote_transports() {
        let config = |name: &str, transport: &str, enabled: bool| {
            json!({
                "name": name,
                "displayName": name,
                "transport": transport,
                "target": "https://mcp.example.test",
                "enabled": enabled
            })
        };
        let restored = mobile_mcp_configs(Some(json!([
            config("http", "http", true),
            config("stream", "streamable-http", true),
            config("sse", "sse", true),
            config("disabled", "sse", false),
            config("stdio", "stdio", true),
            config("unknown", "websocket", true),
            {"malformed": true}
        ])));

        let names: Vec<_> = restored.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["http", "stream", "sse"]);
    }
}
