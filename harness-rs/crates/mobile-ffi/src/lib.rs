//! mobile-ffi：移动端进程内启动 harness 的 extern "C" 入口。
//!
//! iOS/Android 通过 FFI 调 `worldbase_start` 在进程内启动完整 harness
//! （loopback 端口上的 WS/HTTP server），返回实际端口；宿主用 WS 客户端
//! 以相同 JSON-RPC 协议接入，握手时声明移动端 capabilities。
//! 构建移动目标时以 `--no-default-features` 排除 desktop-support 相关能力。

mod transport;

use std::ffi::{c_char, CStr};
use std::sync::OnceLock;

static RUNTIME: OnceLock<std::sync::Mutex<Option<tokio::runtime::Runtime>>> = OnceLock::new();

fn cell() -> &'static std::sync::Mutex<Option<tokio::runtime::Runtime>> {
    RUNTIME.get_or_init(|| std::sync::Mutex::new(None))
}

fn pick_port(hint: u16) -> u16 {
    if hint != 0 {
        // 探测 hint 是否可用
        if std::net::TcpListener::bind(("127.0.0.1", hint)).is_ok() {
            return hint;
        }
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(worldbase_protocol::DEFAULT_SERVE_PORT)
}

/// 启动进程内 harness。
///
/// # Safety
/// `data_dir` 必须是合法的 UTF-8 C 字符串指针（可为 null 使用默认目录）。
/// 返回实际监听端口；失败返回 -1（已启动返回 -2）。
#[no_mangle]
pub unsafe extern "C" fn worldbase_start(data_dir: *const c_char, port_hint: u32) -> i32 {
    let mut guard = cell().lock().unwrap();
    if guard.is_some() {
        return -2; // 已启动
    }

    if data_dir.is_null() {
        std::env::remove_var("WORLDBASE_HOME");
    } else {
        let dir = CStr::from_ptr(data_dir).to_string_lossy().into_owned();
        std::env::set_var("WORLDBASE_HOME", dir);
    }

    let port = pick_port(port_hint as u16);
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
    let caps = worldbase_protocol::types::Capabilities::mobile("mobile-ffi");
    // start_background 需要 tokio 上下文，必须放进 runtime 任务内
    runtime.spawn(async move {
        hub.start_background();
        let _ = transport::run(hub, port, caps).await;
    });

    // 等待 loopback 端口真正可连（最多 ~3s），避免调用方拿到端口即连被拒
    let mut ready = false;
    for _ in 0..60 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !ready {
        runtime.shutdown_timeout(std::time::Duration::from_millis(100));
        return -1;
    }

    *guard = Some(runtime);
    port as i32
}

/// 停止进程内 harness。
#[no_mangle]
pub extern "C" fn worldbase_stop() {
    let mut guard = cell().lock().unwrap();
    if let Some(runtime) = guard.take() {
        runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    }
}
