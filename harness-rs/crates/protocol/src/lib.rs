//! WorldBase Harness 协议单一来源 (v1)。
//!
//! 所有 transport（stdio NDJSON / WebSocket / in-process FFI）共用同一套
//! JSON-RPC 2.0 语义。schema 与 `PROTOCOL_VERSION` 冻结后，TS/Dart 绑定由
//! 本 crate 生成。

pub mod event;
pub mod method;
pub mod rpc;
pub mod types;

pub use event::*;
pub use method::*;
pub use rpc::*;
pub use types::*;

/// 协议版本：不兼容变更必须递增主版本号。
pub const PROTOCOL_VERSION: &str = "1.0";

/// Harness server 版本（与 workspace 版本保持一致）。
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 默认 LAN serve 端口（与原 Electron 版对齐）。
pub const DEFAULT_SERVE_PORT: u16 = 19527;
