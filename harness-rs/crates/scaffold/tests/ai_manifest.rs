use serde_json::Value;
use worldbase_scaffold::types::{EntitySpec, FieldSpec, ScaffoldInput};
use worldbase_scaffold::{ai_files, manifest};

fn field(name: &str, field_type: &str, required: bool, primary_key: bool) -> FieldSpec {
    FieldSpec {
        name: name.to_string(),
        field_type: field_type.to_string(),
        required,
        primary_key,
        default_sql: None,
    }
}

fn sample_input() -> ScaffoldInput {
    ScaffoldInput {
        project_id: "proj_demo".to_string(),
        name: "Demo App".to_string(),
        project_type: "crud".to_string(),
        template: "next-crud".to_string(),
        entities: vec![
            EntitySpec {
                name: "expense".to_string(),
                table: "expenses".to_string(),
                fields: vec![
                    field("id", "text", true, true),
                    field("title", "text", true, false),
                    field("amount", "number", true, false),
                    field("created_at", "text", false, false),
                ],
            },
            EntitySpec {
                name: "category".to_string(),
                table: "categories".to_string(),
                fields: vec![
                    field("id", "text", true, true),
                    field("name", "text", true, false),
                ],
            },
        ],
        features: vec![
            "core".to_string(),
            "data".to_string(),
            "crud-ui".to_string(),
            "ai".to_string(),
            "search".to_string(),
        ],
        ai_integration: true,
        ai_integration_note: None,
        development_mode: false,
    }
}

fn expected_ids() -> Vec<&'static str> {
    vec![
        "app.health",
        "expense.list",
        "expense.get",
        "expense.create",
        "expense.update",
        "expense.remove",
        "expense.search",
        "category.list",
        "category.get",
        "category.create",
        "category.update",
        "category.remove",
        "category.search",
    ]
}

#[test]
fn capability_ids_and_risks_follow_spec() {
    let input = sample_input();
    let capabilities = manifest::build_capabilities(&input).expect("build capabilities");

    let ids = capabilities
        .iter()
        .map(|capability| capability.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, expected_ids());

    let risk = |id: &str| {
        capabilities
            .iter()
            .find(|capability| capability.id == id)
            .unwrap_or_else(|| panic!("missing capability {id}"))
            .risk
            .as_str()
    };

    assert_eq!(risk("app.health"), "read");
    for id in ["expense.list", "expense.get", "expense.search"] {
        assert_eq!(risk(id), "read", "{id}");
    }
    assert_eq!(risk("expense.create"), "write_reversible");
    assert_eq!(risk("expense.update"), "write_reversible");
    assert_eq!(risk("expense.remove"), "write_destructive");
    assert_eq!(risk("category.create"), "write_reversible");
    assert_eq!(risk("category.update"), "write_reversible");
    assert_eq!(risk("category.remove"), "write_destructive");

    for capability in &capabilities {
        assert!(!capability.title.is_empty(), "{} title", capability.id);
        assert!(
            !capability.description.is_empty(),
            "{} description",
            capability.id
        );
        assert_eq!(capability.operation, capability.id);
        assert_eq!(capability.input_schema["type"], "object");
        assert_eq!(
            capability.input_schema["additionalProperties"],
            Value::Bool(false)
        );

        let output_schema = capability
            .output_schema
            .as_ref()
            .unwrap_or_else(|| panic!("{} output schema", capability.id));
        assert_eq!(output_schema["type"], "object");
        assert!(!capability.tags.is_empty(), "{} tags", capability.id);
    }

    for entity in &input.entities {
        let snake = entity.snake();
        for operation in ["list", "get", "create", "update", "remove", "search"] {
            let id = format!("{snake}.{operation}");
            let capability = capabilities
                .iter()
                .find(|capability| capability.id == id)
                .unwrap_or_else(|| panic!("missing capability {id}"));
            assert!(
                capability.tags.iter().any(|tag| tag == &entity.name),
                "{id} tags include entity name"
            );
            assert!(
                capability.tags.iter().any(|tag| tag == &input.name),
                "{id} tags include project name"
            );
        }
    }

    let create = capabilities
        .iter()
        .find(|capability| capability.id == "expense.create")
        .expect("expense.create");
    let required = create.input_schema["required"]
        .as_array()
        .expect("create required list");
    assert!(required.iter().any(|value| value == "title"));
    assert!(required.iter().any(|value| value == "amount"));
    assert!(!required.iter().any(|value| value == "id"));
    assert!(create.input_schema["properties"]
        .get("created_at")
        .is_none());

    let get = capabilities
        .iter()
        .find(|capability| capability.id == "expense.get")
        .expect("expense.get");
    assert_eq!(get.input_schema["required"], Value::from(vec!["id"]));

    let remove = capabilities
        .iter()
        .find(|capability| capability.id == "expense.remove")
        .expect("expense.remove");
    assert!(remove.side_effects);
    assert!(!remove.idempotent);
}

