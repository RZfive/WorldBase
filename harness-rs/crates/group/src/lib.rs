//! 群组协作引擎：对齐桌面端 AgentGroupCollaborationMode 的 5 种模式 + 六字段黑板
//! + HITL 注入队列。纯状态机 + provider 调用，全端可用。

use anyhow::{bail, Context, Result};
use futures::future::join_all;
use futures::StreamExt;
use serde_json::{json, Value};
use std::future::Future;
use worldbase_protocol::types::{
    GroupBoard, GroupBoardTask, GroupMember, GroupMode, GroupRoundRecord, GroupSessionMeta,
    GroupUserInjection,
};
use worldbase_providers::{create_provider, ContentBlock, LlmMessage, LlmRole};

/// 发言回调：(member, content, round)。
pub type OnMessageFn<'a> = &'a mut (dyn FnMut(String, String, u32) + Send);
/// 黑板变更回调。
pub type OnBoardFn<'a> = &'a mut (dyn FnMut(&GroupBoard) + Send);

pub struct GroupEngine;

impl GroupEngine {
    pub const DEFAULT_MAX_PARALLEL_WORKERS: usize = 2;
    pub const MAX_PARALLEL_WORKERS: usize = 5;

    /// 创建会话。coordinator 缺省取第一个成员。
    pub fn create(
        topic: &str,
        mode: GroupMode,
        members: Vec<GroupMember>,
        coordinator: Option<String>,
    ) -> Result<GroupSessionMeta> {
        Self::create_with_max_parallel_workers(
            topic,
            mode,
            members,
            coordinator,
            Self::DEFAULT_MAX_PARALLEL_WORKERS,
        )
    }

    /// Create a session with the Electron-configured member concurrency cap.
    /// The cap is normalized here because this crate is also callable without
    /// Electron's settings-store validation.
    pub fn create_with_max_parallel_workers(
        topic: &str,
        mode: GroupMode,
        members: Vec<GroupMember>,
        coordinator: Option<String>,
        max_parallel_workers: usize,
    ) -> Result<GroupSessionMeta> {
        if members.len() < 2 {
            bail!("group session requires at least 2 members");
        }
        let coord = coordinator.or_else(|| members.first().map(|m| m.name.clone()));
        Ok(GroupSessionMeta {
            id: uuid::Uuid::new_v4().to_string(),
            topic: topic.into(),
            mode,
            members,
            created_at: worldbase_protocol::event::now_rfc3339(),
            status: "open".into(),
            board: GroupBoard::default(),
            board_updates: vec![],
            rounds: vec![],
            coordinator: coord,
            max_parallel_workers: max_parallel_workers.clamp(1, Self::MAX_PARALLEL_WORKERS),
            pending_injections: vec![],
            active_member_ids: vec![],
        })
    }

