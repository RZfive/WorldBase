use std::collections::BTreeMap;

use serde_json::Value;
use worldbase_scaffold::plan::{merge_files, merge_meta};
use worldbase_scaffold::types::{EntitySpec, FieldSpec, ScaffoldInput};
use worldbase_scaffold::{plan, SUPPORTED_FEATURES};

fn field(
    name: &str,
    field_type: &str,
    required: bool,
    primary_key: bool,
    default_sql: Option<&str>,
) -> FieldSpec {
    FieldSpec {
        name: name.to_string(),
        field_type: field_type.to_string(),
        required,
        primary_key,
        default_sql: default_sql.map(str::to_string),
    }
}

fn expense_entity() -> EntitySpec {
    EntitySpec {
        name: "expense".into(),
        table: "expenses".into(),
        fields: vec![
            field("id", "text", true, true, None),
            field("title", "text", true, false, None),
            field("amount", "number", true, false, None),
            field(
                "created_at",
                "text",
                false,
                false,
                Some("CURRENT_TIMESTAMP"),
            ),
        ],
    }
}

fn todo_entity() -> EntitySpec {
    EntitySpec {
        name: "todo".into(),
        table: "todos".into(),
        fields: vec![
            field("id", "text", true, true, None),
            field("title", "text", true, false, None),
            field("done", "boolean", false, false, None),
        ],
    }
}

fn input(template: &str, entities: Vec<EntitySpec>) -> ScaffoldInput {
    ScaffoldInput {
        project_id: "proj_test".into(),
        name: "Test App".into(),
        project_type: "fullstack".into(),
        template: template.into(),
        entities,
        features: vec!["core".into(), "data".into(), "crud-ui".into()],
        ai_integration: true,
        ai_integration_note: None,
        development_mode: false,
    }
}

fn crud_input() -> ScaffoldInput {
    input("next-crud", vec![expense_entity()])
}

#[test]
fn next_crud_generates_runnable_files() {
    let planned = plan(&crud_input()).expect("plan next-crud");
    let files = &planned.files;

    for path in [
        "package.json",
        "next.config.js",
        "tsconfig.json",
        "next-env.d.ts",
        ".gitignore",
        "app/layout.tsx",
        "app/page.tsx",
        "app/globals.css",
        "app/api/health/route.ts",
        "app/expenses/page.tsx",
        "app/expenses/[id]/page.tsx",
        "app/api/expenses/route.ts",
        "app/api/expenses/[id]/route.ts",
        "src/server/data/client.ts",
        "src/server/data/repositories/expense.ts",
        "src/domain/expense-service.ts",
        "src/shared/schema.ts",
        "scripts/postbuild.js",
        "scripts/seed.mjs",
        "scripts/seed-data.json",
        "tests/expenses-contract.test.mjs",
    ] {
        assert!(files.contains_key(path), "missing generated file: {path}");
    }

    let package: Value = serde_json::from_str(&files["package.json"]).expect("package json");
    assert_eq!(package["dependencies"]["next"], "^15.0.0");
    assert_eq!(
        package["scripts"]["build"],
        "next build && node scripts/postbuild.js"
    );

    let next_config = &files["next.config.js"];
    assert!(next_config.contains("output: 'standalone'"));
    assert!(next_config.contains("/.well-known/worldbase/capabilities"));

    let schema = &files["src/shared/schema.ts"];
    assert!(schema.contains("export interface Expense {"));
    assert!(schema.contains("export interface CreateExpenseInput {"));
    assert!(schema.contains("export interface UpdateExpenseInput {"));
    assert!(schema.contains("title: string"));
    assert!(schema.contains("amount: number"));
    assert!(schema.contains("created_at?: string"));
    assert!(schema.contains("deleted_at?: string"));

    let repository = &files["src/server/data/repositories/expense.ts"];
    for name in [
        "listExpenses",
        "getExpense",
        "createExpense",
        "updateExpense",
        "removeExpense",
        "searchExpenses",
    ] {
        assert!(
            repository.contains(&format!("export async function {name}")),
            "repository missing {name}"
        );
    }
    assert!(repository.contains("queryRecords"));
    assert!(repository.contains("saveRecords"));

    let service = &files["src/domain/expense-service.ts"];
    for name in [
        "listExpenses",
        "getExpense",
        "createExpense",
        "updateExpense",
        "removeExpense",
        "searchExpenses",
    ] {
        assert!(
            service.contains(&format!("export async function {name}")),
            "domain service missing {name}"
        );
    }

    let collection = &files["app/api/expenses/route.ts"];
    assert!(collection.contains("export async function GET"));
    assert!(collection.contains("export async function POST"));
    let item = &files["app/api/expenses/[id]/route.ts"];
    assert!(item.contains("export async function GET"));
    assert!(item.contains("export async function PUT"));
    assert!(item.contains("export async function DELETE"));

    let list_page = &files["app/expenses/page.tsx"];
    assert!(list_page.starts_with("'use client'"));
    assert!(list_page.contains("/api/expenses"));
    assert!(list_page.contains("New Expense"));

    let seed: Value = serde_json::from_str(&files["scripts/seed-data.json"]).expect("seed json");
    assert_eq!(seed["tables"][0]["table"], "expenses");
    assert_eq!(seed["tables"][0]["records"].as_array().unwrap().len(), 2);
}

