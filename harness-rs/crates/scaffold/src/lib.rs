//! Deterministic application scaffold generator.
//!
//! The generator turns a small declarative input (template + entities +
//! features) into a runnable managed project with:
//! - a Next.js UI shell and CRUD API routes
//! - a host-data-API data layer
//! - an AI capability manifest, fixed RPC route, and contract tests
//!
//! The public surface is intentionally small so `create_project` and the
//! upgrade tool can share exactly the same plan.

pub mod ai_files;
pub mod manifest;
pub mod plan;
pub mod render;
pub mod templates;
pub mod types;
pub mod validate;

pub use plan::plan;
pub use types::{CapabilitySpec, EntitySpec, FieldSpec, ScaffoldInput, ScaffoldPlan};

pub const DEFAULT_TEMPLATE: &str = "next-crud";

pub const SUPPORTED_TEMPLATES: &[&str] = &["next-crud", "next-dashboard", "node-api", "blank"];

pub const SUPPORTED_FEATURES: &[&str] = &[
    "core", "data", "crud-ui", "ai", "search", "upload", "chart", "settings",
];
