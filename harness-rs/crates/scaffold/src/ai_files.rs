use std::collections::BTreeMap;
use std::fmt::Write as _;

use anyhow::Result;

use crate::{CapabilitySpec, EntitySpec, FieldSpec, ScaffoldInput};

const INVOKE_TS_TEMPLATE: &str = include_str!("../templates/next-crud/ai/invoke.ts.tmpl");
const INVOKE_ROUTE_TEMPLATE: &str = include_str!("../templates/next-crud/ai/route.invoke.ts.tmpl");
const DISCOVERY_ROUTE_TEMPLATE: &str =
    include_str!("../templates/next-crud/ai/route.discovery.ts.tmpl");
const GENERATE_MANIFEST_TEMPLATE: &str =
    include_str!("../templates/next-crud/ai/generate-manifest.mjs.tmpl");
const AI_INTEGRATION_TEMPLATE: &str =
    include_str!("../templates/next-crud/ai/AI_INTEGRATION.md.tmpl");
const AGENTS_TEMPLATE: &str = include_str!("../templates/next-crud/ai/AGENTS.md.tmpl");
const NODE_INVOKE_TEMPLATE: &str = include_str!("../templates/node-api/ai/invoke.mjs.tmpl");

/// Runtime helpers shared by every generated adapter: strict input validation
/// against the manifest schemas, plus a typed error so `src/ai/invoke.ts` can
/// map failures to stable error codes instead of guessing from messages.
const CAPABILITY_HELPERS: &str = r#"export class CapabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
  }
}

interface AdapterField {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  enumValues?: string[];
}

function asRecord(input: unknown, capabilityId: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${capabilityId} expects an object input`);
  }
  return input as Record<string, unknown>;
}

/**
 * Validate `input` against the capability's declared JSON schema shape.
 * Rejection messages always contain "expects" so the invoke dispatcher maps
 * them to the `input_schema_invalid` error code.
 */
function expectFields(
  capabilityId: string,
  input: Record<string, unknown>,
  fields: AdapterField[],
): void {
  const allowed = fields.map((field) => field.name);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${capabilityId} expects only fields: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}`,
      );
    }
  }
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined) {
      if (field.required) {
        throw new Error(`${capabilityId} expects required field "${field.name}"`);
      }
      continue;
    }
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${capabilityId} expects field "${field.name}" to be a number`);
      }
      if (field.integer && !Number.isInteger(value)) {
        throw new Error(`${capabilityId} expects field "${field.name}" to be an integer`);
      }
      if (field.minimum !== undefined && value < field.minimum) {
        throw new Error(`${capabilityId} expects field "${field.name}" to be >= ${field.minimum}`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw new Error(`${capabilityId} expects field "${field.name}" to be <= ${field.maximum}`);
      }
      continue;
    }
    if (typeof value !== field.type) {
      throw new Error(`${capabilityId} expects field "${field.name}" to be a ${field.type}`);
    }
    if (field.enumValues !== undefined && !field.enumValues.includes(value as string)) {
      throw new Error(
        `${capabilityId} expects field "${field.name}" to be one of: ${field.enumValues.join(", ")}`,
      );
    }
  }
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  capabilityId: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${capabilityId} expects a non-empty string "${key}"`);
  }
  return value;
}

/** Domain services throw plain `... not found` errors; give them a code. */
function asRecordNotFound(error: unknown): unknown {
  if (error instanceof CapabilityError) {
    return error;
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return new CapabilityError("record_not_found", error.message);
  }
  return error;
}

const LIST_FIELDS: AdapterField[] = [
  { name: "limit", type: "number", required: false, integer: true, minimum: 1, maximum: 200 },
  { name: "offset", type: "number", required: false, integer: true, minimum: 0 },
  { name: "orderBy", type: "string", required: false },
  { name: "orderDirection", type: "string", required: false, enumValues: ["asc", "desc"] },
];

const ID_FIELDS: AdapterField[] = [{ name: "id", type: "string", required: true }];

const SEARCH_FIELDS: AdapterField[] = [{ name: "query", type: "string", required: true }];

"#;

const CONTRACT_TEST_TEMPLATE: &str = r#"import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../../.worldbase/app-capabilities.json", import.meta.url), "utf8"),
);

const EXPECTED_RISKS = {
__EXPECTED_RISKS__};