    /// 从用户输入解析 @提及的成员名。
    pub fn parse_mentions<'a>(input: &str, members: &'a [GroupMember]) -> Vec<String> {
        members
            .iter()
            .filter(|m| input.contains(&format!("@{}", m.name)))
            .map(|m| m.name.clone())
            .collect()
    }

    /// 按模式决定本轮发言顺序。
    pub fn route_speakers(session: &GroupSessionMeta, user_input: &str) -> Vec<String> {
        let mentioned = Self::parse_mentions(user_input, &session.members);
        let coord = session.coordinator.clone().unwrap_or_default();
        match session.mode {
            GroupMode::CoordinatorOnly => vec![coord],
            GroupMode::Targeted => {
                if mentioned.is_empty() {
                    vec![coord]
                } else {
                    mentioned
                }
            }
            GroupMode::Discussion => session.members.iter().map(|m| m.name.clone()).collect(),
            GroupMode::CoordinatorDecides => {
                // 协调者先发言规划；随后被协调者@到的成员跟进，未@则全员。
                let mut order = vec![coord.clone()];
                order.extend(mentioned.into_iter().filter(|m| *m != coord));
                order
            }
            GroupMode::MentionedAgentDecides => {
                if mentioned.is_empty() {
                    vec![coord]
                } else {
                    mentioned
                }
            }
        }
    }

    /// 运行一轮讨论。`on_board` 在黑板变更后回调。
    pub async fn run_round(
        session: &mut GroupSessionMeta,
        user_input: &str,
        round: u32,
        on_message: OnMessageFn<'_>,
        on_board: OnBoardFn<'_>,
    ) -> Result<usize> {
        Self::run_round_for_members(session, user_input, round, None, on_message, on_board).await
    }

    /// Run one round for an explicit Electron-selected member subset.  The
    /// desktop route has already resolved mentions and coordinator planning,
    /// so preserving that selection lets Rust own execution without silently
    /// changing the user's group-routing intent.
    pub async fn run_round_for_members(
        session: &mut GroupSessionMeta,
        user_input: &str,
        round: u32,
        selected_members: Option<&[String]>,
        on_message: OnMessageFn<'_>,
        on_board: OnBoardFn<'_>,
    ) -> Result<usize> {
        Self::run_round_with_executor(
            session,
            user_input,
            round,
            selected_members,
            |member, prompt| async move { run_member_provider(&member, &prompt).await },
            on_message,
            on_board,
        )
        .await
    }

    /// Execute a round with a caller-provided member runner. The core harness
    /// uses this to route Electron members through Rust's full agent/tool loop
    /// while the standalone group crate retains its provider-only fallback.
    pub async fn run_round_with_executor<F, Fut>(
        session: &mut GroupSessionMeta,
        user_input: &str,
        round: u32,
        selected_members: Option<&[String]>,
        execute_member: F,
        on_message: OnMessageFn<'_>,
        on_board: OnBoardFn<'_>,
    ) -> Result<usize>
    where
        F: FnMut(GroupMember, String) -> Fut,
        Fut: Future<Output = Result<String>>,
    {
        Self::run_round_with_executor_and_hook(
            session,
            user_input,
            round,
            selected_members,
            execute_member,
            |_session, _member| {},
            true,
            on_message,
            on_board,
        )
        .await
    }

    /// Native group execution can synchronize a Rust-owned live session just
    /// before every member starts. This keeps board writes and HITL injections
    /// that arrive while a previous member is running visible to the next
    /// member without letting a stale local executor overwrite them.
    pub async fn run_round_with_executor_and_hook<F, Fut, H>(
        session: &mut GroupSessionMeta,
        user_input: &str,
        round: u32,
        selected_members: Option<&[String]>,
        execute_member: F,
        before_member: H,
        apply_inline_board_directives: bool,
        on_message: OnMessageFn<'_>,
        on_board: OnBoardFn<'_>,
    ) -> Result<usize>
    where
        F: FnMut(GroupMember, String) -> Fut,
        Fut: Future<Output = Result<String>>,
        H: FnMut(&mut GroupSessionMeta, &GroupMember),
    {
        Self::run_round_with_executor_batched_and_hook(
            session,
            user_input,
            round,
            selected_members,
            1,
            execute_member,
            before_member,
            apply_inline_board_directives,
            on_message,
            on_board,
        )
        .await
    }

    /// Execute selected members in stable batches. The limit is applied in
    /// Rust, after Electron has selected participants, so the selected Rust
    /// harness owns the group scheduler rather than delegating it back to TS.
    ///
    /// The hook still runs before each member prompt is assembled. That lets a
    /// native session merge board writes and HITL injections that arrived
    /// between batches before launching the next set of member runs.
    pub async fn run_round_with_executor_batched_and_hook<F, Fut, H>(
        session: &mut GroupSessionMeta,
        user_input: &str,
        round: u32,
        selected_members: Option<&[String]>,
        max_parallel_workers: usize,
        mut execute_member: F,
        mut before_member: H,
        apply_inline_board_directives: bool,
        on_message: OnMessageFn<'_>,
        on_board: OnBoardFn<'_>,
    ) -> Result<usize>
    where
        F: FnMut(GroupMember, String) -> Fut,
        Fut: Future<Output = Result<String>>,
        H: FnMut(&mut GroupSessionMeta, &GroupMember),
    {
        let speakers = Self::resolve_speakers(session, user_input, selected_members);
        let speaker_keys: Vec<String> = speakers.iter().map(member_delivery_key).collect();
        let mut count = 0;
        let mut first_failure = None;
        // An injection is addressed to every selected recipient, rather than
        // being consumed by the first member that happens to run. Keep the
        // original records through the round so broadcast and multi-target
        // clarifications can be rendered into each matching member prompt.
        let mut pending_injections = std::mem::take(&mut session.pending_injections);
        let parallelism = max_parallel_workers.clamp(1, Self::MAX_PARALLEL_WORKERS);
        for batch in speakers.chunks(parallelism) {
            let mut runs = Vec::with_capacity(batch.len());
            for member in batch {
                before_member(session, member);
                // A native injection may have arrived while the previous
                // batch was executing. Keep it alongside the local queue and
                // retain delivery acknowledgements for final reconciliation.
                pending_injections.append(&mut session.pending_injections);
                let member_key = member_delivery_key(member);
                // Targeted clarifications only go to their durable Electron
                // member IDs. An empty target list is a broadcast to every
                // member selected for this round.
                let injection_text: Vec<String> = pending_injections
                    .iter_mut()
                    .filter_map(|injection| {
                        let addressed = injection.target_agent_ids.is_empty()
                            || member.agent_id.as_deref().is_some_and(|agent_id| {
                                injection
                                    .target_agent_ids
                                    .iter()
                                    .any(|target| target == agent_id)
                            });
                        if !addressed || injection.delivered_to_agent_ids.contains(&member_key) {
                            return None;
                        }
                        injection.delivered_to_agent_ids.push(member_key.clone());
                        Some(injection.content.clone())
                    })
                    .collect();
                let prompt = build_prompt(
                    session,
                    member,
                    user_input,
                    &injection_text,
                    apply_inline_board_directives,
                );
                let execution = execute_member(member.clone(), prompt);
                let member = member.clone();
                runs.push(async move { execution.await.map(|content| (member, content)) });
            }

            let results = join_all(runs).await;
            let mut completed = Vec::with_capacity(results.len());
            for result in results {
                match result {
                    Ok(completion) => completed.push(completion),
                    Err(error) if first_failure.is_none() => first_failure = Some(error),
                    Err(_) => {}
                }
            }

            for (member, content) in completed {
                // Provider-only sessions retain the legacy text directive.
                // Native Rust members use the structured update_board tool
                // instead so a local execution snapshot cannot clobber a
                // live board write.
                let visible_content = if apply_inline_board_directives {
                    apply_board_directives(session, &content)
                } else {
                    Self::sanitize_member_output(&content)
                };
                on_board(&session.board);
                count += 1;
                if visible_content.is_empty() {
                    continue;
                }
                session.rounds.push(GroupRoundRecord {
                    member: member.name.clone(),
                    content: visible_content.clone(),
                    round,
                    created_at: worldbase_protocol::event::now_rfc3339(),
                });
                on_message(member.name, visible_content, round);
            }
        }

        // Retain recipients that have not actually consumed this injection.
        // In particular, a clarification that arrives after a target's prompt
        // was built remains queued for the next round instead of disappearing.
        session.pending_injections = pending_injections
            .into_iter()
            .filter(|injection| {
                if injection.target_agent_ids.is_empty() {
                    return speaker_keys
                        .iter()
                        .any(|member_id| !injection.delivered_to_agent_ids.contains(member_id));
                }
                injection
                    .target_agent_ids
                    .iter()
                    .any(|agent_id| !injection.delivered_to_agent_ids.contains(agent_id))
            })
            .collect();
        match (count, first_failure) {
            (0, Some(error)) => Err(error),
            _ => Ok(count),
        }
    }

    /// Remove legacy inline board directives from user-visible member text.
    /// Board state is surfaced separately through `BoardUpdate` events.
    pub fn sanitize_member_output(content: &str) -> String {
        let mut visible = Vec::new();
        let mut in_board_snapshot = false;
        for line in content.lines() {
            if board_directive(line).is_some() {
                continue;
            }
            let normalized = normalized_markdown_line(line);
            if is_board_snapshot_heading(normalized) {
                in_board_snapshot = true;
                continue;
            }
            if in_board_snapshot {
                if normalized.is_empty()
                    || is_board_field_line(normalized)
                    || is_board_task_detail(normalized)
                {
                    continue;
                }
                in_board_snapshot = false;
            }
            if is_compact_board_list_line(normalized) {
                continue;
            }
            visible.push(line);
        }
        visible.join("\n").trim().to_string()
    }

    /// Resolve Electron-selected durable IDs or member names into the actual
    /// group members that will run in this round.
    pub fn resolve_speakers(
        session: &GroupSessionMeta,
        user_input: &str,
        selected_members: Option<&[String]>,
    ) -> Vec<GroupMember> {
        let names = selected_members
            .filter(|members| !members.is_empty())
            .map(|members| {
                members
                    .iter()
                    .filter_map(|selected| {
                        session
                            .members
                            .iter()
                            .find(|member| {
                                member.name == *selected
                                    || member.agent_id.as_deref() == Some(selected.as_str())
                            })
                            .map(|member| member.name.clone())
                    })
                    .collect()
            })
            .unwrap_or_else(|| Self::route_speakers(session, user_input));
        names
            .into_iter()
            .filter_map(|name| {
                session
                    .members
                    .iter()
                    .find(|member| member.name == name)
                    .cloned()
            })
            .collect()
    }

    /// 黑板字段更新（op: set/add/remove）。
    pub fn board_update(
        session: &mut GroupSessionMeta,
        field: &str,
        op: &str,
        value: &str,
    ) -> Result<()> {
        let payload = if field == "tasks" && op == "add" {
            json!({ "id": uuid::Uuid::new_v4().to_string(), "title": value, "status": "todo" })
        } else if field == "tasks" && op == "set" {
            json!([{
                "id": uuid::Uuid::new_v4().to_string(),
                "title": value,
                "status": "todo"
            }])
        } else if op == "set" && field != "goal" {
            // The pre-structured Rust RPC accepted one string for list-set.
            // Keep that compact legacy spelling while the new tool accepts a
            // full array payload.
            json!([value])
        } else {
            json!(value)
        };
        Self::board_update_value(session, field, op, payload)
    }

    /// Apply Electron's structured board payload without losing task metadata.
    pub fn board_update_value(
        session: &mut GroupSessionMeta,
        field: &str,
        op: &str,
        payload: Value,
    ) -> Result<()> {
        let field = canonical_board_field(field)?;
        if field == "goal" {
            if op == "set" {
                let value = payload
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("goal set payload must be a string"))?;
                session.board.goal = value.to_string();
                return Ok(());
            }
            bail!("goal only supports set");
        }
        if field == "tasks" {
            return apply_task_update(&mut session.board.tasks, op, payload);
        }
        let list = match field {
            "assumptions" => &mut session.board.assumptions,
            "decisions" => &mut session.board.decisions,
            "evidenceRefs" => &mut session.board.evidence_refs,
            "openQuestions" => &mut session.board.open_questions,
            _ => unreachable!("canonical_board_field only returns known fields"),
        };
        match op {
            "set" => {
                let values = payload
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("{field} set payload must be a string array"))?;
                list.clear();
                list.extend(
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned),
                );
            }
            "add" => {
                let value = payload
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("{field} add payload must be a string"))?;
                if !list.iter().any(|known| known == value) {
                    list.push(value.to_string());
                }
            }
            "remove" => {
                let value = payload
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("{field} remove payload must be a string"))?;
                list.retain(|known| known != value);
            }
            other => bail!("unknown board op: {other}"),
        }
        Ok(())
    }

    /// HITL 注入：入队，下一轮发言时进入上下文。
    pub fn inject(session: &mut GroupSessionMeta, content: &str, target_agent_ids: Vec<String>) {
        session.pending_injections.push(GroupUserInjection {
            id: uuid::Uuid::new_v4().to_string(),
            content: content.to_string(),
            target_agent_ids,
            round: 0,
            created_at: worldbase_protocol::event::now_rfc3339(),
            delivered_to_agent_ids: vec![],
        });
    }
}

