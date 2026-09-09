//! Backwards-compatible module path for the complete web search tool.
//!
//! The implementation lives in [`crate::web`] beside `web_fetch` and
//! `fetch_webpage`, so all callers use the same Electron-compatible contract.

pub use crate::web::WebSearchTool;
