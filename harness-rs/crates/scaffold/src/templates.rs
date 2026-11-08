use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::render;
use crate::types::{EntitySpec, FieldSpec};
use crate::ScaffoldInput;

const CRUD_PACKAGE: &str = include_str!("../templates/next-crud/shell/package.json.tmpl");
const CRUD_NEXT_CONFIG: &str = include_str!("../templates/next-crud/shell/next.config.js.tmpl");
const CRUD_TSCONFIG: &str = include_str!("../templates/next-crud/shell/tsconfig.json");
const CRUD_NEXT_ENV: &str = include_str!("../templates/next-crud/shell/next-env.d.ts");
const CRUD_LAYOUT: &str = include_str!("../templates/next-crud/shell/app/layout.tsx.tmpl");
const CRUD_HOME: &str = include_str!("../templates/next-crud/shell/app/page.tsx.tmpl");
const CRUD_GLOBALS_CSS: &str = include_str!("../templates/next-crud/shell/app/globals.css");
const CRUD_POSTBUILD: &str = include_str!("../templates/next-crud/shell/scripts/postbuild.js");
const CRUD_SEED: &str = include_str!("../templates/next-crud/shell/scripts/seed.mjs");
const CRUD_HEALTH: &str = include_str!("../templates/next-crud/shell/app/api-health-route.ts.tmpl");
// Stored without the leading dot so git does not apply the template's own
// ignore rules to the Rust crate; it is written out as `.gitignore`.
const CRUD_GITIGNORE: &str = include_str!("../templates/next-crud/gitignore.tmpl");

const DATA_CLIENT: &str = include_str!("../templates/next-crud/shared/src/server/data/client.ts");
const SCHEMA_HEADER: &str =
    include_str!("../templates/next-crud/shared/src/shared/schema.header.ts");

const SCHEMA_FRAGMENT: &str =
    include_str!("../templates/next-crud/entity/src/shared/schema.fragment.ts.tmpl");
const REPOSITORY: &str =
    include_str!("../templates/next-crud/entity/src/server/data/repositories/entity.ts.tmpl");
const DOMAIN_SERVICE: &str =
    include_str!("../templates/next-crud/entity/src/domain/entity-service.ts.tmpl");
const COLLECTION_ROUTE: &str =
    include_str!("../templates/next-crud/entity/app/api-collection-route.ts.tmpl");
const ITEM_ROUTE: &str = include_str!("../templates/next-crud/entity/app/api-item-route.ts.tmpl");
const LIST_PAGE: &str = include_str!("../templates/next-crud/entity/app/list-page.tsx.tmpl");
const DETAIL_PAGE: &str = include_str!("../templates/next-crud/entity/app/detail-page.tsx.tmpl");
const ENTITY_TEST: &str =
    include_str!("../templates/next-crud/entity/tests/entity-contract.test.mjs.tmpl");

const DASHBOARD_HOME: &str = include_str!("../templates/next-dashboard/app/home-page.tsx.tmpl");
const BLANK_HOME: &str = include_str!("../templates/blank/app/page.tsx.tmpl");
const BLANK_HEALTH: &str = include_str!("../templates/blank/app/api/health/route.ts.tmpl");
const BLANK_SEED: &str = include_str!("../templates/blank/scripts/seed.mjs");

const NODE_PACKAGE: &str = include_str!("../templates/node-api/package.json.tmpl");
const NODE_GITIGNORE: &str = include_str!("../templates/node-api/gitignore.tmpl");
const NODE_SERVER: &str = include_str!("../templates/node-api/server.mjs.tmpl");
const NODE_ROUTES: &str = include_str!("../templates/node-api/entity/routes.mjs.tmpl");
const NODE_IMPORTS: &str = include_str!("../templates/node-api/entity/imports.mjs.tmpl");
const NODE_CLIENT: &str = include_str!("../templates/node-api/src/data/client.mjs");
const NODE_REPOSITORY: &str = include_str!("../templates/node-api/entity/repository.mjs.tmpl");
const NODE_SERVICE: &str = include_str!("../templates/node-api/entity/service.mjs.tmpl");
const NODE_TEST: &str = include_str!("../templates/node-api/entity/contract.test.mjs.tmpl");