fn member_delivery_key(member: &GroupMember) -> String {
    member
        .agent_id
        .as_deref()
        .filter(|agent_id| !agent_id.trim().is_empty())
        .unwrap_or(&member.name)
        .to_string()
}

fn canonical_board_field(field: &str) -> Result<&str> {
    match field {
        "goal" | "assumptions" | "tasks" | "decisions" => Ok(field),
        "evidenceRefs" | "evidence_refs" => Ok("evidenceRefs"),
        "openQuestions" | "open_questions" => Ok("openQuestions"),
        other => bail!("unknown board field: {other}"),
    }
}

fn normalize_task(payload: Value) -> Result<GroupBoardTask> {
    let payload = payload
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("task payload must be an object"))?;
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| anyhow::anyhow!("task title is required"))?;
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .unwrap_or("todo");
    if !matches!(status, "todo" | "running" | "blocked" | "done") {
        bail!("invalid task status: {status}");
    }
    let owner_agent_id = payload
        .get("ownerAgentId")
        .or_else(|| payload.get("owner_agent_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|owner| !owner.is_empty())
        .map(ToOwned::to_owned);
    let summary = payload
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(ToOwned::to_owned);
    Ok(GroupBoardTask {
        id,
        title: title.to_string(),
        owner_agent_id,
        status: status.to_string(),
        summary,
    })
}

fn apply_task_update(tasks: &mut Vec<GroupBoardTask>, op: &str, payload: Value) -> Result<()> {
    match op {
        "set" => {
            let values = payload
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("tasks set payload must be an array"))?;
            *tasks = values
                .iter()
                .cloned()
                .map(normalize_task)
                .collect::<Result<Vec<_>>>()?;
        }
        "add" => {
            let task = normalize_task(payload)?;
            if !tasks
                .iter()
                .any(|known| known.id == task.id || known.title == task.title)
            {
                tasks.push(task);
            }
        }
        "update" => {
            let payload = payload
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("tasks update payload must be an object"))?;
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("tasks update payload requires id"))?;
            if let Some(existing) = tasks.iter_mut().find(|task| task.id == id) {
                if let Some(title) = payload.get("title").and_then(Value::as_str) {
                    let title = title.trim();
                    if !title.is_empty() {
                        existing.title = title.to_string();
                    }
                }
                if let Some(owner_agent_id) = payload.get("ownerAgentId") {
                    existing.owner_agent_id = owner_agent_id.as_str().map(ToOwned::to_owned);
                }
                if let Some(status) = payload.get("status").and_then(Value::as_str) {
                    if !matches!(status, "todo" | "running" | "blocked" | "done") {
                        bail!("invalid task status: {status}");
                    }
                    existing.status = status.to_string();
                }
                if let Some(summary) = payload.get("summary") {
                    existing.summary = summary.as_str().map(ToOwned::to_owned);
                }
            }
        }
        "remove" => {
            let key = payload.as_str().ok_or_else(|| {
                anyhow::anyhow!("tasks remove payload must be a task id or title")
            })?;
            tasks.retain(|task| task.id != key && task.title != key);
        }
        other => bail!("unknown board op: {other}"),
    }
    Ok(())
}

