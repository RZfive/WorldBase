use std::collections::HashSet;

use anyhow::{bail, Result};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worldbase_protocol::types::ChatMessage;

use super::Store;

/// A conversation-scoped transcript search hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub snippet: String,
    pub created_at: String,
}

const FTS_QUERY_MAX_CHARS: usize = 2_048;
const FTS_TERM_MAX_CHARS: usize = 64;
const FTS_TERM_LIMIT: usize = 16;
const SNIPPET_CONTEXT_BYTES: usize = 96;
const SNIPPET_FALLBACK_CHARS: usize = 240;

/// Build the transcript FTS index and keep it synchronized with `messages`.
///
/// The index is rebuilt on every open. That makes the migration deterministic
/// for old databases whose message JSON predates validation, while messages
/// themselves remain the source of truth.
pub(crate) fn migrate_transcript_store(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            tool_results,
            tool_names,
            tokenize = 'unicode61'
        );

        DROP TRIGGER IF EXISTS messages_fts_ai;
        DROP TRIGGER IF EXISTS messages_fts_ad;
        DROP TRIGGER IF EXISTS messages_fts_au;

        DELETE FROM messages_fts;

        INSERT INTO messages_fts(rowid, content, tool_results, tool_names)
        SELECT
            m.id,
            COALESCE(m.content, ''),
            COALESCE(
                CASE
                    WHEN m.tool_results_json IS NOT NULL
                         AND json_valid(m.tool_results_json)
                    THEN (
                        SELECT group_concat(
                            COALESCE(
                                json_extract(value, '$.content'),
                                json_extract(value, '$.name'),
                                ''
                            ),
                            char(10)
                        )
                        FROM json_each(m.tool_results_json)
                        WHERE json_type(value) = 'object'
                    )
                    ELSE ''
                END,
                ''
            ),
            trim(
                COALESCE(
                    CASE
                        WHEN m.tool_calls_json IS NOT NULL
                             AND json_valid(m.tool_calls_json)
                        THEN (
                            SELECT group_concat(
                                json_extract(value, '$.name'),
                                ' '
                            )
                            FROM json_each(m.tool_calls_json)
                            WHERE json_type(value) = 'object'
                        )
                        ELSE ''
                    END,
                    ''
                )
                || ' '
                || COALESCE(
                    CASE
                        WHEN m.tool_results_json IS NOT NULL
                             AND json_valid(m.tool_results_json)
                        THEN (
                            SELECT group_concat(
                                json_extract(value, '$.name'),
                                ' '
                            )
                            FROM json_each(m.tool_results_json)
                            WHERE json_type(value) = 'object'
                        )
                        ELSE ''
                    END,
                    ''
                )
            )
        FROM messages m;

        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content, tool_results, tool_names)
            VALUES (
                new.id,
                COALESCE(new.content, ''),
                COALESCE(
                    CASE
                        WHEN new.tool_results_json IS NOT NULL
                             AND json_valid(new.tool_results_json)
                        THEN (
                            SELECT group_concat(
                                COALESCE(
                                    json_extract(value, '$.content'),
                                    json_extract(value, '$.name'),
                                    ''
                                ),
                                char(10)
                            )
                            FROM json_each(new.tool_results_json)
                            WHERE json_type(value) = 'object'
                        )
                        ELSE ''
                    END,
                    ''
                ),
                trim(
                    COALESCE(
                        CASE
                            WHEN new.tool_calls_json IS NOT NULL
                                 AND json_valid(new.tool_calls_json)
                            THEN (
                                SELECT group_concat(
                                    json_extract(value, '$.name'),
                                    ' '
                                )
                                FROM json_each(new.tool_calls_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    )
                    || ' '
                    || COALESCE(
                        CASE
                            WHEN new.tool_results_json IS NOT NULL
                                 AND json_valid(new.tool_results_json)
                            THEN (
                                SELECT group_concat(
                                    json_extract(value, '$.name'),
                                    ' '
                                )
                                FROM json_each(new.tool_results_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    )
                )
            );
        END;

        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.id;
        END;

        CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.id;
            INSERT INTO messages_fts(rowid, content, tool_results, tool_names)
            VALUES (
                new.id,
                COALESCE(new.content, ''),
                COALESCE(
                    CASE
                        WHEN new.tool_results_json IS NOT NULL
                             AND json_valid(new.tool_results_json)
                        THEN (
                            SELECT group_concat(
                                COALESCE(
                                    json_extract(value, '$.content'),
                                    json_extract(value, '$.name'),
                                    ''
                                ),
                                char(10)
                            )
                            FROM json_each(new.tool_results_json)
                            WHERE json_type(value) = 'object'
                        )
                        ELSE ''
                    END,
                    ''
                ),
                trim(
                    COALESCE(
                        CASE
                            WHEN new.tool_calls_json IS NOT NULL
                                 AND json_valid(new.tool_calls_json)
                            THEN (
                                SELECT group_concat(
                                    json_extract(value, '$.name'),
                                    ' '
                                )
                                FROM json_each(new.tool_calls_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    )
                    || ' '
                    || COALESCE(
                        CASE
                            WHEN new.tool_results_json IS NOT NULL
                                 AND json_valid(new.tool_results_json)
                            THEN (
                                SELECT group_concat(
                                    json_extract(value, '$.name'),
                                    ' '
                                )
                                FROM json_each(new.tool_results_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    )
                )
            );
        END;
        "#,
    )?;
    tx.commit()?;
    Ok(())
}

impl Store {
    /// Search the durable transcript for one conversation.
    ///
    /// FTS5 is attempted first. CJK and unspaced queries always run an
    /// authoritative bounded LIKE scan, with LIKE evidence prioritized and FTS
    /// filling any remaining limit. Other queries fall back to LIKE only when
    /// FTS has no hits or rejects the query.
    pub fn search_messages(
        &self,
        conversation_id: &str,
        query: &str,
        role: Option<&str>,
        tool_name: Option<&str>,
        limit: u32,
    ) -> Result<Vec<TranscriptHit>> {
        let query = query
            .trim()
            .chars()
            .take(FTS_QUERY_MAX_CHARS)
            .collect::<String>();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let query = query.as_str();

        let role = match role {
            Some(role) => {
                let role = role.trim().to_ascii_lowercase();
                if !matches!(role.as_str(), "user" | "assistant" | "system" | "tool") {
                    return Ok(Vec::new());
                }
                Some(role)
            }
            None => None,
        };
        let tool_name = tool_name.map(str::trim).filter(|name| !name.is_empty());

        let authoritative_like = contains_cjk(query) || !query.chars().any(char::is_whitespace);
        let like_terms = if authoritative_like {
            let terms = authoritative_query_terms(query);
            if terms.is_empty() {
                return Ok(Vec::new());
            }
            terms
        } else {
            vec![query.to_string()]
        };

        let conn = self.conn.lock().unwrap();
        let fts_hits = sanitize_fts_query(query)
            .map(|fts_query| {
                search_fts(
                    &conn,
                    conversation_id,
                    query,
                    &fts_query,
                    role.as_deref(),
                    tool_name,
                    limit,
                )
                .unwrap_or_default()
            })
            .unwrap_or_default();

        if !authoritative_like && !fts_hits.is_empty() {
            return Ok(fts_hits);
        }

        let like_hits = search_like(
            &conn,
            conversation_id,
            query,
            &like_terms,
            role.as_deref(),
            tool_name,
            limit,
        )?;
        if !authoritative_like {
            return Ok(like_hits);
        }

        // Prefer authoritative LIKE evidence before filling the remaining
        // limit with FTS-only hits, then restore chronological transcript order.
        let mut hits = Vec::with_capacity((like_hits.len() + fts_hits.len()).min(limit as usize));
        let mut seen = HashSet::new();
        for hit in like_hits.into_iter().chain(fts_hits) {
            if hits.len() == limit as usize {
                break;
            }
            if seen.insert(hit.id) {
                hits.push(hit);
            }
        }
        hits.sort_by_key(|hit| hit.id);
        Ok(hits)
    }

    /// Read an anchor message plus bounded neighboring rows from exactly one
    /// conversation. Rows are returned in chronological database order and
    /// every carrier field is reconstructed through `Store::row_to_message`.
    pub fn read_message_range(
        &self,
        conversation_id: &str,
        message_id: i64,
        before: u32,
        after: u32,
    ) -> Result<Vec<ChatMessage>> {
        let conn = self.conn.lock().unwrap();
        let owner: Option<String> = conn
            .query_row(
                "SELECT conversation_id FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .optional()?;

        match owner {
            None => bail!("message {message_id} was not found"),
            Some(owner) if owner != conversation_id => {
                bail!("message {message_id} does not belong to conversation {conversation_id}")
            }
            Some(_) => {}
        }

        let anchor = {
            let mut stmt =
                conn.prepare("SELECT * FROM messages WHERE id = ?1 AND conversation_id = ?2")?;
            stmt.query_row(params![message_id, conversation_id], Self::row_to_message)?
        };

        let mut messages = {
            let mut stmt = conn.prepare(
                "SELECT * FROM messages
                 WHERE conversation_id = ?1 AND id < ?2
                 ORDER BY id DESC
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(
                params![conversation_id, message_id, i64::from(before)],
                Self::row_to_message,
            )?;
            let mut preceding = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            preceding.reverse();
            preceding
        };

        messages.push(anchor);

        {
            let mut stmt = conn.prepare(
                "SELECT * FROM messages
                 WHERE conversation_id = ?1 AND id > ?2
                 ORDER BY id ASC
                 LIMIT ?3",
            )?;
            let following = stmt.query_map(
                params![conversation_id, message_id, i64::from(after)],
                Self::row_to_message,
            )?;
            messages.extend(following.collect::<rusqlite::Result<Vec<_>>>()?);
        }

        Ok(messages)
    }
}

fn search_fts(
    conn: &Connection,
    conversation_id: &str,
    query: &str,
    fts_query: &str,
    role: Option<&str>,
    tool_name: Option<&str>,
    limit: u32,
) -> rusqlite::Result<Vec<TranscriptHit>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT
            m.id,
            m.role,
            m.content,
            m.created_at,
            COALESCE(m.tool_calls_json, '[]') AS tool_calls_json,
            COALESCE(m.tool_results_json, '[]') AS tool_results_json,
            snippet(messages_fts, 0, '', '', ' … ', 32) AS content_snippet,
            snippet(messages_fts, 1, '', '', ' … ', 32) AS result_snippet,
            snippet(messages_fts, 2, '', '', ' … ', 32) AS name_snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?1
          AND m.conversation_id = ?2
          AND (
              ?3 IS NULL
              OR (
                  ?3 = 'tool'
                  AND EXISTS (
                      SELECT 1
                      FROM json_each(
                          CASE
                              WHEN m.tool_results_json IS NOT NULL
                                   AND json_valid(m.tool_results_json)
                              THEN m.tool_results_json
                              ELSE '[]'
                          END
                      ) AS tool_result
                      WHERE json_type(tool_result.value) = 'object'
                  )
              )
              OR (?3 <> 'tool' AND m.role = ?3)
          )
          AND (
              ?4 IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM json_each(
                      CASE
                          WHEN m.tool_calls_json IS NOT NULL
                               AND json_valid(m.tool_calls_json)
                          THEN m.tool_calls_json
                          ELSE '[]'
                      END
                  ) AS call
                  WHERE json_type(call.value) = 'object'
                    AND json_extract(call.value, '$.name') = ?4 COLLATE NOCASE
              )
              OR EXISTS (
                  SELECT 1
                  FROM json_each(
                      CASE
                          WHEN m.tool_results_json IS NOT NULL
                               AND json_valid(m.tool_results_json)
                          THEN m.tool_results_json
                          ELSE '[]'
                      END
                  ) AS result
                  WHERE json_type(result.value) = 'object'
                    AND json_extract(result.value, '$.name') = ?4 COLLATE NOCASE
              )
          )
        ORDER BY m.id ASC
        LIMIT ?5
        "#,
    )?;

    let rows = stmt.query_map(
        params![
            fts_query,
            conversation_id,
            role,
            tool_name,
            i64::from(limit)
        ],
        |row| {
            let content: String = row.get("content")?;
            let tool_calls_json: String = row.get("tool_calls_json")?;
            let tool_results_json: String = row.get("tool_results_json")?;
            let content_snippet: String = row.get("content_snippet")?;
            let result_snippet: String = row.get("result_snippet")?;
            let name_snippet: String = row.get("name_snippet")?;

            Ok(TranscriptHit {
                id: row.get("id")?,
                role: row.get("role")?,
                content: content.clone(),
                snippet: choose_snippet(
                    &content,
                    &tool_calls_json,
                    &tool_results_json,
                    query,
                    [&content_snippet, &result_snippet, &name_snippet],
                ),
                created_at: row.get("created_at")?,
            })
        },
    )?;

    rows.collect()
}

fn search_like(
    conn: &Connection,
    conversation_id: &str,
    query: &str,
    terms: &[String],
    role: Option<&str>,
    tool_name: Option<&str>,
    limit: u32,
) -> Result<Vec<TranscriptHit>> {
    let mut term_conditions = String::new();
    for (index, _) in terms.iter().enumerate() {
        if index > 0 {
            term_conditions.push_str(" AND ");
        }
        term_conditions.push_str(&format!(
            "lower(searchable) LIKE lower(?{}) ESCAPE '\\'",
            index + 4
        ));
    }
    let limit_parameter = terms.len() + 4;

    let sql = format!(
        r#"
        WITH candidates AS (
            SELECT
                m.id,
                m.role,
                m.content,
                m.created_at,
                COALESCE(m.tool_calls_json, '[]') AS tool_calls_json,
                COALESCE(m.tool_results_json, '[]') AS tool_results_json,
                COALESCE(m.content, '')
                    || char(10)
                    || COALESCE(
                        CASE
                            WHEN m.tool_results_json IS NOT NULL
                                 AND json_valid(m.tool_results_json)
                            THEN (
                                SELECT group_concat(
                                    COALESCE(
                                        json_extract(value, '$.content'),
                                        json_extract(value, '$.name'),
                                        ''
                                    ),
                                    char(10)
                                )
                                FROM json_each(m.tool_results_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    )
                    || char(10)
                    || COALESCE(
                        CASE
                            WHEN m.tool_results_json IS NOT NULL
                                 AND json_valid(m.tool_results_json)
                            THEN (
                                SELECT group_concat(
                                    json_extract(value, '$.name'),
                                    ' '
                                )
                                FROM json_each(m.tool_results_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    )
                    || char(10)
                    || COALESCE(
                        CASE
                            WHEN m.tool_calls_json IS NOT NULL
                                 AND json_valid(m.tool_calls_json)
                            THEN (
                                SELECT group_concat(
                                    json_extract(value, '$.name'),
                                    ' '
                                )
                                FROM json_each(m.tool_calls_json)
                                WHERE json_type(value) = 'object'
                            )
                            ELSE ''
                        END,
                        ''
                    ) AS searchable
            FROM messages m
            WHERE m.conversation_id = ?1
              AND (
                  ?2 IS NULL
                  OR (
                      ?2 = 'tool'
                      AND EXISTS (
                          SELECT 1
                          FROM json_each(
                              CASE
                                  WHEN m.tool_results_json IS NOT NULL
                                       AND json_valid(m.tool_results_json)
                                  THEN m.tool_results_json
                                  ELSE '[]'
                              END
                          ) AS tool_result
                          WHERE json_type(tool_result.value) = 'object'
                      )
                  )
                  OR (?2 <> 'tool' AND m.role = ?2)
              )
              AND (
                  ?3 IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM json_each(
                          CASE
                              WHEN m.tool_calls_json IS NOT NULL
                                   AND json_valid(m.tool_calls_json)
                              THEN m.tool_calls_json
                              ELSE '[]'
                          END
                      ) AS call
                      WHERE json_type(call.value) = 'object'
                        AND json_extract(call.value, '$.name') = ?3 COLLATE NOCASE
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM json_each(
                          CASE
                              WHEN m.tool_results_json IS NOT NULL
                                   AND json_valid(m.tool_results_json)
                              THEN m.tool_results_json
                              ELSE '[]'
                          END
                      ) AS result
                      WHERE json_type(result.value) = 'object'
                        AND json_extract(result.value, '$.name') = ?3 COLLATE NOCASE
                  )
              )
        )
        SELECT
            id,
            role,
            content,
            created_at,
            tool_calls_json,
            tool_results_json
        FROM candidates
        WHERE {term_conditions}
        ORDER BY id ASC
        LIMIT ?{limit_parameter}
        "#
    );

    let mut values = vec![
        SqlValue::Text(conversation_id.to_string()),
        role.map_or(SqlValue::Null, |role| SqlValue::Text(role.to_string())),
        tool_name.map_or(SqlValue::Null, |name| SqlValue::Text(name.to_string())),
    ];
    values.extend(terms.iter().map(|term| SqlValue::Text(like_pattern(term))));
    values.push(SqlValue::Integer(i64::from(limit)));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values), |row| {
        let content: String = row.get("content")?;
        let tool_calls_json: String = row.get("tool_calls_json")?;
        let tool_results_json: String = row.get("tool_results_json")?;

        Ok(TranscriptHit {
            id: row.get("id")?,
            role: row.get("role")?,
            content: content.clone(),
            snippet: choose_snippet(
                &content,
                &tool_calls_json,
                &tool_results_json,
                query,
                ["", "", ""],
            ),
            created_at: row.get("created_at")?,
        })
    })?;

    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Convert caller input into quoted FTS5 terms. Punctuation and operators are
/// discarded instead of being forwarded as FTS syntax.
fn sanitize_fts_query(query: &str) -> Option<String> {
    let terms = query_terms(query)
        .into_iter()
        .filter(|term| !is_fts_operator(term))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return None;
    }

    Some(
        terms
            .into_iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn is_fts_operator(term: &str) -> bool {
    matches!(
        term.to_ascii_lowercase().as_str(),
        "and" | "or" | "not" | "near"
    )
}

fn contains_cjk(query: &str) -> bool {
    query.chars().any(is_cjk)
}

fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x1100..=0x11ff
            | 0x3040..=0x30ff
            | 0x3130..=0x318f
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xac00..=0xd7af
            | 0xf900..=0xfaff
            | 0x20000..=0x2fa1f
    )
}

fn query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();

    for character in query.chars().take(FTS_QUERY_MAX_CHARS) {
        if character.is_alphanumeric() || character == '_' {
            if current.chars().count() < FTS_TERM_MAX_CHARS {
                current.push(character);
            }
        } else if !current.is_empty() {
            terms.push(std::mem::take(&mut current));
            if terms.len() == FTS_TERM_LIMIT {
                break;
            }
        }
    }

    if !current.is_empty() && terms.len() < FTS_TERM_LIMIT {
        terms.push(current);
    }
    terms
}

/// Split an authoritative query into bounded literal terms. Unlike the FTS
/// sanitizer, this also separates CJK runs from adjacent non-CJK runs so an
/// unspaced mixed-script query can match the same evidence with separators.
fn authoritative_query_terms(query: &str) -> Vec<String> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum TermClass {
        Cjk,
        Other,
    }

    let mut terms = Vec::new();
    let mut current = String::new();
    let mut current_class = None;

    let flush = |terms: &mut Vec<String>, current: &mut String, class: &mut Option<TermClass>| {
        if !current.is_empty() {
            if !terms
                .iter()
                .any(|known: &String| known.eq_ignore_ascii_case(current))
            {
                terms.push(std::mem::take(current));
            } else {
                current.clear();
            }
        }
        *class = None;
    };

    for character in query.chars().take(FTS_QUERY_MAX_CHARS) {
        let class = if is_cjk(character) {
            Some(TermClass::Cjk)
        } else if character.is_alphanumeric() {
            Some(TermClass::Other)
        } else {
            None
        };

        match class {
            Some(class) => {
                if current_class.is_some_and(|known| known != class) && !current.is_empty() {
                    flush(&mut terms, &mut current, &mut current_class);
                    if terms.len() == FTS_TERM_LIMIT {
                        return terms;
                    }
                }
                if current.is_empty() {
                    current_class = Some(class);
                }
                if current.chars().count() < FTS_TERM_MAX_CHARS {
                    current.push(character);
                }
            }
            None => {
                flush(&mut terms, &mut current, &mut current_class);
                if terms.len() == FTS_TERM_LIMIT {
                    return terms;
                }
            }
        }
    }

    flush(&mut terms, &mut current, &mut current_class);
    terms.truncate(FTS_TERM_LIMIT);
    terms
}

fn like_pattern(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');
    for character in query.chars() {
        match character {
            '\\' => pattern.push_str("\\\\"),
            '%' => pattern.push_str("\\%"),
            '_' => pattern.push_str("\\_"),
            character => pattern.push(character),
        }
    }
    pattern.push('%');
    pattern
}

fn choose_snippet(
    content: &str,
    tool_calls_json: &str,
    tool_results_json: &str,
    query: &str,
    fts_snippets: [&str; 3],
) -> String {
    if let Some(snippet) = matched_source_snippet(content, query) {
        return snippet;
    }

    let tool_results = tool_result_text(tool_results_json);
    if let Some(snippet) = matched_source_snippet(&tool_results, query) {
        return snippet;
    }

    let tool_names = tool_names(tool_calls_json, tool_results_json).join(" ");
    if let Some(snippet) = matched_source_snippet(&tool_names, query) {
        return snippet;
    }

    for snippet in fts_snippets {
        let snippet = snippet.trim();
        if !snippet.is_empty() {
            return truncate_chars(snippet, SNIPPET_FALLBACK_CHARS);
        }
    }

    for source in [content, tool_results.as_str(), tool_names.as_str()] {
        if !source.trim().is_empty() {
            return truncate_chars(source.trim(), SNIPPET_FALLBACK_CHARS);
        }
    }

    String::new()
}

fn matched_source_snippet(source: &str, query: &str) -> Option<String> {
    let source = source.trim();
    if source.is_empty() {
        return None;
    }
    let (position, needle_len) = find_query_match(source, query)?;
    Some(snippet_around(source, position, needle_len))
}

fn find_query_match(source: &str, query: &str) -> Option<(usize, usize)> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    if let Some(position) = find_case_insensitive(source, query) {
        return Some((position, query.len()));
    }

    for term in authoritative_query_terms(query) {
        if let Some(position) = find_case_insensitive(source, &term) {
            return Some((position, term.len()));
        }
    }
    None
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    if let Some(position) = haystack.find(needle) {
        return Some(position);
    }
    let haystack_lower = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    haystack_lower
        .find(&needle_lower)
        .filter(|position| haystack.is_char_boundary(*position))
}

fn snippet_around(source: &str, position: usize, needle_len: usize) -> String {
    let start = floor_char_boundary(source, position.saturating_sub(SNIPPET_CONTEXT_BYTES));
    let end = ceil_char_boundary(
        source,
        position
            .saturating_add(needle_len)
            .saturating_add(SNIPPET_CONTEXT_BYTES * 2)
            .min(source.len()),
    );
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(source[start..end].trim());
    if end < source.len() {
        snippet.push('…');
    }
    truncate_chars(&snippet, SNIPPET_FALLBACK_CHARS)
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

fn tool_result_text(raw: &str) -> String {
    json_objects(raw)
        .into_iter()
        .filter_map(|value| {
            value
                .get("content")
                .and_then(Value::as_str)
                .or_else(|| value.get("name").and_then(Value::as_str))
                .map(str::to_string)
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_names(tool_calls_json: &str, tool_results_json: &str) -> Vec<String> {
    let mut names = Vec::new();
    for raw in [tool_calls_json, tool_results_json] {
        for value in json_objects(raw) {
            let Some(name) = value.get("name").and_then(Value::as_str) else {
                continue;
            };
            let name = name.trim();
            if !name.is_empty() && !names.iter().any(|known| known == name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

fn json_objects(raw: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(values)) => values
            .into_iter()
            .filter(|value| value.is_object())
            .collect(),
        Ok(value @ Value::Object(_)) => vec![value],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;
    use worldbase_protocol::types::{Role, ToolCallRecord, ToolResultRecord};

    use super::*;

    struct TestDb {
        root: PathBuf,
    }

    impl TestDb {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "worldbase-transcript-store-{}",
                uuid::Uuid::new_v4()
            ));
            Self { root }
        }

        fn path(&self) -> PathBuf {
            self.root.join("app.sqlite")
        }

        fn open(&self) -> Store {
            Store::open(&self.path()).expect("open test store")
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn message(role: Role, content: impl Into<String>) -> ChatMessage {
        ChatMessage {
            id: 0,
            role,
            content: content.into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }
    }

    fn ids(hits: &[TranscriptHit]) -> Vec<i64> {
        hits.iter().map(|hit| hit.id).collect()
    }

    #[test]
    fn english_fts_search_is_conversation_scoped_and_returns_snippets() {
        let db = TestDb::new();
        let store = db.open();
        let first = store.create_conversation("first", None).unwrap();
        let second = store.create_conversation("second", None).unwrap();

        let first_id = store
            .append_message(
                &first.id,
                &message(Role::User, "The velvetorbit deploy finished."),
            )
            .unwrap();
        let second_id = store
            .append_message(
                &second.id,
                &message(Role::Assistant, "velvetorbit belongs elsewhere"),
            )
            .unwrap();

        let hits = store
            .search_messages(&first.id, "velvetorbit", None, None, 10)
            .unwrap();
        assert_eq!(ids(&hits), vec![first_id]);
        assert_eq!(hits[0].role, "user");
        assert!(hits[0].snippet.to_lowercase().contains("velvetorbit"));
        assert!(hits[0].content.contains("deploy finished"));
        assert!(!hits[0].created_at.is_empty());
        assert!(hits.iter().all(|hit| hit.id != second_id));
    }

    #[test]
    fn tool_result_text_and_names_are_searchable_and_filterable() {
        let db = TestDb::new();
        let store = db.open();
        let conversation = store.create_conversation("tools", None).unwrap();

        let call_id = store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    role: Role::Assistant,
                    content: "Dispatching lookup.".into(),
                    tool_calls: vec![ToolCallRecord {
                        id: "call-1".into(),
                        name: "lookup_inventory".into(),
                        args: json!({"sku": "SKU-991"}),
                    }],
                    ..message(Role::Assistant, "")
                },
            )
            .unwrap();
        let result_id = store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    role: Role::User,
                    content: String::new(),
                    tool_results: vec![ToolResultRecord {
                        tool_call_id: "call-1".into(),
                        name: "lookup_inventory".into(),
                        content: "The amber reserve contains SKU-991.".into(),
                        is_error: false,
                    }],
                    ..message(Role::User, "")
                },
            )
            .unwrap();

        let result_hits = store
            .search_messages(&conversation.id, "amber", None, None, 10)
            .unwrap();
        assert_eq!(ids(&result_hits), vec![result_id]);
        assert!(result_hits[0].snippet.contains("amber"));

        let name_hits = store
            .search_messages(&conversation.id, "lookup_inventory", None, None, 10)
            .unwrap();
        assert!(ids(&name_hits).contains(&call_id));
        assert!(ids(&name_hits).contains(&result_id));

        let filtered = store
            .search_messages(
                &conversation.id,
                "amber",
                None,
                Some("lookup_inventory"),
                10,
            )
            .unwrap();
        assert_eq!(ids(&filtered), vec![result_id]);
        assert!(store
            .search_messages(&conversation.id, "amber", None, Some("write_file"), 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn contiguous_cjk_uses_the_like_fallback() {
        let db = TestDb::new();
        let store = db.open();
        let conversation = store.create_conversation("cjk", None).unwrap();
        let id = store
            .append_message(
                &conversation.id,
                &message(Role::User, "发布前必须检查缓存配置避免覆盖"),
            )
            .unwrap();

        let hits = store
            .search_messages(&conversation.id, "缓存配置", None, None, 10)
            .unwrap();
        assert_eq!(ids(&hits), vec![id]);
        assert!(hits[0].snippet.contains("缓存配置"));
    }

    #[test]
    fn mixed_cjk_unspaced_query_merges_authoritative_like_evidence() {
        let db = TestDb::new();
        let store = db.open();
        let conversation = store.create_conversation("mixed-cjk", None).unwrap();
        let other = store.create_conversation("other", None).unwrap();
        let query = "缓存配置manifest_invalid";

        let exact_id = store
            .append_message(
                &conversation.id,
                &message(
                    Role::User,
                    "缓存配置manifest_invalid appeared as the exact token",
                ),
            )
            .unwrap();
        let spaced_id = store
            .append_message(
                &conversation.id,
                &message(
                    Role::Assistant,
                    "部署失败\n缓存配置 manifest_invalid\n请修复配置",
                ),
            )
            .unwrap();
        let foreign_id = store
            .append_message(
                &other.id,
                &message(Role::User, "缓存配置 manifest_invalid must stay isolated"),
            )
            .unwrap();

        {
            let conn = store.conn.lock().unwrap();
            let fts_query = sanitize_fts_query(query).unwrap();
            let fts_hits =
                search_fts(&conn, &conversation.id, query, &fts_query, None, None, 10).unwrap();
            assert!(fts_hits.iter().any(|hit| hit.id == exact_id));
            assert!(fts_hits.iter().all(|hit| hit.id != spaced_id));
        }

        let hits = store
            .search_messages(&conversation.id, query, None, None, 10)
            .unwrap();
        assert_eq!(ids(&hits), vec![exact_id, spaced_id]);
        assert!(hits.iter().all(|hit| hit.id != foreign_id));

        let exact_hit = hits.iter().find(|hit| hit.id == exact_id).unwrap();
        assert!(exact_hit.snippet.contains("缓存配置manifest_invalid"));
        let spaced_hit = hits.iter().find(|hit| hit.id == spaced_id).unwrap();
        assert!(spaced_hit.snippet.contains("缓存配置"));
        assert!(spaced_hit.snippet.contains("manifest_invalid"));
    }

    #[test]
    fn tool_role_matches_only_tool_result_carriers_in_fts_and_like_paths() {
        let db = TestDb::new();
        let store = db.open();
        let conversation = store.create_conversation("tool-role", None).unwrap();

        let carrier_id = store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    role: Role::User,
                    content: String::new(),
                    tool_results: vec![ToolResultRecord {
                        tool_call_id: "call-role".into(),
                        name: "lookup_inventory".into(),
                        content: "toolresultnebula evidence: tool result nebula".into(),
                        is_error: false,
                    }],
                    ..message(Role::User, "")
                },
            )
            .unwrap();
        let tool_call_only_id = store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    role: Role::Assistant,
                    content: "toolresultnebula call only; tool result nebula".into(),
                    tool_calls: vec![ToolCallRecord {
                        id: "call-only".into(),
                        name: "lookup_inventory".into(),
                        args: json!({"scope": "test"}),
                    }],
                    ..message(Role::Assistant, "")
                },
            )
            .unwrap();
        let plain_id = store
            .append_message(
                &conversation.id,
                &message(
                    Role::User,
                    "toolresultnebula plain text; tool result nebula",
                ),
            )
            .unwrap();

        let fts_hits = store
            .search_messages(
                &conversation.id,
                "tool result nebula",
                Some("tool"),
                None,
                10,
            )
            .unwrap();
        assert_eq!(ids(&fts_hits), vec![carrier_id]);
        assert_eq!(fts_hits[0].role, "user");

        let like_hits = store
            .search_messages(&conversation.id, "toolresultnebula", Some("tool"), None, 10)
            .unwrap();
        assert_eq!(ids(&like_hits), vec![carrier_id]);
        assert_eq!(like_hits[0].role, "user");
        assert!(like_hits[0].snippet.contains("toolresultnebula"));
        assert!(like_hits
            .iter()
            .all(|hit| hit.id != tool_call_only_id && hit.id != plain_id));
    }

    #[test]
    fn search_filters_roles_and_sanitizes_fts_syntax() {
        let db = TestDb::new();
        let store = db.open();
        let conversation = store.create_conversation("roles", None).unwrap();
        let user_id = store
            .append_message(&conversation.id, &message(Role::User, "quasar input"))
            .unwrap();
        let assistant_id = store
            .append_message(&conversation.id, &message(Role::Assistant, "quasar answer"))
            .unwrap();

        let user_hits = store
            .search_messages(&conversation.id, "quasar", Some("user"), None, 10)
            .unwrap();
        assert_eq!(ids(&user_hits), vec![user_id]);
        let assistant_hits = store
            .search_messages(&conversation.id, "quasar", Some("assistant"), None, 10)
            .unwrap();
        assert_eq!(ids(&assistant_hits), vec![assistant_id]);

        let syntax_shaped = store
            .search_messages(&conversation.id, "quasar OR \"answer", None, None, 10)
            .unwrap();
        assert_eq!(
            syntax_shaped.iter().map(|hit| hit.id).collect::<Vec<_>>(),
            vec![assistant_id]
        );
    }

    #[test]
    fn range_is_chronological_owned_and_preserves_tool_carriers() {
        let db = TestDb::new();
        let store = db.open();
        let conversation = store.create_conversation("range", None).unwrap();
        let other = store.create_conversation("other", None).unwrap();

        store
            .append_message(&conversation.id, &message(Role::User, "before"))
            .unwrap();
        let call_id = store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    role: Role::Assistant,
                    content: "call carrier".into(),
                    tool_calls: vec![ToolCallRecord {
                        id: "call-range".into(),
                        name: "read_file".into(),
                        args: json!({"path": "notes.txt"}),
                    }],
                    ..message(Role::Assistant, "")
                },
            )
            .unwrap();
        let result_id = store
            .append_message(
                &conversation.id,
                &ChatMessage {
                    role: Role::User,
                    content: String::new(),
                    tool_results: vec![ToolResultRecord {
                        tool_call_id: "call-range".into(),
                        name: "read_file".into(),
                        content: "line alpha\nline beta".into(),
                        is_error: false,
                    }],
                    ..message(Role::User, "")
                },
            )
            .unwrap();
        store
            .append_message(&conversation.id, &message(Role::Assistant, "after"))
            .unwrap();
        let foreign_id = store
            .append_message(&other.id, &message(Role::User, "foreign"))
            .unwrap();

        let range = store
            .read_message_range(&conversation.id, result_id, 1, 1)
            .unwrap();
        assert_eq!(
            range.iter().map(|entry| entry.id).collect::<Vec<_>>(),
            vec![call_id, result_id, range[2].id]
        );
        assert_eq!(range[0].role, Role::Assistant);
        assert_eq!(range[0].tool_calls[0].id, "call-range");
        assert_eq!(range[0].tool_calls[0].args, json!({"path": "notes.txt"}));
        assert_eq!(range[1].content, "");
        assert_eq!(range[1].tool_results[0].tool_call_id, "call-range");
        assert_eq!(range[1].tool_results[0].content, "line alpha\nline beta");
        assert!(range[2].content.contains("after"));
        assert!(store
            .read_message_range(&conversation.id, foreign_id, 1, 1)
            .is_err());
    }

    #[test]
    fn migration_reopen_rebuilds_malformed_legacy_rows_and_adds_triggers() {
        let db = TestDb::new();
        let conversation_id = {
            let store = db.open();
            let conversation = store.create_conversation("reopen", None).unwrap();
            store
                .append_message(
                    &conversation.id,
                    &message(Role::User, "searchable across reopen"),
                )
                .unwrap();
            conversation.id
        };

        {
            let conn = Connection::open(db.path()).unwrap();
            conn.execute(
                "INSERT INTO messages
                 (conversation_id, role, content, parts_json, tool_calls_json, tool_results_json, created_at)
                 VALUES (?1, 'assistant', 'legacy searchable row', '[]', '', 'not json', '2026-11-13T00:00:00Z')",
                params![conversation_id],
            )
            .unwrap();
        }

        let store = Store::open(&db.path()).unwrap();
        let reopened_hits = store
            .search_messages(&conversation_id, "searchable", None, None, 10)
            .unwrap();
        assert_eq!(reopened_hits.len(), 2);

        let appended_id = store
            .append_message(
                &conversation_id,
                &message(Role::User, "trigger indexed holder"),
            )
            .unwrap();
        let trigger_hits = store
            .search_messages(&conversation_id, "holder", None, None, 10)
            .unwrap();
        assert_eq!(ids(&trigger_hits), vec![appended_id]);

        store
            .update_message_content(appended_id, "edited searchable content")
            .unwrap();
        assert!(store
            .search_messages(&conversation_id, "holder", None, None, 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            ids(&store
                .search_messages(&conversation_id, "edited", None, None, 10)
                .unwrap()),
            vec![appended_id]
        );

        store
            .truncate_after(
                &conversation_id,
                reopened_hits
                    .iter()
                    .map(|hit| hit.id)
                    .max()
                    .unwrap_or_default(),
            )
            .unwrap();
        assert!(store
            .search_messages(&conversation_id, "edited", None, None, 10)
            .unwrap()
            .is_empty());
    }
}
