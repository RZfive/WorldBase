use super::Store;
use anyhow::Result;
use rusqlite::params;
use std::collections::HashSet;
use worldbase_protocol::types::{ToolCallRecord, ToolResultRecord};

impl Store {
    pub fn room_conversation_ids(&self, native_id: &str) -> Result<Vec<String>> {
        let shared_id = format!("group-{native_id}");
        let member_prefix = format!("{shared_id}-");
        let adhoc_prefix = format!("__group_adhoc__{native_id}:");
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT id FROM conversations
             WHERE (id = ?1 AND COALESCE(agent_id, '') = '')
                OR (agent_id <> '' AND id = (?2 || agent_id))
                OR (instr(agent_id, ?3) = 1 AND id = (?2 || substr(agent_id, length(?3) + 1)))",
        )?;
        let rows = statement.query_map(params![shared_id, member_prefix, adhoc_prefix], |row| {
            row.get::<_, String>(0)
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn delete_room_memories(
        &self,
        conversation_ids: &HashSet<String>,
        native_ids: &HashSet<String>,
        group_scope_ids: &HashSet<&str>,
    ) -> Result<()> {
        let legacy_ids = self.room_memory_tool_results(conversation_ids)?;
        let memory_ids = {
            let conn = self.memory_conn.lock().unwrap();
            let mut statement = conn.prepare(
                "SELECT id, scope_type, scope_id, source_conversation_id, source_session_id
                 FROM memory_entries",
            )?;
            let mut rows = statement.query([])?;
            let mut memory_ids = Vec::new();
            while let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                let scope_type: String = row.get(1)?;
                let scope_id: String = row.get(2)?;
                let conversation_id: Option<String> = row.get(3)?;
                let session_id: Option<String> = row.get(4)?;
                if (scope_type == "group" && group_scope_ids.contains(scope_id.as_str()))
                    || conversation_id
                        .as_ref()
                        .is_some_and(|id| conversation_ids.contains(id))
                    || session_id.as_deref().is_some_and(|id| {
                        let native_id = id.split_once(":member:").map_or(id, |(parent, _)| parent);
                        native_ids.contains(native_id)
                    })
                    || (conversation_id.is_none()
                        && session_id.is_none()
                        && legacy_ids.contains(&id))
                {
                    memory_ids.push(id);
                }
            }
            memory_ids
        };
        for id in memory_ids {
            self.delete_workspace_memory(&id)?;
        }
        Ok(())
    }

    fn room_memory_tool_results(
        &self,
        conversation_ids: &HashSet<String>,
    ) -> Result<HashSet<String>> {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT tool_calls_json, tool_results_json FROM messages
             WHERE conversation_id = ?1 AND (tool_calls_json <> '[]' OR tool_results_json <> '[]')
             ORDER BY id",
        )?;
        let mut memory_ids = HashSet::new();
        for conversation_id in conversation_ids {
            let mut pending_calls = HashSet::new();
            let mut rows = statement.query([conversation_id])?;
            while let Some(row) = rows.next()? {
                let calls = serde_json::from_str::<Vec<ToolCallRecord>>(&row.get::<_, String>(0)?)
                    .unwrap_or_default();
                for call in calls {
                    if call.name == "memory_add" {
                        pending_calls.insert(call.id);
                    } else {
                        pending_calls.remove(&call.id);
                    }
                }
                let results =
                    serde_json::from_str::<Vec<ToolResultRecord>>(&row.get::<_, String>(1)?)
                        .unwrap_or_default();
                for result in results {
                    let memory_add =
                        pending_calls.remove(&result.tool_call_id) || result.name == "memory_add";
                    if !memory_add || result.is_error {
                        continue;
                    }
                    if let Ok(output) = serde_json::from_str::<serde_json::Value>(&result.content) {
                        if output["stored"].as_bool() == Some(true) {
                            if let Some(id) = output["id"].as_str() {
                                memory_ids.insert(id.to_owned());
                            }
                        }
                    }
                }
            }
        }
        Ok(memory_ids)
    }
}
