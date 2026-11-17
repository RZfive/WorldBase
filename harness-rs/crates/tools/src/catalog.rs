//! Run-scoped tool catalog contract.
//!
//! The implementation lives in `worldbase-core` because it needs the full
//! registry and agent policy. Tools (notably `search_tools`) only depend on
//! this narrow trait.

use async_trait::async_trait;
use worldbase_protocol::types::{ApplicationSearchParams, ApplicationSearchResult};

#[async_trait]
pub trait ToolCatalogRuntime: Send + Sync {
    /// Search the policy-filtered discoverable catalog and atomically activate
    /// the returned top-k entries for the next model turn.
    async fn search_and_activate(
        &self,
        request: ApplicationSearchParams,
    ) -> anyhow::Result<ApplicationSearchResult>;

    /// Monotonic version of the current run catalog. It changes whenever an
    /// entry is activated, removed, or invalidated.
    fn catalog_version(&self) -> u64;

    fn active_tool_names(&self) -> Vec<String>;

    /// Instructions for skills activated in this run. The agent loop appends
    /// them to the dynamic system suffix on the next turn.
    fn active_skill_instructions(&self) -> Vec<String>;

    /// Mark the catalog stale (application disabled, grants changed, MCP
    /// reloaded). The next turn must re-snapshot and may require re-search.
    fn invalidate(&self);
}