fn build_prompt(
    session: &GroupSessionMeta,
    member: &GroupMember,
    user_input: &str,
    injections: &[String],
    allow_inline_board_directives: bool,
) -> String {
    let others: String = session
        .members
        .iter()
        .filter(|m| m.name != member.name)
        .map(|m| format!("- @{}\n", m.name))
        .collect();
    let recent: Vec<String> = session
        .rounds
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|r| format!("[@{} 第{}轮] {}", r.member, r.round, r.content))
        .collect();

    let mode_hint = match session.mode {
        GroupMode::CoordinatorOnly => "你是协调者：汇总规划、给结论，不闲聊。",
        GroupMode::Targeted => "你被用户点名：直接回应，可用 @其他成员 咨询。",
        GroupMode::Discussion => "全员讨论：补充前人未覆盖的观点，可用 @点名 回应。",
        GroupMode::CoordinatorDecides => {
            "你是协调者或被协调者点名的成员：协调者先规划，成员按分工执行。"
        }
        GroupMode::MentionedAgentDecides => "你被点名：自行判断是否需要 @拉入其他成员。",
    };

    let board = format!(
        "目标:{}\n假设:[{}]\n任务:[{}]\n决策:[{}]\n证据:[{}]\n待解问题:[{}]",
        session.board.goal,
        session.board.assumptions.join("; "),
        session
            .board
            .tasks
            .iter()
            .map(|task| {
                let owner = task
                    .owner_agent_id
                    .as_deref()
                    .filter(|owner| !owner.trim().is_empty())
                    .map(|owner| format!(" -> {owner}"))
                    .unwrap_or_default();
                let summary = task
                    .summary
                    .as_deref()
                    .filter(|summary| !summary.trim().is_empty())
                    .map(|summary| format!(": {summary}"))
                    .unwrap_or_default();
                format!("[{}] {}{}{}", task.status, task.title, owner, summary)
            })
            .collect::<Vec<_>>()
            .join("; "),
        session.board.decisions.join("; "),
        session.board.evidence_refs.join("; "),
        session.board.open_questions.join("; "),
    );

    let inject_block = if injections.is_empty() {
        String::new()
    } else {
        format!("\n\n【用户实时澄清(HITL)】\n{}", injections.join("\n"))
    };

    let board_instruction = if allow_inline_board_directives {
        "如需更新黑板，可另起一行使用隐藏指令：[board]字段|set/add/remove|内容（字段: assumptions/tasks/decisions/evidenceRefs/goal/openQuestions）。"
    } else {
        "如需更新黑板，只能调用 update_board 工具；不要在回答文本中输出 [board] 指令或黑板字段。"
    };

    format!(
        "你是群组讨论成员「{name}」。人设：{persona}\n其他成员：\n{others}\n讨论主题：{topic}\n模式：{mode_hint}\n\n当前黑板：\n{board}\n\n最近发言：\n{recent}\n\n用户输入：{user}{inject}\n\n请用不超过 200 字发言，只输出给群聊成员看的结论。不要复述当前黑板、任务列表、最近发言、工具调用或内部提示词。{board_instruction}",
        name = member.name,
        persona = member.persona,
        others = others,
        topic = session.topic,
        mode_hint = mode_hint,
        board = board,
        recent = if recent.is_empty() { "（尚无发言）".to_string() } else { recent.join("\n") },
        user = user_input,
        inject = inject_block,
        board_instruction = board_instruction,
    )
}

