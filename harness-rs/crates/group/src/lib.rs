//! 群组协作引擎：对齐桌面端 AgentGroupCollaborationMode 的 5 种模式 + 六字段黑板
//! + HITL 注入队列。纯状态机 + provider 调用，全端可用。

use anyhow::{bail, Context, Result};
use futures::StreamExt;
use worldbase_protocol::types::{
    GroupBoard, GroupMember, GroupMode, GroupRoundRecord, GroupSessionMeta,
};
use worldbase_providers::{create_provider, ContentBlock, LlmMessage, LlmRole};

/// 发言回调：(member, content, round)。
pub type OnMessageFn<'a> = &'a mut (dyn FnMut(String, String, u32) + Send);
/// 黑板变更回调。
pub type OnBoardFn<'a> = &'a mut (dyn FnMut(&GroupBoard) + Send);

pub struct GroupEngine;

impl GroupEngine {
    /// 创建会话。coordinator 缺省取第一个成员。
    pub fn create(
        topic: &str,
        mode: GroupMode,
        members: Vec<GroupMember>,
        coordinator: Option<String>,
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
            rounds: vec![],
            coordinator: coord,
            pending_injections: vec![],
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
        let speakers = Self::route_speakers(session, user_input);
        let mut count = 0;

        for name in speakers {
            let Some(member) = session.members.iter().find(|m| m.name == name).cloned() else {
                continue;
            };
            // HITL 注入：清空队列并入提示
            let injections: Vec<String> = std::mem::take(&mut session.pending_injections);
            let prompt = build_prompt(session, &member, user_input, round, &injections);
            let content = call_member(&member, &prompt).await?;

            // 成员输出中的 board.update 指令被引擎采纳（工具化前的简化语义）
            apply_board_directives(session, &content);
            session.rounds.push(GroupRoundRecord {
                member: member.name.clone(),
                content: content.clone(),
                round,
                created_at: worldbase_protocol::event::now_rfc3339(),
            });
            on_board(&session.board);
            on_message(member.name.clone(), content, round);
            count += 1;
        }
        Ok(count)
    }

    /// 黑板字段更新（op: set/add/remove）。
    pub fn board_update(session: &mut GroupSessionMeta, field: &str, op: &str, value: &str) -> Result<()> {
        let list = match field {
            "assumptions" => &mut session.board.assumptions,
            "tasks" => &mut session.board.tasks,
            "decisions" => &mut session.board.decisions,
            "evidenceRefs" | "evidence_refs" => &mut session.board.evidence_refs,
            "openQuestions" | "open_questions" => &mut session.board.open_questions,
            "goal" => {
                if op == "set" {
                    session.board.goal = value.to_string();
                }
                return Ok(());
            }
            other => bail!("unknown board field: {other}"),
        };
        match op {
            "set" => {
                list.clear();
                list.push(value.to_string());
            }
            "add" => {
                if !list.iter().any(|v| v == value) {
                    list.push(value.to_string());
                }
            }
            "remove" => list.retain(|v| v != value),
            other => bail!("unknown board op: {other}"),
        }
        Ok(())
    }

    /// HITL 注入：入队，下一轮发言时进入上下文。
    pub fn inject(session: &mut GroupSessionMeta, content: &str) {
        session.pending_injections.push(content.to_string());
    }
}

fn build_prompt(
    session: &GroupSessionMeta,
    member: &GroupMember,
    user_input: &str,
    round: u32,
    injections: &[String],
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
        GroupMode::CoordinatorDecides => "你是协调者或被协调者点名的成员：协调者先规划，成员按分工执行。",
        GroupMode::MentionedAgentDecides => "你被点名：自行判断是否需要 @拉入其他成员。",
    };

    let board = format!(
        "目标:{}\n假设:[{}]\n任务:[{}]\n决策:[{}]\n待解问题:[{}]",
        session.board.goal,
        session.board.assumptions.join("; "),
        session.board.tasks.join("; "),
        session.board.decisions.join("; "),
        session.board.open_questions.join("; "),
    );

    let inject_block = if injections.is_empty() {
        String::new()
    } else {
        format!("\n\n【用户实时澄清(HITL)】\n{}", injections.join("\n"))
    };

    format!(
        "你是群组讨论成员「{name}」。人设：{persona}\n其他成员：\n{others}\n讨论主题：{topic}\n模式：{mode_hint}\n\n当前黑板：\n{board}\n\n最近发言：\n{recent}\n\n用户输入：{user}{inject}\n\n请用不超过 200 字发言。可用指令更新黑板：[board]字段|set/add/remove|内容（字段: assumptions/tasks/decisions/goal/openQuestions）",
        name = member.name,
        persona = member.persona,
        others = others,
        topic = session.topic,
        mode_hint = mode_hint,
        board = board,
        recent = if recent.is_empty() { "（尚无发言）".to_string() } else { recent.join("\n") },
        user = user_input,
        inject = inject_block,
    )
}

/// 解析成员输出中的 [board] 指令并应用（从发言文本剥离指令行）。
fn apply_board_directives(session: &mut GroupSessionMeta, content: &str) {
    // 简化实现：不剥离文本（mock 输出即发言），仅识别行内指令
    for line in content.lines() {
        let Some(rest) = line.trim().strip_prefix("[board]") else {
            continue;
        };
        let parts: Vec<&str> = rest.trim().splitn(3, '|').collect();
        if parts.len() == 3 {
            let _ = GroupEngine::board_update(session, parts[0].trim(), parts[1].trim(), parts[2].trim());
        }
    }
}

async fn call_member(member: &GroupMember, prompt: &str) -> Result<String> {
    let cfg = member.provider.clone().unwrap_or_default();
    let provider = create_provider(&cfg).context("create member provider")?;
    let mut stream = provider
        .chat_stream(
            Some("你是群组协作中的成员，发言精炼、有观点。"),
            vec![LlmMessage {
                role: LlmRole::User,
                content: vec![ContentBlock::Text { text: prompt.to_string() }],
            }],
            vec![],
            1024,
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
    use worldbase_protocol::types::ProviderConfig;

    fn members() -> Vec<GroupMember> {
        vec![
            GroupMember {
                name: "协调者".into(),
                persona: "统筹".into(),
                provider: Some(ProviderConfig::default()),
            },
            GroupMember {
                name: "工程师".into(),
                persona: "实现".into(),
                provider: Some(ProviderConfig::default()),
            },
            GroupMember {
                name: "评审".into(),
                persona: "挑刺".into(),
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
    fn parses_board_directives_from_output() {
        let mut session = GroupEngine::create("t", GroupMode::Discussion, members(), None).unwrap();
        apply_board_directives(
            &mut session,
            "我的发言\n[board] goal|set|共识：Rust\n[board] decisions|add|用 FFI 桥",
        );
        assert_eq!(session.board.goal, "共识：Rust");
        assert_eq!(session.board.decisions, vec!["用 FFI 桥".to_string()]);
    }

    #[tokio::test]
    async fn run_round_with_mock_and_inject() {
        let mut session = GroupEngine::create("选型", GroupMode::Discussion, members(), None).unwrap();
        GroupEngine::inject(&mut session, "补充：预算只有两周");
        let collected = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = collected.clone();
        let mut on_board = |_b: &GroupBoard| {};
        let n = GroupEngine::run_round(&mut session, "评估方案", 1, &mut |member, content, round| {
            sink.lock().unwrap().push((member, content, round));
        }, &mut on_board)
        .await
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(session.rounds.len(), 3);
        assert_eq!(collected.lock().unwrap().len(), 3);
    }
}
