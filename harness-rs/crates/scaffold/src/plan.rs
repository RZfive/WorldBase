use std::collections::BTreeMap;

use anyhow::Result;
use serde_json::{json, Value};

use crate::{ai_files, manifest, templates, validate, ScaffoldInput, ScaffoldPlan};

/// Build a deterministic plan from declarative input.
pub fn plan(input: &ScaffoldInput) -> Result<ScaffoldPlan> {
    validate::validate(input)?;

    let capabilities = manifest::build_capabilities(input)?;
    let mut files = templates::template_files(input)?;
    files.extend(ai_files::generate(input, &capabilities)?);

    let meta = build_meta(input, &capabilities);
    let warnings = Vec::new();

    Ok(ScaffoldPlan {
        files,
        meta,
        capabilities,
        warnings,
        template: input.template.clone(),
        features: input.features.clone(),
    })
}

fn build_meta(input: &ScaffoldInput, capabilities: &[crate::CapabilitySpec]) -> Value {
    let tables = input
        .entities
        .iter()
        .map(|entity| {
            let columns = templates::effective_fields(entity)
                .iter()
                .map(|field| {
                    let mut column = json!({
                        "name": field.name,
                        "type": field.sqlite_type(),
                    });
                    if field.primary_key {
                        column["primaryKey"] = json!(true);
                    }
                    if field.required || field.primary_key {
                        column["notNull"] = json!(true);
                    }
                    if let Some(default_sql) = &field.default_sql {
                        column["defaultSql"] = json!(default_sql);
                    }
                    column
                })
                .collect::<Vec<_>>();
            json!({ "name": entity.table, "columns": columns })
        })
        .collect::<Vec<_>>();

    let mut endpoints = vec![json!({
        "method": "GET",
        "path": "/api/health",
        "description": "应用健康检查",
    })];
    endpoints.extend(input.entities.iter().flat_map(|entity| {
        let base = format!("/api/{}", entity.table);
        vec![
            json!({ "method": "GET", "path": base, "description": format!("列出 {}", entity.name) }),
            json!({ "method": "POST", "path": base, "description": format!("创建 {}", entity.name) }),
            json!({ "method": "GET", "path": format!("{base}/{{id}}"), "description": format!("获取 {}", entity.name) }),
            json!({ "method": "PUT", "path": format!("{base}/{{id}}"), "description": format!("更新 {}", entity.name) }),
            json!({ "method": "DELETE", "path": format!("{base}/{{id}}"), "description": format!("删除 {}", entity.name) }),
        ]
    }));

    let capability_ids = capabilities
        .iter()
        .map(|capability| capability.id.clone())
        .collect::<Vec<_>>();

    let is_node = input.template == "node-api";
    let framework = if is_node { "node" } else { "nextjs" };
    let runtime_command = if is_node {
        "node server.mjs"
    } else {
        "node .next/standalone/server.js"
    };
    let runtime_type = if is_node { "api" } else { "fullstack" };

    json!({
        "id": input.project_id,
        "name": input.name,
        "type": input.project_type,
        "framework": framework,
        "template": { "id": input.template, "version": "1.0.0" },
        "features": input.features,
        "runtime": {
            "type": runtime_type,
            "framework": framework,
            "backend": { "command": runtime_command }
        },
        "api": { "endpoints": endpoints },
        "dataSchema": {
            "database": "sqlite",
            "dbPath": "data/app.sqlite",
            "schemaVersion": 1,
            "tables": tables
        },
        "aiIntegration": {
            "enabled": input.ai_integration,
            "capabilities": capability_ids
        },
        "workflow": {
            "mode": if input.development_mode { "development" } else { "direct" },
            "incremental": input.development_mode
        }
    })
}

/// Normalize the common `meta` filter: user-provided top-level keys win, but
/// missing fields are filled from the scaffold plan.
pub fn merge_meta(plan_meta: &Value, user_meta: &Value) -> Value {
    let mut merged = plan_meta.clone();
    if let (Some(target), Some(source)) = (merged.as_object_mut(), user_meta.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// Merge user files over generated files. User-provided content wins.
pub fn merge_files(
    generated: BTreeMap<String, String>,
    user: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut merged = generated;
    for (path, content) in user {
        merged.insert(path.clone(), content.clone());
    }
    merged
}
