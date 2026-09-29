//! Lexical recall over the original memory records. FTS is one candidate
//! source, not a gate: unicode61 does not split unspaced Chinese, so bounded
//! CJK n-grams also search literal substrings. Ranking happens before LIMIT.

use super::Store;
use anyhow::Result;
use rusqlite::params_from_iter;
use std::collections::HashSet;
use worldbase_protocol::types::{WorkspaceMemoryEntry, WorkspaceMemorySearchOptions};

const MAX_QUERY_CHARS: usize = 512;
const MAX_TERMS: usize = 32;

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x2fa1f)
}

fn search_terms(query: &str) -> Vec<String> {
    // Remove question scaffolding rather than requiring it to occur verbatim
    // in a saved fact ("我喜欢吃什么" -> "喜欢吃"). This is lexical recall,
    // not a claim that arbitrary paraphrases can work without embeddings.
    let mut text: String = query.to_lowercase().chars().take(MAX_QUERY_CHARS).collect();
    for word in [
        "请问",
        "你还记得",
        "还记得",
        "记不记得",
        "什么",
        "哪些",
        "多少",
        "用户",
        "我的",
        "我",
        "吗",
        "呢",
        "呀",
    ] {
        text = text.replace(word, " ");
    }
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |term: String| {
        if !term.is_empty() && terms.len() < MAX_TERMS && seen.insert(term.clone()) {
            terms.push(term);
        }
    };
    let mut run = String::new();
    let flush = |run: &mut String, add: &mut dyn FnMut(String)| {
        if run.is_empty() {
            return;
        }
        if run.chars().all(is_cjk) {
            let chars: Vec<char> = run.chars().collect();
            if chars.len() <= 16 {
                add(run.clone());
            }
            for pair in chars.windows(2) {
                add(pair.iter().collect());
            }
        } else if !matches!(
            run.as_str(),
            "what"
                | "which"
                | "do"
                | "does"
                | "did"
                | "i"
                | "my"
                | "me"
                | "you"
                | "the"
                | "a"
                | "is"
                | "are"
                | "remember"
        ) {
            add(run.clone());
        }
        run.clear();
    };
    for c in text.chars() {
        if c.is_alphanumeric() || c == '_' {
            if run
                .chars()
                .next()
                .is_some_and(|first| is_cjk(first) != is_cjk(c))
            {
                flush(&mut run, &mut add);
            }
            run.push(c);
        } else {
            flush(&mut run, &mut add);
        }
    }
    flush(&mut run, &mut add);
    terms
}

pub fn is_personal_memory_query(query: &str) -> bool {
    let query = query.to_lowercase();
    (query.contains('我')
        || query.contains("用户")
        || query.contains(" my ")
        || query.starts_with("my ")
        || query.contains(" i ")
        || query.chars().count() <= 12)
        && [
            "喜欢",
            "爱吃",
            "偏好",
            "习惯",
            "口味",
            "记得",
            "like",
            "prefer",
            "favorite",
            "favourite",
        ]
        .iter()
        .any(|word| query.contains(word))
}

impl Store {
    /// Catalog search (including entries which are not eligible for recall).
    pub fn search_workspace_memories(
        &self,
        options: &WorkspaceMemorySearchOptions,
    ) -> Result<Vec<WorkspaceMemoryEntry>> {
        self.search_workspace_memories_inner(options, false)
    }

    /// Chat and tools must apply lifecycle gates, not just the catalog filters.
    pub fn recall_workspace_memories(
        &self,
        options: &WorkspaceMemorySearchOptions,
    ) -> Result<Vec<WorkspaceMemoryEntry>> {
        if options.scopes.is_empty() {
            return Ok(Vec::new());
        }
        self.search_workspace_memories_inner(options, true)
    }

