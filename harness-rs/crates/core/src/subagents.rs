//! Rust-native execution for the canonical `spawn_subagents` tool.
//!
//! The tools crate owns the public schema and result shape. This module owns
//! child chat lifecycle, policy inheritance, progress, and cancellation.

use crate::agent::start_subagent_chat;
use crate::hub::Hub;
use anyhow::Result;
use async_trait::async_trait;
use futures::future::join_all;
use std::collections::HashSet;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::types::{Capabilities, ChatRunContext};
use worldbase_tools::{
    GroupCollaborationRuntime, SubagentRunRequest, SubagentRunResponse, SubagentRuntime,
    SubagentTaskRequest, SubagentTaskResult, SubagentTaskStatus, SubagentTokenUsage,
};

pub(crate) const MAX_SUBAGENT_NESTING_DEPTH: u8 = 2;
const BLOCK_ALL_TOOLS_SENTINEL: &str = "__blocked_subagent_tools__";

pub(crate) struct CoreSubagentRuntime {
    hub: Arc<Hub>,
    parent_stream_id: String,
    parent_abort: CancellationToken,
    capabilities: Capabilities,
    interactive: bool,
    agent_id: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    context: ChatRunContext,
    group_collaboration: Option<Arc<dyn GroupCollaborationRuntime>>,
    nesting_depth: u8,
}

