//! SQLite/FTS5 持久化：会话、消息、长期记忆、设置、定时任务。
//!
//! 单库设计（`~/.the-world/app.sqlite`），路径可由 `WORLDBASE_HOME` 覆盖。

use anyhow::{Context, Result};
use image::io::Reader as ImageReader;
use image::{GenericImageView, ImageOutputFormat};
use rusqlite::{params, params_from_iter, Connection, OpenFlags, Row};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use worldbase_protocol::types::{
    ChatMessage, ConversationMeta, MemoryCompactionPlan, MemoryCompactionResult,
    MemoryCompactionStatus, MemoryEntry, Role, ScheduleEntry, ToolCallRecord, ToolResultRecord,
    WorkspaceMemoryEntry, WorkspaceMemorySearchOptions,
};

mod embedding;
mod embedding_service;
mod embedding_store;
mod vector;

pub use embedding::{
    EMBEDDING_PREPROCESS_VERSION, EmbeddingProvider, FakeEmbeddingProvider,
    OpenAIEmbeddingProvider,
};
pub use embedding_service::MemoryEmbeddingQueue;
pub use vector::VectorIndex;

pub struct Store {
    conn: Mutex<Connection>,
    /// Electron's Agent Workspace memory lives in its own database at
    /// `agent-memory/memory.sqlite`. Keep it separate from the legacy
    /// `memories` table used by the original memory tools so both contracts
    /// remain available during the backend migration.
    memory_conn: Mutex<Connection>,
    /// 主库文件路径，用于按需打开共享的派生向量库 `memory-vector.sqlite`。
    memory_path: PathBuf,
    memory_compaction_status: Mutex<MemoryCompactionStatus>,
}

/// A bounded preview produced by Rust for an image-library entry.
#[derive(Debug, Clone)]
pub struct ImageLibraryThumbnail {
    pub name: String,
    pub width: u32,
    pub height: u32,
}

const IMAGE_LIBRARY_THUMBNAIL_MAX_DIMENSION: u32 = 320;

/// Electron's StudioTaskStore keeps at most this many queued/failed tasks.
/// The Rust queue uses the same bound so a malformed or runaway host request
/// cannot grow the shared settings row without limit.
const MAX_STUDIO_TASKS: usize = 200;

fn now_ts() -> String {
    worldbase_protocol::event::now_rfc3339()
}

/// UTC 日期回退 n 天（YYYY-MM-DD）。
fn shift_days_back(day: &str, n: i64) -> Option<String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    // 用 ts 差值近似：直接减 n*86400 后取当天日期不可靠，改为字符串日期解析
    let _ = secs;
    let parts: Vec<i64> = day.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 {
        return None;
    }
    let (mut y, mut m, mut d) = (parts[0], parts[1], parts[2]);
    d -= n;
    while d < 1 {
        m -= 1;
        if m < 1 {
            m = 12;
            y -= 1;
        }
        let dim = match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            _ => {
                if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                    29
                } else {
                    28
                }
            }
        };
        d += dim;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn role_to_str(r: Role) -> &'static str {
    match r {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
    }
}

/// Older gateways emitted tool calls without ids. OpenAI-compatible APIs
/// reject those ids on the continuation request, so pair and repair them at
/// read time without rewriting durable history.
fn repair_empty_tool_message_ids(mut messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut pending = std::collections::VecDeque::new();
    for message in &mut messages {
        if message.role == Role::Assistant {
            for call in &mut message.tool_calls {
                if call.id.trim().is_empty() {
                    let id = format!(
                        "repaired_call_{}_{}",
                        message.id,
                        uuid::Uuid::new_v4().simple()
                    );
                    call.id = id.clone();
                    pending.push_back((id, call.name.clone()));
                }
            }
        } else if message.role == Role::User {
            for result in &mut message.tool_results {
                if !result.tool_call_id.trim().is_empty() {
                    continue;
                }
                result.tool_call_id = pending.pop_front().map(|(id, _)| id).unwrap_or_else(|| {
                    format!("repaired_result_{}", uuid::Uuid::new_v4().simple())
                });
            }
        }
    }
    messages
}

fn str_to_role(s: &str) -> Role {
    match s {
        "assistant" => Role::Assistant,
        "system" => Role::System,
        _ => Role::User,
    }
}

fn normalize_image_tags(tags: &[String]) -> Vec<String> {
    // Image cards preserve the user's tag order in Electron. De-duplicate
    // without sorting so Rust reads and mirrors retain that presentation.
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for tag in tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
    {
        if seen.insert(tag.to_string()) {
            normalized.push(tag.to_string());
        }
    }
    normalized
}

fn normalize_memory_strings(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || !seen.insert(value.to_string()) {
            continue;
        }
        normalized.push(value.to_string());
    }
    normalized
}

fn clean_memory_value(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches('`')
        .trim()
        .to_string()
}

fn first_memory_line(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn stable_memory_id(seed: &str) -> String {
    let mut hash: i32 = 0;
    for ch in seed.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as i32);
    }
    let magnitude = (hash as i64).unsigned_abs();
    format!("mem_{magnitude:x}")
}

// The first Rust images used a comma-delimited column. New entries use JSON so
// tags containing commas survive a TS <-> Rust migration; the reader accepts
// both durable formats.
fn image_tags_from_storage(value: &str) -> Vec<String> {
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(value) {
        return normalize_image_tags(&tags);
    }
    normalize_image_tags(&value.split(',').map(ToOwned::to_owned).collect::<Vec<_>>())
}

fn image_tags_to_storage(tags: &[String]) -> String {
    serde_json::to_string(&normalize_image_tags(tags)).unwrap_or_else(|_| "[]".to_string())
}

fn safe_image_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn memory_database_path(store_path: &Path) -> PathBuf {
    // Electron's MemoryStore always uses <userData>/agent-memory/memory.sqlite.
    // Tests and other Rust callers pass an app.sqlite path, so derive the same
    // sibling directory there. Passing memory.sqlite directly is useful for
    // focused store tests and remains idempotent.
    if store_path.file_name().and_then(|name| name.to_str()) == Some("memory.sqlite") {
        return store_path.to_path_buf();
    }
    store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("agent-memory")
        .join("memory.sqlite")
}

fn empty_memory_compaction_status() -> worldbase_protocol::types::MemoryCompactionStatus {
    MemoryCompactionStatus {
        id: None,
        status: "idle".into(),
        stage: "idle".into(),
        detail: None,
        scanned: 0,
        total_chunks: 0,
        completed_chunks: 0,
        started_at: None,
        updated_at: now_ts(),
        finished_at: None,
        result: None,
        error: None,
    }
}

