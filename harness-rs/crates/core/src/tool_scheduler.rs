//! Dependency-aware scheduling for tool calls inside one assistant turn.
//!
//! The scheduler is pure: it never executes tools or reads the filesystem. It
//! only partitions calls into ordered groups.
//!
//! Rules:
//! - Consecutive read-only calls keep the existing parallel grouping.
//! - Consecutive write calls from the parallel-safe allow-list are planned with
//!   [`worldbase_coding::plan_write_batches`]. Same-file writes are serialized
//!   in call order and dependency files land in earlier batches.
//! - Only `write_file`, `write_project_file`, `patch_project_file`, and
//!   `coding_edit` are parallel-safe. `coding_apply`, shell commands, project
//!   lifecycle tools, deletes, and unknown tools stay serial barriers.
//! - If any call in a planned write batch may show an interactive permission
//!   prompt while auto-approve is off, that whole batch is executed serially in
//!   call order so the host never receives concurrent prompts.
//! - Execution results are re-ordered back to the original tool-call order
//!   before publishing/finalizing, even when planning changed batch order.

use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use worldbase_coding::{plan_write_batches, PlannedWrite};

/// Write tools that may run concurrently on distinct files.
const PARALLEL_SAFE_WRITE_TOOLS: &[&str] = &[
    "write_file",
    "write_project_file",
    "patch_project_file",
    "coding_edit",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduledCall {
    /// Position of the call in the original assistant turn.
    pub index: usize,
    pub call_id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduledGroup {
    pub calls: Vec<ScheduledCall>,
}

/// Partition calls into ordered execution groups.
///
/// `read_only` is the existing read-only allow-list predicate, and
/// `requires_interactive_permission` reports whether a write call may need an
/// interactive prompt with auto-approve off. Both are injected so the
/// scheduler stays pure and unit-testable.
pub(crate) fn schedule_tool_calls<R, P>(
    calls: &[ScheduledCall],
    read_only: R,
    requires_interactive_permission: P,
) -> Vec<ScheduledGroup>
where
    R: Fn(&str) -> bool,
    P: Fn(&ScheduledCall) -> bool,
{
    let mut groups = Vec::new();
    let mut index = 0;
    while index < calls.len() {
        if read_only(&calls[index].name) {
            let mut group = Vec::new();
            while index < calls.len() && read_only(&calls[index].name) {
                group.push(calls[index].clone());
                index += 1;
            }
            groups.push(ScheduledGroup { calls: group });
            continue;
        }

        if parallel_safe_write(&calls[index]) {
            let mut writes = Vec::new();
            while index < calls.len() && parallel_safe_write(&calls[index]) {
                writes.push(calls[index].clone());
                index += 1;
            }
            groups.extend(plan_write_call_batches(
                writes,
                &requires_interactive_permission,
            ));
            continue;
        }

        groups.push(ScheduledGroup {
            calls: vec![calls[index].clone()],
        });
        index += 1;
    }
    groups
}

/// Restore the original assistant call order after concurrent execution.
pub(crate) fn into_call_order<T>(mut values: Vec<(usize, T)>) -> Vec<T> {
    values.sort_by_key(|(index, _)| *index);
    values.into_iter().map(|(_, value)| value).collect()
}

fn parallel_safe_write(call: &ScheduledCall) -> bool {
    PARALLEL_SAFE_WRITE_TOOLS.contains(&call.name.as_str()) && write_target(&call.input).is_some()
}

fn plan_write_call_batches<P>(
    writes: Vec<ScheduledCall>,
    requires_interactive_permission: &P,
) -> Vec<ScheduledGroup>
where
    P: Fn(&ScheduledCall) -> bool,
{
    let planned = writes
        .iter()
        .map(|call| PlannedWrite {
            file_path: write_target(&call.input).unwrap_or_default(),
            depends_on: write_dependencies(&call.input),
        })
        .collect::<Vec<_>>();
    let batches = plan_write_batches(planned);

    // The planner returns cloneable paths, so keep a queue per normalized path
    // to map each planned write back to its original call. Same-file writes
    // stay in call order and are emitted in consecutive batches.
    let mut calls_by_path: HashMap<PathBuf, VecDeque<ScheduledCall>> = HashMap::new();
    for call in writes {
        let key = write_target(&call.input)
            .map(|path| normalize_key(&path))
            .unwrap_or_default();
        calls_by_path.entry(key).or_default().push_back(call);
    }

    let mut groups = Vec::new();
    for batch in batches {
        let mut calls = batch
            .edits
            .into_iter()
            .map(|edit| {
                calls_by_path
                    .get_mut(&normalize_key(&edit.file_path))
                    .and_then(VecDeque::pop_front)
                    .expect("every planned write maps back to a scheduled call")
            })
            .collect::<Vec<_>>();
        calls.sort_by_key(|call| call.index);

        if calls.iter().any(requires_interactive_permission) {
            // Serial fallback for this batch: one group per call keeps the
            // host's permission prompts sequential while preserving order.
            groups.extend(
                calls
                    .into_iter()
                    .map(|call| ScheduledGroup { calls: vec![call] }),
            );
        } else {
            groups.push(ScheduledGroup { calls });
        }
    }
    groups
}

fn write_target(input: &Value) -> Option<PathBuf> {
    ["file_path", "filePath", "path"].iter().find_map(|key| {
        input
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

fn write_dependencies(input: &Value) -> Vec<PathBuf> {
    input
        .get("depends_on")
        .and_then(Value::as_array)
        .map(|dependencies| {
            dependencies
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_key(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::{into_call_order, schedule_tool_calls, ScheduledCall};
    use serde_json::json;

    fn call(index: usize, name: &str, input: serde_json::Value) -> ScheduledCall {
        ScheduledCall {
            index,
            call_id: format!("call-{index}"),
            name: name.into(),
            input,
        }
    }

    fn read_only(name: &str) -> bool {
        matches!(
            name,
            "read_file" | "read_document" | "list_documents" | "web_search"
        )
    }

    fn indices(groups: &[super::ScheduledGroup]) -> Vec<Vec<usize>> {
        groups
            .iter()
            .map(|group| group.calls.iter().map(|call| call.index).collect())
            .collect()
    }

    #[test]
    fn independent_writes_plan_into_one_parallel_batch() {
        let calls = vec![
            call(0, "write_file", json!({ "path": "src/a.ts" })),
            call(1, "write_project_file", json!({ "file_path": "src/b.ts" })),
            call(2, "patch_project_file", json!({ "filePath": "src/c.ts" })),
            call(3, "coding_edit", json!({ "file_path": "src/d.ts" })),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |_| false);
        assert_eq!(indices(&groups), vec![vec![0, 1, 2, 3]]);
    }

    #[test]
    fn same_file_writes_serialize_in_call_order() {
        let calls = vec![
            call(0, "write_file", json!({ "path": "src/app.ts" })),
            call(1, "write_file", json!({ "path": "src/app.ts" })),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |_| false);
        assert_eq!(indices(&groups), vec![vec![0], vec![1]]);
    }

    #[test]
    fn dependency_files_are_emitted_before_dependents() {
        let calls = vec![
            call(
                0,
                "write_project_file",
                json!({
                    "file_path": "src/app.ts",
                    "depends_on": ["src/lib.ts"]
                }),
            ),
            call(
                1,
                "write_project_file",
                json!({ "file_path": "src/lib.ts" }),
            ),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |_| false);
        assert_eq!(indices(&groups), vec![vec![1], vec![0]]);
    }

    #[test]
    fn unknown_dependencies_are_ignored() {
        let calls = vec![
            call(
                0,
                "write_file",
                json!({ "path": "src/a.ts", "depends_on": ["missing.ts"] }),
            ),
            call(1, "write_file", json!({ "path": "src/b.ts" })),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |_| false);
        assert_eq!(indices(&groups), vec![vec![0, 1]]);
    }

    #[test]
    fn read_only_groups_still_run_in_parallel() {
        let calls = vec![
            call(0, "read_file", json!({ "path": "a.txt" })),
            call(1, "read_document", json!({ "path": "b.md" })),
            call(2, "write_file", json!({ "path": "src/a.ts" })),
            call(3, "list_documents", json!({})),
            call(4, "web_search", json!({ "query": "x" })),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |_| false);
        assert_eq!(indices(&groups), vec![vec![0, 1], vec![2], vec![3, 4]]);
    }

    #[test]
    fn interactive_permission_falls_back_to_serial_for_the_batch() {
        let calls = vec![
            call(0, "write_file", json!({ "path": "src/a.ts" })),
            call(1, "coding_edit", json!({ "file_path": "src/b.ts" })),
            call(2, "write_file", json!({ "path": "src/c.ts" })),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |call| call.index == 1);
        assert_eq!(indices(&groups), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn non_allowlisted_writes_are_serial_barriers() {
        let calls = vec![
            call(0, "coding_apply", json!({ "edits": [] })),
            call(1, "write_file", json!({ "path": "src/a.ts" })),
            call(2, "write_file", json!({ "path": "src/b.ts" })),
            call(3, "run_shell_command", json!({ "command": "cargo test" })),
        ];
        let groups = schedule_tool_calls(&calls, read_only, |_| false);
        assert_eq!(indices(&groups), vec![vec![0], vec![1, 2], vec![3]]);
    }

    #[test]
    fn failed_results_are_kept_and_restored_to_call_order() {
        let values = vec![(1, "second:error"), (0, "first:ok"), (2, "third:ok")];
        assert_eq!(
            into_call_order(values),
            vec!["first:ok", "second:error", "third:ok"]
        );
    }
}
