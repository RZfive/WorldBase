//! YAML 技能引擎：从技能目录加载技能清单，供 Agent 以工具形式调用。
//!
//! 技能目录约定（`~/.the-world/skills/` 或工作区 `.worldbase/skills/`）：
//! 每个技能一个 `*.yaml`，含 name/description/instructions 字段。

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use worldbase_protocol::types::SkillDescriptor;

#[derive(Debug, Clone, Deserialize)]
pub struct Skill {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub instructions: String,
}

pub struct SkillRegistry {
    dirs: Vec<PathBuf>,
}

impl SkillRegistry {
    pub fn new(dirs: Vec<PathBuf>) -> Self {
        Self { dirs }
    }

    /// 默认目录：`~/.the-world/skills` + 工作区 `.worldbase/skills`。
    pub fn default_dirs(workspace: &Path) -> Vec<PathBuf> {
        let mut dirs = vec![worldbase_default_skills_dir()];
        dirs.push(workspace.join(".worldbase").join("skills"));
        dirs
    }

    /// 扫描所有目录，加载全部技能（后目录同名覆盖先目录）。
    pub fn list(&self) -> Result<Vec<SkillDescriptor>> {
        let mut out: Vec<SkillDescriptor> = Vec::new();
        for dir in &self.dirs {
            if !dir.is_dir() {
                continue;
            }
            let mut entries: Vec<_> = std::fs::read_dir(dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml")))
                .collect();
            entries.sort();
            for path in entries {
                match Self::load_one(&path) {
                    Ok(skill) => {
                        out.retain(|s: &SkillDescriptor| s.name != skill.name);
                        out.push(SkillDescriptor {
                            name: skill.name,
                            description: skill.description,
                            instructions: skill.instructions,
                            path: path.to_string_lossy().into_owned(),
                        });
                    }
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "skip invalid skill file");
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn get(&self, name: &str) -> Result<Option<SkillDescriptor>> {
        Ok(self.list()?.into_iter().find(|s| s.name == name))
    }

    fn load_one(path: &Path) -> Result<Skill> {
        let raw = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let skill: Skill = serde_yaml::from_str(&raw).with_context(|| format!("parse yaml {}", path.display()))?;
        Ok(skill)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_yaml_skills() {
        let dir = tempfile::tempdir().unwrap();
        let skills = dir.path().join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(
            skills.join("daily-report.yaml"),
            "name: daily-report\ndescription: 每日汇总\ninstructions: 汇总今日对话要点\n",
        )
        .unwrap();
        std::fs::write(skills.join("bad.yaml"), "not: [valid\n").unwrap();

        let registry = SkillRegistry::new(vec![skills]);
        let list = registry.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "daily-report");
        assert!(list[0].instructions.contains("汇总"));

        let got = registry.get("daily-report").unwrap().unwrap();
        assert_eq!(got.description, "每日汇总");
    }
}
