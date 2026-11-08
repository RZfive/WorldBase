use std::collections::HashSet;

use anyhow::{bail, Result};

use crate::{ScaffoldInput, SUPPORTED_FEATURES, SUPPORTED_TEMPLATES};

const SUPPORTED_FIELD_TYPES: &[&str] = &[
    "text",
    "string",
    "varchar",
    "integer",
    "int",
    "number",
    "float",
    "real",
    "double",
    "boolean",
    "bool",
    "date",
    "datetime",
    "timestamp",
    "json",
];

pub fn validate(input: &ScaffoldInput) -> Result<()> {
    if input.project_id.trim().is_empty() {
        bail!("project_id is required");
    }
    if input.name.trim().is_empty() {
        bail!("project name is required");
    }
    if !SUPPORTED_TEMPLATES.contains(&input.template.as_str()) {
        bail!(
            "unsupported template: {} (expected one of {})",
            input.template,
            SUPPORTED_TEMPLATES.join(", ")
        );
    }
    if input.template == "blank" && !input.entities.is_empty() {
        bail!("blank template does not generate entity files; use next-crud for entities");
    }
    let mut features = HashSet::new();
    for feature in &input.features {
        if !SUPPORTED_FEATURES.contains(&feature.as_str()) {
            bail!(
                "unsupported feature: {feature} (expected one of {})",
                SUPPORTED_FEATURES.join(", ")
            );
        }
        if !features.insert(feature.as_str()) {
            bail!("duplicate feature: {feature}");
        }
    }

    let mut entity_names = HashSet::new();
    let mut table_names = HashSet::new();
    for entity in &input.entities {
        let name = entity.name.trim();
        if name.is_empty() {
            bail!("entity name is required");
        }
        let snake = entity.snake();
        if !is_identifier(&snake) {
            bail!("entity {name} does not produce a valid identifier: {snake}");
        }
        if !entity_names.insert(snake.clone()) {
            bail!("duplicate entity name: {name}");
        }

        let table = entity.table.trim();
        if table.is_empty() {
            bail!("entity {name} table is required");
        }
        if !is_identifier(table) {
            bail!(
                "entity {name} has an invalid table name: {table} (use letters, digits and underscores, starting with a letter or underscore)"
            );
        }
        if !table_names.insert(table.to_string()) {
            bail!("duplicate entity table: {table}");
        }

        let mut field_names = HashSet::new();
        let mut primary_keys = 0usize;
        for field in &entity.fields {
            let field_name = field.name.trim();
            if field_name.is_empty() {
                bail!("entity {name} has a field with an empty name");
            }
            if !is_identifier(field_name) {
                bail!(
                    "entity {name} field {field_name} is not a valid column name (use letters, digits and underscores, starting with a letter or underscore)"
                );
            }
            if !field_names.insert(field_name.to_string()) {
                bail!("entity {name} has duplicate field {field_name}");
            }
            let field_type = field.field_type.trim().to_ascii_lowercase();
            if !SUPPORTED_FIELD_TYPES.contains(&field_type.as_str()) {
                bail!(
                    "entity {name} field {field_name} has unsupported type: {} (expected one of {})",
                    field.field_type,
                    SUPPORTED_FIELD_TYPES.join(", ")
                );
            }
            if field.primary_key {
                primary_keys += 1;
            }
        }
        if primary_keys > 1 {
            bail!("entity {name} declares more than one primary key");
        }
        if primary_keys == 0 && !entity.fields.iter().any(|field| field.name.trim() == "id") {
            bail!("entity {name} must declare a primary key field or an `id` field");
        }
    }
    Ok(())
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first != '_' && !first.is_ascii_alphabetic() {
        return false;
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EntitySpec, FieldSpec};

    fn base_input() -> ScaffoldInput {
        ScaffoldInput {
            project_id: "proj_test".into(),
            name: "Test".into(),
            project_type: "fullstack".into(),
            template: "next-crud".into(),
            entities: vec![],
            features: vec!["core".into(), "data".into()],
            ai_integration: true,
            ai_integration_note: None,
            development_mode: true,
        }
    }

    fn text_field(name: &str) -> FieldSpec {
        FieldSpec {
            name: name.into(),
            field_type: "text".into(),
            required: false,
            primary_key: false,
            default_sql: None,
        }
    }

    #[test]
    fn rejects_unsupported_template() {
        let mut input = base_input();
        input.template = "svelte".into();
        let error = validate(&input).unwrap_err().to_string();
        assert!(error.contains("unsupported template: svelte"));
    }

    #[test]
    fn rejects_unsupported_feature() {
        let mut input = base_input();
        input.features.push("blockchain".into());
        let error = validate(&input).unwrap_err().to_string();
        assert!(error.contains("unsupported feature: blockchain"));
    }

    #[test]
    fn rejects_invalid_table_and_field_names() {
        let mut input = base_input();
        input.entities = vec![EntitySpec {
            name: "expense".into(),
            table: "bad table".into(),
            fields: vec![text_field("id")],
        }];
        let error = validate(&input).unwrap_err().to_string();
        assert!(error.contains("invalid table name: bad table"));

        let mut input = base_input();
        input.entities = vec![EntitySpec {
            name: "expense".into(),
            table: "expenses".into(),
            fields: vec![text_field("bad-field")],
        }];
        let error = validate(&input).unwrap_err().to_string();
        assert!(error.contains("not a valid column name"));
        assert!(error.contains("bad-field"));
    }

    #[test]
    fn rejects_duplicate_entities_and_fields() {
        let mut input = base_input();
        input.entities = vec![
            EntitySpec {
                name: "expense".into(),
                table: "expenses".into(),
                fields: vec![text_field("id")],
            },
            EntitySpec {
                name: "expense".into(),
                table: "expenses_2".into(),
                fields: vec![text_field("id")],
            },
        ];
        assert!(validate(&input)
            .unwrap_err()
            .to_string()
            .contains("duplicate entity name"));

        let mut input = base_input();
        input.entities = vec![EntitySpec {
            name: "expense".into(),
            table: "expenses".into(),
            fields: vec![text_field("title"), text_field("title")],
        }];
        assert!(validate(&input)
            .unwrap_err()
            .to_string()
            .contains("duplicate field title"));
    }
}