test("__ENTITY__ capabilities are declared with strict schemas", () => {
  for (const [id, risk] of Object.entries(EXPECTED_RISKS)) {
    const capability = manifest.capabilities.find((entry) => entry.id === id);
    assert.ok(capability, `${id} is declared`);
    assert.equal(capability.risk, risk);
    assert.equal(capability.inputSchema?.type, "object");
    assert.equal(capability.outputSchema?.type, "object");
    assert.equal(capability.inputSchema?.additionalProperties, false);
  }
});

test("__ENTITY__ write capabilities declare side effects", () => {
  for (const id of ["__ENTITY__.create", "__ENTITY__.update", "__ENTITY__.remove"]) {
    const capability = manifest.capabilities.find((entry) => entry.id === id);
    assert.ok(capability, `${id} is declared`);
    assert.equal(capability.sideEffects, true);
  }
});

test("__ENTITY__ destructive capability is not marked idempotent", () => {
  const capability = manifest.capabilities.find((entry) => entry.id === "__ENTITY__.remove");
  assert.ok(capability, "__ENTITY__.remove is declared");
  assert.equal(capability.risk, "write_destructive");
  assert.equal(capability.idempotent, false);
});

test.skip("__ENTITY__ adapter uses the domain service", async () => {
  const adapter = await import("../../src/ai/capabilities.ts");
  const capabilities = adapter.capabilities ?? adapter.default?.capabilities;
  assert.ok(capabilities["__ENTITY__.list"]);
});
"#;

/// Generate manifest, adapter, fixed RPC route, docs, and contract tests.
pub fn generate(
    input: &ScaffoldInput,
    capabilities: &[CapabilitySpec],
) -> Result<BTreeMap<String, String>> {
    if input.template == "node-api" {
        return node_api_files(input, capabilities);
    }
    let manifest = crate::manifest::manifest_json(input, capabilities);
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    let manifest_file = format!("{manifest_json}\n");

    let mut files = BTreeMap::new();
    files.insert(
        ".worldbase/app-capabilities.json".to_string(),
        manifest_file,
    );
    files.insert(
        "scripts/generate-manifest.mjs".to_string(),
        GENERATE_MANIFEST_TEMPLATE.replace("{{MANIFEST_JSON}}", &manifest_json),
    );

    if input.ai_integration {
        files.insert(
            "src/ai/capabilities.ts".to_string(),
            capabilities_ts(input, capabilities),
        );
        files.insert(
            "src/ai/invoke.ts".to_string(),
            INVOKE_TS_TEMPLATE.to_string(),
        );
        files.insert(
            "app/worldbase/capabilities/invoke/route.ts".to_string(),
            INVOKE_ROUTE_TEMPLATE.to_string(),
        );
        files.insert(
            "app/api/worldbase/capabilities/route.ts".to_string(),
            DISCOVERY_ROUTE_TEMPLATE.to_string(),
        );

        for entity in &input.entities {
            files.insert(
                format!("tests/capability_contract/{}.test.mjs", entity.snake()),
                contract_test(entity),
            );
        }
    }

    files.insert(
        "AI_INTEGRATION.md".to_string(),
        ai_integration_doc(input, capabilities),
    );
    files.insert("AGENTS.md".to_string(), agents_doc(input, capabilities));

    Ok(files)
}

fn node_api_files(
    input: &ScaffoldInput,
    capabilities: &[CapabilitySpec],
) -> Result<BTreeMap<String, String>> {
    let manifest = crate::manifest::manifest_json(input, capabilities);
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    let manifest_file = format!("{manifest_json}\n");

    let mut files = BTreeMap::new();
    files.insert(
        ".worldbase/app-capabilities.json".to_string(),
        manifest_file,
    );
    files.insert(
        "scripts/generate-manifest.mjs".to_string(),
        GENERATE_MANIFEST_TEMPLATE.replace("{{MANIFEST_JSON}}", &manifest_json),
    );

    files.insert(
        "src/ai/capabilities.mjs".to_string(),
        capabilities_mjs(input, capabilities),
    );
    files.insert(
        "src/ai/invoke.mjs".to_string(),
        NODE_INVOKE_TEMPLATE.to_string(),
    );
    if input.ai_integration {
        for entity in &input.entities {
            files.insert(
                format!("tests/capability_contract/{}.test.mjs", entity.snake()),
                contract_test(entity),
            );
        }
    }

    files.insert(
        "AI_INTEGRATION.md".to_string(),
        ai_integration_doc(input, capabilities),
    );
    files.insert("AGENTS.md".to_string(), agents_doc(input, capabilities));
    Ok(files)
}