/// 解析成员输出中的 [board] 指令并应用（从发言文本剥离指令行）。
fn apply_board_directives(session: &mut GroupSessionMeta, content: &str) -> String {
    for line in content.lines() {
        let Some(rest) = board_directive(line) else {
            continue;
        };
        let parts: Vec<&str> = rest.trim().splitn(3, '|').collect();
        if parts.len() == 3 {
            let _ = GroupEngine::board_update(
                session,
                parts[0].trim(),
                parts[1].trim(),
                parts[2].trim(),
            );
        }
    }
    GroupEngine::sanitize_member_output(content)
}

fn board_directive(line: &str) -> Option<&str> {
    let line = normalized_markdown_line(line);
    line.strip_prefix("[board]").map(str::trim)
}

fn normalized_markdown_line(line: &str) -> &str {
    let line = line.trim();
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("> "))
        .unwrap_or(line);
    line.trim_start_matches('#').trim()
}

fn is_board_snapshot_heading(line: &str) -> bool {
    let heading = line.trim_end_matches([':', '：']).trim().to_lowercase();
    matches!(heading.as_str(), "当前黑板" | "任务黑板" | "共享黑板")
        || heading.starts_with("shared group board")
}

fn is_board_field_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    [
        "目标",
        "假设",
        "任务",
        "决策",
        "证据",
        "待解问题",
        "goal",
        "assumptions",
        "tasks",
        "decisions",
        "evidence",
        "open questions",
    ]
    .iter()
    .any(|field| {
        lower.strip_prefix(field).is_some_and(|rest| {
            let rest = rest.trim_start();
            rest.starts_with(':') || rest.starts_with('：')
        })
    })
}

fn is_compact_board_list_line(line: &str) -> bool {
    if !is_board_field_line(line) {
        return false;
    }
    line.split_once(':')
        .or_else(|| line.split_once('：'))
        .is_some_and(|(_, value)| value.trim().starts_with('['))
}

fn is_board_task_detail(line: &str) -> bool {
    let line = line.trim_start_matches('·').trim();
    ["todo", "running", "blocked", "done"]
        .iter()
        .any(|status| line.to_lowercase().starts_with(&format!("[{status}]")))
}