impl Store {
    /// 打开（或创建）数据库并迁移 schema。
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create dir {}", dir.display()))?;
        }
        let conn =
            Connection::open(path).with_context(|| format!("open sqlite at {}", path.display()))?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                agent_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                parts_json TEXT NOT NULL DEFAULT '[]',
                tool_calls_json TEXT NOT NULL DEFAULT '[]',
                tool_results_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content, tags,
                content='memories', content_rowid='id',
                tokenize='unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content, tags)
                VALUES (new.id, new.content, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, tags)
                VALUES ('delete', old.id, old.content, old.tags);
            END;

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                system_prompt TEXT NOT NULL DEFAULT '',
                provider_id TEXT,
                model_id TEXT,
                skill_ids TEXT NOT NULL DEFAULT '[]',
                reasoning_strength TEXT NOT NULL DEFAULT 'medium',
                allowed_tools TEXT NOT NULL DEFAULT '[]',
                denied_tools TEXT NOT NULL DEFAULT '[]',
                memory_scopes TEXT NOT NULL DEFAULT '["user","agent","project"]',
                memory_write_policy TEXT NOT NULL DEFAULT '{}',
                auto_reply_policy TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS images (
                id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                provider_id TEXT,
                model TEXT NOT NULL DEFAULT '',
                file TEXT NOT NULL,
                created_at TEXT NOT NULL,
                meta TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS image_folders (
                name TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS lightapps (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                conversation_id TEXT,
                provider_id TEXT,
                model TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost REAL NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
            CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                cron TEXT NOT NULL,
                task TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                last_run_at TEXT,
                next_run_at TEXT,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            "#,
        )
        .context("migrate schema")?;

        // 增量列迁移（幂等：忽略 duplicate column 错误）
        {
            let alters = [
                "ALTER TABLE conversations ADD COLUMN forked_from_conversation_id TEXT",
                "ALTER TABLE conversations ADD COLUMN forked_from_message_id INTEGER",
                "ALTER TABLE conversations ADD COLUMN fork_depth INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]'",
                "ALTER TABLE images ADD COLUMN folder TEXT NOT NULL DEFAULT ''",
                "ALTER TABLE images ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
                "ALTER TABLE agents ADD COLUMN reasoning_strength TEXT NOT NULL DEFAULT 'medium'",
                "ALTER TABLE agents ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'",
                "ALTER TABLE agents ADD COLUMN denied_tools TEXT NOT NULL DEFAULT '[]'",
                "ALTER TABLE agents ADD COLUMN memory_scopes TEXT NOT NULL DEFAULT '[\"user\",\"agent\",\"project\"]'",
                "ALTER TABLE agents ADD COLUMN memory_write_policy TEXT NOT NULL DEFAULT '{}'",
                "ALTER TABLE agents ADD COLUMN auto_reply_policy TEXT NOT NULL DEFAULT '{}'",
                "ALTER TABLE schedules ADD COLUMN next_run_at TEXT",
                "ALTER TABLE schedules ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
            ];
            for sql in alters {
                let _ = conn.execute(sql, []);
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC, id DESC);\n                 CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);",
            )?;
        }
        let memory_path = memory_database_path(path);
        if let Some(dir) = memory_path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create memory dir {}", dir.display()))?;
        }
        let memory_conn = Connection::open(&memory_path)
            .with_context(|| format!("open memory sqlite at {}", memory_path.display()))?;
        memory_conn
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA busy_timeout = 5000;

                CREATE TABLE IF NOT EXISTS memory_entries (
                    id TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    memory_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    details TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    source_conversation_id TEXT,
                    source_session_id TEXT,
                    source_message_ids_json TEXT NOT NULL DEFAULT '[]',
                    importance REAL NOT NULL DEFAULT 0.5,
                    confidence REAL NOT NULL DEFAULT 0.5,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    last_used_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
                    ON memory_entries(scope_type, scope_id);
                CREATE INDEX IF NOT EXISTS idx_memory_entries_type
                    ON memory_entries(memory_type);
                CREATE INDEX IF NOT EXISTS idx_memory_entries_last_used
                    ON memory_entries(last_used_at);

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
                    id UNINDEXED,
                    title,
                    summary,
                    details,
                    tags
                );

                -- A previous Electron process may have created the durable
                -- rows before FTS population completed. Reinsert only missing
                -- documents so Rust search has deterministic coverage without
                -- duplicating existing index rows.
                INSERT INTO memory_entries_fts (id, title, summary, details, tags)
                SELECT e.id, e.title, e.summary, COALESCE(e.details, ''),
                       replace(replace(e.tags_json, '[', ''), ']', '')
                FROM memory_entries e
                WHERE NOT EXISTS (
                    SELECT 1 FROM memory_entries_fts f WHERE f.id = e.id
                );
                "#,
            )
            .context("migrate memory schema")?;

        // Shared-memory governance fields and the embedding pipeline tables
        // mirror the Electron main database exactly: both runtimes open the
        // same `agent-memory/memory.sqlite`, so the schema (and the FTS and
        // vector projections built on it) must stay byte-compatible.
        Self::migrate_shared_memory_schema(&memory_conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            memory_conn: Mutex::new(memory_conn),
            memory_path: memory_path.clone(),
            memory_compaction_status: Mutex::new(empty_memory_compaction_status()),
        })
    }

    /// Shared-memory schema migration. SQLite has no `ADD COLUMN IF NOT
    /// EXISTS`, so each governance column is added defensively and duplicate
    /// errors are ignored; the embedding pipeline tables are idempotent
    /// `CREATE TABLE IF NOT EXISTS` statements identical to the Electron DDL.
    fn migrate_shared_memory_schema(conn: &Connection) -> Result<()> {
        for statement in [
            "ALTER TABLE memory_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
            "ALTER TABLE memory_entries ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'",
            "ALTER TABLE memory_entries ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE memory_entries ADD COLUMN last_confirmed_at TEXT",
            "ALTER TABLE memory_entries ADD COLUMN expires_at TEXT",
        ] {
            let _ = conn.execute(statement, []);
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS memory_events (
                id TEXT PRIMARY KEY,
                entry_id TEXT,
                event_type TEXT NOT NULL,
                detail_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_events_entry
                ON memory_events(entry_id);

            CREATE TABLE IF NOT EXISTS embedding_documents (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                scope_type TEXT NOT NULL,
                scope_id TEXT NOT NULL,
                embedding_text TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                active_generation_id TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_embedding_documents_source
                ON embedding_documents(source_type, source_id);
            CREATE INDEX IF NOT EXISTS idx_embedding_documents_status
                ON embedding_documents(status);

            CREATE TABLE IF NOT EXISTS embedding_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL,
                generation_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status
                ON embedding_jobs(status, next_retry_at);
            CREATE INDEX IF NOT EXISTS idx_embedding_jobs_document
                ON embedding_jobs(document_id);

            CREATE TABLE IF NOT EXISTS embedding_generations (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                model_revision TEXT,
                dimensions INTEGER NOT NULL,
                distance_metric TEXT NOT NULL DEFAULT 'cosine',
                normalized INTEGER NOT NULL DEFAULT 0,
                preprocess_version TEXT NOT NULL,
                index_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'building',
                total_documents INTEGER NOT NULL DEFAULT 0,
                indexed_documents INTEGER NOT NULL DEFAULT 0,
                failed_documents INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                activated_at TEXT
            );
            "#,
        )
        .context("create shared-memory embedding tables")?;
        Ok(())
    }

    /// 默认数据目录：`$WORLDBASE_HOME` 或 `~/.the-world`。
    pub fn default_dir() -> PathBuf {
        if let Ok(home) = std::env::var("WORLDBASE_HOME") {
            return PathBuf::from(home);
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".the-world")
    }

    pub fn open_default() -> Result<Self> {
        let dir = Self::default_dir();
        Self::open(&dir.join("app.sqlite"))
    }

    /// Reconcile Electron's durable image-library mirrors before Rust access.
    /// `index.db` remains Electron's disposable cache; JSON records and the
    /// empty-folder registry are the handoff contract between the two engines.
    ///
    /// Existing IDs are intentionally updated, not ignored: a user can change
    /// a folder or tags while TypeScript is selected and then switch back to
    /// Rust. Records are pruned only when their primary image file is gone, so
    /// an older Rust record with a real file but no legacy JSON mirror survives
    /// the migration.
    pub fn import_image_library_mirror(&self, directory: &Path) -> Result<u32> {
        if !directory.is_dir() {
            return Ok(0);
        }
        let mut imported = 0u32;
        for entry in std::fs::read_dir(directory)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json")
                || path.file_name().and_then(|name| name.to_str()) == Some("folders.json")
            {
                continue;
            }
            let raw: serde_json::Value = match std::fs::read_to_string(&path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
            {
                Some(value) => value,
                None => continue,
            };
            let id = raw
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim();
            let file = raw
                .get("fileName")
                .or_else(|| raw.get("file"))
                .and_then(serde_json::Value::as_str)
                .and_then(|value| Path::new(value).file_name())
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            if !safe_image_id(id) || file.is_empty() || !directory.join(&file).is_file() {
                continue;
            }
            let tags = raw
                .get("tags")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let image = worldbase_protocol::types::ImageEntry {
                id: id.to_string(),
                prompt: raw
                    .get("prompt")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                provider_id: raw
                    .get("providerId")
                    .or_else(|| raw.get("provider_id"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned),
                model: raw
                    .get("model")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                file,
                created_at: raw
                    .get("createdAt")
                    .or_else(|| raw.get("created_at"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(now_ts),
                folder: raw
                    .get("folder")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                tags,
                // Retain the whole Electron record: old images may carry
                // sourceImageFileNames, dimensions, or provider fields not
                // present in the initial Rust table schema.
                meta: raw,
            };
            self.add_image(&image)?;
            imported = imported.saturating_add(1);
        }

        // `folders.json` is written by Rust for a later TS fallback. It is
        // also usable when Electron's derived index has not been created yet.
        let folders_mirror = directory.join("folders.json");
        let mut folder_mirror = None;
        if let Ok(raw) = std::fs::read_to_string(&folders_mirror) {
            if let Ok(names) = serde_json::from_str::<Vec<String>>(&raw) {
                folder_mirror = Some(names);
            }
        }

        if let Some(names) = folder_mirror {
            let names = names
                .into_iter()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty() && name != "*")
                .collect::<HashSet<_>>();
            let conn = self.conn.lock().unwrap();
            let tx = conn.unchecked_transaction()?;
            let existing = {
                let mut statement = tx.prepare("SELECT name FROM image_folders")?;
                let names = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .filter_map(|row| row.ok())
                    .collect::<Vec<_>>();
                names
            };
            for name in existing {
                if !names.contains(&name) {
                    tx.execute("DELETE FROM image_folders WHERE name = ?1", params![name])?;
                }
            }
            for name in names {
                tx.execute(
                    "INSERT OR IGNORE INTO image_folders (name) VALUES (?1)",
                    params![name],
                )?;
            }
            tx.commit()?;
        } else {
            // Older Electron installs did not create folders.json. Preserve
            // their registry once from the disposable index; once the JSON
            // mirror exists it is authoritative and stale index rows must not
            // resurrect a deleted empty folder.
            let legacy_index = directory.join("index.db");
            if legacy_index.is_file() {
                if let Ok(conn) = Connection::open_with_flags(
                    legacy_index,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                ) {
                    if let Ok(mut stmt) = conn.prepare("SELECT name FROM folders") {
                        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                            for name in rows.flatten() {
                                let _ = self.create_image_folder(&name);
                            }
                        }
                    }
                }
            }
        }

        // A missing output file is the only deletion signal that can safely
        // cross modes. Do not remove image rows merely because their JSON file
        // is absent: legacy Rust records may predate the mirror but still point
        // to valid shared-library files.
        let stale_ids = {
            let conn = self.conn.lock().unwrap();
            let mut statement = conn.prepare("SELECT id, file FROM images")?;
            let ids = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .filter_map(|row| row.ok())
                .filter_map(|(id, file)| {
                    let file_name = Path::new(&file).file_name()?.to_str()?;
                    (!directory.join(file_name).is_file()).then_some(id)
                })
                .collect::<Vec<_>>();
            ids
        };
        if !stale_ids.is_empty() {
            let conn = self.conn.lock().unwrap();
            let tx = conn.unchecked_transaction()?;
            for id in stale_ids {
                tx.execute("DELETE FROM images WHERE id = ?1", params![id])?;
            }
            tx.commit()?;
        }
        Ok(imported)
    }

    /// Persist a renderer-compatible image metadata mirror. Rust remains the
    /// authoritative index in Rust mode; this file only makes a later switch
    /// back to the legacy gallery reversible without importing app.sqlite.
    pub fn write_image_library_mirror(
        directory: &Path,
        entry: &worldbase_protocol::types::ImageEntry,
    ) -> Result<()> {
        std::fs::create_dir_all(directory)?;
        anyhow::ensure!(safe_image_id(&entry.id), "invalid image id");
        let meta = entry.meta.as_object();
        let string = |key: &str| {
            meta.and_then(|meta| meta.get(key))
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
        };
        let source_image_file_names = meta
            .and_then(|meta| meta.get("sourceImageFileNames"))
            .or_else(|| meta.and_then(|meta| meta.get("source_image_file_names")))
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .filter_map(|value| Path::new(value).file_name())
                    .filter_map(|value| value.to_str())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mirror = serde_json::json!({
            "id": entry.id,
            "createdAt": entry.created_at,
            "mode": string("mode").unwrap_or("generate"),
            "providerId": entry.provider_id,
            "model": entry.model,
            "prompt": entry.prompt,
            "negativePrompt": string("negativePrompt"),
            "aspectRatio": string("aspectRatio").or_else(|| string("aspect")),
            "size": string("size").unwrap_or(""),
            "quality": string("quality"),
            "outputFormat": string("outputFormat").or_else(|| string("format")),
            "fileName": Path::new(&entry.file).file_name().and_then(|value| value.to_str()).unwrap_or_default(),
            "thumbName": string("thumbName").or_else(|| string("thumb_name")),
            "sourceImageFileNames": source_image_file_names,
            "folder": (!entry.folder.trim().is_empty()).then_some(entry.folder.trim()),
            "tags": normalize_image_tags(&entry.tags),
            "width": meta.and_then(|meta| meta.get("width")).and_then(serde_json::Value::as_u64),
            "height": meta.and_then(|meta| meta.get("height")).and_then(serde_json::Value::as_u64),
        });
        let target = directory.join(format!("{}.json", entry.id));
        let temporary = directory.join(format!("{}.json.tmp", entry.id));
        std::fs::write(&temporary, serde_json::to_vec_pretty(&mirror)?)?;
        std::fs::rename(temporary, target)?;
        Ok(())
    }

    /// Create a bounded WebP preview beside a gallery image. Rust uses this
    /// from both Image Studio and native image tools, so switching execution
    /// engines never changes where thumbnails are produced.
    ///
    /// Unsupported or corrupt source formats return `None`; callers then keep
    /// serving the original image, matching the legacy gallery's graceful
    /// fallback when its thumbnailer is unavailable.
    pub fn write_image_library_thumbnail(
        directory: &Path,
        id: &str,
        file_name: &str,
    ) -> Option<ImageLibraryThumbnail> {
        if !safe_image_id(id) {
            return None;
        }
        let source_name = Path::new(file_name).file_name()?.to_str()?;
        let image = ImageReader::open(directory.join(source_name))
            .ok()?
            .with_guessed_format()
            .ok()?
            .decode()
            .ok()?;
        let (width, height) = image.dimensions();
        let thumbnail = if width <= IMAGE_LIBRARY_THUMBNAIL_MAX_DIMENSION
            && height <= IMAGE_LIBRARY_THUMBNAIL_MAX_DIMENSION
        {
            image
        } else {
            image.thumbnail(
                IMAGE_LIBRARY_THUMBNAIL_MAX_DIMENSION,
                IMAGE_LIBRARY_THUMBNAIL_MAX_DIMENSION,
            )
        };
        let name = format!("{id}.thumb.webp");
        let target = directory.join(&name);
        let temporary = directory.join(format!("{id}.thumb.webp.tmp"));
        let mut bytes = Vec::new();
        thumbnail
            .write_to(&mut Cursor::new(&mut bytes), ImageOutputFormat::WebP)
            .ok()?;
        std::fs::write(&temporary, bytes).ok()?;
        if std::fs::rename(&temporary, &target).is_err() {
            let _ = std::fs::remove_file(&temporary);
            if !target.is_file() {
                return None;
            }
        }
        Some(ImageLibraryThumbnail {
            name,
            width,
            height,
        })
    }

    pub fn write_image_folder_mirror(
        directory: &Path,
        folders: &[worldbase_protocol::types::ImageFolder],
    ) -> Result<()> {
        std::fs::create_dir_all(directory)?;
        let names: Vec<_> = folders
            .iter()
            .map(|folder| folder.name.trim())
            .filter(|name| !name.is_empty())
            .collect();
        let target = directory.join("folders.json");
        let temporary = directory.join("folders.json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(&names)?)?;
        std::fs::rename(temporary, target)?;
        Ok(())
    }

    // ---------- conversations ----------

    pub fn create_conversation(
        &self,
        title: &str,
        agent_id: Option<&str>,
    ) -> Result<ConversationMeta> {
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, agent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, title, agent_id, ts, ts],
        )?;
        Ok(ConversationMeta {
            id,
            title: title.into(),
            created_at: ts.clone(),
            updated_at: ts,
            message_count: 0,
            agent_id: agent_id.map(Into::into),
            forked_from_conversation_id: None,
            forked_from_message_id: None,
            fork_depth: 0,
        })
    }

    /// Create a conversation with a caller-provided id when it does not exist.
    /// Electron uses this to keep its renderer conversation id stable while
    /// switching between the TypeScript and Rust harnesses.
    pub fn ensure_conversation(
        &self,
        id: &str,
        title: &str,
        agent_id: Option<&str>,
    ) -> Result<ConversationMeta> {
        let ts = now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO conversations (id, title, agent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, title, agent_id, ts],
        )?;
        if agent_id.is_some() {
            conn.execute(
                "UPDATE conversations SET agent_id = ?2 WHERE id = ?1 AND (agent_id IS NULL OR agent_id = '')",
                params![id, agent_id],
            )?;
        }
        drop(conn);
        self.get_conversation(id)?
            .ok_or_else(|| anyhow::anyhow!("conversation was not created"))
    }

    /// 从源会话分叉：复制标题/agent 元数据并写谱系字段。
    pub fn create_forked_conversation(
        &self,
        source: &ConversationMeta,
        source_message_id: i64,
        new_title: &str,
    ) -> Result<ConversationMeta> {
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_ts();
        let depth = self
            .get_conversation(&source.id)?
            .map(|c| c.fork_depth)
            .unwrap_or(0);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, agent_id, created_at, updated_at, forked_from_conversation_id, forked_from_message_id, fork_depth)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                new_title,
                source.agent_id,
                ts,
                ts,
                source.id,
                source_message_id,
                depth + 1,
            ],
        )?;
        Ok(ConversationMeta {
            id,
            title: new_title.into(),
            created_at: ts.clone(),
            updated_at: ts,
            message_count: 0,
            agent_id: source.agent_id.clone(),
            forked_from_conversation_id: Some(source.id.clone()),
            forked_from_message_id: Some(source_message_id),
            fork_depth: depth + 1,
        })
    }

    /// 截断 anchor 之后的消息（不含 anchor）。返回删除条数。
    pub fn truncate_after(&self, conversation_id: &str, anchor_message_id: i64) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id > ?2",
            params![conversation_id, anchor_message_id],
        )?;
        conn.execute(
            "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
            params![conversation_id, now_ts()],
        )?;
        Ok(n as i64)
    }

    /// 覆写消息文本（编辑重发的 inplace 模式）。
    pub fn update_message_content(&self, message_id: i64, content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET content = ?2 WHERE id = ?1",
            params![message_id, content],
        )?;
        Ok(())
    }

    /// 取 anchor（含）之前的消息 id 列表（用于复制前缀）。
    pub fn message_ids_up_to(
        &self,
        conversation_id: &str,
        anchor: Option<i64>,
    ) -> Result<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match anchor {
            Some(_) => conn.prepare(
                "SELECT id FROM messages WHERE conversation_id = ?1 AND id <= ?2 ORDER BY id",
            )?,
            None => {
                conn.prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")?
            }
        };
        let rows: Vec<i64> = match anchor {
            Some(a) => stmt
                .query_map(params![conversation_id, a], |r| r.get::<_, i64>(0))?
                .filter_map(|r| r.ok())
                .collect(),
            None => stmt
                .query_map(params![conversation_id], |r| r.get::<_, i64>(0))?
                .filter_map(|r| r.ok())
                .collect(),
        };
        Ok(rows)
    }

    pub fn get_message(
        &self,
        conversation_id: &str,
        message_id: i64,
    ) -> Result<Option<ChatMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT * FROM messages WHERE conversation_id = ?1 AND id = ?2")?;
        let mut rows =
            stmt.query_map(params![conversation_id, message_id], Self::row_to_message)?;
        Ok(rows.next().transpose()?)
    }

    // ---------- agents ----------

    pub fn upsert_agent(&self, agent: &worldbase_protocol::types::AgentDefinition) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agents (id, name, icon, description, system_prompt, provider_id, model_id, skill_ids, reasoning_strength, allowed_tools, denied_tools, memory_scopes, memory_write_policy, auto_reply_policy, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, description=excluded.description,
               system_prompt=excluded.system_prompt, provider_id=excluded.provider_id, model_id=excluded.model_id,
               skill_ids=excluded.skill_ids, reasoning_strength=excluded.reasoning_strength,
               allowed_tools=excluded.allowed_tools, denied_tools=excluded.denied_tools,
               memory_scopes=excluded.memory_scopes, memory_write_policy=excluded.memory_write_policy,
               auto_reply_policy=excluded.auto_reply_policy, updated_at=excluded.updated_at",
            params![
                agent.id,
                agent.name,
                agent.icon,
                agent.description,
                agent.system_prompt,
                agent.provider_id,
                agent.model_id,
                serde_json::to_string(&agent.skill_ids)?,
                agent.reasoning_strength,
                serde_json::to_string(&agent.allowed_tools)?,
                serde_json::to_string(&agent.denied_tools)?,
                serde_json::to_string(&agent.memory_scopes)?,
                serde_json::to_string(&agent.memory_write_policy)?,
                serde_json::to_string(&agent.auto_reply_policy)?,
                agent.created_at,
                agent.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_agents(&self) -> Result<Vec<worldbase_protocol::types::AgentDefinition>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM agents ORDER BY created_at")?;
        let rows = stmt.query_map([], Self::row_to_agent)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_agent(
        &self,
        id: &str,
    ) -> Result<Option<worldbase_protocol::types::AgentDefinition>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM agents WHERE id = ?1")?;
        let mut rows = stmt.query_map(params![id], Self::row_to_agent)?;
        Ok(rows.next().transpose()?)
    }

    pub fn delete_agent(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ---------- durable Agent Workspace groups ----------

    /// Return the raw group catalog stored in settings.  Group normalization
    /// belongs to the core dispatcher because save/get/list need the same
    /// Electron-compatible defaults while retaining the settings migration
    /// format used by older Rust tools.
    pub fn get_agent_groups_setting(&self) -> Result<Vec<serde_json::Value>> {
        let value = self
            .get_setting("agent_groups")?
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
        Ok(value.as_array().cloned().unwrap_or_default())
    }

    /// Replace the durable group catalog atomically from the store's point of
    /// view.  The caller supplies already-normalized group values.
    pub fn set_agent_groups_setting(&self, groups: &[serde_json::Value]) -> Result<()> {
        self.set_setting("agent_groups", &serde_json::Value::Array(groups.to_vec()))
    }

    fn row_to_agent(row: &Row) -> rusqlite::Result<worldbase_protocol::types::AgentDefinition> {
        Ok(worldbase_protocol::types::AgentDefinition {
            id: row.get("id")?,
            name: row.get("name")?,
            icon: row.get("icon")?,
            description: row.get("description")?,
            system_prompt: row.get("system_prompt")?,
            provider_id: row.get("provider_id")?,
            model_id: row.get("model_id")?,
            skill_ids: serde_json::from_str(&row.get::<_, String>("skill_ids")?)
                .unwrap_or_default(),
            reasoning_strength: row
                .get::<_, String>("reasoning_strength")
                .unwrap_or_else(|_| "medium".into()),
            allowed_tools: serde_json::from_str(
                &row.get::<_, String>("allowed_tools")
                    .unwrap_or_else(|_| "[]".into()),
            )
            .unwrap_or_default(),
            denied_tools: serde_json::from_str(
                &row.get::<_, String>("denied_tools")
                    .unwrap_or_else(|_| "[]".into()),
            )
            .unwrap_or_default(),
            memory_scopes: serde_json::from_str(
                &row.get::<_, String>("memory_scopes")
                    .unwrap_or_else(|_| "[\"user\",\"agent\",\"project\"]".into()),
            )
            .unwrap_or_else(|_| vec!["user".into(), "agent".into(), "project".into()]),
            memory_write_policy: serde_json::from_str(
                &row.get::<_, String>("memory_write_policy")
                    .unwrap_or_else(|_| "{}".into()),
            )
            .unwrap_or_default(),
            auto_reply_policy: serde_json::from_str(
                &row.get::<_, String>("auto_reply_policy")
                    .unwrap_or_else(|_| "{}".into()),
            )
            .unwrap_or_default(),
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    // ---------- image library ----------

    pub fn add_image(&self, entry: &worldbase_protocol::types::ImageEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO images (id, prompt, provider_id, model, file, created_at, meta, folder, tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                prompt = excluded.prompt,
                provider_id = excluded.provider_id,
                model = excluded.model,
                file = excluded.file,
                created_at = excluded.created_at,
                meta = excluded.meta,
                folder = excluded.folder,
                tags = excluded.tags",
            params![
                entry.id,
                entry.prompt,
                entry.provider_id,
                entry.model,
                entry.file,
                entry.created_at,
                entry.meta.to_string(),
                entry.folder,
                image_tags_to_storage(&entry.tags),
            ],
        )?;
        Ok(())
    }

    pub fn list_images(&self, limit: u32) -> Result<Vec<worldbase_protocol::types::ImageEntry>> {
        Ok(self
            .query_image_page(None, true, &[], None, limit, 0)?
            .images)
    }

    /// Legacy compact query. Its absence of a folder filter historically meant
    /// all images, unlike the Electron gallery's explicit root-folder view.
    pub fn query_images(
        &self,
        folder: Option<&str>,
        tag: Option<&str>,
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<worldbase_protocol::types::ImageEntry>> {
        let tags = tag.map(|tag| vec![tag.to_string()]).unwrap_or_default();
        Ok(self
            .query_image_page(folder, folder.is_none(), &tags, search, limit, 0)?
            .images)
    }

    /// Full gallery query used by Rust-mode Electron. Root, all-folder,
    /// pagination and multi-tag semantics deliberately match ImageLibraryStore.
    pub fn query_image_page(
        &self,
        folder: Option<&str>,
        all_folders: bool,
        tags: &[String],
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<worldbase_protocol::types::ImagePage> {
        let conn = self.conn.lock().unwrap();
        let mut clauses = Vec::new();
        let mut binds: Vec<String> = Vec::new();
        let search = search.map(str::trim).filter(|search| !search.is_empty());
        // Electron's gallery turns a text search into a flat, global result
        // set. Keep the same behavior rather than retaining the current
        // root/folder scope beneath an active search.
        if search.is_none() && !all_folders {
            let folder = folder.unwrap_or("").trim();
            if folder.is_empty() {
                clauses.push("COALESCE(folder, '') = ''".to_string());
            } else {
                clauses.push("folder = ?".to_string());
                binds.push(folder.to_string());
            }
        }
        if let Some(search) = search {
            clauses.push(
                "(prompt LIKE ? OR COALESCE(folder, '') LIKE ? OR COALESCE(tags, '') LIKE ? OR COALESCE(meta, '') LIKE ?)".to_string(),
            );
            let pattern = format!("%{search}%");
            for _ in 0..4 {
                binds.push(pattern.clone());
            }
        }
        let mut sql = String::from("SELECT * FROM images");
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds.iter()), Self::row_to_image)?;
        let required_tags = normalize_image_tags(tags);
        let images: Vec<_> = rows
            .filter_map(|row| row.ok())
            .filter(|entry| {
                required_tags
                    .iter()
                    .all(|tag| entry.tags.iter().any(|entry_tag| entry_tag == tag))
            })
            .collect();
        let total = images.len().min(u32::MAX as usize) as u32;
        let limit = limit.clamp(1, 200) as usize;
        let offset = offset as usize;
        let page_images: Vec<_> = images.into_iter().skip(offset).take(limit).collect();
        let consumed = offset.saturating_add(page_images.len());
        Ok(worldbase_protocol::types::ImagePage {
            images: page_images,
            total,
            next_offset: (consumed < total as usize).then_some(consumed as u32),
        })
    }

    pub fn set_image_folder(&self, ids: &[String], folder: Option<&str>) -> Result<u32> {
        let folder = folder.unwrap_or("").trim();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut updated = 0u32;
        for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
            updated = updated.saturating_add(tx.execute(
                "UPDATE images SET folder = ?2 WHERE id = ?1",
                params![id, folder],
            )? as u32);
        }
        tx.commit()?;
        Ok(updated)
    }

    pub fn set_image_tags(&self, id: &str, tags: &[String]) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE images SET tags = ?2 WHERE id = ?1",
            params![id.trim(), image_tags_to_storage(tags)],
        )?;
        Ok(changed > 0)
    }

    pub fn set_image_meta(&self, id: &str, folder: &str, tags: &[String]) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE images SET folder = ?2, tags = ?3 WHERE id = ?1",
            params![id.trim(), folder.trim(), image_tags_to_storage(tags)],
        )?;
        Ok(n > 0)
    }

    pub fn get_image(&self, id: &str) -> Result<Option<worldbase_protocol::types::ImageEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM images WHERE id = ?1")?;
        let mut rows = stmt.query_map(params![id], Self::row_to_image)?;
        Ok(rows.next().transpose()?)
    }

    pub fn delete_image(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM images WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn create_image_folder(&self, name: &str) -> Result<()> {
        let name = name.trim();
        anyhow::ensure!(!name.is_empty() && name != "*", "invalid image folder name");
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO image_folders (name) VALUES (?1)",
            params![name],
        )?;
        Ok(())
    }

    pub fn list_image_folders(&self) -> Result<Vec<worldbase_protocol::types::ImageFolder>> {
        let conn = self.conn.lock().unwrap();
        let mut folders = BTreeMap::<String, u32>::new();
        {
            let mut stmt = conn.prepare(
                "SELECT folder, COUNT(*) FROM images WHERE COALESCE(folder, '') <> '' GROUP BY folder",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })?;
            for row in rows.flatten() {
                folders.insert(row.0, row.1);
            }
        }
        {
            let mut stmt = conn.prepare("SELECT name FROM image_folders")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for name in rows.flatten() {
                folders.entry(name).or_insert(0);
            }
        }
        let mut cover_stmt = conn.prepare(
            "SELECT id FROM images WHERE folder = ?1 ORDER BY created_at DESC, id DESC LIMIT 4",
        )?;
        folders
            .into_iter()
            .map(|(name, count)| {
                let cover_image_ids = cover_stmt
                    .query_map(params![name], |row| row.get::<_, String>(0))?
                    .filter_map(|row| row.ok())
                    .collect();
                Ok(worldbase_protocol::types::ImageFolder {
                    name,
                    count,
                    cover_image_ids,
                })
            })
            .collect()
    }

    pub fn rename_image_folder(&self, old_name: &str, new_name: &str) -> Result<u32> {
        let old_name = old_name.trim();
        let new_name = new_name.trim();
        if old_name.is_empty() || new_name.is_empty() || new_name == "*" || old_name == new_name {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let updated = tx.execute(
            "UPDATE images SET folder = ?2 WHERE folder = ?1",
            params![old_name, new_name],
        )? as u32;
        tx.execute(
            "DELETE FROM image_folders WHERE name = ?1",
            params![old_name],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO image_folders (name) VALUES (?1)",
            params![new_name],
        )?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn delete_image_folder(&self, name: &str) -> Result<u32> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let updated = tx.execute(
            "UPDATE images SET folder = '' WHERE folder = ?1",
            params![name],
        )? as u32;
        tx.execute("DELETE FROM image_folders WHERE name = ?1", params![name])?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn list_image_tags(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT tags FROM images WHERE COALESCE(tags, '') <> ''")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut tags = BTreeMap::<String, ()>::new();
        for raw in rows.flatten() {
            for tag in image_tags_from_storage(&raw) {
                tags.insert(tag, ());
            }
        }
        Ok(tags.into_keys().collect())
    }

    pub fn image_entries_in_folder(
        &self,
        folder: &str,
    ) -> Result<Vec<worldbase_protocol::types::ImageEntry>> {
        let folder = folder.trim();
        let conn = self.conn.lock().unwrap();
        let sql = if folder.is_empty() {
            "SELECT * FROM images WHERE COALESCE(folder, '') = '' ORDER BY created_at DESC, id DESC"
        } else {
            "SELECT * FROM images WHERE folder = ?1 ORDER BY created_at DESC, id DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = if folder.is_empty() {
            stmt.query_map([], Self::row_to_image)?
        } else {
            stmt.query_map(params![folder], Self::row_to_image)?
        };
        Ok(rows.filter_map(|row| row.ok()).collect())
    }

    fn row_to_image(row: &Row) -> rusqlite::Result<worldbase_protocol::types::ImageEntry> {
        let tags: String = row
            .get::<_, Option<String>>("tags")
            .ok()
            .flatten()
            .unwrap_or_default();
        let folder: String = row
            .get::<_, Option<String>>("folder")
            .ok()
            .flatten()
            .unwrap_or_default();
        Ok(worldbase_protocol::types::ImageEntry {
            id: row.get("id")?,
            prompt: row.get("prompt")?,
            provider_id: row.get("provider_id")?,
            model: row.get("model")?,
            file: row.get("file")?,
            created_at: row.get("created_at")?,
            folder,
            tags: image_tags_from_storage(&tags),
            meta: serde_json::from_str(&row.get::<_, String>("meta")?)
                .unwrap_or(serde_json::Value::Null),
        })
    }

    fn row_to_meta(row: &Row) -> rusqlite::Result<ConversationMeta> {
        Ok(ConversationMeta {
            id: row.get("id")?,
            title: row.get("title")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            message_count: row.get("message_count")?,
            agent_id: row.get("agent_id")?,
            forked_from_conversation_id: row.get("forked_from_conversation_id").ok(),
            forked_from_message_id: row.get("forked_from_message_id").ok(),
            fork_depth: row
                .get::<_, Option<i64>>("fork_depth")
                .ok()
                .flatten()
                .unwrap_or(0),
        })
    }

    pub fn list_conversations(&self, limit: u32) -> Result<Vec<ConversationMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
             FROM conversations c ORDER BY c.updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], Self::row_to_meta)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_conversation(&self, id: &str) -> Result<Option<ConversationMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
             FROM conversations c WHERE c.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], Self::row_to_meta)?;
        Ok(rows.next().transpose()?)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now_ts()],
        )?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- messages ----------

    pub fn append_message(&self, conversation_id: &str, msg: &ChatMessage) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let ts = msg.created_at.clone().unwrap_or_else(now_ts);
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, parts_json, tool_calls_json, tool_results_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                conversation_id,
                role_to_str(msg.role),
                msg.content,
                serde_json::to_string(&msg.parts)?,
                serde_json::to_string(&msg.tool_calls)?,
                serde_json::to_string(&msg.tool_results)?,
                ts,
            ],
        )?;
        let row_id = conn.last_insert_rowid();
        conn.execute(
            "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
            params![conversation_id, now_ts()],
        )?;
        Ok(row_id)
    }

    /// Replace the persisted message prefix for a conversation.
    ///
    /// Electron stores conversations as JSON files while the Rust harness
    /// stores them in SQLite. The bridge excludes the current user turn so
    /// the agent can append that turn exactly once after synchronization.
    pub fn replace_messages(&self, conversation_id: &str, messages: &[ChatMessage]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO messages (conversation_id, role, content, parts_json, tool_calls_json, tool_results_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for msg in messages {
                let ts = msg.created_at.clone().unwrap_or_else(now_ts);
                stmt.execute(params![
                    conversation_id,
                    role_to_str(msg.role),
                    msg.content,
                    serde_json::to_string(&msg.parts)?,
                    serde_json::to_string(&msg.tool_calls)?,
                    serde_json::to_string(&msg.tool_results)?,
                    ts,
                ])?;
            }
        }
        tx.execute(
            "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
            params![conversation_id, now_ts()],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn row_to_message(row: &Row) -> rusqlite::Result<ChatMessage> {
        let tool_calls: Vec<ToolCallRecord> =
            serde_json::from_str(&row.get::<_, String>("tool_calls_json")?).unwrap_or_default();
        let tool_results: Vec<ToolResultRecord> =
            serde_json::from_str(&row.get::<_, String>("tool_results_json")?).unwrap_or_default();
        let parts = row
            .get::<_, Option<String>>("parts_json")
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Ok(ChatMessage {
            id: row.get("id")?,
            role: str_to_role(&row.get::<_, String>("role")?),
            content: row.get("content")?,
            parts,
            tool_calls,
            tool_results,
            created_at: row.get("created_at")?,
        })
    }

    pub fn list_messages(&self, conversation_id: &str, limit: u32) -> Result<Vec<ChatMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![conversation_id, limit], Self::row_to_message)?;
        let messages: Vec<_> = rows.filter_map(|r| r.ok()).collect();
        Ok(repair_empty_tool_message_ids(messages))
    }

    // ---------- long-term memory (FTS5) ----------

    pub fn add_memory(&self, content: &str, tags: &[String]) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO memories (content, tags, created_at) VALUES (?1, ?2, ?3)",
            params![content, tags.join(","), now_ts()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn delete_memory(&self, id: i64) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn search_memories(&self, query: &str, limit: u32) -> Result<Vec<MemoryEntry>> {
        let conn = self.conn.lock().unwrap();
        // FTS5 unicode61 对连续 CJK 无分词，命中为空时回退 LIKE 扫描。
        let fts_rows = conn
            .prepare(
                "SELECT m.id, m.content, m.tags, m.created_at,
                        bm25(memories_fts) AS score
                 FROM memories_fts f JOIN memories m ON m.id = f.rowid
                 WHERE memories_fts MATCH ?1
                 ORDER BY score LIMIT ?2",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map(params![query, limit], Self::row_to_memory)?;
                let hits: Vec<_> = rows.filter_map(|r| r.ok()).collect();
                Ok(hits)
            });
        if let Ok(hits) = fts_rows {
            if !hits.is_empty() {
                return Ok(hits);
            }
        }
        let mut stmt = conn.prepare(
            "SELECT id, content, tags, created_at FROM memories
             WHERE content LIKE '%' || ?1 || '%' OR tags LIKE '%' || ?1 || '%'
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![query, limit], Self::row_to_memory)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn row_to_memory(row: &Row) -> rusqlite::Result<MemoryEntry> {
        let tags: String = row.get("tags")?;
        Ok(MemoryEntry {
            id: row.get("id")?,
            content: row.get("content")?,
            tags: tags
                .split(',')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            created_at: row.get("created_at")?,
            score: row.get("score").ok(),
        })
    }

    // ---------- Electron Agent Workspace memory ----------

    fn normalize_workspace_memory(mut entry: WorkspaceMemoryEntry) -> WorkspaceMemoryEntry {
        if entry.id.trim().is_empty() {
            entry.id = format!("mem_{}", uuid::Uuid::new_v4().simple());
        } else {
            entry.id = entry.id.trim().to_string();
        }
        entry.scope_type = if entry.scope_type.trim().is_empty() {
            "user".into()
        } else {
            entry.scope_type.trim().to_string()
        };
        entry.scope_id = if entry.scope_id.trim().is_empty() {
            "local-user".into()
        } else {
            entry.scope_id.trim().to_string()
        };
        entry.memory_type = if entry.memory_type.trim().is_empty() {
            "knowledge".into()
        } else {
            entry.memory_type.trim().to_string()
        };
        entry.title = entry.title.trim().to_string();
        entry.summary = entry.summary.trim().to_string();
        entry.details = entry.details.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        entry.tags = normalize_memory_strings(&entry.tags);
        entry.source_message_ids = normalize_memory_strings(&entry.source_message_ids);
        entry.source_conversation_id = entry.source_conversation_id.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        entry.source_session_id = entry.source_session_id.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        entry.last_used_at = entry.last_used_at.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        entry.importance = entry.importance.clamp(0.0, 1.0);
        entry.confidence = entry.confidence.clamp(0.0, 1.0);
        if entry.created_at.trim().is_empty() {
            entry.created_at = now_ts();
        } else {
            entry.created_at = entry.created_at.trim().to_string();
        }
        entry.updated_at = now_ts();
        entry
    }

    fn row_to_workspace_memory(row: &Row) -> rusqlite::Result<WorkspaceMemoryEntry> {
        let tags_json: String = row
            .get::<_, Option<String>>("tags_json")?
            .unwrap_or_else(|| "[]".into());
        let source_ids_json: String = row
            .get::<_, Option<String>>("source_message_ids_json")?
            .unwrap_or_else(|| "[]".into());
        let parse_strings = |raw: &str| {
            serde_json::from_str::<Vec<String>>(raw)
                .map(|values| normalize_memory_strings(&values))
                .unwrap_or_default()
        };
        Ok(WorkspaceMemoryEntry {
            id: row.get("id")?,
            scope_type: row.get("scope_type")?,
            scope_id: row.get("scope_id")?,
            memory_type: row.get("memory_type")?,
            title: row.get("title")?,
            summary: row.get("summary")?,
            details: row.get("details")?,
            tags: parse_strings(&tags_json),
            source_conversation_id: row.get("source_conversation_id")?,
            source_session_id: row.get("source_session_id")?,
            source_message_ids: parse_strings(&source_ids_json),
            importance: row.get::<_, Option<f64>>("importance")?.unwrap_or(0.5),
            confidence: row.get::<_, Option<f64>>("confidence")?.unwrap_or(0.5),
            pinned: row.get::<_, Option<i64>>("pinned")?.unwrap_or(0) != 0,
            last_used_at: row.get("last_used_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    pub fn get_workspace_memory(&self, id: &str) -> Result<Option<WorkspaceMemoryEntry>> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        let conn = self.memory_conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM memory_entries WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Self::row_to_workspace_memory(row)?)),
            None => Ok(None),
        }
    }

    pub fn save_workspace_memory(
        &self,
        entry: &WorkspaceMemoryEntry,
    ) -> Result<WorkspaceMemoryEntry> {
        let normalized = Self::normalize_workspace_memory(entry.clone());
        let tags_json = serde_json::to_string(&normalized.tags)?;
        let source_ids_json = serde_json::to_string(&normalized.source_message_ids)?;
        let mut conn = self.memory_conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO memory_entries (
                id, scope_type, scope_id, memory_type, title, summary, details,
                tags_json, source_conversation_id, source_session_id,
                source_message_ids_json, importance, confidence, pinned,
                last_used_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            ON CONFLICT(id) DO UPDATE SET
                scope_type = excluded.scope_type,
                scope_id = excluded.scope_id,
                memory_type = excluded.memory_type,
                title = excluded.title,
                summary = excluded.summary,
                details = excluded.details,
                tags_json = excluded.tags_json,
                source_conversation_id = excluded.source_conversation_id,
                source_session_id = excluded.source_session_id,
                source_message_ids_json = excluded.source_message_ids_json,
                importance = excluded.importance,
                confidence = excluded.confidence,
                pinned = excluded.pinned,
                last_used_at = excluded.last_used_at,
                updated_at = excluded.updated_at",
            params![
                normalized.id,
                normalized.scope_type,
                normalized.scope_id,
                normalized.memory_type,
                normalized.title,
                normalized.summary,
                normalized.details,
                tags_json,
                normalized.source_conversation_id,
                normalized.source_session_id,
                source_ids_json,
                normalized.importance,
                normalized.confidence,
                if normalized.pinned { 1i64 } else { 0i64 },
                normalized.last_used_at,
                normalized.created_at,
                normalized.updated_at,
            ],
        )?;
        // This FTS table is intentionally contentless/manual, matching the
        // Electron implementation and allowing old rows to be rebuilt safely.
        tx.execute(
            "DELETE FROM memory_entries_fts WHERE id = ?1",
            params![normalized.id],
        )?;
        tx.execute(
            "INSERT INTO memory_entries_fts (id, title, summary, details, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                normalized.id,
                normalized.title,
                normalized.summary,
                normalized.details.clone().unwrap_or_default(),
                normalized.tags.join(" "),
            ],
        )?;
        // Embedding document + job enqueue share this exact transaction so a
        // crash can never leave the main record and its retrieval projection
        // inconsistent (design §10.1). The vector write itself stays async.
        let embedding_text = Self::build_embedding_text(
            &normalized.title,
            &normalized.summary,
            normalized.details.as_deref(),
            &normalized.tags,
            None,
        );
        let _ = Self::sync_embedding_document_in_tx(
            &tx,
            embedding_store::EMBEDDING_SOURCE_MEMORY,
            &normalized.id,
            &normalized.scope_type,
            &normalized.scope_id,
            &embedding_text,
        );
        tx.commit()?;
        Ok(normalized)
    }

    pub fn search_workspace_memories(
        &self,
        options: &WorkspaceMemorySearchOptions,
    ) -> Result<Vec<WorkspaceMemoryEntry>> {
        let limit = options.limit.unwrap_or(20).clamp(1, 50_000);
        let query = options.query.as_deref().unwrap_or("").trim().to_string();
        let mut filters = Vec::new();
        let mut values: Vec<String> = Vec::new();
        if !options.scopes.is_empty() {
            let mut scope_filters = Vec::new();
            for scope in &options.scopes {
                let scope_type = scope.scope_type.trim();
                let scope_id = scope.scope_id.trim();
                if scope_type.is_empty() || scope_id.is_empty() {
                    continue;
                }
                scope_filters.push("(e.scope_type = ? AND e.scope_id = ?)".to_string());
                values.push(scope_type.to_string());
                values.push(scope_id.to_string());
            }
            if !scope_filters.is_empty() {
                filters.push(format!("({})", scope_filters.join(" OR ")));
            }
        }
        if !options.memory_types.is_empty() {
            let types: Vec<String> = options
                .memory_types
                .iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect();
            if !types.is_empty() {
                filters.push(format!(
                    "e.memory_type IN ({})",
                    std::iter::repeat("?")
                        .take(types.len())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
                values.extend(types);
            }
        }

        let fetch = |use_fts: bool| -> Result<Vec<WorkspaceMemoryEntry>> {
            let mut sql = if use_fts {
                "SELECT DISTINCT e.* FROM memory_entries e
                 JOIN memory_entries_fts f ON e.id = f.id"
                    .to_string()
            } else {
                "SELECT e.* FROM memory_entries e".to_string()
            };
            let mut local_values = values.clone();
            let mut local_filters = filters.clone();
            if use_fts {
                let terms: Vec<String> = query
                    .split_whitespace()
                    .map(|term| {
                        term.trim_matches(|character: char| {
                            !character.is_alphanumeric() && character != '_' && character != '-'
                        })
                        .replace('"', "\"\"")
                    })
                    .filter(|term| !term.is_empty())
                    .take(8)
                    .map(|term| format!("\"{term}\""))
                    .collect();
                if terms.is_empty() {
                    return Ok(Vec::new());
                }
                local_filters.push("f MATCH ?".into());
                local_values.push(terms.join(" AND "));
            } else if !query.is_empty() {
                local_filters.push(
                    "(e.title LIKE '%' || ? || '%' OR e.summary LIKE '%' || ? || '%' OR
                     COALESCE(e.details, '') LIKE '%' || ? || '%' OR e.tags_json LIKE '%' || ? || '%')"
                        .replace('\n', " "),
                );
                local_values.extend(std::iter::repeat(query.clone()).take(4));
            }
            if !local_filters.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&local_filters.join(" AND "));
            }
            sql.push_str(&format!(
                " ORDER BY e.pinned DESC, e.importance DESC, e.confidence DESC,
                          COALESCE(e.last_used_at, e.updated_at) DESC LIMIT {limit}"
            ));
            let conn = self.memory_conn.lock().unwrap();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                params_from_iter(local_values.iter()),
                Self::row_to_workspace_memory,
            )?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        };

        if !query.is_empty() {
            if let Ok(hits) = fetch(true) {
                if !hits.is_empty() {
                    return Ok(hits);
                }
            }
        }
        fetch(false)
    }

    pub fn list_workspace_memories(&self, limit: u32) -> Result<Vec<WorkspaceMemoryEntry>> {
        self.search_workspace_memories(&WorkspaceMemorySearchOptions {
            limit: Some(limit),
            ..Default::default()
        })
    }

    pub fn pin_workspace_memory(&self, id: &str, pinned: bool) -> Result<bool> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(false);
        }
        let conn = self.memory_conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE memory_entries SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![if pinned { 1i64 } else { 0i64 }, now_ts(), id],
        )?;
        Ok(changed > 0)
    }

    pub fn delete_workspace_memory(&self, id: &str) -> Result<bool> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(false);
        }
        let document = self.get_embedding_document(embedding_store::EMBEDDING_SOURCE_MEMORY, id)?;
        let mut conn = self.memory_conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM memory_entries_fts WHERE id = ?1", params![id])?;
        let changed = tx.execute("DELETE FROM memory_entries WHERE id = ?1", params![id])?;
        if changed > 0 {
            // §10.3: the main record disappears immediately; the derived
            // vector follows right after (deletion failures leave a
            // tombstone so forgotten memory cannot resurface).
            let _ = tx.execute(
                "DELETE FROM embedding_jobs WHERE document_id = ?1",
                params![embedding_store::document_id_for(embedding_store::EMBEDDING_SOURCE_MEMORY, id)],
            )?;
            let _ = tx.execute(
                "DELETE FROM embedding_documents WHERE id = ?1",
                params![embedding_store::document_id_for(embedding_store::EMBEDDING_SOURCE_MEMORY, id)],
            )?;
        }
        tx.commit()?;
        drop(conn);
        if changed > 0 {
            self.record_memory_event("forget", Some(id), "{}");
            if let Some(document) = document {
                self.delete_document_vectors(&document.id);
            }
        }
        Ok(changed > 0)
    }

    /// Extract durable memory from a completed session.  The input mirrors
    /// Electron's MemoryEngine context, but extraction and persistence happen
    /// entirely in Rust so the selected Rust backend never writes through the
    /// TypeScript MemoryStore.
    pub fn ingest_workspace_memories(
        &self,
        input: &serde_json::Value,
    ) -> Result<Vec<WorkspaceMemoryEntry>> {
        let scopes = input
            .get("scopes")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let scope_type = item.get("scopeType")?.as_str()?.trim();
                        let scope_id = item.get("scopeId")?.as_str()?.trim();
                        (!scope_type.is_empty() && !scope_id.is_empty())
                            .then(|| (scope_type.to_string(), scope_id.to_string()))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let scope = |kind: &str| {
            scopes
                .iter()
                .find(|(scope_type, _)| scope_type == kind)
                .cloned()
        };
        let user_scope = scope("user");
        let agent_scope = scope("agent");
        let project_scope = scope("project");
        let group_scope = scope("group");
        let source_conversation_id = input
            .get("sourceConversationId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let source_session_id = input
            .get("sourceSessionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let user_messages = input
            .get("userMessages")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let assistant_text = input
            .get("finalAssistantText")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let tool_names = input
            .get("toolNames")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let agent = input.get("agent");
        let policy = agent
            .and_then(|value| value.get("memoryWritePolicy"))
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let allow = |key: &str| {
            policy
                .get(key)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true)
        };
        let mut candidates = Vec::new();
        let mut push_entry = |scope_ref: Option<(String, String)>,
                              memory_type: &str,
                              title: String,
                              summary: String,
                              details: Option<String>,
                              tags: Vec<String>,
                              importance: f64,
                              confidence: f64| {
            let Some((scope_type, scope_id)) = scope_ref else {
                return;
            };
            let title = clean_memory_value(&title);
            let summary = clean_memory_value(&summary);
            if title.is_empty() || summary.is_empty() {
                return;
            }
            let seed = format!("{scope_type}|{scope_id}|{memory_type}|{title}|{summary}");
            candidates.push(WorkspaceMemoryEntry {
                id: stable_memory_id(&seed),
                scope_type,
                scope_id,
                memory_type: memory_type.to_string(),
                title,
                summary,
                details: details
                    .map(|value| clean_memory_value(&value))
                    .filter(|value| !value.is_empty()),
                tags: normalize_memory_strings(&tags),
                source_conversation_id: source_conversation_id.clone(),
                source_session_id: source_session_id.clone(),
                source_message_ids: Vec::new(),
                importance,
                confidence,
                pinned: false,
                last_used_at: None,
                created_at: now_ts(),
                updated_at: now_ts(),
            });
        };

        if allow("allowUserTraits") {
            for message in &user_messages {
                if regex::Regex::new(r"(?i)(以后|今后|默认|始终).{0,12}(中文|Chinese)")
                    .unwrap()
                    .is_match(message)
                {
                    push_entry(
                        user_scope.clone(),
                        "user_trait",
                        "偏好使用中文".into(),
                        "用户偏好默认使用中文沟通和输出。".into(),
                        Some(first_memory_line(message)),
                        vec!["language".into(), "preference".into()],
                        0.85,
                        0.85,
                    );
                }
                if regex::Regex::new(r"(?i)(先.*方案.*再.*(写|改)代码|先规划后执行|先出方案)")
                    .unwrap()
                    .is_match(message)
                {
                    push_entry(
                        user_scope.clone(),
                        "user_trait",
                        "偏好先方案后执行".into(),
                        "用户偏好先看方案或规划，再进入实现。".into(),
                        Some(first_memory_line(message)),
                        vec!["workflow".into(), "planning".into()],
                        0.85,
                        0.85,
                    );
                }
            }
        }
        if allow("allowAgentSkills") {
            let skill_ids = agent
                .and_then(|value| value.get("skillIds"))
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !skill_ids.is_empty() {
                let name = agent
                    .and_then(|value| value.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent");
                push_entry(
                    agent_scope.clone(),
                    "agent_skill",
                    format!("{name} 默认技能组合"),
                    format!("默认激活技能: {}", skill_ids.join(", ")),
                    None,
                    vec!["skills".into(), "profile".into()],
                    0.8,
                    0.95,
                );
            }
        }
        if allow("allowSteps") && tool_names.len() >= 2 {
            push_entry(
                project_scope.clone().or(agent_scope.clone()),
                "step",
                "常用执行链路".into(),
                format!(
                    "近期高频执行顺序: {}",
                    tool_names
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>()
                        .join(" -> ")
                ),
                Some("该步骤来自已完成会话的工具执行顺序，可在相似任务中优先复用。".into()),
                vec!["workflow".into(), "tools".into()],
                0.72,
                0.7,
            );
        }
        if allow("allowKnowledge") {
            let knowledge_scope = project_scope
                .clone()
                .or(group_scope.clone())
                .or(agent_scope.clone());
            let signal = regex::Regex::new(r"(关键|注意|约束|坑|必须|不要|优先|应该|需要|避免|只能|不能|务必|建议|推荐|AI|API|Electron|SQLite|TypeScript|项目|文件|构建|测试|依赖|权限|命令|模型|工具|记忆)").unwrap();
            for part in assistant_text
                .split(|c| matches!(c, '\n' | '.' | '。' | '!' | '！' | '?' | '？'))
                .map(str::trim)
                .filter(|value| value.len() >= 8)
                .take(3)
            {
                if signal.is_match(part) {
                    let title = if part.chars().count() > 32 {
                        format!("{}...", part.chars().take(32).collect::<String>())
                    } else {
                        part.to_string()
                    };
                    push_entry(
                        knowledge_scope.clone(),
                        "knowledge",
                        title,
                        part.to_string(),
                        Some(assistant_text.chars().take(600).collect()),
                        vec!["knowledge".into(), "insight".into()],
                        0.75,
                        0.62,
                    );
                }
            }
        }
        let mut saved = Vec::new();
        let mut seen = HashSet::new();
        for entry in candidates {
            if seen.insert(entry.id.clone()) {
                saved.push(self.save_workspace_memory(&entry)?);
            }
        }
        Ok(saved)
    }

    pub fn memory_compaction_status(&self) -> MemoryCompactionStatus {
        self.memory_compaction_status.lock().unwrap().clone()
    }

    fn remove_workspace_memory_for_compaction(
        &self,
        id: &str,
        by_id: &mut HashMap<String, WorkspaceMemoryEntry>,
        deleted_ids: &mut HashSet<String>,
        deleted: &mut u32,
    ) -> Result<bool> {
        let Some(entry) = by_id.get(id) else {
            return Ok(false);
        };
        if entry.pinned || deleted_ids.contains(id) {
            return Ok(false);
        }
        if !self.delete_workspace_memory(id)? {
            return Ok(false);
        }
        deleted_ids.insert(id.to_string());
        by_id.remove(id);
        *deleted += 1;
        Ok(true)
    }

    pub fn compact_workspace_memories(
        &self,
        plan: &MemoryCompactionPlan,
    ) -> Result<MemoryCompactionResult> {
        let task_id = format!("memory_compact_{}", uuid::Uuid::new_v4().simple());
        let started_at = now_ts();
        {
            let mut status = self.memory_compaction_status.lock().unwrap();
            *status = MemoryCompactionStatus {
                id: Some(task_id),
                status: "running".into(),
                stage: "applying".into(),
                detail: None,
                scanned: 0,
                total_chunks: 0,
                completed_chunks: 0,
                started_at: Some(started_at),
                updated_at: now_ts(),
                finished_at: None,
                result: None,
                error: None,
            };
        }

        let operation = (|| -> Result<MemoryCompactionResult> {
            let entries = self.list_workspace_memories(50_000)?;
            let scanned = entries.len() as u32;
            let mut by_id: HashMap<String, WorkspaceMemoryEntry> = entries
                .into_iter()
                .map(|entry| (entry.id.clone(), entry))
                .collect();
            let mut deleted_ids = HashSet::new();
            let mut deleted = 0u32;
            let mut removed_useless = 0u32;
            let mut merged = 0u32;
            let mut updated = 0u32;
            let mut groups = Vec::new();

            for id in normalize_memory_strings(&plan.delete_ids) {
                if self.remove_workspace_memory_for_compaction(
                    &id,
                    &mut by_id,
                    &mut deleted_ids,
                    &mut deleted,
                )? {
                    removed_useless += 1;
                }
            }

            for group in &plan.merge_groups {
                let ids = normalize_memory_strings(&group.ids);
                let cluster: Vec<WorkspaceMemoryEntry> = ids
                    .iter()
                    .filter_map(|id| by_id.get(id).cloned())
                    .filter(|entry| !deleted_ids.contains(&entry.id))
                    .collect();
                if cluster.len() <= 1 {
                    continue;
                }
                let first = &cluster[0];
                if cluster.iter().any(|entry| {
                    entry.scope_type != first.scope_type
                        || entry.scope_id != first.scope_id
                        || entry.memory_type != first.memory_type
                }) {
                    continue;
                }
                let target_id = group
                    .target_id
                    .as_deref()
                    .filter(|id| cluster.iter().any(|entry| entry.id == *id))
                    .map(str::to_string)
                    .or_else(|| {
                        cluster
                            .iter()
                            .find(|entry| entry.pinned)
                            .or_else(|| cluster.first())
                            .map(|entry| entry.id.clone())
                    })
                    .unwrap_or_else(|| first.id.clone());
                let target = cluster
                    .iter()
                    .find(|entry| entry.id == target_id)
                    .cloned()
                    .unwrap_or_else(|| first.clone());
                let mut merged_entry = target.clone();
                merged_entry.title = group
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&target.title)
                    .to_string();
                merged_entry.summary = group
                    .summary
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&target.summary)
                    .to_string();
                merged_entry.details = group
                    .details
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .or_else(|| target.details.clone());
                let mut tags = Vec::new();
                for entry in &cluster {
                    tags.extend(entry.tags.iter().cloned());
                }
                if let Some(group_tags) = &group.tags {
                    tags.extend(group_tags.iter().cloned());
                }
                merged_entry.tags = normalize_memory_strings(&tags);
                merged_entry.pinned = cluster.iter().any(|entry| entry.pinned);
                merged_entry.importance = cluster
                    .iter()
                    .map(|entry| entry.importance)
                    .fold(merged_entry.importance, f64::max);
                merged_entry.confidence = cluster
                    .iter()
                    .map(|entry| entry.confidence)
                    .fold(merged_entry.confidence, f64::max);
                let saved = self.save_workspace_memory(&merged_entry)?;
                by_id.insert(saved.id.clone(), saved.clone());
                updated += 1;
                let mut merged_ids = Vec::new();
                for entry in cluster {
                    if entry.id != saved.id
                        && self.remove_workspace_memory_for_compaction(
                            &entry.id,
                            &mut by_id,
                            &mut deleted_ids,
                            &mut deleted,
                        )?
                    {
                        merged_ids.push(entry.id);
                        merged += 1;
                    }
                }
                if !merged_ids.is_empty() {
                    groups.push(worldbase_protocol::types::MemoryCompactionGroupResult {
                        target_id: saved.id,
                        merged_ids,
                        title: saved.title,
                    });
                }
            }

            for patch in &plan.updates {
                let Some(current) = by_id.get(&patch.id).cloned() else {
                    continue;
                };
                if deleted_ids.contains(&current.id) {
                    continue;
                }
                let mut next = current;
                if let Some(value) = patch
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    next.title = value.to_string();
                }
                if let Some(value) = patch
                    .summary
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    next.summary = value.to_string();
                }
                if let Some(value) = patch
                    .details
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    next.details = Some(value.to_string());
                }
                if let Some(tags) = &patch.tags {
                    let tags = normalize_memory_strings(tags);
                    if !tags.is_empty() {
                        next.tags = tags;
                    }
                }
                if let Some(value) = patch.importance {
                    next.importance = value.clamp(0.0, 1.0);
                }
                if let Some(value) = patch.confidence {
                    next.confidence = value.clamp(0.0, 1.0);
                }
                if next.title.is_empty() || next.summary.is_empty() {
                    continue;
                }
                let saved = self.save_workspace_memory(&next)?;
                by_id.insert(saved.id.clone(), saved);
                updated += 1;
            }

            Ok(MemoryCompactionResult {
                scanned,
                deleted,
                removed_useless,
                merged,
                updated,
                retained: scanned.saturating_sub(deleted),
                groups,
            })
        })();

        let mut status = self.memory_compaction_status.lock().unwrap();
        match &operation {
            Ok(result) => {
                status.status = "completed".into();
                status.stage = "done".into();
                status.scanned = result.scanned;
                status.completed_chunks = result.scanned;
                status.result = Some(result.clone());
                status.finished_at = Some(now_ts());
                status.error = None;
            }
            Err(error) => {
                status.status = "failed".into();
                status.stage = "failed".into();
                status.error = Some(error.to_string());
                status.finished_at = Some(now_ts());
            }
        }
        status.updated_at = now_ts();
        operation
    }

    // ---------- settings ----------

    pub fn get_setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(Ok(raw)) => Ok(serde_json::from_str(&raw).ok()),
            _ => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    // ---------- Image Studio task queue ----------

    /// Normalize one persisted Studio task while preserving its lifecycle.
    /// Mobile chat and Studio share this checkpoint, so completed rows must
    /// remain visible after a result arrives instead of disappearing from the
    /// queue immediately.
    fn normalize_studio_task(value: &serde_json::Value) -> Option<serde_json::Value> {
        let object = value.as_object()?;
        let id = object.get("id")?.as_str()?.trim();
        if id.is_empty() {
            return None;
        }
        let status = object.get("status")?.as_str()?;
        if status != "queued" && status != "running" && status != "success" && status != "error" {
            return None;
        }
        let request = object.get("request")?.as_object()?;
        for key in ["providerId", "model", "prompt", "size"] {
            if request
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return None;
            }
        }
        let mut normalized = value.clone();
        let Some(normalized_object) = normalized.as_object_mut() else {
            return None;
        };
        // Older checkpoints omitted entries; keep completed image results when
        // present and provide the renderer-safe empty default otherwise.
        normalized_object
            .entry("entries")
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if !normalized_object.contains_key("label") {
            if let Some(prompt) = request.get("prompt").and_then(serde_json::Value::as_str) {
                normalized_object.insert("label".into(), serde_json::Value::String(prompt.into()));
            }
        }
        if request.get("mode").and_then(serde_json::Value::as_str) == Some("edit")
            && !normalized_object.contains_key("inputPreview")
        {
            if let Some(preview) = request
                .get("inputImages")
                .and_then(serde_json::Value::as_array)
                .and_then(|images| images.first())
                .and_then(serde_json::Value::as_str)
            {
                normalized_object.insert(
                    "inputPreview".into(),
                    serde_json::Value::String(preview.into()),
                );
            }
        }
        Some(normalized)
    }

    fn normalize_studio_tasks(value: &serde_json::Value) -> Vec<serde_json::Value> {
        let list = value
            .as_array()
            .cloned()
            .or_else(|| {
                value
                    .get("tasks")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
            })
            .unwrap_or_default();
        let mut tasks: Vec<_> = list
            .iter()
            .filter_map(Self::normalize_studio_task)
            .collect();
        // Electron reads oldest first and reconstructs its newest-first UI
        // ordering in the renderer. Preserve that deterministic ordering here.
        tasks.sort_by_key(|task| {
            task.get("createdAt")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
        });
        tasks.truncate(MAX_STUDIO_TASKS);
        tasks
    }

    fn read_setting_locked(conn: &rusqlite::Connection, key: &str) -> Option<serde_json::Value> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
    }

    fn write_setting_locked(
        conn: &rusqlite::Connection,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    /// Load the shared Studio task timeline. During the first Rust run, import
    /// the legacy Electron JSON checkpoint so switching engines does not hide
    /// queued work.
    pub fn load_studio_tasks(&self) -> Result<Vec<serde_json::Value>> {
        let legacy_path = Self::default_dir().join("studio-tasks.json");
        if let Ok(raw) = std::fs::read_to_string(&legacy_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                let tasks = Self::normalize_studio_tasks(&value);
                let conn = self.conn.lock().unwrap();
                Self::write_setting_locked(
                    &conn,
                    "studio_tasks",
                    &serde_json::Value::Array(tasks.clone()),
                )?;
                return Ok(tasks);
            }
        }
        let conn = self.conn.lock().unwrap();
        Ok(Self::read_setting_locked(&conn, "studio_tasks")
            .map(|value| Self::normalize_studio_tasks(&value))
            .unwrap_or_default())
    }

    /// Replace the durable queue and update the legacy JSON mirror used when
    /// the user explicitly hands ownership back to TypeScript.
    pub fn save_studio_tasks(&self, tasks: &[serde_json::Value]) -> Result<()> {
        let normalized = Self::normalize_studio_tasks(&serde_json::Value::Array(tasks.to_vec()));
        {
            let conn = self.conn.lock().unwrap();
            Self::write_setting_locked(
                &conn,
                "studio_tasks",
                &serde_json::Value::Array(normalized.clone()),
            )?;
        }

        let directory = Self::default_dir();
        std::fs::create_dir_all(&directory)?;
        let target = directory.join("studio-tasks.json");
        let temporary = directory.join("studio-tasks.json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(&normalized)?)?;
        // A stale temporary file must never replace a valid checkpoint.
        if let Err(error) = std::fs::rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }

    /// Append requests handed off by a native image tool. Requests are kept
    /// separately from the renderer's task records until the studio drains
    /// them, matching Electron's atomic in-memory handoff semantics.
    pub fn enqueue_studio_pending_tasks(&self, requests: &[serde_json::Value]) -> Result<usize> {
        if requests.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let mut pending = Self::read_setting_locked(&conn, "studio_pending_tasks")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        pending.extend(requests.iter().cloned());
        if pending.len() > MAX_STUDIO_TASKS {
            let drop_count = pending.len() - MAX_STUDIO_TASKS;
            pending.drain(0..drop_count);
        }
        let count = requests.len().min(MAX_STUDIO_TASKS);
        Self::write_setting_locked(
            &conn,
            "studio_pending_tasks",
            &serde_json::Value::Array(pending),
        )?;
        Ok(count)
    }

    /// Atomically return and clear native requests waiting for the renderer.
    pub fn drain_studio_pending_tasks(&self) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let pending = Self::read_setting_locked(&conn, "studio_pending_tasks")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        Self::write_setting_locked(
            &conn,
            "studio_pending_tasks",
            &serde_json::Value::Array(Vec::new()),
        )?;
        Ok(pending)
    }

    // ---------- 轻应用 ----------

    pub fn add_lightapp(&self, id: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO lightapps (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![id, name, now_ts()],
        )?;
        Ok(())
    }

    pub fn list_lightapps(&self) -> Result<Vec<worldbase_protocol::types::LightApp>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM lightapps ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(worldbase_protocol::types::LightApp {
                id: row.get("id")?,
                name: row.get("name")?,
                created_at: row.get("created_at")?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_lightapp(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM lightapps WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ---------- 用量统计 ----------

    pub fn record_usage(
        &self,
        conversation_id: Option<&str>,
        provider_id: Option<&str>,
        model: &str,
        input_tokens: u64,
        output_tokens: u64,
        cost: f64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage (ts, conversation_id, provider_id, model, input_tokens, output_tokens, cost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![now_ts(), conversation_id, provider_id, model, input_tokens as i64, output_tokens as i64, cost],
        )?;
        Ok(())
    }

    pub fn usage_summary(&self, days: u32) -> Result<worldbase_protocol::types::UsageSummary> {
        let conn = self.conn.lock().unwrap();
        let mut daily: std::collections::BTreeMap<String, (u64, u64, f64)> = Default::default();
        let mut by_model: std::collections::BTreeMap<String, (u64, u64, f64)> = Default::default();
        let mut total = (0u64, 0u64, 0f64);
        let mut stmt = conn.prepare(
            "SELECT ts, model, input_tokens, output_tokens, cost FROM usage ORDER BY ts DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })?;
        let cutoff = {
            // 最近 days 天（粗粒度按 UTC 日期）
            let now = worldbase_protocol::event::now_rfc3339();
            let day = &now[..10.min(now.len())];
            day.to_string()
        };
        for r in rows.filter_map(|r| r.ok()) {
            let (ts, model, inp, out, cost) = r;
            let day = &ts[..10.min(ts.len())];
            // 只统计 cutoff 起近似窗口（days 天）——按字典序近似比较
            if days > 0 {
                let Some(cut_date) = shift_days_back(&cutoff, days as i64) else {
                    continue;
                };
                if day < cut_date.as_str() {
                    continue;
                }
            }
            let e = daily.entry(day.to_string()).or_insert((0, 0, 0.0));
            e.0 += inp as u64;
            e.1 += out as u64;
            e.2 += cost;
            let m = by_model.entry(model).or_insert((0, 0, 0.0));
            m.0 += inp as u64;
            m.1 += out as u64;
            m.2 += cost;
            total.0 += inp as u64;
            total.1 += out as u64;
            total.2 += cost;
        }
        Ok(worldbase_protocol::types::UsageSummary {
            daily: daily
                .into_iter()
                .map(|(day, (i, o, c))| worldbase_protocol::types::DailyUsage {
                    day,
                    input_tokens: i,
                    output_tokens: o,
                    cost: c,
                })
                .collect(),
            by_model: by_model
                .into_iter()
                .map(|(model, (i, o, c))| worldbase_protocol::types::ModelUsage {
                    model,
                    input_tokens: i,
                    output_tokens: o,
                    cost: c,
                })
                .collect(),
            total_cost: total.2,
            total_input_tokens: total.0,
            total_output_tokens: total.1,
        })
    }

    // ---------- schedules ----------

    pub fn create_schedule(&self, entry: &ScheduleEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let metadata = serde_json::to_string(entry)?;
        let created_at = if entry.created_at.trim().is_empty() {
            now_ts()
        } else {
            entry.created_at.clone()
        };
        conn.execute(
            "INSERT INTO schedules (id, name, cron, task, enabled, last_run_at, next_run_at, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry.id,
                entry.name,
                entry.cron,
                entry.task,
                entry.enabled,
                entry.last_run_at,
                entry.next_run_at,
                metadata,
                created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_schedules(&self) -> Result<Vec<ScheduleEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, cron, task, enabled, last_run_at, next_run_at, metadata, created_at FROM schedules ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let id = row.get("id")?;
            let name = row.get("name")?;
            let cron = row.get("cron")?;
            let task = row.get("task")?;
            let enabled = row.get::<_, i64>("enabled")? != 0;
            let last_run_at = row.get("last_run_at")?;
            let next_run_at = row.get("next_run_at")?;
            let metadata: String = row.get("metadata")?;
            let created_at: String = row.get("created_at")?;
            let mut entry = serde_json::from_str::<ScheduleEntry>(&metadata).unwrap_or_else(|_| {
                ScheduleEntry {
                    id: String::new(),
                    name: String::new(),
                    cron: String::new(),
                    task: String::new(),
                    enabled: false,
                    last_run_at: None,
                    next_run_at: None,
                    schedule: None,
                    selected_skill_ids: Vec::new(),
                    selected_mcp_server_ids: Vec::new(),
                    retry_policy: Default::default(),
                    retry_scheduled_at: None,
                    retry_attempt: 0,
                    created_by: String::new(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    last_status: String::new(),
                }
            });
            // The indexed columns remain authoritative so legacy update paths
            // cannot be hidden by stale values in the extensible metadata.
            entry.id = id;
            entry.name = name;
            entry.cron = cron;
            entry.task = task;
            entry.enabled = enabled;
            entry.last_run_at = last_run_at;
            entry.next_run_at = next_run_at;
            if entry.created_at.is_empty() {
                entry.created_at = created_at;
            }
            Ok(entry)
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Persist both the legacy indexed fields and structured scheduler
    /// metadata in one statement.
    pub fn update_schedule(&self, entry: &ScheduleEntry) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let metadata = serde_json::to_string(entry)?;
        let updated = conn.execute(
            "UPDATE schedules
             SET name = ?2, cron = ?3, task = ?4, enabled = ?5,
                 last_run_at = ?6, next_run_at = ?7, metadata = ?8
             WHERE id = ?1",
            params![
                entry.id,
                entry.name,
                entry.cron,
                entry.task,
                entry.enabled,
                entry.last_run_at,
                entry.next_run_at,
                metadata,
            ],
        )?;
        Ok(updated > 0)
    }

    pub fn delete_schedule(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn mark_schedule_ran(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE schedules SET last_run_at = ?2 WHERE id = ?1",
            params![id, now_ts()],
        )?;
        Ok(())
    }

    pub fn set_schedule_next_run(&self, id: &str, next_run_at: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE schedules SET next_run_at = ?2 WHERE id = ?1",
            params![id, next_run_at],
        )?;
        Ok(())
    }

    pub fn advance_schedule(
        &self,
        id: &str,
        last_run_at: &str,
        next_run_at: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE schedules SET last_run_at = ?2, next_run_at = ?3 WHERE id = ?1",
            params![id, last_run_at, next_run_at],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use worldbase_protocol::types::{MemorySearchScopeEntry, ToolCallRecord, ToolResultRecord};

    fn workspace_entry(id: &str, title: &str, summary: &str) -> WorkspaceMemoryEntry {
        WorkspaceMemoryEntry {
            id: id.into(),
            scope_type: "user".into(),
            scope_id: "local-user".into(),
            memory_type: "knowledge".into(),
            title: title.into(),
            summary: summary.into(),
            details: None,
            tags: vec![" rust ".into(), "rust".into()],
            source_conversation_id: None,
            source_session_id: None,
            source_message_ids: vec![],
            importance: 1.5,
            confidence: -1.0,
            pinned: false,
            last_used_at: None,
            created_at: "".into(),
            updated_at: "".into(),
        }
    }

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("worldbase-test-{}", uuid::Uuid::new_v4()));
        Store::open(&dir.join("app.sqlite")).unwrap()
    }

    #[test]
    fn fts5_available_and_searchable() {
        let store = temp_store();
        store
            .add_memory("用户喜欢 Rust 编程语言", &["preference".to_string()])
            .unwrap();
        store
            .add_memory("项目部署在阿里云", &["infra".to_string()])
            .unwrap();

        let hits = store.search_memories("Rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "用户喜欢 Rust 编程语言");
        assert!(hits[0].tags.contains(&"preference".to_string()));
    }

    #[test]
    fn workspace_memory_crud_search_and_compaction_match_electron_shape() {
        let store = temp_store();
        let first = store
            .save_workspace_memory(&workspace_entry(
                "memory-one",
                "Rust preference",
                "The user prefers Rust for services",
            ))
            .unwrap();
        assert_eq!(first.tags, vec!["rust"]);
        assert_eq!(first.importance, 1.0);
        assert_eq!(first.confidence, 0.0);
        assert!(!first.created_at.is_empty());
        assert!(store.get_workspace_memory("memory-one").unwrap().is_some());

        let mut second = workspace_entry(
            "memory-two",
            "Rust preference duplicate",
            "Rust is preferred for backend services",
        );
        second.tags = vec!["backend".into()];
        second.importance = 0.8;
        second.confidence = 0.9;
        store.save_workspace_memory(&second).unwrap();

        let hits = store
            .search_workspace_memories(&WorkspaceMemorySearchOptions {
                query: Some("Rust".into()),
                scopes: vec![MemorySearchScopeEntry {
                    scope_type: "user".into(),
                    scope_id: "local-user".into(),
                }],
                memory_types: vec!["knowledge".into()],
                limit: Some(10),
            })
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(store.list_workspace_memories(1).unwrap().len(), 1);

        assert!(store.pin_workspace_memory("memory-two", true).unwrap());
        let result = store
            .compact_workspace_memories(&MemoryCompactionPlan {
                delete_ids: vec!["memory-one".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result.scanned, 2);
        assert_eq!(result.deleted, 1);
        assert_eq!(result.removed_useless, 1);
        assert_eq!(result.retained, 1);
        assert!(store.get_workspace_memory("memory-one").unwrap().is_none());
        assert_eq!(store.memory_compaction_status().status, "completed");

        assert!(store.delete_workspace_memory("memory-two").unwrap());
        assert!(store.get_workspace_memory("memory-two").unwrap().is_none());
    }

    #[test]
    fn conversation_message_roundtrip() {
        let store = temp_store();
        let conv = store.create_conversation("测试会话", None).unwrap();
        let msg = ChatMessage {
            id: 0,
            role: Role::User,
            content: "你好".into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        };
        store.append_message(&conv.id, &msg).unwrap();
        let msgs = store.list_messages(&conv.id, 100).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "你好");
        assert_eq!(msgs[0].role, Role::User);

        let with_tools = ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: "查看文件".into(),
            parts: vec![],
            tool_calls: vec![ToolCallRecord {
                id: "t1".into(),
                name: "read_file".into(),
                args: json!({"path": "a"}),
            }],
            tool_results: vec![ToolResultRecord {
                tool_call_id: "t1".into(),
                name: "read_file".into(),
                content: "数据".into(),
                is_error: false,
            }],
            created_at: None,
        };
        store.append_message(&conv.id, &with_tools).unwrap();
        let msgs = store.list_messages(&conv.id, 100).unwrap();
        assert_eq!(msgs[1].tool_calls.len(), 1);
        assert_eq!(msgs[1].tool_results[0].content, "数据");
    }

    #[test]
    fn legacy_empty_tool_call_ids_are_paired_at_read_time() {
        let store = temp_store();
        let conversation = store.create_conversation("tools", None).unwrap();
        store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    id: 0,
                    role: Role::Assistant,
                    content: "queued".into(),
                    parts: vec![],
                    tool_calls: vec![ToolCallRecord {
                        id: String::new(),
                        name: "generate_image".into(),
                        args: json!({"prompt": "rain"}),
                    }],
                    tool_results: vec![],
                    created_at: None,
                },
            )
            .unwrap();
        store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    id: 0,
                    role: Role::User,
                    content: String::new(),
                    parts: vec![],
                    tool_calls: vec![],
                    tool_results: vec![ToolResultRecord {
                        tool_call_id: String::new(),
                        name: "generate_image".into(),
                        content: r#"{"queued":1}"#.into(),
                        is_error: false,
                    }],
                    created_at: None,
                },
            )
            .unwrap();

        let messages = store.list_messages(&conversation.id, 10).unwrap();
        let call_id = messages[0].tool_calls[0].id.as_str();
        assert!(call_id.starts_with("repaired_call_"));
        assert_eq!(messages[1].tool_results[0].tool_call_id, call_id);
    }

    #[test]
    fn settings_kv() {
        let store = temp_store();
        assert_eq!(store.get_setting("provider.model").unwrap(), None);
        store
            .set_setting("provider.model", &json!("claude-sonnet"))
            .unwrap();
        assert_eq!(
            store.get_setting("provider.model").unwrap(),
            Some(json!("claude-sonnet"))
        );
        store
            .set_setting("provider.model", &json!("gpt-4o"))
            .unwrap();
        assert_eq!(
            store.get_setting("provider.model").unwrap(),
            Some(json!("gpt-4o"))
        );
    }

    fn image(
        id: &str,
        folder: &str,
        tags: &[&str],
        created_at: &str,
    ) -> worldbase_protocol::types::ImageEntry {
        worldbase_protocol::types::ImageEntry {
            id: id.into(),
            prompt: format!("prompt for {id}"),
            provider_id: Some("provider".into()),
            model: "image-model".into(),
            file: format!("{id}.png"),
            created_at: created_at.into(),
            folder: folder.into(),
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            meta: json!({ "mode": "generate", "size": "1024x1024" }),
        }
    }

    #[test]
    fn image_page_matches_gallery_folder_tag_search_and_paging_semantics() {
        let store = temp_store();
        store
            .add_image(&image(
                "root",
                "",
                &["red", "shared"],
                "2026-01-01T00:00:00Z",
            ))
            .unwrap();
        store
            .add_image(&image(
                "folder-new",
                "design",
                &["red", "blue"],
                "2026-01-03T00:00:00Z",
            ))
            .unwrap();
        store
            .add_image(&image(
                "folder-old",
                "design",
                &["blue", "shared"],
                "2026-01-02T00:00:00Z",
            ))
            .unwrap();

        let root = store
            .query_image_page(None, false, &[], None, 60, 0)
            .unwrap();
        assert_eq!(
            root.images
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["root"]
        );

        let all = store.query_image_page(None, true, &[], None, 2, 0).unwrap();
        assert_eq!(all.total, 3);
        assert_eq!(
            all.images
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["folder-new", "folder-old"]
        );
        assert_eq!(all.next_offset, Some(2));

        let tagged = store
            .query_image_page(
                Some("design"),
                false,
                &["red".into(), "blue".into()],
                None,
                60,
                0,
            )
            .unwrap();
        assert_eq!(tagged.images.len(), 1);
        assert_eq!(tagged.images[0].id, "folder-new");

        // A gallery search is global even when the caller was viewing root.
        let searched = store
            .query_image_page(None, false, &[], Some("folder-old"), 60, 0)
            .unwrap();
        assert_eq!(searched.images.len(), 1);
        assert_eq!(searched.images[0].id, "folder-old");
    }

    #[test]
    fn image_mirrors_round_trip_tags_folders_and_legacy_json() {
        let root =
            std::env::temp_dir().join(format!("worldbase-image-mirror-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("app.sqlite")).unwrap();
        let mut entry = image(
            "entry",
            "design",
            &["first", "second", "first"],
            "2026-01-01T00:00:00Z",
        );
        entry.meta = json!({
            "mode": "generate",
            "size": "1024x1024",
            "thumbName": "entry.thumb.webp"
        });
        std::fs::write(root.join(&entry.file), b"png").unwrap();
        store.add_image(&entry).unwrap();
        Store::write_image_library_mirror(&root, &entry).unwrap();
        store.create_image_folder("empty").unwrap();
        Store::write_image_folder_mirror(&root, &store.list_image_folders().unwrap()).unwrap();

        let mirror: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("entry.json")).unwrap())
                .unwrap();
        assert_eq!(mirror["folder"], "design");
        assert_eq!(mirror["tags"], json!(["first", "second"]));
        assert_eq!(mirror["thumbName"], "entry.thumb.webp");

        let restored = Store::open(&root.join("restored.sqlite")).unwrap();
        assert_eq!(restored.import_image_library_mirror(&root).unwrap(), 1);
        let loaded = restored.get_image("entry").unwrap().unwrap();
        assert_eq!(loaded.folder, "design");
        assert_eq!(loaded.tags, vec!["first", "second"]);
        assert_eq!(loaded.meta["thumbName"], "entry.thumb.webp");
        assert!(restored
            .list_image_folders()
            .unwrap()
            .iter()
            .any(|folder| folder.name == "empty"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn image_thumbnail_is_bounded_webp_and_records_source_dimensions() {
        let root = std::env::temp_dir().join(format!(
            "worldbase-image-thumbnail-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let original = image::RgbaImage::from_pixel(640, 480, image::Rgba([12, 34, 56, 255]));
        original.save(root.join("entry.png")).unwrap();

        let thumbnail = Store::write_image_library_thumbnail(&root, "entry", "entry.png").unwrap();

        assert_eq!(thumbnail.name, "entry.thumb.webp");
        assert_eq!((thumbnail.width, thumbnail.height), (640, 480));
        let decoded = image::open(root.join(&thumbnail.name)).unwrap();
        assert_eq!(decoded.dimensions(), (320, 240));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn image_mirror_reconciliation_updates_ts_edits_and_only_prunes_missing_files() {
        let root = std::env::temp_dir().join(format!(
            "worldbase-image-reconcile-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("app.sqlite")).unwrap();

        let tracked = image(
            "tracked",
            "rust-folder",
            &["rust-tag"],
            "2026-01-01T00:00:00Z",
        );
        let legacy = image(
            "legacy",
            "legacy-folder",
            &["legacy-tag"],
            "2026-01-02T00:00:00Z",
        );
        let missing = image(
            "missing",
            "stale-folder",
            &["stale-tag"],
            "2026-01-03T00:00:00Z",
        );
        std::fs::write(root.join(&tracked.file), b"png").unwrap();
        std::fs::write(root.join(&legacy.file), b"png").unwrap();
        store.add_image(&tracked).unwrap();
        store.add_image(&legacy).unwrap();
        store.add_image(&missing).unwrap();
        store.create_image_folder("obsolete-empty").unwrap();

        // This mirrors a TS-side metadata mutation after Rust had already
        // imported the original record. The legacy image deliberately has no
        // JSON mirror and must survive because its bytes still exist.
        std::fs::write(
            root.join("tracked.json"),
            serde_json::to_vec_pretty(&json!({
                "id": "tracked",
                "createdAt": "2026-01-04T00:00:00Z",
                "mode": "edit",
                "providerId": "typescript-provider",
                "model": "typescript-model",
                "prompt": "edited in TypeScript",
                "fileName": "tracked.png",
                "folder": "ts-folder",
                "tags": ["ts-tag", "shared"]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.join("folders.json"),
            serde_json::to_vec_pretty(&vec!["ts-folder", "ts-empty"]).unwrap(),
        )
        .unwrap();

        assert_eq!(store.import_image_library_mirror(&root).unwrap(), 1);
        let updated = store.get_image("tracked").unwrap().unwrap();
        assert_eq!(updated.prompt, "edited in TypeScript");
        assert_eq!(updated.folder, "ts-folder");
        assert_eq!(updated.tags, vec!["ts-tag", "shared"]);
        assert!(store.get_image("missing").unwrap().is_none());
        assert_eq!(
            store.get_image("legacy").unwrap().unwrap().folder,
            "legacy-folder"
        );

        let folders = store.list_image_folders().unwrap();
        assert!(folders
            .iter()
            .any(|folder| folder.name == "ts-empty" && folder.count == 0));
        assert!(!folders.iter().any(|folder| folder.name == "obsolete-empty"));
        assert!(folders.iter().any(|folder| folder.name == "legacy-folder"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn studio_task_queue_round_trips_and_drains_pending_requests() {
        let root =
            std::env::temp_dir().join(format!("worldbase-studio-tasks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let previous_home = std::env::var_os("WORLDBASE_HOME");
        std::env::set_var("WORLDBASE_HOME", &root);
        let store = Store::open(&root.join("app.sqlite")).unwrap();

        let task = json!({
            "id": "task-1",
            "status": "queued",
            "createdAt": 10,
            "request": {
                "providerId": "provider",
                "model": "image-model",
                "prompt": "draw a tree",
                "size": "1024x1024",
                "mode": "generate"
            },
            "label": "draw a tree"
        });
        // Invalid rows are filtered; lifecycle rows and result entries survive
        // so mobile chat and Studio can render the same task state.
        let successful = json!({
            "id": "success",
            "status": "success",
            "createdAt": 12,
            "request": task["request"],
            "entries": [{ "id": "image-1", "prompt": "draw a tree" }]
        });
        store
            .save_studio_tasks(&[
                task.clone(),
                json!({ "id": "running", "status": "running", "createdAt": 11, "request": task["request"] }),
                successful,
                json!({ "id": "invalid", "status": "queued" }),
            ])
            .unwrap();
        let loaded = store.load_studio_tasks().unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0]["id"], "task-1");
        assert_eq!(loaded[0]["entries"], json!([]));
        assert_eq!(loaded[1]["id"], "running");
        assert_eq!(loaded[2]["status"], "success");
        assert_eq!(loaded[2]["entries"][0]["id"], "image-1");

        let request = json!({
            "providerId": "provider",
            "model": "image-model",
            "mode": "generate",
            "prompt": "queued by agent",
            "size": "1024x1024"
        });
        assert_eq!(
            store
                .enqueue_studio_pending_tasks(&[request.clone()])
                .unwrap(),
            1
        );
        assert_eq!(store.drain_studio_pending_tasks().unwrap(), vec![request]);
        assert!(store.drain_studio_pending_tasks().unwrap().is_empty());

        match previous_home {
            Some(value) => std::env::set_var("WORLDBASE_HOME", value),
            None => std::env::remove_var("WORLDBASE_HOME"),
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