fn capabilities_mjs(input: &ScaffoldInput, capabilities: &[CapabilitySpec]) -> String {
    let mut out = String::new();
    out.push_str("// Generated by WorldBase scaffold. Do not edit by hand.\n\n");
    if !input.ai_integration {
        out.push_str("export const capabilities = {};\n");
        return out;
    }

    for entity in &input.entities {
        let snake = entity.snake();
        let pascal = entity.pascal();
        let plural = plural_pascal(entity);
        let _ = writeln!(
            out,
            "import {{\n  create{pascal},\n  get{pascal},\n  list{plural},\n  remove{pascal},\n  search{plural},\n  update{pascal},\n}} from \"../domain/{snake}-service.mjs\";"
        );
    }

    let _ = writeln!(out, "const APP_ID = {};\n", json_string(&input.app_id()));
    out.push_str("export const capabilities = {\n");
    let _ = writeln!(
        out,
        "  \"app.health\": {{\n    id: \"app.health\",\n    inputSchema: {},\n    async invoke() {{\n      return {{ status: \"ok\", appId: APP_ID }};\n    }},\n  }},",
        schema_literal(capabilities, "app.health")
    );

    for entity in &input.entities {
        let snake = entity.snake();
        let pascal = entity.pascal();
        let plural = plural_pascal(entity);

        let list_id = format!("{snake}.list");
        let _ = writeln!(
            out,
            "  \"{list_id}\": {{\n    id: \"{list_id}\",\n    inputSchema: {schema},\n    async invoke(input) {{\n      return list{plural}(input ?? {{}});\n    }},\n  }},",
            schema = schema_literal(capabilities, &list_id)
        );

        let get_id = format!("{snake}.get");
        let _ = writeln!(
            out,
            "  \"{get_id}\": {{\n    id: \"{get_id}\",\n    inputSchema: {schema},\n    async invoke(input) {{\n      return get{pascal}(input?.id);\n    }},\n  }},",
            schema = schema_literal(capabilities, &get_id)
        );

        let create_id = format!("{snake}.create");
        let _ = writeln!(
            out,
            "  \"{create_id}\": {{\n    id: \"{create_id}\",\n    inputSchema: {schema},\n    async invoke(input) {{\n      return create{pascal}(input ?? {{}});\n    }},\n  }},",
            schema = schema_literal(capabilities, &create_id)
        );

        let update_id = format!("{snake}.update");
        let _ = writeln!(
            out,
            "  \"{update_id}\": {{\n    id: \"{update_id}\",\n    inputSchema: {schema},\n    async invoke(input) {{\n      const patch = {{ ...(input ?? {{}}) }};\n      delete patch.id;\n      return update{pascal}(input?.id, patch);\n    }},\n  }},",
            schema = schema_literal(capabilities, &update_id)
        );

        let remove_id = format!("{snake}.remove");
        let _ = writeln!(
            out,
            "  \"{remove_id}\": {{\n    id: \"{remove_id}\",\n    inputSchema: {schema},\n    async invoke(input) {{\n      await remove{pascal}(input?.id);\n      return {{ id: input?.id, deleted: true }};\n    }},\n  }},",
            schema = schema_literal(capabilities, &remove_id)
        );

        let search_id = format!("{snake}.search");
        let _ = writeln!(
            out,
            "  \"{search_id}\": {{\n    id: \"{search_id}\",\n    inputSchema: {schema},\n    async invoke(input) {{\n      const items = await search{plural}(input?.query ?? \"\");\n      return {{ items, total: items.length }};\n    }},\n  }},",
            schema = schema_literal(capabilities, &search_id)
        );
    }
    out.push_str("};\n");
    out
}