/// Generate the template-owned files (UI, data layer, API routes, scripts).
pub fn template_files(input: &ScaffoldInput) -> Result<BTreeMap<String, String>> {
    match input.template.as_str() {
        "next-crud" => next_crud_files(input),
        "next-dashboard" => next_dashboard_files(input),
        "node-api" => node_api_files(input),
        "blank" => blank_files(input),
        other => bail!("unsupported template: {other}"),
    }
}

fn next_crud_files(input: &ScaffoldInput) -> Result<BTreeMap<String, String>> {
    let globals = global_vars(input);
    let mut files = BTreeMap::new();

    for (path, template) in [
        ("package.json", CRUD_PACKAGE),
        ("next.config.js", CRUD_NEXT_CONFIG),
        ("tsconfig.json", CRUD_TSCONFIG),
        ("next-env.d.ts", CRUD_NEXT_ENV),
        (".gitignore", CRUD_GITIGNORE),
        ("app/layout.tsx", CRUD_LAYOUT),
        ("app/page.tsx", CRUD_HOME),
        ("app/globals.css", CRUD_GLOBALS_CSS),
        ("app/api/health/route.ts", CRUD_HEALTH),
        ("scripts/postbuild.js", CRUD_POSTBUILD),
        ("scripts/seed.mjs", CRUD_SEED),
        ("src/server/data/client.ts", DATA_CLIENT),
    ] {
        files.insert(path.to_string(), render::render(template, &globals));
    }

    let mut schema = render::render(SCHEMA_HEADER, &globals);
    for entity in &input.entities {
        let vars = entity_vars(entity);
        schema.push_str(&render::render(SCHEMA_FRAGMENT, &vars));
        schema.push('\n');
    }
    files.insert("src/shared/schema.ts".into(), schema);
    files.insert("scripts/seed-data.json".into(), seed_data_json(input)?);

    insert_entity_files(input, &mut files);
    Ok(files)
}

fn next_dashboard_files(input: &ScaffoldInput) -> Result<BTreeMap<String, String>> {
    let mut files = next_crud_files(input)?;
    let globals = global_vars(input);
    files.insert(
        "app/page.tsx".into(),
        render::render(DASHBOARD_HOME, &globals),
    );
    Ok(files)
}

fn node_api_files(input: &ScaffoldInput) -> Result<BTreeMap<String, String>> {
    let globals = global_vars(input);
    let mut files = BTreeMap::new();
    files.insert(
        "package.json".into(),
        render::render(NODE_PACKAGE, &globals),
    );
    files.insert(".gitignore".into(), NODE_GITIGNORE.to_string());
    files.insert("src/data/client.mjs".into(), NODE_CLIENT.to_string());

    let mut routes = String::new();
    let mut imports = String::new();
    for entity in &input.entities {
        let vars = entity_vars(entity);
        routes.push_str(&render::render(NODE_ROUTES, &vars));
        imports.push_str(&render::render(NODE_IMPORTS, &vars));
    }
    let mut server_vars = globals;
    server_vars.insert("entity_routes".into(), routes);
    server_vars.insert("entity_imports".into(), imports);
    files.insert(
        "server.mjs".into(),
        render::render(NODE_SERVER, &server_vars),
    );

    for entity in &input.entities {
        let vars = entity_vars(entity);
        let entries = [
            ("src/data/repositories/{{entity_name}}.mjs", NODE_REPOSITORY),
            ("src/domain/{{entity_name}}-service.mjs", NODE_SERVICE),
            ("tests/{{table_name}}-contract.test.mjs", NODE_TEST),
        ];
        for (path_template, template) in entries {
            files.insert(
                render::render(path_template, &vars),
                render::render(template, &vars),
            );
        }
    }

    Ok(files)
}

