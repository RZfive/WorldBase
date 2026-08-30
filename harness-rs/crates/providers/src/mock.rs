//! Mock provider：脚本化多轮流次，供测试与无 API key 的全链路演示。

use super::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
};
use anyhow::Result;
use futures::stream::{BoxStream, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// 一轮流次脚本：文本 + 可选工具调用。
#[derive(Clone)]
pub struct MockTurn {
    pub text: String,
    pub tool_calls: Vec<(String, String, Value)>, // (id, name, input)
    /// 按空格切分文本逐段下发，模拟流式。
    pub stream_in_chunks: bool,
}

pub struct MockProvider {
    model: String,
    script: Mutex<Vec<MockTurn>>,
    cursor: AtomicUsize,
}

impl MockProvider {
    pub fn new(model: impl Into<String>, script: Vec<MockTurn>) -> Self {
        Self {
            model: model.into(),
            script: Mutex::new(script),
            cursor: AtomicUsize::new(0),
        }
    }

    /// 无脚本时的默认行为：
    /// - 用户想"做一个应用" → 调 create_lightweight_app 生成单页轻应用（演示全链路）
    /// - 工具结果之后 → 确认语
    /// - 其余 → 回显
    pub fn default_script(model: impl Into<String>) -> Self {
        Self::new(model, vec![])
    }

    fn default_turn(&self, messages: &[LlmMessage]) -> MockTurn {
        let last_user = messages.iter().rev().find(|m| m.role == LlmRole::User);
        // 工具结果轮：确认
        if let Some(m) = last_user {
            if matches!(m.content.first(), Some(ContentBlock::ToolResult { .. })) {
                return MockTurn {
                    text: "✅ 轻应用已创建，可在「应用」页打开。".into(),
                    tool_calls: vec![],
                    stream_in_chunks: true,
                };
            }
        }
        let text = last_user.map(|m| m.text_view()).unwrap_or_default();
        let app_intent = ["轻应用", "应用", "app", "App", "页面", "做一个", "生成一个"]
            .iter()
            .any(|k| text.contains(k));
        if app_intent {
            let name = extract_app_name(&text);
            return MockTurn {
                text: format!("好的，我来创建单页轻应用「{name}」。"),
                tool_calls: vec![(
                    "t1".into(),
                    "create_lightweight_app".into(),
                    serde_json::json!({ "name": name, "html": demo_app_html(&name) }),
                )],
                stream_in_chunks: true,
            };
        }
        MockTurn {
            text: format!("（mock）已收到：{text}"),
            tool_calls: vec![],
            stream_in_chunks: true,
        }
    }
}

#[async_trait::async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn chat_stream(
        &self,
        _system: Option<&str>,
        messages: Vec<LlmMessage>,
        _tools: Vec<LlmTool>,
        _max_tokens: u32,
        _options: ChatOptions,
    ) -> Result<ChunkStream> {
        let turn = {
            let script = self.script.lock().unwrap();
            if script.is_empty() {
                None
            } else {
                let idx = self.cursor.fetch_add(1, Ordering::SeqCst);
                let last = script.len() - 1;
                script.get(idx.min(last)).cloned()
            }
        }
        .unwrap_or_else(|| self.default_turn(&messages));

        let stream: BoxStream<'static, Result<StreamChunk>> = if turn.stream_in_chunks {
            let chunks: Vec<Result<StreamChunk>> = turn
                .text
                .split_inclusive(' ')
                .filter(|s| !s.is_empty())
                .map(|s| Ok(StreamChunk::TextDelta(s.to_string())))
                .collect();
            // 中文文本可能没有空格：split_inclusive(' ') 会把整段留在最后一段，OK。
            Box::pin(futures::stream::iter(chunks))
        } else {
            Box::pin(futures::stream::iter(vec![Ok(StreamChunk::TextDelta(
                turn.text.clone(),
            ))]))
        };

        // Completed 块在文本流之后追加。
        let content = {
            let mut c: Vec<ContentBlock> = Vec::new();
            if !turn.text.is_empty() {
                c.push(ContentBlock::Text {
                    text: turn.text.clone(),
                });
            }
            for (id, name, input) in &turn.tool_calls {
                c.push(ContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
            }
            c
        };
        // mock 估算用量：输入按最后一条用户消息长度/3，输出按文本长度/2
        let input_est = messages
            .iter()
            .rev()
            .find(|m| m.role == LlmRole::User)
            .map(|m| (m.text_view().chars().count() as u64 / 3).max(1))
            .unwrap_or(10);
        let output_est = (turn.text.chars().count() as u64 / 2).max(1);
        let completed = Ok(StreamChunk::Completed {
            stop_reason: if turn.tool_calls.is_empty() {
                "end_turn".into()
            } else {
                "tool_use".into()
            },
            assistant: LlmMessage {
                role: LlmRole::Assistant,
                content,
            },
            usage: super::TokenUsage {
                input_tokens: input_est,
                output_tokens: output_est,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
        });

        Ok(Box::pin(
            stream.chain(futures::stream::iter(vec![completed])),
        ))
    }
}