/// Provider-only fallback used by clients that do not supply a native agent
/// runner. Electron's Rust route uses run_round_with_executor instead.
pub async fn run_member_provider(member: &GroupMember, prompt: &str) -> Result<String> {
    let cfg = member.provider.clone().unwrap_or_default();
    let provider = create_provider(&cfg).context("create member provider")?;
    let mut stream = provider
        .chat_stream(
            Some("你是群组协作中的成员，发言精炼、有观点。"),
            vec![LlmMessage {
                role: LlmRole::User,
                content: vec![ContentBlock::Text {
                    text: prompt.to_string(),
                }],
            }],
            vec![],
            1024,
            worldbase_providers::ChatOptions::default(),
        )
        .await?;
    let mut text = String::new();
    while let Some(chunk) = stream.next().await {
        match chunk? {
            worldbase_providers::StreamChunk::TextDelta(t) => text.push_str(&t),
            worldbase_providers::StreamChunk::Completed { assistant, .. } => {
                let full = assistant.text_view();
                if !full.is_empty() {
                    text = full;
                }
                break;
            }
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use worldbase_protocol::types::ProviderConfig;

    fn members() -> Vec<GroupMember> {
        vec![
            GroupMember {
                name: "协调者".into(),
                persona: "统筹".into(),
                agent_id: None,
                allowed_tool_names: vec![],
                denied_tool_names: vec![],
                provider: Some(ProviderConfig::default()),
            },
            GroupMember {
                name: "工程师".into(),
                persona: "实现".into(),
                agent_id: None,
                allowed_tool_names: vec![],
                denied_tool_names: vec![],
                provider: Some(ProviderConfig::default()),
            },
            GroupMember {
                name: "评审".into(),
                persona: "挑刺".into(),
                agent_id: None,
                allowed_tool_names: vec![],
                denied_tool_names: vec![],
                provider: Some(ProviderConfig::default()),
            },
        ]
    }

    #[test]
    fn create_with_coordinator() {
        let session = GroupEngine::create("选型", GroupMode::Discussion, members(), None).unwrap();
        assert_eq!(session.coordinator.as_deref(), Some("协调者"));
        assert!(session.board.goal.is_empty());

        let one = vec![members().remove(0)];
        assert!(GroupEngine::create("t", GroupMode::Discussion, one, None).is_err());
    }

    #[test]
    fn routing_per_mode() {
        let mut session = GroupEngine::create("t", GroupMode::Discussion, members(), None).unwrap();
        assert_eq!(GroupEngine::route_speakers(&session, "开始").len(), 3);

        session.mode = GroupMode::CoordinatorOnly;
        assert_eq!(
            GroupEngine::route_speakers(&session, "开始"),
            vec!["协调者".to_string()]
        );

        session.mode = GroupMode::Targeted;
        assert_eq!(
            GroupEngine::route_speakers(&session, "@工程师 看看"),
            vec!["工程师".to_string()]
        );

        session.mode = GroupMode::CoordinatorDecides;
        let order = GroupEngine::route_speakers(&session, "@评审 @工程师");
        assert_eq!(order.first().unwrap(), "协调者");
        assert!(order.contains(&"评审".to_string()));

        session.mode = GroupMode::MentionedAgentDecides;
        assert_eq!(
            GroupEngine::route_speakers(&session, "@评审 请把脉"),
            vec!["评审".to_string()]
        );
    }

    #[test]
    fn board_update_ops() {
        let mut session = GroupEngine::create("t", GroupMode::Discussion, members(), None).unwrap();
        GroupEngine::board_update(&mut session, "goal", "set", "交付 v1").unwrap();
        assert_eq!(session.board.goal, "交付 v1");
        GroupEngine::board_update(&mut session, "tasks", "add", "迁移协议层").unwrap();
        GroupEngine::board_update(&mut session, "tasks", "add", "迁移协议层").unwrap();
        assert_eq!(session.board.tasks.len(), 1);
        GroupEngine::board_update(&mut session, "tasks", "remove", "迁移协议层").unwrap();
        assert!(session.board.tasks.is_empty());
        assert!(GroupEngine::board_update(&mut session, "nope", "add", "x").is_err());
    }

    #[test]
    fn structured_task_updates_preserve_owner_and_lifecycle() {
        let mut session = GroupEngine::create("t", GroupMode::Discussion, members(), None).unwrap();
        GroupEngine::board_update_value(
            &mut session,
            "tasks",
            "add",
            json!({
                "id": "task-rust",
                "title": "Move group tools into Rust",
                "ownerAgentId": "engineer",
                "status": "running",
                "summary": "Runtime trait is wired"
            }),
        )
        .unwrap();
        GroupEngine::board_update_value(
            &mut session,
            "tasks",
            "update",
            json!({ "id": "task-rust", "status": "done" }),
        )
        .unwrap();

        assert_eq!(session.board.tasks.len(), 1);
        let task = &session.board.tasks[0];
        assert_eq!(task.owner_agent_id.as_deref(), Some("engineer"));
        assert_eq!(task.status, "done");
        assert_eq!(task.summary.as_deref(), Some("Runtime trait is wired"));

        GroupEngine::board_update_value(
            &mut session,
            "tasks",
            "add",
            json!({ "title": "Generated task id" }),
        )
        .unwrap();
        assert!(!session.board.tasks[1].id.is_empty());
        assert_eq!(session.board.tasks[1].status, "todo");
    }

    #[test]
    fn parses_board_directives_from_output() {
        let mut session = GroupEngine::create("t", GroupMode::Discussion, members(), None).unwrap();
        let visible = apply_board_directives(
            &mut session,
            "我的发言\n[board] goal|set|共识：Rust\n[board] decisions|add|用 FFI 桥",
        );
        assert_eq!(session.board.goal, "共识：Rust");
        assert_eq!(session.board.decisions, vec!["用 FFI 桥".to_string()]);
        assert_eq!(visible, "我的发言");
    }

    #[test]
    fn native_prompt_uses_tools_without_exposing_board_directives() {
        let session = GroupEngine::create("t", GroupMode::Discussion, members(), None).unwrap();
        let prompt = build_prompt(&session, &session.members[0], "开始", &[], false);

        assert!(prompt.contains("不要复述当前黑板"));
        assert!(prompt.contains("只能调用 update_board 工具"));
        assert!(!prompt.contains("可另起一行使用隐藏指令"));
    }

    #[tokio::test]
    async fn run_round_with_mock_and_inject() {
        let mut session =
            GroupEngine::create("选型", GroupMode::Discussion, members(), None).unwrap();
        GroupEngine::inject(&mut session, "补充：预算只有两周", vec![]);
        let collected = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = collected.clone();
        let mut on_board = |_b: &GroupBoard| {};
        let n = GroupEngine::run_round(
            &mut session,
            "评估方案",
            1,
            &mut |member, content, round| {
                sink.lock().unwrap().push((member, content, round));
            },
            &mut on_board,
        )
        .await
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(session.rounds.len(), 3);
        assert_eq!(collected.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn batched_executor_observes_parallel_worker_limit() {
        let mut session = GroupEngine::create_with_max_parallel_workers(
            "parallel scheduling",
            GroupMode::Discussion,
            members(),
            None,
            2,
        )
        .unwrap();
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let max_parallel_workers = session.max_parallel_workers;
        let mut on_message = |_member: String, _content: String, _round: u32| {};
        let mut on_board = |_board: &GroupBoard| {};

        let count = GroupEngine::run_round_with_executor_batched_and_hook(
            &mut session,
            "Review the implementation.",
            1,
            None,
            max_parallel_workers,
            {
                let running = running.clone();
                let peak = peak.clone();
                move |member, _prompt| {
                    let running = running.clone();
                    let peak = peak.clone();
                    async move {
                        let current = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        running.fetch_sub(1, Ordering::SeqCst);
                        Ok(format!("{} completed", member.name))
                    }
                }
            },
            |_session, _member| {},
            true,
            &mut on_message,
            &mut on_board,
        )
        .await
        .unwrap();

        assert_eq!(count, 3);
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(session.max_parallel_workers, 2);
    }

    #[tokio::test]
    async fn successful_members_are_kept_when_another_member_fails() {
        let mut session =
            GroupEngine::create("partial failure", GroupMode::Discussion, members(), None).unwrap();
        let collected = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = collected.clone();
        let mut on_message = move |member: String, content: String, _round: u32| {
            sink.lock().unwrap().push((member, content));
        };
        let mut on_board = |_board: &GroupBoard| {};

        let count = GroupEngine::run_round_with_executor(
            &mut session,
            "Review",
            1,
            None,
            |member, _prompt| async move {
                if member.name == "工程师" {
                    bail!("provider unavailable");
                }
                Ok(format!("{} completed", member.name))
            },
            &mut on_message,
            &mut on_board,
        )
        .await
        .unwrap();

        assert_eq!(count, 2);
        assert_eq!(session.rounds.len(), 2);
        assert_eq!(collected.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn inline_board_updates_never_reach_member_messages() {
        let mut session =
            GroupEngine::create("board privacy", GroupMode::Discussion, members(), None).unwrap();
        let collected = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = collected.clone();
        let mut on_message = move |_member: String, content: String, _round: u32| {
            sink.lock().unwrap().push(content);
        };
        let mut on_board = |_board: &GroupBoard| {};

        GroupEngine::run_round_with_executor(
            &mut session,
            "Review",
            1,
            None,
            |member, _prompt| async move {
                Ok(format!(
                    "{} result\n[board] tasks|add|internal progress",
                    member.name
                ))
            },
            &mut on_message,
            &mut on_board,
        )
        .await
        .unwrap();

        assert_eq!(session.board.tasks.len(), 1);
        assert!(session
            .rounds
            .iter()
            .all(|record| !record.content.contains("[board]")));
        assert!(collected
            .lock()
            .unwrap()
            .iter()
            .all(|content| !content.contains("[board]")));
    }

    #[tokio::test]
    async fn round_fails_when_every_selected_member_fails() {
        let mut session =
            GroupEngine::create("total failure", GroupMode::Discussion, members(), None).unwrap();
        let mut on_message = |_member: String, _content: String, _round: u32| {};
        let mut on_board = |_board: &GroupBoard| {};

        let result = GroupEngine::run_round_with_executor(
            &mut session,
            "Review",
            1,
            None,
            |_member, _prompt| async move { bail!("provider unavailable") },
            &mut on_message,
            &mut on_board,
        )
        .await;

        assert!(result.is_err());
        assert!(session.rounds.is_empty());
    }

    #[tokio::test]
    async fn targeted_injection_is_only_visible_to_its_member() {
        let mut configured = members();
        configured[0].agent_id = Some("coordinator".into());
        configured[1].agent_id = Some("engineer".into());
        configured[2].agent_id = Some("reviewer".into());
        let mut session =
            GroupEngine::create("targeted", GroupMode::Discussion, configured, None).unwrap();
        GroupEngine::inject(
            &mut session,
            "Only the engineer should see this clarification.",
            vec!["engineer".into()],
        );
        let selected = vec!["coordinator".to_string(), "engineer".to_string()];
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = observed.clone();
        let mut on_message = |_member: String, _content: String, _round: u32| {};
        let mut on_board = |_board: &GroupBoard| {};

        GroupEngine::run_round_with_executor(
            &mut session,
            "Review the route.",
            1,
            Some(&selected),
            move |member, prompt| {
                let sink = sink.clone();
                async move {
                    sink.lock().unwrap().push((member.agent_id, prompt));
                    Ok("done".to_string())
                }
            },
            &mut on_message,
            &mut on_board,
        )
        .await
        .unwrap();

        let observed = observed.lock().unwrap();
        let coordinator_prompt = observed
            .iter()
            .find(|(id, _)| id.as_deref() == Some("coordinator"))
            .map(|(_, prompt)| prompt)
            .unwrap();
        let engineer_prompt = observed
            .iter()
            .find(|(id, _)| id.as_deref() == Some("engineer"))
            .map(|(_, prompt)| prompt)
            .unwrap();
        assert!(!coordinator_prompt.contains("Only the engineer"));
        assert!(engineer_prompt.contains("Only the engineer"));
        assert!(session.pending_injections.is_empty());
    }

    #[tokio::test]
    async fn broadcast_injection_reaches_every_selected_member() {
        let mut configured = members();
        configured[0].agent_id = Some("coordinator".into());
        configured[1].agent_id = Some("engineer".into());
        configured[2].agent_id = Some("reviewer".into());
        let mut session =
            GroupEngine::create("broadcast", GroupMode::Discussion, configured, None).unwrap();
        GroupEngine::inject(
            &mut session,
            "All selected members must account for the revised budget.",
            vec![],
        );
        let selected = vec!["coordinator".to_string(), "engineer".to_string()];
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = observed.clone();
        let mut on_message = |_member: String, _content: String, _round: u32| {};
        let mut on_board = |_board: &GroupBoard| {};

        GroupEngine::run_round_with_executor(
            &mut session,
            "Review the route.",
            1,
            Some(&selected),
            move |member, prompt| {
                let sink = sink.clone();
                async move {
                    sink.lock().unwrap().push((member.agent_id, prompt));
                    Ok("done".to_string())
                }
            },
            &mut on_message,
            &mut on_board,
        )
        .await
        .unwrap();

        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 2);
        for (_, prompt) in observed.iter() {
            assert!(prompt.contains("All selected members must account for the revised budget."));
        }
        assert!(session.pending_injections.is_empty());
    }

    #[tokio::test]
    async fn hook_delivers_an_injection_that_arrives_between_member_turns() {
        let mut configured = members();
        configured[0].agent_id = Some("coordinator".into());
        configured[1].agent_id = Some("engineer".into());
        configured[2].agent_id = Some("reviewer".into());
        let mut session =
            GroupEngine::create("live injection", GroupMode::Discussion, configured, None).unwrap();
        let selected = vec!["coordinator".to_string(), "engineer".to_string()];
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = observed.clone();
        let mut on_message = |_member: String, _content: String, _round: u32| {};
        let mut on_board = |_board: &GroupBoard| {};

        GroupEngine::run_round_with_executor_and_hook(
            &mut session,
            "Review the route.",
            1,
            Some(&selected),
            move |member, prompt| {
                let sink = sink.clone();
                async move {
                    sink.lock().unwrap().push((member.agent_id, prompt));
                    Ok("done".to_string())
                }
            },
            |session, member| {
                if member.agent_id.as_deref() == Some("engineer") {
                    GroupEngine::inject(
                        session,
                        "This clarification arrived after the coordinator started.",
                        vec!["engineer".into()],
                    );
                }
            },
            false,
            &mut on_message,
            &mut on_board,
        )
        .await
        .unwrap();

        let observed = observed.lock().unwrap();
        let engineer_prompt = observed
            .iter()
            .find(|(id, _)| id.as_deref() == Some("engineer"))
            .map(|(_, prompt)| prompt)
            .unwrap();
        assert!(engineer_prompt.contains("This clarification arrived after the coordinator"));
        assert!(session.pending_injections.is_empty());
    }
}