fn capabilities_ts(input: &ScaffoldInput, capabilities: &[CapabilitySpec]) -> String {
    let mut out = String::new();
    out.push_str("// Generated by WorldBase scaffold. Do not edit by hand.\n\n");

    for entity in &input.entities {
        let snake = entity.snake();
        let pascal = entity.pascal();
        let plural = plural_pascal(entity);
        let _ = writeln!(
            out,
            "import {{\n  create{pascal},\n  get{pascal},\n  list{plural},\n  remove{pascal},\n  search{plural},\n  update{pascal},\n}} from \"../domain/{snake}-service\";"
        );
        let _ = writeln!(
            out,
            "import type {{\n  Create{pascal}Input,\n  Update{pascal}Input,\n}} from \"../shared/schema\";\n"
        );
    }

    out.push_str(
        "export interface CapabilityCallContext {\n  requestId: string;\n  signal?: AbortSignal;\n  deadline?: number;\n}\n\n",
    );
    out.push_str(
        "export interface AppCapability<TInput = unknown, TOutput = unknown> {\n  id: string;\n  inputSchema: Record<string, unknown>;\n  invoke(input: TInput, context: CapabilityCallContext): Promise<TOutput>;\n}\n\n",
    );
    let _ = writeln!(out, "const APP_ID = {};\n", json_string(&input.app_id()));
    out.push_str(CAPABILITY_HELPERS);

    for entity in &input.entities {
        let pascal = entity.pascal();
        let _ = writeln!(
            out,
            "export interface {pascal}ListInput {{\n  limit?: number;\n  offset?: number;\n  orderBy?: string;\n  orderDirection?: \"asc\" | \"desc\";\n}}\n"
        );
    }

    for entity in &input.entities {
        let prefix = entity.snake().to_ascii_uppercase();
        let create_fields = entity
            .writable_fields()
            .iter()
            .map(|field| format!("  {}", adapter_field_literal(field, field.required)))
            .collect::<Vec<_>>()
            .join(",\n");
        let mut update_fields =
            vec!["  { name: \"id\", type: \"string\", required: true }".to_string()];
        update_fields.extend(
            entity
                .writable_fields()
                .iter()
                .map(|field| format!("  {}", adapter_field_literal(field, false))),
        );
        let _ = writeln!(
            out,
            "const {prefix}_CREATE_FIELDS: AdapterField[] = [{}];\n",
            if create_fields.is_empty() {
                String::new()
            } else {
                format!("\n{create_fields}\n")
            }
        );
        let _ = writeln!(
            out,
            "const {prefix}_UPDATE_FIELDS: AdapterField[] = [\n{}\n];\n",
            update_fields.join(",\n")
        );
    }

    out.push_str("export const capabilities: Record<string, AppCapability> = {\n");
    let _ = writeln!(
        out,
        "  \"app.health\": {{\n    id: \"app.health\",\n    inputSchema: {},\n    async invoke(input: unknown) {{\n      expectFields(\"app.health\", asRecord(input ?? {{}}, \"app.health\"), []);\n      return {{ status: \"ok\", appId: APP_ID }};\n    }},\n  }},",
        schema_literal(capabilities, "app.health")
    );

    for entity in &input.entities {
        let snake = entity.snake();
        let pascal = entity.pascal();
        let plural = plural_pascal(entity);
        let prefix = snake.to_ascii_uppercase();

        let list_id = format!("{snake}.list");
        let _ = writeln!(
            out,
            "  \"{list_id}\": {{\n    id: \"{list_id}\",\n    inputSchema: {schema},\n    async invoke(input: unknown) {{\n      const value = asRecord(input ?? {{}}, \"{list_id}\");\n      expectFields(\"{list_id}\", value, LIST_FIELDS);\n      return list{plural}(value as unknown as {pascal}ListInput);\n    }},\n  }},",
            schema = schema_literal(capabilities, &list_id)
        );

        let get_id = format!("{snake}.get");
        let _ = writeln!(
            out,
            "  \"{get_id}\": {{\n    id: \"{get_id}\",\n    inputSchema: {schema},\n    async invoke(input: unknown) {{\n      const value = asRecord(input, \"{get_id}\");\n      expectFields(\"{get_id}\", value, ID_FIELDS);\n      const record = await get{pascal}(requireString(value, \"id\", \"{get_id}\"));\n      if (!record) {{\n        throw new CapabilityError(\n          \"record_not_found\",\n          `{get_id} expects an existing {snake} id`,\n        );\n      }}\n      return record;\n    }},\n  }},",
            schema = schema_literal(capabilities, &get_id)
        );

        let create_id = format!("{snake}.create");
        let _ = writeln!(
            out,
            "  \"{create_id}\": {{\n    id: \"{create_id}\",\n    inputSchema: {schema},\n    async invoke(input: unknown) {{\n      const value = asRecord(input, \"{create_id}\");\n      expectFields(\"{create_id}\", value, {prefix}_CREATE_FIELDS);\n      return create{pascal}(value as unknown as Create{pascal}Input);\n    }},\n  }},",
            schema = schema_literal(capabilities, &create_id)
        );

        let update_id = format!("{snake}.update");
        let _ = writeln!(
            out,
            "  \"{update_id}\": {{\n    id: \"{update_id}\",\n    inputSchema: {schema},\n    async invoke(input: unknown) {{\n      const value = asRecord(input, \"{update_id}\");\n      expectFields(\"{update_id}\", value, {prefix}_UPDATE_FIELDS);\n      const recordId = requireString(value, \"id\", \"{update_id}\");\n      const patch: Record<string, unknown> = {{ ...value }};\n      delete patch.id;\n      try {{\n        return await update{pascal}(recordId, patch as unknown as Update{pascal}Input);\n      }} catch (error) {{\n        throw asRecordNotFound(error);\n      }}\n    }},\n  }},",
            schema = schema_literal(capabilities, &update_id)
        );

        let remove_id = format!("{snake}.remove");
        let _ = writeln!(
            out,
            "  \"{remove_id}\": {{\n    id: \"{remove_id}\",\n    inputSchema: {schema},\n    async invoke(input: unknown) {{\n      const value = asRecord(input, \"{remove_id}\");\n      expectFields(\"{remove_id}\", value, ID_FIELDS);\n      const recordId = requireString(value, \"id\", \"{remove_id}\");\n      try {{\n        await remove{pascal}(recordId);\n      }} catch (error) {{\n        throw asRecordNotFound(error);\n      }}\n      return {{ id: recordId, deleted: true }};\n    }},\n  }},",
            schema = schema_literal(capabilities, &remove_id)
        );

        let search_id = format!("{snake}.search");
        let _ = writeln!(
            out,
            "  \"{search_id}\": {{\n    id: \"{search_id}\",\n    inputSchema: {schema},\n    async invoke(input: unknown) {{\n      const value = asRecord(input, \"{search_id}\");\n      expectFields(\"{search_id}\", value, SEARCH_FIELDS);\n      const items = await search{plural}(requireString(value, \"query\", \"{search_id}\"));\n      return {{ items, total: items.length }};\n    }},\n  }},",
            schema = schema_literal(capabilities, &search_id)
        );
    }

    out.push_str("};\n\n");
    out.push_str(
        "export async function invoke(\n  capabilityId: string,\n  input: unknown,\n  context: CapabilityCallContext,\n): Promise<unknown> {\n  const capability = capabilities[capabilityId];\n  if (!capability) {\n    throw new Error(`unknown capability: ${capabilityId}`);\n  }\n  return capability.invoke(input, context);\n}\n",
    );

    out
}

