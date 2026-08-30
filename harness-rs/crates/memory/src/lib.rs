//! SQLite/FTS5 持久化：会话、消息、长期记忆、设置、定时任务。
//!
//! 单库设计（`~/.the-world/app.sqlite`），路径可由 `WORLDBASE_HOME` 覆盖。

use anyhow::{Context, Result};
use image::io::Reader as ImageReader;
use image::{GenericImageView, ImageOutputFormat};
use rusqlite::{params, params_from_iter, Connection, OpenFlags, Row};
use std::collections::{BTreeMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use worldbase_protocol::types::{
    ChatMessage, ConversationMeta, MemoryEntry, Role, ScheduleEntry, ToolCallRecord,
    ToolResultRecord,
};

pub struct Store {
    conn: Mutex<Connection>,
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
            ];
            for sql in alters {
                let _ = conn.execute(sql, []);
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC, id DESC);\n                 CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);",
            )?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
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
                &row
                    .get::<_, String>("allowed_tools")
                    .unwrap_or_else(|_| "[]".into()),
            )
            .unwrap_or_default(),
            denied_tools: serde_json::from_str(
                &row
                    .get::<_, String>("denied_tools")
                    .unwrap_or_else(|_| "[]".into()),
            )
            .unwrap_or_default(),
            memory_scopes: serde_json::from_str(
                &row
                    .get::<_, String>("memory_scopes")
                    .unwrap_or_else(|_| "[\"user\",\"agent\",\"project\"]".into()),
            )
            .unwrap_or_else(|_| vec!["user".into(), "agent".into(), "project".into()]),
            memory_write_policy: serde_json::from_str(
                &row
                    .get::<_, String>("memory_write_policy")
                    .unwrap_or_else(|_| "{}".into()),
            )
            .unwrap_or_default(),
            auto_reply_policy: serde_json::from_str(
                &row
                    .get::<_, String>("auto_reply_policy")
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
        Ok(rows.filter_map(|r| r.ok()).collect())
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

    /// Normalize one persisted Studio task to the subset Electron can resume.
    /// Running/success rows are intentionally discarded: running work is
    /// transient and successful images are already represented by the gallery.
    fn normalize_studio_task(value: &serde_json::Value) -> Option<serde_json::Value> {
        let object = value.as_object()?;
        let id = object.get("id")?.as_str()?.trim();
        if id.is_empty() {
            return None;
        }
        let status = object.get("status")?.as_str()?;
        if status != "queued" && status != "error" {
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
        // Electron's loader reconstructs transient renderer fields that are
        // intentionally omitted from the checkpoint file. Without these
        // defaults a Vue queue row would attempt `task.entries.length` on
        // undefined after a Rust-owned reload.
        normalized_object.insert("entries".into(), serde_json::Value::Array(Vec::new()));
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
            .or_else(|| value.get("tasks").and_then(serde_json::Value::as_array).cloned())
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

    fn read_setting_locked(
        conn: &rusqlite::Connection,
        key: &str,
    ) -> Option<serde_json::Value> {
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

    /// Load queued/failed tasks. During the first Rust run, import the legacy
    /// Electron JSON checkpoint so switching engines does not hide work.
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
        conn.execute(
            "INSERT INTO schedules (id, name, cron, task, enabled, last_run_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry.id,
                entry.name,
                entry.cron,
                entry.task,
                entry.enabled,
                entry.last_run_at,
                now_ts(),
            ],
        )?;
        Ok(())
    }

    pub fn list_schedules(&self) -> Result<Vec<ScheduleEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, cron, task, enabled, last_run_at FROM schedules ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ScheduleEntry {
                id: row.get("id")?,
                name: row.get("name")?,
                cron: row.get("cron")?,
                task: row.get("task")?,
                enabled: row.get::<_, i64>("enabled")? != 0,
                last_run_at: row.get("last_run_at")?,
                next_run_at: None,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        let root = std::env::temp_dir().join(format!(
            "worldbase-studio-tasks-{}",
            uuid::Uuid::new_v4()
        ));
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
        // Invalid/running rows are filtered like the Electron checkpoint.
        store
            .save_studio_tasks(&[
                task.clone(),
                json!({ "id": "running", "status": "running", "request": task["request"] }),
                json!({ "id": "invalid", "status": "queued" }),
            ])
            .unwrap();
        let loaded = store.load_studio_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["id"], "task-1");
        assert_eq!(loaded[0]["entries"], json!([]));

        let request = json!({
            "providerId": "provider",
            "model": "image-model",
            "mode": "generate",
            "prompt": "queued by agent",
            "size": "1024x1024"
        });
        assert_eq!(store.enqueue_studio_pending_tasks(&[request.clone()]).unwrap(), 1);
        assert_eq!(store.drain_studio_pending_tasks().unwrap(), vec![request]);
        assert!(store.drain_studio_pending_tasks().unwrap().is_empty());

        match previous_home {
            Some(value) => std::env::set_var("WORLDBASE_HOME", value),
            None => std::env::remove_var("WORLDBASE_HOME"),
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
