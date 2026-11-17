//! Application capability platform: manifest validation, canonical catalog,
//! run-scoped tool catalog and risk/grant policy.

pub mod manifest;
pub mod policy;
pub mod registry;
pub mod run_catalog;

pub use manifest::{capability_tool_name, manifest_hash, validate_manifest};
pub use policy::{capability_pattern_matches, effective_policy, risk_requires_confirmation};
pub use registry::ApplicationRegistry;
pub use run_catalog::{CatalogEntry, RunCatalogSnapshot, RunToolCatalog, SkillCatalogEntry};
