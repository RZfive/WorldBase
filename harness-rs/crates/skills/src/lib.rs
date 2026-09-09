//! Skill registry for native YAML files and Markdown files with YAML frontmatter.
//!
//! Skill directories are `~/.the-world/skills/` and the workspace-local
//! `.worldbase/skills/`. Later directories override earlier skills with the
//! same declared name.

use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};
use worldbase_protocol::types::{SkillArgument, SkillContext, SkillDescriptor};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSource {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, alias = "when_to_use", alias = "when-to-use")]
    when_to_use: Option<String>,
    #[serde(default)]
    arguments: Option<Vec<SkillArgumentSource>>,
    #[serde(
        default,
        alias = "allowed_tools",
        alias = "allowed-tools",
        alias = "tools"
    )]
    allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default, alias = "content")]
    instructions: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct SkillArgumentSource {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, deserialize_with = "deserialize_boolish")]
    required: bool,
}

fn deserialize_boolish<'de, D>(deserializer: D) -> std::result::Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_yaml::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_yaml::Value::Bool(value) => value,
        serde_yaml::Value::String(value) => value.eq_ignore_ascii_case("true"),
        _ => false,
    })
}

pub struct SkillRegistry {
    dirs: Vec<PathBuf>,
}

/// Canonical payload for creating or updating a skill through the RPC layer.
/// The metadata matches the Electron SkillEngine frontmatter contract so a
/// skill saved by Rust can be activated by either runtime.
#[derive(Debug, Clone, Default)]
pub struct SkillSaveRequest {
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub when_to_use: Option<String>,
    pub arguments: Vec<SkillArgument>,
    pub allowed_tools: Vec<String>,
    pub context: SkillContext,
}

impl SkillRegistry {
    pub fn new(dirs: Vec<PathBuf>) -> Self {
        Self { dirs }
    }

    /// Default directories: `~/.the-world/skills` and workspace
    /// `.worldbase/skills`.
    pub fn default_dirs(workspace: &Path) -> Vec<PathBuf> {
        let mut dirs = vec![worldbase_default_skills_dir()];
        dirs.push(workspace.join(".worldbase").join("skills"));
        dirs
    }

    /// Scan all configured directories. Later directories and later sorted
    /// files replace an earlier skill with the same declared name.
    pub fn list(&self) -> Result<Vec<SkillDescriptor>> {
        let mut out: Vec<SkillDescriptor> = Vec::new();
        for dir in &self.dirs {
            if !dir.is_dir() {
                continue;
            }
            let mut entries: Vec<_> = std::fs::read_dir(dir)?
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && supported_skill_file(path))
                .collect();
            entries.sort();
            for path in entries {
                match Self::load_one(&path) {
                    Ok(skill) => {
                        out.retain(|known| known.name != skill.name);
                        out.push(skill);
                    }
                    Err(error) => {
                        tracing::warn!(path = %path.display(), %error, "skip invalid skill file");
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn get(&self, name: &str) -> Result<Option<SkillDescriptor>> {
        Ok(self.list()?.into_iter().find(|skill| skill.name == name))
    }

    /// Save a skill in the first configured directory. The default registry
    /// puts the user-level directory first, matching Electron's writable
    /// skill store while preserving workspace-local override precedence.
    pub fn save(&self, request: SkillSaveRequest) -> Result<SkillDescriptor> {
        let directory = self
            .dirs
            .first()
            .cloned()
            .unwrap_or_else(worldbase_default_skills_dir);
        save_skill_to_dir(&directory, request)
    }

    fn load_one(path: &Path) -> Result<SkillDescriptor> {
        let raw =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "md" | "markdown" | "mdx") {
            parse_markdown_skill(&raw, path)
        } else {
            parse_yaml_skill(&raw, path)
        }
    }
}

fn supported_skill_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("yaml" | "yml" | "md" | "markdown" | "mdx")
    )
}

fn parse_yaml_skill(raw: &str, path: &Path) -> Result<SkillDescriptor> {
    let source: SkillSource = serde_yaml::from_str(raw)
        .with_context(|| format!("parse yaml skill {}", path.display()))?;
    Ok(build_descriptor(
        source.instructions.clone(),
        source,
        path,
        None,
    ))
}

fn parse_markdown_skill(raw: &str, path: &Path) -> Result<SkillDescriptor> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let (source, body) = match split_frontmatter(raw) {
        Some((yaml, body)) => {
            let source = if yaml.trim().is_empty() {
                SkillSource::default()
            } else {
                serde_yaml::from_str(yaml)
                    .with_context(|| format!("parse skill frontmatter {}", path.display()))?
            };
            (source, body)
        }
        None => (SkillSource::default(), raw),
    };
    let heading = first_markdown_heading(body);
    Ok(build_descriptor(body.to_string(), source, path, heading))
}

fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw
        .strip_prefix("---\r\n")
        .or_else(|| raw.strip_prefix("---\n"))?;
    let mut offset = 0;
    for segment in rest.split_inclusive('\n') {
        let without_newline = segment.strip_suffix('\n').unwrap_or(segment);
        let line = without_newline
            .strip_suffix('\r')
            .unwrap_or(without_newline);
        if line == "---" {
            return Some((&rest[..offset], &rest[offset + segment.len()..]));
        }
        offset += segment.len();
    }
    None
}

fn first_markdown_heading(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let level = line.bytes().take_while(|byte| *byte == b'#').count();
        if level == 0 || level >= line.len() {
            return None;
        }
        let remainder = &line[level..];
        if !remainder.chars().next().is_some_and(char::is_whitespace) {
            return None;
        }
        let heading = remainder.trim();
        (!heading.is_empty()).then(|| heading.to_string())
    })
}

fn build_descriptor(
    instructions: String,
    source: SkillSource,
    path: &Path,
    heading: Option<String>,
) -> SkillDescriptor {
    let fallback_name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("unnamed-skill");
    let name = if source.name.trim().is_empty() {
        heading.unwrap_or_else(|| fallback_name.to_string())
    } else {
        source.name.trim().to_string()
    };
    let arguments = source
        .arguments
        .unwrap_or_default()
        .into_iter()
        .filter_map(|argument| {
            let name = argument.name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(SkillArgument {
                name,
                description: argument.description.trim().to_string(),
                required: argument.required,
            })
        })
        .collect();
    let allowed_tools = source
        .allowed_tools
        .unwrap_or_default()
        .into_iter()
        .map(|tool| tool.trim().to_string())
        .filter(|tool| !tool.is_empty())
        .collect();
    let context = if source.context.as_deref() == Some("fork") {
        SkillContext::Fork
    } else {
        SkillContext::Inline
    };

    SkillDescriptor {
        name,
        description: source.description.trim().to_string(),
        when_to_use: source
            .when_to_use
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        arguments,
        allowed_tools,
        context,
        instructions: instructions.trim().to_string(),
        path: path.to_string_lossy().into_owned(),
    }
}

pub fn worldbase_default_skills_dir() -> PathBuf {
    let base = if let Ok(home) = std::env::var("WORLDBASE_HOME") {
        PathBuf::from(home)
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".the-world")
    };
    base.join("skills")
}

/// Save a skill using the default user-level skills directory.
pub fn save_skill(request: SkillSaveRequest) -> Result<SkillDescriptor> {
    save_skill_to_dir(&worldbase_default_skills_dir(), request)
}

/// Testable implementation shared by the RPC dispatcher and callers that own
/// a custom skill directory.
pub fn save_skill_to_dir(dir: &Path, request: SkillSaveRequest) -> Result<SkillDescriptor> {
    let name = sanitize_skill_name(&request.name);
    anyhow::ensure!(!name.is_empty(), "skill name is required");
    let instructions = request.instructions.trim().to_string();
    anyhow::ensure!(!instructions.is_empty(), "skill instructions are required");

    let description = request.description.trim().to_string();
    let when_to_use = request
        .when_to_use
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let arguments = request
        .arguments
        .into_iter()
        .filter_map(|argument| {
            let name = argument.name.trim().to_string();
            (!name.is_empty()).then_some(SkillArgumentSource {
                name,
                description: argument.description.trim().to_string(),
                required: argument.required,
            })
        })
        .collect::<Vec<_>>();
    let mut seen_tools = std::collections::HashSet::new();
    let allowed_tools = request
        .allowed_tools
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen_tools.insert(value.clone()))
        .collect::<Vec<_>>();
    let source = SkillSource {
        name: name.clone(),
        description,
        when_to_use,
        arguments: (!arguments.is_empty()).then_some(arguments),
        allowed_tools: (!allowed_tools.is_empty()).then_some(allowed_tools),
        context: Some(request.context.as_str().to_string()),
        instructions,
    };

    std::fs::create_dir_all(dir)
        .with_context(|| format!("create skills directory {}", dir.display()))?;
    let path = dir.join(format!("{name}.yaml"));
    let yaml = serde_yaml::to_string(&source).context("serialize skill yaml")?;
    std::fs::write(&path, yaml).with_context(|| format!("write skill {}", path.display()))?;
    SkillRegistry::load_one(&path)
}

