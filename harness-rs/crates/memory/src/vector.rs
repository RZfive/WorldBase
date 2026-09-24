//! 派生向量索引：`agent-memory/memory-vector.sqlite`（design §5.2/§6.6）。
//!
//! 该文件不是事实来源，可随时删除并从主库重建。与 Electron 共享同一个
//! 文件和 schema：vec0 虚表按 generation 命名，`vector_row_map` 保存
//! vec0 rowid 与业务 document_id 的映射，并承担删除失败的墓碑记录
//! （design §10.3）。

use anyhow::{anyhow, Context as _, Result};
use rusqlite::{params, params_from_iter, Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::Once;

/// 向量库所在目录与主库一致：`<agent-memory>/memory-vector.sqlite`。
pub fn vector_database_path(memory_database: &Path) -> PathBuf {
    memory_database
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("memory-vector.sqlite")
}

static REGISTER_SQLITE_VEC: Once = Once::new();

/// 注册编译进二进制的 vec0 模块。`sqlite3_auto_extension` 是进程级设置，
/// 之后打开的每个连接都能创建/读取 vec0 虚表；它只注册模块，不改变任何
/// 已有连接的行为。
fn register_sqlite_vec() {
    REGISTER_SQLITE_VEC.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

pub struct VectorUpsertItem<'a> {
    pub document_id: &'a str,
    pub scope_key: &'a str,
    pub document_kind: &'a str,
    pub vector: &'a [f32],
}

pub struct VectorKnnQuery<'a> {
    pub vector: &'a [f32],
    pub scope_keys: &'a [String],
    pub document_kinds: &'a [String],
    pub limit: usize,
}

pub struct VectorKnnHit {
    pub document_id: String,
    pub distance: f32,
}

pub struct DeleteOutcome {
    pub deleted: u32,
    pub tombstoned: u32,
}

pub struct VectorIndex {
    conn: Connection,
    path: PathBuf,
    ready_generations: Vec<String>,
}