fn blank_files(input: &ScaffoldInput) -> Result<BTreeMap<String, String>> {
    let mut globals = global_vars(input);
    globals.insert("entity_nav_json".into(), "[]".into());
    let mut files = BTreeMap::new();

    for (path, template) in [
        ("package.json", CRUD_PACKAGE),
        ("next.config.js", CRUD_NEXT_CONFIG),
        ("tsconfig.json", CRUD_TSCONFIG),
        ("next-env.d.ts", CRUD_NEXT_ENV),
        (".gitignore", CRUD_GITIGNORE),
        ("app/layout.tsx", CRUD_LAYOUT),
        ("app/page.tsx", BLANK_HOME),
        ("app/globals.css", CRUD_GLOBALS_CSS),
        ("app/api/health/route.ts", BLANK_HEALTH),
        ("scripts/postbuild.js", CRUD_POSTBUILD),
        ("scripts/seed.mjs", BLANK_SEED),
    ] {
        files.insert(path.to_string(), render::render(template, &globals));
    }
    files.insert(
        "scripts/seed-data.json".into(),
        "{\n  \"tables\": []\n}\n".into(),
    );

    Ok(files)
}

fn insert_entity_files(input: &ScaffoldInput, files: &mut BTreeMap<String, String>) {
    for entity in &input.entities {
        let vars = entity_vars(entity);
        let entries = [
            ("app/{{table_name}}/page.tsx", LIST_PAGE),
            ("app/{{table_name}}/[id]/page.tsx", DETAIL_PAGE),
            ("app/api/{{table_name}}/route.ts", COLLECTION_ROUTE),
            ("app/api/{{table_name}}/[id]/route.ts", ITEM_ROUTE),
            (
                "src/server/data/repositories/{{entity_name}}.ts",
                REPOSITORY,
            ),
            ("src/domain/{{entity_name}}-service.ts", DOMAIN_SERVICE),
            ("tests/{{table_name}}-contract.test.mjs", ENTITY_TEST),
        ];
        for (path_template, template) in entries {
            files.insert(
                render::render(path_template, &vars),
                render::render(template, &vars),
            );
        }
    }
}

fn global_vars(input: &ScaffoldInput) -> BTreeMap<String, String> {
    let nav = input
        .entities
        .iter()
        .map(|entity| {
            json!({
                "table": entity.table,
                "title": title_case(&entity.snake()),
                "href": format!("/{}", entity.table),
            })
        })
        .collect::<Vec<_>>();
    let nav_json = to_json(&nav);
    let primary = input.entities.first();

    let mut vars = BTreeMap::new();
    insert(&mut vars, "project_name", &input.name);
    insert(&mut vars, "project_name_ts", json_string(&input.name));
    insert(&mut vars, "project_id", &input.project_id);
    insert(&mut vars, "project_id_ts", json_string(&input.project_id));
    insert(&mut vars, "app_id", input.app_id());
    insert(&mut vars, "app_id_ts", json_string(&input.app_id()));
    insert(&mut vars, "template_id", &input.template);
    insert(&mut vars, "template_id_ts", json_string(&input.template));
    insert(&mut vars, "project_type", &input.project_type);
    insert(&mut vars, "features_csv", input.features.join(","));
    insert(&mut vars, "package_name", package_name(input));
    insert(&mut vars, "entity_nav_json", nav_json);
    insert(
        &mut vars,
        "primary_table",
        primary.map(|entity| entity.table.as_str()).unwrap_or(""),
    );
    insert(
        &mut vars,
        "primary_title",
        primary
            .map(|entity| title_case(&entity.snake()))
            .unwrap_or_default(),
    );
    insert(
        &mut vars,
        "primary_page_base",
        primary
            .map(|entity| format!("/{}", entity.table))
            .unwrap_or_default(),
    );
    insert(
        &mut vars,
        "primary_route_base",
        primary
            .map(|entity| format!("/api/{}", entity.table))
            .unwrap_or_default(),
    );
    insert(&mut vars, "health_path", "/api/health");
    vars
}