#[test]
fn meta_declares_tables_and_columns_including_soft_delete() {
    let planned = plan(&crud_input()).expect("plan next-crud");
    let meta = &planned.meta;

    assert_eq!(meta["template"]["id"], "next-crud");
    assert_eq!(
        meta["runtime"]["backend"]["command"],
        "node .next/standalone/server.js"
    );
    assert!(meta["dataSchema"]["tables"].is_array());
    let tables = meta["dataSchema"]["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0]["name"], "expenses");

    let columns = tables[0]["columns"].as_array().unwrap();
    let find = |name: &str| {
        columns
            .iter()
            .find(|column| column["name"] == name)
            .unwrap_or_else(|| panic!("missing column {name}"))
    };
    assert_eq!(find("id")["primaryKey"], true);
    assert_eq!(find("id")["type"], "TEXT");
    assert_eq!(find("title")["notNull"], true);
    assert_eq!(find("amount")["type"], "REAL");
    assert_eq!(find("created_at")["defaultSql"], "CURRENT_TIMESTAMP");
    assert!(find("deleted_at")["type"] == "TEXT");

    let endpoints = meta["api"]["endpoints"].as_array().unwrap();
    assert!(endpoints
        .iter()
        .any(|endpoint| endpoint["path"] == "/api/expenses"));
    assert!(endpoints
        .iter()
        .any(|endpoint| endpoint["path"] == "/api/expenses/{id}"));
}

#[test]
fn multiple_entities_generate_files_and_schema() {
    let planned = plan(&input("next-crud", vec![expense_entity(), todo_entity()]))
        .expect("plan multi entity");

    for path in [
        "app/expenses/page.tsx",
        "app/todos/page.tsx",
        "app/api/todos/route.ts",
        "src/domain/todo-service.ts",
        "src/server/data/repositories/todo.ts",
        "tests/todos-contract.test.mjs",
    ] {
        assert!(planned.files.contains_key(path), "missing {path}");
    }

    let schema = &planned.files["src/shared/schema.ts"];
    assert!(schema.contains("export interface Expense {"));
    assert!(schema.contains("export interface Todo {"));

    let tables = planned.meta["dataSchema"]["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 2);
    assert!(tables.iter().any(|table| table["name"] == "expenses"));
    assert!(tables.iter().any(|table| table["name"] == "todos"));
}

#[test]
fn unsupported_template_and_feature_are_rejected() {
    let mut bad_template = crud_input();
    bad_template.template = "remix-crud".into();
    let error = plan(&bad_template).expect_err("unsupported template");
    assert!(error.to_string().contains("unsupported template"));

    let mut bad_feature = crud_input();
    bad_feature.features.push("teleport".into());
    let error = plan(&bad_feature).expect_err("unsupported feature");
    assert!(error.to_string().contains("unsupported feature"));

    let mut duplicate = crud_input();
    duplicate.features.push("core".into());
    let error = plan(&duplicate).expect_err("duplicate feature");
    assert!(error.to_string().contains("duplicate feature"));
}

#[test]
fn entity_without_identifier_is_rejected() {
    let mut entity = expense_entity();
    entity.fields.retain(|field| field.name != "id");
    let error = plan(&input("next-crud", vec![entity])).expect_err("missing id");
    assert!(error
        .to_string()
        .contains("primary key field or an `id` field"));
}

#[test]
fn blank_template_is_a_minimal_next_shell() {
    let planned = plan(&input("blank", Vec::new())).expect("plan blank");
    for path in [
        "package.json",
        "next.config.js",
        "tsconfig.json",
        ".gitignore",
        "app/layout.tsx",
        "app/page.tsx",
        "app/globals.css",
        "app/api/health/route.ts",
        "scripts/postbuild.js",
    ] {
        assert!(planned.files.contains_key(path), "missing {path}");
    }
    assert!(!planned
        .files
        .keys()
        .any(|path| path.contains("/api/expenses")));
    let tables = planned.meta["dataSchema"]["tables"].as_array().unwrap();
    assert!(tables.is_empty());
}

#[test]
fn node_api_template_generates_http_server() {
    let planned = plan(&input("node-api", vec![expense_entity()])).expect("plan node-api");
    for path in [
        "package.json",
        ".gitignore",
        "server.mjs",
        "src/data/client.mjs",
        "src/data/repositories/expense.mjs",
        "src/domain/expense-service.mjs",
        "tests/expenses-contract.test.mjs",
    ] {
        assert!(planned.files.contains_key(path), "missing {path}");
    }

    let server = &planned.files["server.mjs"];
    assert!(server.contains("http.createServer"));
    assert!(server.contains("/api/expenses"));
    assert!(server.contains("appId"));
    assert!(server.contains("from './src/domain/expense-service.mjs'"));
    assert!(server.contains("listExpenses"));

    assert_eq!(planned.meta["framework"], "node");
    assert_eq!(
        planned.meta["runtime"]["backend"]["command"],
        "node server.mjs"
    );
}

#[test]
fn dashboard_template_reuses_crud_and_adds_chart_home() {
    let planned = plan(&input("next-dashboard", vec![expense_entity()])).expect("plan dashboard");
    assert!(planned.files.contains_key("app/expenses/page.tsx"));
    assert!(planned.files.contains_key("src/domain/expense-service.ts"));

    let home = &planned.files["app/page.tsx"];
    assert!(home.contains("bar-chart"));
    assert!(home.contains("Records by entity"));
    assert!(home.contains("appName"));
}

#[test]
fn merge_helpers_prefer_user_values() {
    let planned = plan(&crud_input()).expect("plan");
    let user_meta = serde_json::json!({ "name": "User Name", "custom": true });
    let merged = merge_meta(&planned.meta, &user_meta);
    assert_eq!(merged["name"], "User Name");
    assert_eq!(merged["custom"], true);
    assert_eq!(merged["template"]["id"], "next-crud");

    let mut user_files = BTreeMap::new();
    user_files.insert("app/page.tsx".to_string(), "user page".to_string());
    let merged = merge_files(planned.files.clone(), &user_files);
    assert_eq!(merged["app/page.tsx"], "user page");
    assert!(merged.contains_key("src/domain/expense-service.ts"));
}

#[test]
fn supported_features_are_stable() {
    for feature in [
        "core", "data", "crud-ui", "ai", "search", "upload", "chart", "settings",
    ] {
        assert!(
            SUPPORTED_FEATURES.contains(&feature),
            "missing feature {feature}"
        );
    }
}

#[test]
fn ai_integration_none_generates_manifest_without_capabilities() {
    let mut request = crud_input();
    request.ai_integration = false;
    let planned = plan(&request).expect("plan without AI integration");
    assert!(planned.capabilities.is_empty());
    assert!(!planned.files.contains_key("src/ai/capabilities.ts"));
    assert!(!planned
        .files
        .contains_key("app/worldbase/capabilities/invoke/route.ts"));
    let manifest: Value = serde_json::from_str(&planned.files[".worldbase/app-capabilities.json"])
        .expect("parse manifest");
    assert_eq!(manifest["aiIntegration"], "none");
    assert!(manifest["capabilities"]
        .as_array()
        .is_some_and(|capabilities| capabilities.is_empty()));
    assert!(manifest["runtime"].get("healthCheck").is_none());
}

#[test]
fn node_api_generates_ai_rpc_files_and_server_routes() {
    let planned = plan(&input("node-api", vec![expense_entity()])).expect("plan node-api");
    for path in [
        "src/ai/capabilities.mjs",
        "src/ai/invoke.mjs",
        "tests/capability_contract/expense.test.mjs",
    ] {
        assert!(planned.files.contains_key(path), "missing {path}");
    }
    let server = &planned.files["server.mjs"];
    assert!(server.contains("/worldbase/capabilities/invoke"));
    assert!(server.contains("/.well-known/worldbase/capabilities"));
    assert!(server.contains("WORLDBASE_APP_TOKEN"));
    let adapter = &planned.files["src/ai/capabilities.mjs"];
    assert!(adapter.contains("listExpenses"));
    assert!(adapter.contains("expense.create"));
}

#[test]
fn blank_template_rejects_entities() {
    let error = plan(&input("blank", vec![expense_entity()])).expect_err("blank with entities");
    assert!(
        error.to_string().contains("does not generate entity files"),
        "{error}"
    );
}