fn contract_test(entity: &EntitySpec) -> String {
    let snake = entity.snake();
    let mut expected = String::new();
    for (operation, risk) in [
        ("list", "read"),
        ("get", "read"),
        ("create", "write_reversible"),
        ("update", "write_reversible"),
        ("remove", "write_destructive"),
        ("search", "read"),
    ] {
        let _ = writeln!(expected, "  \"{snake}.{operation}\": \"{risk}\",");
    }

    CONTRACT_TEST_TEMPLATE
        .replace("__EXPECTED_RISKS__", &expected)
        .replace("__ENTITY__", &snake)
}

fn ai_integration_doc(input: &ScaffoldInput, capabilities: &[CapabilitySpec]) -> String {
    if !input.ai_integration {
        let reason = input
            .ai_integration_note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty())
            .unwrap_or("该应用没有声明 AI operation。");
        return format!(
            "# AI Integration\n\n应用：{}（`{}`）\n\nAI 接入状态：`aiIntegration: \"none\"`\n\n## 原因\n\n{}\n\n## Capability\n\n无。AI 不应尝试通过页面自动化替代业务操作。\n",
            input.name,
            input.app_id(),
            reason
        );
    }
    let mut doc = AI_INTEGRATION_TEMPLATE
        .replace("{{PROJECT_NAME}}", &input.name)
        .replace("{{APP_ID}}", &input.app_id())
        .replace("{{TEMPLATE}}", &input.template)
        .replace("{{PROJECT_TYPE}}", &input.project_type)
        .replace("{{CAPABILITY_TABLE}}", &capability_table(capabilities))
        .replace("{{ENTITY_SUMMARY}}", &entity_summary(input))
        .replace(
            "{{AI_NOTE}}",
            input
                .ai_integration_note
                .as_deref()
                .map(str::trim)
                .filter(|note| !note.is_empty())
                .unwrap_or("无补充说明。"),
        );
    if input.template == "node-api" {
        doc = doc
            .replace(
                "src/domain/<entity>-service.ts",
                "src/domain/<entity>-service.mjs",
            )
            .replace("src/ai/capabilities.ts", "src/ai/capabilities.mjs")
            .replace("src/ai/invoke.ts", "src/ai/invoke.mjs")
            .replace(
                "app/worldbase/capabilities/invoke/route.ts",
                "server.mjs (`/worldbase/capabilities/invoke`)",
            )
            .replace(
                "- 固定路由：`app/api/worldbase/capabilities/route.ts`\n",
                "",
            );
    }
    doc
}