fn sanitize_skill_name(value: &str) -> String {
    let mut output = String::new();
    let mut pending_separator = false;
    for character in value.trim().chars() {
        if character.is_alphanumeric() || character == '-' || character == '_' {
            if pending_separator && !output.is_empty() {
                output.push('-');
            }
            pending_separator = false;
            output.push(character);
        } else {
            pending_separator = true;
        }
    }
    output.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_legacy_yaml_skills_with_compatible_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let skills = dir.path().join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(
            skills.join("daily-report.yaml"),
            "name: daily-report\ndescription: Daily summary\ninstructions: Summarize today\n",
        )
        .unwrap();
        std::fs::write(skills.join("bad.yaml"), "not: [valid\n").unwrap();

        let registry = SkillRegistry::new(vec![skills]);
        let list = registry.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "daily-report");
        assert_eq!(list[0].instructions, "Summarize today");
        assert_eq!(list[0].context, SkillContext::Inline);
        assert!(list[0].arguments.is_empty());
        assert!(list[0].allowed_tools.is_empty());
    }

    #[test]
    fn loads_native_yaml_with_node_skill_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("release.yaml");
        std::fs::write(
            &path,
            r#"name: release-helper
description: Prepare a release
whenToUse: When a release is requested
arguments:
  - name: channel
    description: Release channel
    required: "TRUE"
  - name: notes
    description: Optional notes
allowedTools:
  - read_file
  - write_file
context: fork
instructions: |
  Release to ${channel}.
  Notes: ${notes}
"#,
        )
        .unwrap();

        let skill = SkillRegistry::load_one(&path).unwrap();
        assert_eq!(
            skill.when_to_use.as_deref(),
            Some("When a release is requested")
        );
        assert_eq!(skill.arguments.len(), 2);
        assert!(skill.arguments[0].required);
        assert!(!skill.arguments[1].required);
        assert_eq!(skill.allowed_tools, ["read_file", "write_file"]);
        assert_eq!(skill.context, SkillContext::Fork);
        assert!(skill.instructions.contains("${channel}"));

        let json = serde_json::to_value(&skill).unwrap();
        assert_eq!(json["whenToUse"], "When a release is requested");
        assert_eq!(
            json["allowedTools"],
            serde_json::json!(["read_file", "write_file"])
        );
        assert_eq!(json["context"], "fork");
    }

    #[test]
    fn loads_markdown_frontmatter_and_uses_only_body_as_instructions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deploy.md");
        std::fs::write(
            &path,
            "\u{feff}---\r\nname: deploy\r\ndescription: Deploy safely\r\nwhenToUse: Before deployment\r\narguments:\r\n  - name: environment\r\n    description: Target environment\r\n    required: true\r\nallowedTools: [read_file, run_project_command]\r\ncontext: fork\r\n---\r\n# Deployment workflow\r\nDeploy ${environment}.\r\n",
        )
        .unwrap();

        let registry = SkillRegistry::new(vec![dir.path().to_path_buf()]);
        let skill = registry.get("deploy").unwrap().unwrap();
        assert_eq!(skill.description, "Deploy safely");
        assert_eq!(skill.arguments[0].name, "environment");
        assert_eq!(skill.allowed_tools, ["read_file", "run_project_command"]);
        assert_eq!(skill.context, SkillContext::Fork);
        assert_eq!(
            skill.instructions,
            "# Deployment workflow\r\nDeploy ${environment}."
        );
        assert!(!skill.instructions.contains("whenToUse"));
    }

    #[test]
    fn markdown_without_frontmatter_uses_first_heading_then_filename() {
        let dir = tempfile::tempdir().unwrap();
        let heading_path = dir.path().join("fallback.md");
        std::fs::write(&heading_path, "Intro\n## Review changes\nDo the review.").unwrap();
        let heading = SkillRegistry::load_one(&heading_path).unwrap();
        assert_eq!(heading.name, "Review changes");
        assert_eq!(
            heading.instructions,
            "Intro\n## Review changes\nDo the review."
        );

        let filename_path = dir.path().join("plain.markdown");
        std::fs::write(&filename_path, "Run the plain workflow.").unwrap();
        let filename = SkillRegistry::load_one(&filename_path).unwrap();
        assert_eq!(filename.name, "plain");
        assert_eq!(filename.context, SkillContext::Inline);
    }

    #[test]
    fn saves_full_node_metadata_and_round_trips_through_registry() {
        let dir = tempfile::tempdir().unwrap();
        let saved = save_skill_to_dir(
            dir.path(),
            SkillSaveRequest {
                name: " Release / Helper ".into(),
                description: " Prepare releases ".into(),
                instructions: "Ship ${channel}.".into(),
                when_to_use: Some("When publishing".into()),
                arguments: vec![SkillArgument {
                    name: "channel".into(),
                    description: "Release channel".into(),
                    required: true,
                }],
                allowed_tools: vec!["read_file".into(), "read_file".into()],
                context: SkillContext::Fork,
            },
        )
        .unwrap();
        assert_eq!(saved.name, "Release-Helper");
        assert_eq!(saved.description, "Prepare releases");
        assert_eq!(saved.when_to_use.as_deref(), Some("When publishing"));
        assert_eq!(saved.arguments[0].name, "channel");
        assert_eq!(saved.allowed_tools, ["read_file"]);
        assert_eq!(saved.context, SkillContext::Fork);
        assert_eq!(saved.instructions, "Ship ${channel}.");
        assert!(saved.path.ends_with("Release-Helper.yaml"));
    }

    #[test]
    fn rejects_empty_skill_content() {
        let dir = tempfile::tempdir().unwrap();
        let error = save_skill_to_dir(
            dir.path(),
            SkillSaveRequest {
                name: "empty".into(),
                instructions: "  ".into(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("instructions"));
    }
}