impl CoreSubagentRuntime {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        hub: Arc<Hub>,
        parent_stream_id: String,
        parent_abort: CancellationToken,
        capabilities: Capabilities,
        interactive: bool,
        agent_id: Option<String>,
        provider_id: Option<String>,
        model: Option<String>,
        context: ChatRunContext,
        group_collaboration: Option<Arc<dyn GroupCollaborationRuntime>>,
        nesting_depth: u8,
    ) -> Self {
        Self {
            hub,
            parent_stream_id,
            parent_abort,
            capabilities,
            interactive,
            agent_id,
            provider_id,
            model,
            context,
            group_collaboration,
            nesting_depth,
        }
    }

    async fn notice(&self, text: impl Into<String>) {
        self.hub
            .emit(
                &self.parent_stream_id,
                EventKind::Notice { text: text.into() },
            )
            .await;
    }

    async fn run_task(&self, task: SubagentTaskRequest) -> SubagentTaskResult {
        let description = normalized_label(&task.description);
        match self.run_task_inner(&description, task).await {
            Ok((result, token_usage)) => {
                self.notice(format!("[{description}] 子 Agent 已完成"))
                    .await;
                SubagentTaskResult {
                    description,
                    result,
                    status: SubagentTaskStatus::Completed,
                    error: None,
                    token_usage: Some(token_usage),
                }
            }
            Err(error) => {
                let error = error.to_string();
                self.notice(format!("[{description}] 子 Agent 失败: {error}"))
                    .await;
                SubagentTaskResult {
                    description,
                    result: String::new(),
                    status: SubagentTaskStatus::Failed,
                    error: Some(error),
                    token_usage: None,
                }
            }
        }
    }

    async fn run_task_inner(
        &self,
        description: &str,
        task: SubagentTaskRequest,
    ) -> Result<(String, SubagentTokenUsage)> {
        anyhow::ensure!(
            self.nesting_depth < MAX_SUBAGENT_NESTING_DEPTH,
            "subagent nesting limit reached"
        );
        anyhow::ensure!(
            !self.parent_abort.is_cancelled(),
            "parent agent was cancelled"
        );

        let child_depth = self.nesting_depth + 1;
        let mut context = self.context.clone();
        context.allowed_tool_names = intersect_allowed_tool_names(
            &context.allowed_tool_names,
            task.allowed_tools.as_deref(),
        );
        context.denied_tool_names =
            merge_denied_tool_names(&context.denied_tool_names, task.denied_tools.as_deref());
        for section in task.system_prompt_sections.unwrap_or_default() {
            push_unique(&mut context.system_prompt_sections, section);
        }
        push_unique(
            &mut context.system_prompt_sections,
            nested_subagent_prompt(child_depth),
        );

        let conversation = self.hub.store.create_conversation(
            &format!("[子 Agent] {description}"),
            self.agent_id.as_deref(),
        )?;
        let child_stream_id = format!(
            "{}:subagent:{}:{}",
            self.parent_stream_id,
            child_depth,
            uuid::Uuid::new_v4().simple()
        );
        let channel = self.hub.register_stream(&child_stream_id);
        let mut receiver = channel.tx.subscribe();
        let mut after_seq = channel.latest_seq().await;

        self.notice(format!("[{description}] 子 Agent 启动")).await;
        let run = start_subagent_chat(
            self.hub.clone(),
            conversation.id,
            task.prompt,
            self.capabilities.clone(),
            self.interactive,
            self.agent_id.clone(),
            self.provider_id.clone(),
            self.model.clone(),
            context,
            child_stream_id.clone(),
            self.group_collaboration.clone(),
            child_depth,
        )?;
        anyhow::ensure!(
            run.stream_id == child_stream_id,
            "subagent was assigned an unexpected stream"
        );

        // `spawn_subagents` itself is cancelled by dropping its future. Keep
        // cancellation tied to this waiter's lifetime so its spawned chat
        // cannot continue executing tools after the parent has moved on.
        let mut cancel_guard = CancelChildRunOnDrop::new(self.hub.clone(), child_stream_id.clone());
        let mut last_assistant_message = String::new();
        let mut token_usage = SubagentTokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            total_cost: 0.0,
        };

        loop {
            for frame in channel.replay(after_seq).await {
                after_seq = after_seq.max(frame.seq as i64);
                if let Some(result) = self
                    .handle_child_event(
                        description,
                        frame.kind,
                        &mut last_assistant_message,
                        &mut token_usage,
                    )
                    .await?
                {
                    cancel_guard.disarm();
                    return Ok((result, token_usage));
                }
            }

            let received = tokio::select! {
                biased;
                _ = self.parent_abort.cancelled() => {
                    anyhow::bail!("parent agent was cancelled")
                }
                received = receiver.recv() => received,
            };
            match received {
                Ok(frame) if frame.seq as i64 > after_seq => {
                    after_seq = frame.seq as i64;
                    if let Some(result) = self
                        .handle_child_event(
                            description,
                            frame.kind,
                            &mut last_assistant_message,
                            &mut token_usage,
                        )
                        .await?
                    {
                        cancel_guard.disarm();
                        return Ok((result, token_usage));
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    anyhow::bail!("subagent stream closed unexpectedly")
                }
            }
        }
    }

    async fn handle_child_event(
        &self,
        description: &str,
        kind: EventKind,
        last_assistant_message: &mut String,
        token_usage: &mut SubagentTokenUsage,
    ) -> Result<Option<String>> {
        match kind {
            EventKind::AssistantMessage { content, .. } => {
                *last_assistant_message = content;
            }
            EventKind::ToolCall { name, .. } => {
                self.notice(format!("[{description}] 正在调用 {name}"))
                    .await;
            }
            EventKind::Usage {
                total_input_tokens,
                total_output_tokens,
                total_cost,
                ..
            } => {
                token_usage.input_tokens = total_input_tokens;
                token_usage.output_tokens = total_output_tokens;
                token_usage.total_cost = total_cost;
            }
            EventKind::Done { stop_reason } => {
                anyhow::ensure!(stop_reason != "aborted", "subagent was cancelled");
                return Ok(Some(last_assistant_message.clone()));
            }
            EventKind::Error { message } => anyhow::bail!(message),
            _ => {}
        }
        Ok(None)
    }
}

