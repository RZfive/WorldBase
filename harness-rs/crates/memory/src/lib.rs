//! SQLite/FTS5 持久化：会话、消息、长期记忆、设置、定时任务。
//!
//! 单库设计（`~/.the-world/app.sqlite`），路径可由 `WORLDBASE_HOME` 覆盖。

use anyhow::{Context, Result};
use rusqlite::{params, Connection, Row};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use worldbase_protocol::types::{
    ChatMessage, ConversationMeta, MemoryEntry, Role, ScheduleEntry, ToolCallRecord, ToolResultRecord,
};

pub struct Store {
    conn: Mutex<Connection>,
}

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
                if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 }
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

impl Store {
    /// 打开（或创建）数据库并迁移 schema。
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("create dir {}", dir.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("open sqlite at {}", path.display()))?;
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
                "ALTER TABLE images ADD COLUMN folder TEXT NOT NULL DEFAULT ''",
                "ALTER TABLE images ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
            ];
            for sql in alters {
                let _ = conn.execute(sql, []);
            }
        }
        Ok(Self { conn: Mutex::new(conn) })
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

    // ---------- conversations ----------

    pub fn create_conversation(&self, title: &str, agent_id: Option<&str>) -> Result<ConversationMeta> {
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
    pub fn message_ids_up_to(&self, conversation_id: &str, anchor: Option<i64>) -> Result<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match anchor {
            Some(a) => conn.prepare(
                "SELECT id FROM messages WHERE conversation_id = ?1 AND id <= ?2 ORDER BY id",
            )?,
            None => conn
                .prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")?,
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

    pub fn get_message(&self, conversation_id: &str, message_id: i64) -> Result<Option<ChatMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT * FROM messages WHERE conversation_id = ?1 AND id = ?2",
        )?;
        let mut rows = stmt.query_map(params![conversation_id, message_id], Self::row_to_message)?;
        Ok(rows.next().transpose()?)
    }

    // ---------- agents ----------

    pub fn upsert_agent(&self, agent: &worldbase_protocol::types::AgentDefinition) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agents (id, name, icon, description, system_prompt, provider_id, model_id, skill_ids, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, description=excluded.description,
               system_prompt=excluded.system_prompt, provider_id=excluded.provider_id, model_id=excluded.model_id,
               skill_ids=excluded.skill_ids, updated_at=excluded.updated_at",
            params![
                agent.id,
                agent.name,
                agent.icon,
                agent.description,
                agent.system_prompt,
                agent.provider_id,
                agent.model_id,
                serde_json::to_string(&agent.skill_ids)?,
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

    pub fn get_agent(&self, id: &str) -> Result<Option<worldbase_protocol::types::AgentDefinition>> {
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

    fn row_to_agent(row: &Row) -> rusqlite::Result<worldbase_protocol::types::AgentDefinition> {
        Ok(worldbase_protocol::types::AgentDefinition {
            id: row.get("id")?,
            name: row.get("name")?,
            icon: row.get("icon")?,
            description: row.get("description")?,
            system_prompt: row.get("system_prompt")?,
            provider_id: row.get("provider_id")?,
            model_id: row.get("model_id")?,
            skill_ids: serde_json::from_str(&row.get::<_, String>("skill_ids")?).unwrap_or_default(),
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    // ---------- image library ----------

    pub fn add_image(&self, entry: &worldbase_protocol::types::ImageEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO images (id, prompt, provider_id, model, file, created_at, meta, folder, tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry.id,
                entry.prompt,
                entry.provider_id,
                entry.model,
                entry.file,
                entry.created_at,
                entry.meta.to_string(),
                entry.folder,
                entry.tags.join(","),
            ],
        )?;
        Ok(())
    }

    pub fn list_images(&self, limit: u32) -> Result<Vec<worldbase_protocol::types::ImageEntry>> {
        self.query_images(None, None, None, limit)
    }

    /// 图库查询：folder/tag/search（prompt 子串）过滤。
    pub fn query_images(
        &self,
        folder: Option<&str>,
        tag: Option<&str>,
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<worldbase_protocol::types::ImageEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from("SELECT * FROM images WHERE 1=1");
        let mut binds: Vec<String> = Vec::new();
        if let Some(f) = folder {
            sql.push_str(&format!(" AND folder = ?{}", binds.len() + 1));
            binds.push(f.to_string());
        }
        if let Some(t) = tag {
            sql.push_str(&format!(
                " AND (',' || tags || ',') LIKE '%' || ?{} || '%'",
                binds.len() + 1
            ));
            binds.push(t.to_string());
        }
        if let Some(q) = search {
            sql.push_str(&format!(" AND prompt LIKE '%' || ?{} || '%'", binds.len() + 1));
            binds.push(q.to_string());
        }
        sql.push_str(" ORDER BY created_at DESC, id LIMIT ");
        sql.push_str(&limit.to_string());
        let mut stmt = conn.prepare(&sql)?;
        let rows = match binds.len() {
            0 => stmt.query_map([], Self::row_to_image)?,
            1 => stmt.query_map(params![binds[0]], Self::row_to_image)?,
            2 => stmt.query_map(params![binds[0], binds[1]], Self::row_to_image)?,
            3 => stmt.query_map(params![binds[0], binds[1], binds[2]], Self::row_to_image)?,
            n => anyhow::bail!("too many binds: {n}"),
        };
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_image_meta(&self, id: &str, folder: &str, tags: &[String]) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE images SET folder = ?2, tags = ?3 WHERE id = ?1",
            params![id, folder, tags.join(",")],
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

    fn row_to_image(row: &Row) -> rusqlite::Result<worldbase_protocol::types::ImageEntry> {
        let tags: String = row.get::<_, Option<String>>("tags").ok().flatten().unwrap_or_default();
        let folder: String = row.get::<_, Option<String>>("folder").ok().flatten().unwrap_or_default();
        Ok(worldbase_protocol::types::ImageEntry {
            id: row.get("id")?,
            prompt: row.get("prompt")?,
            provider_id: row.get("provider_id")?,
            model: row.get("model")?,
            file: row.get("file")?,
            created_at: row.get("created_at")?,
            folder,
            tags: tags.split(',').filter(|t| !t.is_empty()).map(String::from).collect(),
            meta: serde_json::from_str(&row.get::<_, String>("meta")?).unwrap_or(serde_json::Value::Null),
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
            fork_depth: row.get::<_, Option<i64>>("fork_depth").ok().flatten().unwrap_or(0),
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
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])?;
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- messages ----------

    pub fn append_message(&self, conversation_id: &str, msg: &ChatMessage) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let ts = msg.created_at.clone().unwrap_or_else(now_ts);
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, tool_calls_json, tool_results_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                conversation_id,
                role_to_str(msg.role),
                msg.content,
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

    fn row_to_message(row: &Row) -> rusqlite::Result<ChatMessage> {
        let tool_calls: Vec<ToolCallRecord> =
            serde_json::from_str(&row.get::<_, String>("tool_calls_json")?).unwrap_or_default();
        let tool_results: Vec<ToolResultRecord> =
            serde_json::from_str(&row.get::<_, String>("tool_results_json")?).unwrap_or_default();
        Ok(ChatMessage {
            id: row.get("id")?,
            role: str_to_role(&row.get::<_, String>("role")?),
            content: row.get("content")?,
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
            tags: tags.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
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
                let Some(cut_date) = shift_days_back(&cutoff, days as i64) else { continue };
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
        let mut stmt =
            conn.prepare("SELECT id, name, cron, task, enabled, last_run_at FROM schedules ORDER BY created_at")?;
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
        conn.execute("UPDATE schedules SET last_run_at = ?2 WHERE id = ?1", params![id, now_ts()])?;
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
        store.add_memory("用户喜欢 Rust 编程语言", &["preference".to_string()]).unwrap();
        store.add_memory("项目部署在阿里云", &["infra".to_string()]).unwrap();

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
            tool_calls: vec![ToolCallRecord { id: "t1".into(), name: "read_file".into(), args: json!({"path": "a"}) }],
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
        store.set_setting("provider.model", &json!("claude-sonnet")).unwrap();
        assert_eq!(store.get_setting("provider.model").unwrap(), Some(json!("claude-sonnet")));
        store.set_setting("provider.model", &json!("gpt-4o")).unwrap();
        assert_eq!(store.get_setting("provider.model").unwrap(), Some(json!("gpt-4o")));
    }
}