/// 从用户输入提取应用名（「」引号优先，否则截取前 12 字）。
fn extract_app_name(text: &str) -> String {
    if let Some(start) = text.find('「') {
        if let Some(end_offset) = text[start + 3..].find('」') {
            let name = &text[start + 3..start + 3 + end_offset];
            if !name.trim().is_empty() {
                return name.trim().to_string();
            }
        }
    }
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    cleaned.chars().take(12).collect()
}

/// 生成演示单页应用 HTML（iOS 风格待办清单，数据存 localStorage）。
fn demo_app_html(name: &str) -> String {
    let title = name;
    format!(
        r#"<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>{title}</title>
<style>
  body {{ margin:0; font-family:-apple-system,'PingFang SC',sans-serif; background:#F2F2F7; }}
  h1 {{ font-size:26px; margin:18px 16px 8px; letter-spacing:-0.5px; }}
  .row {{ display:flex; gap:8px; padding:0 16px 12px; }}
  input {{ flex:1; border:none; border-radius:10px; padding:10px 12px; font-size:15px; background:#fff; }}
  button {{ border:none; border-radius:10px; padding:10px 16px; font-size:15px;
           background:#007AFF; color:#fff; font-weight:600; }}
  ul {{ list-style:none; margin:0; padding:0 16px; }}
  li {{ display:flex; align-items:center; gap:10px; background:#fff; border-radius:10px;
       padding:12px; margin-bottom:8px; font-size:15px; }}
  li.done span {{ color:#8E8E93; text-decoration:line-through; }}
  li b {{ width:20px; height:20px; border-radius:10px; border:1.5px solid #C7C7CC; }}
  li.done b {{ background:#34C759; border-color:#34C759; position:relative; }}
  li.done b::after {{ content:'✓'; position:absolute; left:4px; top:-2px; color:#fff; font-size:12px; }}
  li span {{ flex:1; }}
  li i {{ color:#FF3B30; font-style:normal; font-size:18px; }}
</style></head><body>
<h1>{title}</h1>
<div class="row"><input id="t" placeholder="添加待办…"><button onclick="add()">添加</button></div>
<ul id="list"></ul>
<script>
  const KEY = 'wb-todos';
  let todos = JSON.parse(localStorage.getItem(KEY) || '[]');
  function save() {{ localStorage.setItem(KEY, JSON.stringify(todos)); render(); }}
  function render() {{
    document.getElementById('list').innerHTML = todos.map((t, i) =>
      `<li class="${{t.done ? 'done' : ''}}" onclick="toggle(${{i}})"><b></b><span>${{t.text}}</span><i onclick="event.stopPropagation();del(${{i}})">×</i></li>`).join('');
  }}
  function add() {{
    const el = document.getElementById('t');
    if (!el.value.trim()) return;
    todos.push({{ text: el.value.trim(), done: false }});
    el.value = ''; save();
  }}
  function toggle(i) {{ todos[i].done = !todos[i].done; save(); }}
  function del(i) {{ todos.splice(i, 1); save(); }}
  render();
</script></body></html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[test]
    fn app_name_extraction() {
        assert_eq!(extract_app_name("做一个「番茄钟」应用"), "番茄钟");
        assert_eq!(extract_app_name("做一个记事本应用"), "做一个记事本应用");
    }

    #[test]
    fn default_turn_detects_app_intent() {
        let provider = MockProvider::default_script("mock");
        let messages = vec![LlmMessage::text(LlmRole::User, "帮我做一个「番茄钟」应用")];
        let turn = provider.default_turn(&messages);
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].1, "create_lightweight_app");
        assert!(turn.tool_calls[0].2["html"]
            .as_str()
            .unwrap()
            .contains("<html"));
        assert!(turn.tool_calls[0].2["name"]
            .as_str()
            .unwrap()
            .contains("番茄钟"));

        // 工具结果之后 → 确认语，不再重复创建
        let after = vec![
            LlmMessage::text(LlmRole::User, "帮我做一个「番茄钟」应用"),
            LlmMessage {
                role: LlmRole::Assistant,
                content: vec![ContentBlock::Text {
                    text: "好的".into(),
                }],
            },
            LlmMessage {
                role: LlmRole::User,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "ok".into(),
                    is_error: false,
                }],
            },
        ];
        let turn2 = provider.default_turn(&after);
        assert!(turn2.tool_calls.is_empty());
        assert!(turn2.text.contains("已创建"));

        // 无意图 → 回显
        let turn3 = provider.default_turn(&[LlmMessage::text(LlmRole::User, "你好")]);
        assert!(turn3.tool_calls.is_empty());
        assert!(turn3.text.contains("你好"));
    }

    #[tokio::test]
    async fn scripted_tool_call_flow() {
        let provider = MockProvider::new(
            "mock-1",
            vec![
                MockTurn {
                    text: "查看文件".into(),
                    tool_calls: vec![(
                        "t1".into(),
                        "read_file".into(),
                        serde_json::json!({"path": "a.txt"}),
                    )],
                    stream_in_chunks: true,
                },
                MockTurn {
                    text: "内容是 hello".into(),
                    tool_calls: vec![],
                    stream_in_chunks: true,
                },
            ],
        );
        let tools = vec![LlmTool {
            name: "read_file".into(),
            description: "r".into(),
            input_schema: serde_json::json!({}),
        }];
        let mut messages = vec![LlmMessage::text(LlmRole::User, "读一下 a.txt")];

        let mut s1 = provider
            .chat_stream(
                None,
                messages.clone(),
                tools.clone(),
                1024,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let mut deltas = String::new();
        let mut completed = None;
        while let Some(chunk) = s1.next().await {
            match chunk.unwrap() {
                StreamChunk::TextDelta(t) => deltas.push_str(&t),
                StreamChunk::Completed { assistant, .. } => completed = Some(assistant),
            }
        }
        assert_eq!(deltas, "查看文件");
        let a1 = completed.unwrap();
        assert_eq!(a1.tool_uses().len(), 1);

        // 第二轮：带 tool_result 的历史
        messages.push(a1);
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "hello".into(),
                is_error: false,
            }],
        });
        let mut s2 = provider
            .chat_stream(None, messages, tools, 1024, ChatOptions::default())
            .await
            .unwrap();
        let mut second_text = String::new();
        while let Some(chunk) = s2.next().await {
            if let StreamChunk::TextDelta(t) = chunk.unwrap() {
                second_text.push_str(&t);
            }
        }
        assert_eq!(second_text, "内容是 hello");
    }
}