#[async_trait]
impl SubagentRuntime for CoreSubagentRuntime {
    async fn run_parallel(&self, request: SubagentRunRequest) -> Result<SubagentRunResponse> {
        anyhow::ensure!(
            request.parent_stream_id == self.parent_stream_id,
            "subagent parent stream mismatch"
        );
        anyhow::ensure!(
            self.nesting_depth < MAX_SUBAGENT_NESTING_DEPTH,
            "subagent nesting limit reached"
        );

        self.notice(format!("启动 {} 个并行子 Agent", request.tasks.len()))
            .await;
        let results = join_all(request.tasks.into_iter().map(|task| self.run_task(task))).await;
        let completed = results
            .iter()
            .filter(|result| result.status == SubagentTaskStatus::Completed)
            .count();
        self.notice(format!(
            "所有子 Agent 已返回: {completed}/{} 成功",
            results.len()
        ))
        .await;
        Ok(SubagentRunResponse { results })
    }
}

struct CancelChildRunOnDrop {
    hub: Arc<Hub>,
    stream_id: String,
    armed: bool,
}

impl CancelChildRunOnDrop {
    fn new(hub: Arc<Hub>, stream_id: String) -> Self {
        Self {
            hub,
            stream_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelChildRunOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(run) = self.hub.runs.lock().unwrap().get(&self.stream_id) {
            run.abort.cancel();
        }
    }
}

fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert((*value).to_string()))
        .map(ToOwned::to_owned)
        .collect()
}

fn intersect_allowed_tool_names(parent: &[String], child: Option<&[String]>) -> Vec<String> {
    let parent = normalized_strings(parent);
    let child = normalized_strings(child.unwrap_or_default());
    if parent.is_empty() {
        return child;
    }
    if child.is_empty() {
        return parent;
    }
    let child: HashSet<_> = child.into_iter().collect();
    let intersection: Vec<_> = parent
        .into_iter()
        .filter(|name| child.contains(name))
        .collect();
    if intersection.is_empty() {
        vec![BLOCK_ALL_TOOLS_SENTINEL.into()]
    } else {
        intersection
    }
}

fn merge_denied_tool_names(parent: &[String], child: Option<&[String]>) -> Vec<String> {
    let mut merged = parent.to_vec();
    merged.extend_from_slice(child.unwrap_or_default());
    normalized_strings(&merged)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    let value = value.trim();
    if !value.is_empty() && !values.iter().any(|known| known.trim() == value) {
        values.push(value.to_string());
    }
}

fn normalized_label(description: &str) -> String {
    let label = description.trim();
    if label.is_empty() {
        "subagent".into()
    } else {
        label.chars().take(120).collect()
    }
}