#[test]
fn manifest_shape_matches_spec() {
    let input = sample_input();
    let capabilities = manifest::build_capabilities(&input).expect("build capabilities");
    let document = manifest::manifest_json(&input, &capabilities);

    assert_eq!(document["schemaVersion"], 1);
    assert_eq!(document["app"]["id"], "worldbase.local.proj_demo");
    assert_eq!(document["app"]["name"], "Demo App");
    assert_eq!(document["app"]["version"], "0.1.0");
    assert_eq!(document["app"]["trustLevel"], "untrusted");

    let tags = document["app"]["tags"].as_array().expect("app tags");
    for expected in [
        "worldbase.scaffold",
        "next-crud",
        "crud",
        "Demo App",
        "expense",
        "category",
    ] {
        assert!(
            tags.iter().any(|tag| tag == expected),
            "missing app tag {expected}"
        );
    }

    assert_eq!(document["runtime"]["kind"], "managed_project");
    assert_eq!(document["runtime"]["activation"], "on-demand");
    assert_eq!(document["runtime"]["healthCheck"], "app.health");

    let entries = document["capabilities"].as_array().expect("capabilities");
    assert_eq!(entries.len(), capabilities.len());
    for (entry, capability) in entries.iter().zip(capabilities.iter()) {
        assert_eq!(entry["id"], capability.id);
        assert_eq!(entry["operation"], capability.operation);
        assert_eq!(entry["risk"], capability.risk);
        assert_eq!(entry["sideEffects"], capability.side_effects);
        assert_eq!(entry["idempotent"], capability.idempotent);
        assert_eq!(entry["inputSchema"]["type"], "object");
        assert_eq!(entry["outputSchema"]["type"], "object");
    }
}

#[test]
fn app_tags_include_scaffold_marker_once() {
    let mut input = sample_input();
    // The project name is also an app tag, so this exercises deduplication.
    input.name = "worldbase.scaffold".to_string();

    let capabilities = manifest::build_capabilities(&input).expect("build capabilities");
    let document = manifest::manifest_json(&input, &capabilities);

    let tags = document["app"]["tags"].as_array().expect("app tags");
    let scaffold_tags = tags
        .iter()
        .filter(|tag| tag.as_str() == Some("worldbase.scaffold"))
        .count();
    assert_eq!(scaffold_tags, 1, "scaffold tag must appear exactly once");
    assert!(
        tags.iter().any(|tag| tag == "next-crud"),
        "scaffold tag must not replace existing tags"
    );
}