impl VectorIndex {
    /// 打开（必要时创建）向量库。只在已配置 embedding 模型或已存在
    /// generation 时调用——没有配置时绝不创建该文件（design §7.3）。
    pub fn open(memory_database: &Path) -> Result<Self> {
        register_sqlite_vec();
        let path = vector_database_path(memory_database);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .with_context(|| format!("open vector database at {}", path.display()))?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            "#,
        )
        .ok();
        let probe = conn.query_row("SELECT vec_version()", [], |row| row.get::<_, String>(0));
        if probe.is_err() {
            return Err(anyhow!("sqlite-vec module failed to load: {:?}", probe));
        }
        Ok(Self {
            conn,
            path,
            ready_generations: Vec::new(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn table_name(generation_id: &str) -> String {
        let sanitized: String = generation_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
            .collect();
        format!("vec_documents_{sanitized}")
    }

    /// 确保 generation 对应的 vec0 虚表与映射表存在。维度/距离与
    /// generation 指纹一一对应，不允许混用向量空间（design §6.5）。
    pub fn ensure_generation(&mut self, generation_id: &str, dimensions: u32, distance_metric: &str) -> Result<()> {
        if self.ready_generations.iter().any(|id| id == generation_id) {
            return Ok(());
        }
        let table = Self::table_name(generation_id);
        self.conn
            .execute_batch(&format!(
                r#"
                CREATE VIRTUAL TABLE IF NOT EXISTS {table} USING vec0(
                    scope_key TEXT partition key,
                    document_kind TEXT,
                    embedding FLOAT[{dimensions}] distance_metric={distance_metric},
                    +document_id TEXT
                );
                CREATE TABLE IF NOT EXISTS vector_row_map (
                    document_id TEXT PRIMARY KEY,
                    generation_id TEXT NOT NULL,
                    vector_rowid INTEGER,
                    content_hash TEXT NOT NULL DEFAULT '',
                    indexed_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                "#
            ))
            .with_context(|| format!("ensure vec table {table}"))?;
        self.ready_generations.push(generation_id.to_string());
        Ok(())
    }

    /// 插入/刷新一条向量；先删除旧行，内容更新不会留下陈旧向量。
    pub fn upsert(&self, generation_id: &str, item: &VectorUpsertItem<'_>, content_hash: &str) -> Result<()> {
        let table = Self::table_name(generation_id);
        self.delete_row(generation_id, item.document_id)?;
        self.conn.execute(
            &format!(
                "INSERT INTO {table} (scope_key, document_kind, embedding, document_id)
                 VALUES (?1, ?2, ?3, ?4)"
            ),
            params![
                item.scope_key,
                item.document_kind,
                to_json_vector(item.vector),
                item.document_id
            ],
        )?;
        let rowid: Option<i64> = self
            .conn
            .query_row(
                &format!("SELECT rowid FROM {table} WHERE document_id = ?1"),
                params![item.document_id],
                |row| row.get(0),
            )
            .ok();
        self.conn.execute(
            r#"
            INSERT INTO vector_row_map (document_id, generation_id, vector_rowid, content_hash, indexed_at, deleted_at)
            VALUES (?1, ?2, ?3, ?4, ?5, NULL)
            ON CONFLICT(document_id) DO UPDATE SET
                generation_id = excluded.generation_id,
                vector_rowid = excluded.vector_rowid,
                content_hash = excluded.content_hash,
                indexed_at = excluded.indexed_at,
                deleted_at = NULL
            "#,
            params![
                item.document_id,
                generation_id,
                rowid,
                content_hash,
                now_iso()
            ],
        )?;
        Ok(())
    }

    /// 分区范围内的 KNN 检索；墓碑与其他 generation 的行会被过滤。
    /// 绑定顺序必须与 SQL 中占位符出现顺序一致：
    /// scope keys → document kinds → 向量 → limit。
    pub fn query(&self, generation_id: &str, query: &VectorKnnQuery<'_>) -> Result<Vec<VectorKnnHit>> {
        if query.limit == 0 || query.scope_keys.is_empty() {
            return Ok(Vec::new());
        }
        let table = Self::table_name(generation_id);
        let mut sql = format!(
            "SELECT document_id, distance FROM {table} WHERE scope_key IN ({})",
            std::iter::repeat("?").take(query.scope_keys.len()).collect::<Vec<_>>().join(", ")
        );
        if !query.document_kinds.is_empty() {
            sql.push_str(&format!(
                " AND document_kind IN ({})",
                std::iter::repeat("?").take(query.document_kinds.len()).collect::<Vec<_>>().join(", ")
            ));
        }
        sql.push_str(" AND embedding MATCH ? ORDER BY distance LIMIT ?");

        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        for scope_key in query.scope_keys {
            values.push(Box::new(scope_key.clone()));
        }
        for kind in query.document_kinds {
            values.push(Box::new(kind.clone()));
        }
        values.push(Box::new(to_json_vector(query.vector)));
        values.push(Box::new(query.limit as i64));

        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(
            params_from_iter(values.iter().map(|value| value.as_ref())),
            |row| {
                Ok(VectorKnnHit {
                    document_id: row.get::<_, String>(0)?,
                    distance: row.get::<_, f64>(1)? as f32,
                })
            },
        )?;
        let mut hits = Vec::new();
        for row in rows {
            let hit = row?;
            if self.has_tombstone(&hit.document_id, generation_id) {
                continue;
            }
            hits.push(hit);
        }
        Ok(hits)
    }

    /// 删除向量。删除失败时保留墓碑，防止被遗忘的记忆继续被召回。
    pub fn delete_documents(&self, generation_id: &str, document_ids: &[String]) -> Result<DeleteOutcome> {
        let mut deleted = 0u32;
        let mut tombstoned = 0u32;
        for document_id in document_ids {
            match self.delete_row(generation_id, document_id) {
                Ok(true) => deleted += 1,
                Ok(false) => tombstoned += 1,
                Err(error) => {
                    tracing::warn!(document_id, %error, "vector delete failed; writing tombstone");
                    self.tombstone(document_id, generation_id);
                    tombstoned += 1;
                }
            }
        }
        Ok(DeleteOutcome { deleted, tombstoned })
    }

    /// generation 切换完成后彻底删除其派生行（design §9.3）。
    pub fn drop_generation(&mut self, generation_id: &str) {
        let table = Self::table_name(generation_id);
        let _ = self.conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS {table};
             DELETE FROM vector_row_map WHERE generation_id = '{generation_id}';"
        ));
        self.ready_generations.retain(|id| id != generation_id);
    }

    fn delete_row(&self, generation_id: &str, document_id: &str) -> Result<bool> {
        let table = Self::table_name(generation_id);
        let rowid: Option<i64> = self
            .conn
            .query_row(
                "SELECT vector_rowid FROM vector_row_map WHERE document_id = ?1",
                params![document_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        let changed = match rowid {
            Some(rowid) => self
                .conn
                .execute(&format!("DELETE FROM {table} WHERE rowid = ?1"), params![rowid])?,
            None => self
                .conn
                .execute(&format!("DELETE FROM {table} WHERE document_id = ?1"), params![document_id])?,
        };
        self.conn
            .execute("DELETE FROM vector_row_map WHERE document_id = ?1", params![document_id])?;
        Ok(changed > 0)
    }

    fn tombstone(&self, document_id: &str, generation_id: &str) {
        let now = now_iso();
        let _ = self.conn.execute(
            r#"
            INSERT INTO vector_row_map (document_id, generation_id, vector_rowid, content_hash, indexed_at, deleted_at)
            VALUES (?1, ?2, NULL, '', ?3, ?4)
            ON CONFLICT(document_id) DO UPDATE SET deleted_at = excluded.deleted_at
            "#,
            params![document_id, generation_id, now, now],
        );
    }

    fn has_tombstone(&self, document_id: &str, generation_id: &str) -> bool {
        self.conn
            .query_row(
                "SELECT deleted_at FROM vector_row_map WHERE document_id = ?1 AND generation_id = ?2",
                params![document_id, generation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .is_some()
    }
}

fn to_json_vector(vector: &[f32]) -> String {
    let body = vector
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!("[{body}]")
}

pub(crate) fn now_iso() -> String {
    // 与 Electron 侧一致的 UTC ISO-8601 毫秒时间戳（无额外依赖）。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_iso8601(now.as_millis() as i64)
}

pub(crate) fn now_after_millis(delay_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_iso8601((now.as_millis() + delay_ms as u128) as i64)
}

fn format_iso8601(unix_millis: i64) -> String {
    // 最小实现：仅支持 1970-9999 年的 UTC 格式化，避免引入 chrono。
    let seconds = unix_millis.div_euclid(1000);
    let millis = unix_millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant 的 days_from_civil 逆运算。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("worldbase-vector-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn knn_respects_partition_and_tombstones() {
        let dir = temp_dir();
        let mut index = VectorIndex::open(&dir.join("memory.sqlite")).unwrap();
        index.ensure_generation("gen_test", 4, "cosine").unwrap();

        let scope = "user:local-user".to_string();
        let upsert = |document_id: &str, vector: Vec<f32>| {
            index
                .upsert(
                    "gen_test",
                    &VectorUpsertItem {
                        document_id,
                        scope_key: &scope,
                        document_kind: "memory",
                        vector: &vector,
                    },
                    "hash",
                )
                .unwrap();
        };
        upsert("memory:a", vec![1.0, 0.0, 0.0, 0.0]);
        upsert("memory:b", vec![0.0, 1.0, 0.0, 0.0]);

        let scope_keys = vec![scope.clone()];
        let kinds: Vec<String> = vec!["memory".into()];
        let hits = index
            .query(
                "gen_test",
                &VectorKnnQuery {
                    vector: &[0.9, 0.1, 0.0, 0.0],
                    scope_keys: &scope_keys,
                    document_kinds: &kinds,
                    limit: 2,
                },
            )
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].document_id, "memory:a");

        index.delete_documents("gen_test", &["memory:a".to_string()]).unwrap();
        let hits = index
            .query(
                "gen_test",
                &VectorKnnQuery {
                    vector: &[0.9, 0.1, 0.0, 0.0],
                    scope_keys: &scope_keys,
                    document_kinds: &kinds,
                    limit: 2,
                },
            )
            .unwrap();
        assert!(hits.iter().all(|hit| hit.document_id != "memory:a"));

        index.drop_generation("gen_test");
        let map_count: i64 = index
            .conn
            .query_row("SELECT COUNT(*) FROM vector_row_map", [], |row| row.get(0))
            .unwrap();
        assert_eq!(map_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn iso_formatting_matches_expected_shape() {
        let formatted = format_iso8601(1_790_000_000_123);
        assert!(formatted.ends_with(".123Z"), "{formatted}");
        assert_eq!(formatted.len(), 24, "{formatted}");
    }
}