fn nested_subagent_prompt(depth: u8) -> String {
    let mut lines = vec![
        "## Nested subagent execution".to_string(),
        format!("- You are a spawned subagent at nesting depth {depth}."),
        "- The parent receives your final result; complete the assigned task directly and return concrete findings or changes.".into(),
        "- If you call `spawn_subagents`, wait for every result and inspect every returned status before continuing.".into(),
    ];
    if depth < MAX_SUBAGENT_NESTING_DEPTH {
        lines.push("- You may spawn one more layer only for clearly independent work; avoid recursive fan-out.".into());
    } else {
        lines.push("- Your nesting limit is reached. Do not try to spawn more subagents.".into());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;
    use std::sync::Mutex;
    use worldbase_providers::{
        ChatOptions, ChunkStream, LlmMessage, LlmTool, Provider, StreamChunk, TokenUsage,
    };

    #[derive(Default)]
    struct CapturingProvider {
        requests: Mutex<Vec<(String, String, Vec<String>)>>,
    }

    struct BlockingProvider {
        started: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl Provider for CapturingProvider {
        fn name(&self) -> &str {
            "subagent-capturing-test"
        }

        fn model(&self) -> &str {
            "subagent-capturing-model"
        }

        async fn chat_stream(
            &self,
            system: Option<&str>,
            messages: Vec<LlmMessage>,
            tools: Vec<LlmTool>,
            _max_tokens: u32,
            _options: ChatOptions,
        ) -> Result<ChunkStream> {
            let prompt = messages
                .iter()
                .rev()
                .find(|message| message.role == worldbase_providers::LlmRole::User)
                .map(LlmMessage::text_view)
                .unwrap_or_default();
            self.requests.lock().unwrap().push((
                prompt.clone(),
                system.unwrap_or_default().to_string(),
                tools.into_iter().map(|tool| tool.name).collect(),
            ));
            Ok(Box::pin(stream::iter([Ok(StreamChunk::Completed {
                stop_reason: "end_turn".into(),
                assistant: LlmMessage::text(
                    worldbase_providers::LlmRole::Assistant,
                    format!("completed {prompt}"),
                ),
                usage: TokenUsage {
                    input_tokens: 11,
                    output_tokens: 7,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
            })])))
        }
    }

    #[async_trait]
    impl Provider for BlockingProvider {
        fn name(&self) -> &str {
            "subagent-blocking-test"
        }

        fn model(&self) -> &str {
            "subagent-blocking-model"
        }

        async fn chat_stream(
            &self,
            _system: Option<&str>,
            _messages: Vec<LlmMessage>,
            _tools: Vec<LlmTool>,
            _max_tokens: u32,
            _options: ChatOptions,
        ) -> Result<ChunkStream> {
            self.started.notify_one();
            std::future::pending::<Result<ChunkStream>>().await
        }
    }

    #[test]
    fn child_allow_list_intersects_parent_without_widening() {
        let parent = vec!["read_file".into(), "grep".into()];
        assert_eq!(
            intersect_allowed_tool_names(&parent, Some(&["grep".into(), "write_file".into()])),
            vec!["grep"]
        );
        assert_eq!(
            intersect_allowed_tool_names(&parent, Some(&["write_file".into()])),
            vec![BLOCK_ALL_TOOLS_SENTINEL]
        );
        assert_eq!(intersect_allowed_tool_names(&parent, None), parent);
    }

    #[test]
    fn child_denies_are_merged_and_deduplicated() {
        assert_eq!(
            merge_denied_tool_names(
                &["execute_command".into(), " grep ".into()],
                Some(&["grep".into(), "write_file".into()]),
            ),
            vec!["execute_command", "grep", "write_file"]
        );
    }

    #[test]
    fn deepest_child_prompt_forbids_more_spawning() {
        let prompt = nested_subagent_prompt(MAX_SUBAGENT_NESTING_DEPTH);
        assert!(prompt.contains("nesting limit is reached"));
        assert!(!prompt.contains("spawn one more layer"));
    }

    #[tokio::test]
    async fn runtime_runs_isolated_children_in_input_order_with_narrowed_tools() {
        let workspace = std::env::temp_dir().join(format!(
            "worldbase-subagents-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Arc::new(
            worldbase_memory::Store::open(&workspace.join("app.sqlite"))
                .expect("open subagent test store"),
        );
        let hub = Hub::new(workspace.clone(), store).expect("create subagent test hub");
        let provider = Arc::new(CapturingProvider::default());
        hub.set_custom_provider(provider.clone());
        hub.register_stream("parent-stream");

        let runtime = CoreSubagentRuntime::new(
            hub.clone(),
            "parent-stream".into(),
            CancellationToken::new(),
            Capabilities::desktop(),
            false,
            None,
            None,
            None,
            ChatRunContext {
                allowed_tool_names: vec![
                    "read_file".into(),
                    "grep".into(),
                    "spawn_subagents".into(),
                ],
                ..Default::default()
            },
            None,
            0,
        );
        let response = runtime
            .run_parallel(SubagentRunRequest {
                parent_stream_id: "parent-stream".into(),
                tasks: vec![
                    SubagentTaskRequest {
                        description: "first".into(),
                        prompt: "alpha".into(),
                        allowed_tools: Some(vec!["read_file".into(), "write_file".into()]),
                        denied_tools: None,
                        system_prompt_sections: None,
                    },
                    SubagentTaskRequest {
                        description: "second".into(),
                        prompt: "beta".into(),
                        allowed_tools: Some(vec!["grep".into(), "spawn_subagents".into()]),
                        denied_tools: None,
                        system_prompt_sections: Some(vec!["Task-specific section".into()]),
                    },
                ],
            })
            .await
            .expect("run parallel subagents");

        assert_eq!(response.results.len(), 2);
        assert_eq!(response.results[0].description, "first");
        assert_eq!(response.results[0].result, "completed alpha");
        assert_eq!(response.results[1].description, "second");
        assert_eq!(response.results[1].result, "completed beta");
        assert!(response
            .results
            .iter()
            .all(|result| result.status == SubagentTaskStatus::Completed));

        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for (prompt, system, tools) in requests.iter() {
            assert!(system.contains("spawned subagent at nesting depth 1"));
            let tools: HashSet<_> = tools.iter().map(String::as_str).collect();
            match prompt.as_str() {
                "alpha" => {
                    assert!(tools.contains("read_file"));
                    assert!(!tools.contains("write_file"));
                    assert!(!tools.contains("grep"));
                    assert!(!tools.contains("spawn_subagents"));
                }
                "beta" => {
                    assert!(tools.contains("grep"));
                    assert!(tools.contains("spawn_subagents"));
                    assert!(!tools.contains("read_file"));
                    assert!(system.contains("Task-specific section"));
                }
                other => panic!("unexpected captured prompt: {other}"),
            }
        }
        drop(requests);

        let notices = hub
            .register_stream("parent-stream")
            .replay(-1)
            .await
            .into_iter()
            .filter(|frame| matches!(frame.kind, EventKind::Notice { .. }))
            .count();
        assert!(notices >= 6);
        let _ = std::fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn cancelling_parent_cancels_and_cleans_child_run() {
        let workspace = std::env::temp_dir().join(format!(
            "worldbase-subagent-cancel-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Arc::new(
            worldbase_memory::Store::open(&workspace.join("app.sqlite"))
                .expect("open subagent cancellation store"),
        );
        let hub = Hub::new(workspace.clone(), store).expect("create subagent cancellation hub");
        let started = Arc::new(tokio::sync::Notify::new());
        hub.set_custom_provider(Arc::new(BlockingProvider {
            started: started.clone(),
        }));
        hub.register_stream("cancel-parent");
        let parent_abort = CancellationToken::new();
        let runtime = Arc::new(CoreSubagentRuntime::new(
            hub.clone(),
            "cancel-parent".into(),
            parent_abort.clone(),
            Capabilities::desktop(),
            false,
            None,
            None,
            None,
            ChatRunContext::default(),
            None,
            0,
        ));
        let started_waiter = started.notified();
        let task = tokio::spawn(async move {
            runtime
                .run_parallel(SubagentRunRequest {
                    parent_stream_id: "cancel-parent".into(),
                    tasks: vec![SubagentTaskRequest {
                        description: "blocked child".into(),
                        prompt: "wait forever".into(),
                        allowed_tools: None,
                        denied_tools: None,
                        system_prompt_sections: None,
                    }],
                })
                .await
        });

        tokio::time::timeout(std::time::Duration::from_secs(2), started_waiter)
            .await
            .expect("child provider did not start");
        parent_abort.cancel();
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("subagent runtime did not observe parent cancellation")
            .expect("subagent runtime task panicked")
            .expect("batch should report task-level cancellation");
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].status, SubagentTaskStatus::Failed);
        assert!(response.results[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("parent agent was cancelled")));

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if hub
                    .runs
                    .lock()
                    .unwrap()
                    .keys()
                    .all(|stream_id| !stream_id.starts_with("cancel-parent:subagent:"))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled child run was not cleaned up");
        let _ = std::fs::remove_dir_all(workspace);
    }
}