#[test]
fn generated_files_cover_fixed_rpc_contract() {
    let input = sample_input();
    let capabilities = manifest::build_capabilities(&input).expect("build capabilities");
    let files = ai_files::generate(&input, &capabilities).expect("generate AI files");

    let required_paths = [
        ".worldbase/app-capabilities.json",
        "src/ai/capabilities.ts",
        "src/ai/invoke.ts",
        "app/worldbase/capabilities/invoke/route.ts",
        "app/api/worldbase/capabilities/route.ts",
        "scripts/generate-manifest.mjs",
        "tests/capability_contract/expense.test.mjs",
        "tests/capability_contract/category.test.mjs",
        "AI_INTEGRATION.md",
        "AGENTS.md",
    ];
    for path in required_paths {
        assert!(files.contains_key(path), "missing generated file {path}");
    }

    let manifest_file: Value = serde_json::from_str(
        files
            .get(".worldbase/app-capabilities.json")
            .expect("manifest file"),
    )
    .expect("manifest JSON");
    assert_eq!(manifest_file["schemaVersion"], 1);
    assert_eq!(manifest_file["runtime"]["healthCheck"], "app.health");
    assert!(
        manifest_file["app"]["tags"]
            .as_array()
            .is_some_and(|tags| tags.iter().any(|tag| tag == "worldbase.scaffold")),
        "generated manifest must be tagged as a WorldBase scaffold app"
    );

    let invoke_route = files
        .get("app/worldbase/capabilities/invoke/route.ts")
        .expect("invoke route");
    assert!(invoke_route.contains("Bearer ${process.env.WORLDBASE_APP_TOKEN}"));
    assert!(invoke_route.contains("protocolVersion"));
    assert!(invoke_route.contains("deadline"));
    assert!(invoke_route.contains("1024 * 1024"));
    assert!(invoke_route.contains("status: \"ok\""));
    assert!(invoke_route.contains("status: \"error\""));
    assert!(invoke_route.contains("errorCode"));

    let capabilities_ts = files
        .get("src/ai/capabilities.ts")
        .expect("capabilities adapter");
    assert!(capabilities_ts.contains("from \"../domain/expense-service\""));
    assert!(capabilities_ts.contains("from \"../shared/schema\""));
    for function in [
        "listExpenses",
        "getExpense",
        "createExpense",
        "updateExpense",
        "removeExpense",
        "searchExpenses",
    ] {
        assert!(
            capabilities_ts.contains(function),
            "missing domain call {function}"
        );
    }
    for id in expected_ids() {
        assert!(capabilities_ts.contains(id), "missing adapter entry {id}");
    }

    let invoke_ts = files.get("src/ai/invoke.ts").expect("invoke module");
    assert!(invoke_ts.contains("invokeCapability"));
    assert!(invoke_ts.contains("capability_not_found"));
    assert!(invoke_ts.contains("MAX_INPUT_BYTES"));

    let discovery_route = files
        .get("app/api/worldbase/capabilities/route.ts")
        .expect("discovery route");
    assert!(discovery_route.contains("app-capabilities.json"));

    let script = files
        .get("scripts/generate-manifest.mjs")
        .expect("manifest generator");
    assert!(script.contains(".worldbase"));
    assert!(script.contains("app-capabilities.json"));
    assert!(script.contains("\"schemaVersion\": 1"));

    let contract = files
        .get("tests/capability_contract/expense.test.mjs")
        .expect("contract test");
    assert!(contract.contains("expense.list"));
    assert!(contract.contains("write_destructive"));

    let integration_doc = files.get("AI_INTEGRATION.md").expect("AI docs");
    assert!(integration_doc.contains("Demo App"));
    assert!(integration_doc.contains("worldbase.local.proj_demo"));
    assert!(integration_doc.contains("expense.list"));

    let agents_doc = files.get("AGENTS.md").expect("AGENTS.md");
    assert!(agents_doc.contains("Demo App"));
    assert!(agents_doc.contains("proj_demo"));
    assert!(agents_doc.contains("app.health"));
}

#[test]
fn generated_output_has_no_legacy_example_capability() {
    let input = sample_input();
    let capabilities = manifest::build_capabilities(&input).expect("build capabilities");
    let files = ai_files::generate(&input, &capabilities).expect("generate AI files");

    assert!(!files.is_empty());
    for (path, content) in files {
        assert!(
            !content.contains("example.search"),
            "{path} still contains example.search"
        );
        assert!(
            !content.contains("example-service"),
            "{path} still contains example-service"
        );
    }
}