fn entity_vars(entity: &EntitySpec) -> BTreeMap<String, String> {
    let snake = entity.snake();
    let pascal = entity.pascal();
    let title = title_case(&snake);
    let fields = effective_fields(entity);
    let id_field = entity
        .id_field()
        .map(|field| field.name.clone())
        .unwrap_or_else(|| "id".to_string());
    let id_ts_type = fields
        .iter()
        .find(|field| field.name == id_field)
        .map(|field| field.ts_type())
        .unwrap_or("string");
    let id_generator = if id_ts_type == "number" {
        "Date.now()"
    } else {
        "newId()"
    };
    let order_column = if entity.has_field("created_at") {
        "created_at".to_string()
    } else {
        id_field.clone()
    };

    let interface_fields = fields
        .iter()
        .map(|field| {
            let required = field.primary_key || field.name == id_field || field.required;
            format!(
                "  {}{}: {};",
                field.name,
                if required { "" } else { "?" },
                field.ts_type()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let writable = entity
        .writable_fields()
        .into_iter()
        .filter(|field| field.name != "deleted_at")
        .collect::<Vec<_>>();
    let create_input_fields = writable
        .iter()
        .map(|field| {
            format!(
                "  {}{}: {};",
                field.name,
                if field.required { "" } else { "?" },
                field.ts_type()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let update_input_fields = writable
        .iter()
        .map(|field| format!("  {}?: {};", field.name, field.ts_type()))
        .collect::<Vec<_>>()
        .join("\n");

    let mut list_fields = fields
        .iter()
        .filter(|field| field.name != "deleted_at" && !field.primary_key)
        .map(|field| field_meta(field, false))
        .collect::<Vec<_>>();
    if list_fields.is_empty() {
        list_fields = fields
            .iter()
            .filter(|field| field.name == id_field)
            .map(|field| field_meta(field, false))
            .collect();
    }
    let form_fields = writable
        .iter()
        .map(|field| field_meta(field, true))
        .collect::<Vec<_>>();
    let search_fields = fields
        .iter()
        .filter(|field| field.name != "deleted_at" && field.ts_type() == "string")
        .map(|field| field.name.clone())
        .collect::<Vec<_>>();

    let created_at_setup = if entity.has_field("created_at") {
        "  const now = new Date().toISOString()\n  if (record['created_at'] === undefined) record['created_at'] = now".to_string()
    } else {
        String::new()
    };

    let mut vars = BTreeMap::new();
    insert(&mut vars, "entity_name", &snake);
    insert(&mut vars, "entity_pascal", &pascal);
    insert(
        &mut vars,
        "entity_plural_pascal",
        pascal_from_snake(&entity.table),
    );
    insert(&mut vars, "entity_camel", entity.camel());
    insert(&mut vars, "entity_title", &title);
    insert(&mut vars, "entity_title_ts", json_string(&title));
    insert(&mut vars, "table_name", &entity.table);
    insert(&mut vars, "route_base", format!("/api/{}", entity.table));
    insert(&mut vars, "page_base", format!("/{}", entity.table));
    insert(&mut vars, "id_field", &id_field);
    insert(&mut vars, "id_ts_type", id_ts_type);
    insert(&mut vars, "id_generator", id_generator);
    insert(&mut vars, "order_column", order_column);
    insert(&mut vars, "list_fields_json", to_json(&list_fields));
    insert(&mut vars, "form_fields_json", to_json(&form_fields));
    insert(&mut vars, "search_fields_json", to_json(&search_fields));
    insert(&mut vars, "interface_fields", interface_fields);
    insert(&mut vars, "create_input_fields", create_input_fields);
    insert(&mut vars, "update_input_fields", update_input_fields);
    insert(&mut vars, "created_at_setup", created_at_setup);
    vars
}

/// Declared fields plus the implicit soft-delete column used by generated
/// repositories. `dataSchema.tables` must declare `deleted_at` or the host data
/// API would reject the write.
pub fn effective_fields(entity: &EntitySpec) -> Vec<FieldSpec> {
    let mut fields = entity.fields.clone();
    if !fields.iter().any(|field| field.name == "deleted_at") {
        fields.push(FieldSpec {
            name: "deleted_at".to_string(),
            field_type: "text".to_string(),
            required: false,
            primary_key: false,
            default_sql: None,
        });
    }
    fields
}

fn field_meta(field: &FieldSpec, form: bool) -> Value {
    let mut value = json!({
        "name": field.name,
        "label": title_case(&field.name),
        "type": ui_type(field),
    });
    if form {
        value["required"] = json!(field.required);
        value["step"] = if field.ts_type() == "number" {
            json!("any")
        } else {
            Value::Null
        };
    }
    value
}

fn ui_type(field: &FieldSpec) -> &'static str {
    match field.ts_type() {
        "number" => "number",
        "boolean" => "checkbox",
        _ => "text",
    }
}

fn seed_data_json(input: &ScaffoldInput) -> Result<String> {
    let mut tables = Vec::new();
    for entity in &input.entities {
        let fields = effective_fields(entity);
        let id_field = entity
            .id_field()
            .map(|field| field.name.clone())
            .unwrap_or_else(|| "id".to_string());
        let mut records = Vec::new();
        for index in 1..=2 {
            let mut record = serde_json::Map::new();
            for field in &fields {
                if field.name == "deleted_at" {
                    continue;
                }
                let value = if field.name == id_field {
                    if field.ts_type() == "number" {
                        json!(index)
                    } else {
                        json!(format!("seed-{}-{index}", entity.table))
                    }
                } else if field.name == "created_at" {
                    json!("2026-01-01T00:00:00.000Z")
                } else {
                    sample_value(field, index)
                };
                record.insert(field.name.clone(), value);
            }
            records.push(Value::Object(record));
        }
        tables.push(json!({ "table": entity.table, "records": records }));
    }
    let payload = json!({
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "tables": tables,
    });
    let text = serde_json::to_string_pretty(&payload).context("serialize seed data")?;
    Ok(format!("{text}\n"))
}

fn sample_value(field: &FieldSpec, index: u32) -> Value {
    match field.ts_type() {
        "number" => json!(index * 10),
        "boolean" => json!(index == 2),
        _ => json!(format!("{} sample {index}", title_case(&field.name))),
    }
}

fn package_name(input: &ScaffoldInput) -> String {
    let lower = input.project_id.to_ascii_lowercase();
    let mut slug = String::new();
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "worldbase-app".to_string()
    } else {
        format!("worldbase-{slug}")
    }
}

fn pascal_from_snake(value: &str) -> String {
    value
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect()
}

fn title_case(value: &str) -> String {
    value
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string())
}

fn insert(vars: &mut BTreeMap<String, String>, key: &str, value: impl Into<String>) {
    vars.insert(key.to_string(), value.into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity() -> EntitySpec {
        EntitySpec {
            name: "expense".into(),
            table: "expenses".into(),
            fields: vec![
                FieldSpec {
                    name: "id".into(),
                    field_type: "text".into(),
                    required: true,
                    primary_key: true,
                    default_sql: None,
                },
                FieldSpec {
                    name: "title".into(),
                    field_type: "text".into(),
                    required: true,
                    primary_key: false,
                    default_sql: None,
                },
                FieldSpec {
                    name: "amount".into(),
                    field_type: "number".into(),
                    required: true,
                    primary_key: false,
                    default_sql: None,
                },
            ],
        }
    }

    #[test]
    fn effective_fields_adds_soft_delete_column() {
        let fields = effective_fields(&entity());
        assert!(fields.iter().any(|field| field.name == "deleted_at"));
    }

    #[test]
    fn entity_vars_use_spec_names() {
        let vars = entity_vars(&entity());
        assert_eq!(
            vars.get("entity_pascal").map(String::as_str),
            Some("Expense")
        );
        assert_eq!(
            vars.get("route_base").map(String::as_str),
            Some("/api/expenses")
        );
        assert_eq!(vars.get("order_column").map(String::as_str), Some("id"));
    }
}
