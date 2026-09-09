//! WorldBase Harness 核心：Hub（状态与服务编排）、Agent 循环、JSON-RPC dispatcher。

pub mod agent;
pub mod dispatcher;
pub mod hub;
pub mod permissions;
pub mod studio;
mod subagents;
pub mod tool_results;

pub use agent::{start_chat, to_llm_messages, ChatRun};
pub use dispatcher::ConnectionContext;
pub use hub::Hub;
