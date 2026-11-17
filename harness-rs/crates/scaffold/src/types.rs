use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Declarative input shared by `create_project` and the upgrade tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScaffoldInput {
    pub project_id: String,
    pub name: String,
    pub project_type: String,
    pub template: String,
    pub entities: Vec<EntitySpec>,
    pub features: Vec<String>,
    pub ai_integration: bool,
    pub ai_integration_note: Option<String>,
    pub development_mode: bool,
}

impl ScaffoldInput {
    pub fn app_id(&self) -> String {
        format!("worldbase.local.{}", self.project_id)
    }

    pub fn has_feature(&self, feature: &str) -> bool {
        self.features.iter().any(|value| value == feature)
    }

    pub fn primary_entity(&self) -> Option<&EntitySpec> {
        self.entities.first()
    }
}

/// One business entity. `name` is the singular camel/snake identifier used in
/// TypeScript, `table` is the persisted table name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitySpec {
    pub name: String,
    pub table: String,
    pub fields: Vec<FieldSpec>,
}

impl EntitySpec {
    /// `expense` -> `expenses`, `todo` -> `todos`.
    pub fn default_table(name: &str) -> String {
        let snake = to_snake(name);
        if snake.ends_with('s') {
            snake
        } else {
            format!("{snake}s")
        }
    }

    pub fn snake(&self) -> String {
        to_snake(&self.name)
    }

    /// Uppercase first letter and strip separators: `expense_item` -> `ExpenseItem`.
    pub fn pascal(&self) -> String {
        self.snake()
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

    pub fn camel(&self) -> String {
        let pascal = self.pascal();
        let mut chars = pascal.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_ascii_lowercase(), chars.as_str()),
            None => String::new(),
        }
    }

    pub fn id_field(&self) -> Option<&FieldSpec> {
        self.fields
            .iter()
            .find(|field| field.primary_key)
            .or_else(|| self.fields.iter().find(|field| field.name == "id"))
    }

    pub fn has_field(&self, name: &str) -> bool {
        self.fields.iter().any(|field| field.name == name)
    }

    pub fn writable_fields(&self) -> Vec<&FieldSpec> {
        self.fields
            .iter()
            .filter(|field| !field.primary_key && field.name != "created_at")
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub default_sql: Option<String>,
}

impl FieldSpec {
    pub fn camel(&self) -> String {
        let mut parts = self.name.split('_').filter(|part| !part.is_empty());
        let Some(first) = parts.next() else {
            return String::new();
        };
        let mut out = first.to_ascii_lowercase();
        for part in parts {
            let mut chars = part.chars();
            if let Some(ch) = chars.next() {
                out.push(ch.to_ascii_uppercase());
                out.push_str(chars.as_str());
            }
        }
        out
    }

    pub fn sqlite_type(&self) -> &'static str {
        match self.field_type.to_ascii_lowercase().as_str() {
            "integer" | "int" | "boolean" | "bool" => "INTEGER",
            "number" | "float" | "real" | "double" => "REAL",
            _ => "TEXT",
        }
    }

    pub fn ts_type(&self) -> &'static str {
        match self.field_type.to_ascii_lowercase().as_str() {
            "integer" | "int" | "number" | "float" | "real" | "double" => "number",
            "boolean" | "bool" => "boolean",
            _ => "string",
        }
    }

    pub fn input_type(&self) -> &'static str {
        match self.ts_type() {
            "number" => "number",
            "boolean" => "boolean",
            _ => "string",
        }
    }
}

/// One AI-callable operation. The scaffold uses this as the single source of
/// truth for the manifest, the TypeScript adapter, and contract tests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitySpec {
    pub id: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub risk: String,
    pub side_effects: bool,
    pub idempotent: bool,
    pub operation: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// The full deterministic result of planning a project. The caller writes
/// `files` only when the target path does not already exist.
#[derive(Debug, Clone)]
pub struct ScaffoldPlan {
    pub files: BTreeMap<String, String>,
    pub meta: Value,
    pub capabilities: Vec<CapabilitySpec>,
    pub warnings: Vec<String>,
    pub template: String,
    pub features: Vec<String>,
}

pub fn to_snake(value: &str) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 && !out.ends_with('_') {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}