    fn search_workspace_memories_inner(
        &self,
        options: &WorkspaceMemorySearchOptions,
        recall: bool,
    ) -> Result<Vec<WorkspaceMemoryEntry>> {
        let limit = options.limit.unwrap_or(20).clamp(1, 50_000);
        let query: String = options
            .query
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_lowercase()
            .chars()
            .take(MAX_QUERY_CHARS)
            .collect();
        let mut values: Vec<String> = Vec::new();
        let mut bind = |value: String| {
            values.push(value);
            format!("?{}", values.len())
        };
        let mut filters = Vec::new();
        if !options.scopes.is_empty() {
            let scopes: Vec<_> = options
                .scopes
                .iter()
                .filter(|scope| {
                    !scope.scope_type.trim().is_empty() && !scope.scope_id.trim().is_empty()
                })
                .map(|scope| {
                    format!(
                        "(e.scope_type = {} AND e.scope_id = {})",
                        bind(scope.scope_type.trim().into()),
                        bind(scope.scope_id.trim().into())
                    )
                })
                .collect();
            // An invalid explicit scope must never widen access to all rows.
            if scopes.is_empty() {
                return Ok(Vec::new());
            }
            filters.push(format!("({})", scopes.join(" OR ")));
        }
        if !options.memory_types.is_empty() {
            let types: Vec<_> = options
                .memory_types
                .iter()
                .map(|kind| kind.trim())
                .filter(|kind| !kind.is_empty())
                .map(|kind| bind(kind.into()))
                .collect();
            if types.is_empty() {
                return Ok(Vec::new());
            }
            filters.push(format!("e.memory_type IN ({})", types.join(", ")));
        }
        if recall {
            filters.push("COALESCE(e.status, 'active') = 'active'".into());
            filters.push(format!(
                "(e.expires_at IS NULL OR julianday(e.expires_at) > julianday({}))",
                bind(super::vector::now_iso())
            ));
        }
        let terms = search_terms(&query);
        let mut rank = Vec::new();
        let mut matches = Vec::new();
        let mut fts_filter = None;
        if !query.is_empty() {
            let mut needles = vec![(query.clone(), 2)];
            needles.extend(
                terms
                    .iter()
                    .filter(|term| **term != query)
                    .cloned()
                    .map(|term| (term, 1)),
            );
            for (needle, bonus) in needles {
                let parameter = bind(needle);
                for (column, weight) in [
                    ("e.title", 3),
                    ("e.summary", 5),
                    ("COALESCE(e.details, '')", 1),
                    ("e.tags_json", 2),
                    ("COALESCE(e.source_text, '')", 1),
                ] {
                    let hit = format!("instr(lower({column}), {parameter}) > 0");
                    rank.push(format!(
                        "CASE WHEN {hit} THEN {} ELSE 0 END",
                        weight * bonus
                    ));
                    matches.push(hit);
                }
            }
            if !terms.is_empty() {
                let expression = terms
                    .iter()
                    .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                // MATCH takes the actual FTS table name, not its SQL alias.
                fts_filter = Some(format!(
                    "e.id IN (SELECT id FROM memory_entries_fts WHERE memory_entries_fts MATCH {})",
                    bind(expression)
                ));
            }
        }
        let fetch = |use_fts: bool| -> Result<Vec<WorkspaceMemoryEntry>> {
            let mut clauses = filters.clone();
            let mut candidates = matches.clone();
            if use_fts {
                candidates.extend(fts_filter.clone());
            }
            if !candidates.is_empty() {
                clauses.push(format!("({})", candidates.join(" OR ")));
            }
            let score = if rank.is_empty() {
                "0".into()
            } else {
                rank.join(" + ")
            };
            let mut sql = format!("SELECT e.*, ({score}) AS relevance FROM memory_entries e");
            if !clauses.is_empty() {
                sql.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
            }
            // Direct user facts should not lose to an agent's summary of a
            // previous failed recall, even if that summary quotes the question.
            let user_priority = if is_personal_memory_query(&query) {
                "(e.scope_type = 'user') DESC, "
            } else {
                ""
            };
            sql.push_str(&format!(" ORDER BY {user_priority}relevance DESC, e.pinned DESC, e.importance DESC, e.confidence DESC, COALESCE(e.last_used_at, e.updated_at) DESC, e.id LIMIT {limit}"));
            let conn = self.memory_conn.lock().unwrap();
            let mut stmt = conn.prepare(&sql)?;
            let count = if !use_fts && fts_filter.is_some() {
                values.len() - 1
            } else {
                values.len()
            };
            let rows = stmt.query_map(
                params_from_iter(values[..count].iter()),
                Self::row_to_workspace_memory,
            )?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        };
        match fetch(true) {
            Ok(entries) => Ok(entries),
            Err(error) if fts_filter.is_some() => {
                tracing::warn!(%error, "memory FTS unavailable; using literal term recall");
                fetch(false)
            }
            Err(error) => Err(error),
        }
    }
}

/// Fuse retrieval ranks instead of letting the vector list evict all literal
/// hits. Both channels keep their ordering; duplicate evidence receives credit
/// from both. Personal questions favor matching user facts over agent reports.
pub fn merge_memory_recall(
    query: &str,
    lexical: Vec<WorkspaceMemoryEntry>,
    semantic: Vec<WorkspaceMemoryEntry>,
    limit: usize,
) -> Vec<WorkspaceMemoryEntry> {
    let mut candidates: std::collections::HashMap<String, (WorkspaceMemoryEntry, f64)> =
        std::collections::HashMap::new();
    for (entries, weight) in [(lexical, 1.1), (semantic, 1.0)] {
        for (rank, entry) in entries.into_iter().enumerate() {
            let score = weight / (60.0 + rank as f64 + 1.0);
            candidates
                .entry(entry.id.clone())
                .and_modify(|(_, total)| *total += score)
                .or_insert((entry, score));
        }
    }
    let mut candidates: Vec<_> = candidates.into_values().collect();
    let personal = is_personal_memory_query(query);
    candidates.sort_by(|(left, l_score), (right, r_score)| {
        (personal && right.scope_type == "user")
            .cmp(&(personal && left.scope_type == "user"))
            .then_with(|| r_score.total_cmp(l_score))
            .then_with(|| left.id.cmp(&right.id))
    });
    candidates
        .into_iter()
        .take(limit)
        .map(|(entry, _)| entry)
        .collect()
}