fn agents_doc(input: &ScaffoldInput, capabilities: &[CapabilitySpec]) -> String {
    AGENTS_TEMPLATE
        .replace("{{PROJECT_NAME}}", &input.name)
        .replace("{{PROJECT_ID}}", &input.project_id)
        .replace("{{APP_ID}}", &input.app_id())
        .replace("{{TEMPLATE}}", &input.template)
        .replace("{{PROJECT_TYPE}}", &input.project_type)
        .replace("{{ENTITY_SUMMARY}}", &entity_summary(input))
        .replace("{{CAPABILITY_LIST}}", &capability_list(capabilities))
        .replace("{{GENERATED_FILES}}", &generated_file_list(input))
}

fn capability_table(capabilities: &[CapabilitySpec]) -> String {
    let mut table = String::from("| Capability | Risk | Description |\n| --- | --- | --- |\n");
    for capability in capabilities {
        let _ = writeln!(
            table,
            "| `{}` | `{}` | {} |",
            capability.id,
            capability.risk,
            md_escape(&capability.description)
        );
    }
    table.trim_end().to_string()
}

fn capability_list(capabilities: &[CapabilitySpec]) -> String {
    let mut list = String::new();
    for capability in capabilities {
        let _ = writeln!(
            list,
            "- `{}` ({})：{}",
            capability.id, capability.risk, capability.description
        );
    }
    list.trim_end().to_string()
}

fn generated_file_list(input: &ScaffoldInput) -> String {
    let mut paths = vec![
        ".worldbase/app-capabilities.json".to_string(),
        "scripts/generate-manifest.mjs".to_string(),
        "AI_INTEGRATION.md".to_string(),
        "AGENTS.md".to_string(),
    ];
    if input.ai_integration {
        if input.template == "node-api" {
            paths.extend([
                "src/ai/capabilities.mjs".to_string(),
                "src/ai/invoke.mjs".to_string(),
            ]);
        } else {
            paths.extend([
                "src/ai/capabilities.ts".to_string(),
                "src/ai/invoke.ts".to_string(),
                "app/worldbase/capabilities/invoke/route.ts".to_string(),
                "app/api/worldbase/capabilities/route.ts".to_string(),
            ]);
        }
        paths.extend(
            input
                .entities
                .iter()
                .map(|entity| format!("tests/capability_contract/{}.test.mjs", entity.snake())),
        );
    }
    paths
        .into_iter()
        .map(|path| format!("- `{path}`"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn entity_summary(input: &ScaffoldInput) -> String {
    if input.entities.is_empty() {
        return "- 暂无实体。".to_string();
    }
    input
        .entities
        .iter()
        .map(|entity| {
            let fields = entity
                .fields
                .iter()
                .map(|field| format!("`{}` ({})", field.name, field.field_type))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "- `{}`（table `{}`）：{}",
                entity.snake(),
                entity.table,
                fields
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn schema_literal(capabilities: &[CapabilitySpec], id: &str) -> String {
    capabilities
        .iter()
        .find(|capability| capability.id == id)
        .and_then(|capability| serde_json::to_string(&capability.input_schema).ok())
        .unwrap_or_else(|| "{\"type\":\"object\",\"additionalProperties\":false}".to_string())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// `{ name: "title", type: "string", required: true }` for the adapter's
/// generated field-validation constants.
fn adapter_field_literal(field: &FieldSpec, required: bool) -> String {
    format!(
        r#"{{ name: "{}", type: "{}", required: {} }}"#,
        field.name,
        field.input_type(),
        required
    )
}

fn pascal(value: &str) -> String {
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

fn plural_pascal(entity: &EntitySpec) -> String {
    let table = entity.table.trim();
    if table.is_empty() {
        let snake = entity.snake();
        let plural = if snake.ends_with('s') {
            snake
        } else {
            format!("{snake}s")
        };
        return pascal(&plural);
    }
    let pascal_table = pascal(table);
    if pascal_table.is_empty() {
        pascal(&format!("{}s", entity.snake()))
    } else {
        pascal_table
    }
}

fn md_escape(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}
