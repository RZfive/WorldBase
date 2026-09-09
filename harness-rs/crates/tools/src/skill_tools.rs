//! Skill tools: `skill_list` / `skill_run` and their Electron aliases.

use super::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use worldbase_protocol::types::SkillDescriptor;

pub struct SkillListTool;

#[async_trait]
impl Tool for SkillListTool {
    fn name(&self) -> &str {
        "skill_list"
    }
    fn description(&self) -> &str {
        "列出可用的 Markdown/YAML 技能"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let skills = services.skills.list()?;
        Ok(json!({ "skills": skills }))
    }
}

pub struct SkillRunTool;

#[async_trait]
impl Tool for SkillRunTool {
    fn name(&self) -> &str {
        "skill_run"
    }
    fn description(&self) -> &str {
        "加载技能指令（把 instructions 返回给模型按其执行）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "skill_name": { "type": "string" },
                "arguments": { "type": "object" }
            },
            "anyOf": [{ "required": ["name"] }, { "required": ["skill_name"] }]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let name = input
            .get("skill_name")
            .or_else(|| input.get("name"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing required string parameter: skill_name"))?;
        let skill = services
            .skills
            .get(name)?
            .ok_or_else(|| anyhow::anyhow!("skill not found: {name}"))?;
        Ok(render_skill(&skill, &input))
    }
}

fn render_skill(skill: &SkillDescriptor, input: &Value) -> Value {
    let arguments = input
        .get("arguments")
        .and_then(Value::as_object)
        .map(|arguments| {
            arguments
                .iter()
                .map(|(name, value)| {
                    let value = value
                        .as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| value.to_string());
                    (name.clone(), value)
                })
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    if let Some(argument) = skill.arguments.iter().find(|argument| {
        argument.required
            && arguments
                .get(&argument.name)
                .is_none_or(|value| value.is_empty())
    }) {
        return json!({
            "error": format!(
                "Missing required argument '{}': {}",
                argument.name, argument.description
            )
        });
    }

    json!({
        "skill": skill.name,
        "context": skill.context.as_str(),
        "instructions": substitute_arguments(&skill.instructions, &arguments),
    })
}

fn substitute_arguments(template: &str, arguments: &HashMap<String, String>) -> String {
    let mut output = String::with_capacity(template.len());
    let mut cursor = 0;
    while let Some(relative_start) = template[cursor..].find("${") {
        let start = cursor + relative_start;
        output.push_str(&template[cursor..start]);
        let name_start = start + 2;
        let Some(relative_end) = template[name_start..].find('}') else {
            output.push_str(&template[start..]);
            return output;
        };
        let end = name_start + relative_end;
        let name = &template[name_start..end];
        if valid_argument_name(name) {
            if let Some(value) = arguments.get(name) {
                output.push_str(value);
            } else {
                output.push_str(&template[start..=end]);
            }
        } else {
            output.push_str(&template[start..=end]);
        }
        cursor = end + 1;
    }
    output.push_str(&template[cursor..]);
    output
}

fn valid_argument_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphanumeric() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use worldbase_protocol::types::{SkillArgument, SkillContext};

    fn services(root: &Path, skill_dir: &Path) -> ToolServices {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&projects).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(crate::HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace,
            folder_workspace: None,
            target_project_id: None,
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            store: store.clone(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![
                skill_dir.to_path_buf()
            ])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
            subagent_runtime: None,
        }
    }

    fn skill(context: SkillContext) -> SkillDescriptor {
        SkillDescriptor {
            name: "release".into(),
            description: "Release helper".into(),
            when_to_use: Some("When publishing".into()),
            arguments: vec![
                SkillArgument {
                    name: "channel".into(),
                    description: "Release channel".into(),
                    required: true,
                },
                SkillArgument {
                    name: "notes".into(),
                    description: "Optional notes".into(),
                    required: false,
                },
            ],
            allowed_tools: vec!["read_file".into()],
            context,
            instructions: "Ship ${channel}. Notes: ${notes}. Keep ${unknown}.".into(),
            path: "release.md".into(),
        }
    }

    #[test]
    fn validates_required_arguments_before_rendering() {
        let missing = render_skill(&skill(SkillContext::Inline), &json!({}));
        assert_eq!(
            missing["error"],
            "Missing required argument 'channel': Release channel"
        );

        let empty = render_skill(
            &skill(SkillContext::Inline),
            &json!({"arguments": {"channel": ""}}),
        );
        assert_eq!(
            empty["error"],
            "Missing required argument 'channel': Release channel"
        );
    }

    #[test]
    fn substitutes_arguments_once_and_preserves_unknown_placeholders() {
        let result = render_skill(
            &skill(SkillContext::Fork),
            &json!({
                "arguments": {
                    "channel": "${notes}",
                    "notes": "stable"
                }
            }),
        );
        assert_eq!(result["skill"], "release");
        assert_eq!(result["context"], "fork");
        assert_eq!(
            result["instructions"],
            "Ship ${notes}. Notes: stable. Keep ${unknown}."
        );
    }

    #[test]
    fn converts_canonical_argument_scalars_to_strings() {
        let result = render_skill(
            &skill(SkillContext::Inline),
            &json!({"arguments": {"channel": 42, "notes": true}}),
        );
        assert_eq!(
            result["instructions"],
            "Ship 42. Notes: true. Keep ${unknown}."
        );
    }

    #[tokio::test]
    async fn canonical_tools_execute_markdown_skills_and_list_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let skill_dir = temp.path().join("skills");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("release.md"),
            r#"---
name: release
description: Release helper
whenToUse: When publishing
arguments:
  - name: channel
    description: Release channel
    required: true
allowedTools:
  - read_file
context: fork
---
Ship ${channel}.
"#,
        )
        .unwrap();
        let services = services(temp.path(), &skill_dir);
        let tools = crate::builtin_tools();

        let run = tools
            .iter()
            .find(|tool| tool.name() == "run_skill")
            .unwrap()
            .execute(
                json!({
                    "skill_name": "release",
                    "arguments": {"channel": "stable"}
                }),
                &services,
            )
            .await
            .unwrap();
        assert_eq!(run["context"], "fork");
        assert_eq!(run["instructions"], "Ship stable.");

        let list = tools
            .iter()
            .find(|tool| tool.name() == "list_skills")
            .unwrap()
            .execute(json!({}), &services)
            .await
            .unwrap();
        assert_eq!(list["skills"][0]["whenToUse"], "When publishing");
        assert_eq!(list["skills"][0]["arguments"][0]["required"], true);
        assert_eq!(list["skills"][0]["allowedTools"][0], "read_file");
        assert_eq!(list["skills"][0]["context"], "fork");
    }
}
