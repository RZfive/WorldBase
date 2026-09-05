//! 宿主域工具（domain="host"，需宿主声明 webview_automation/交互能力）：
//! - ask_user：向宿主弹问题（HITL）
//! - read_current_page：读取宿主 WebView 当前页面快照
//! - interact_current_page：对宿主 WebView 执行交互动作
//! （对齐桌面 tool-active-page 的移动端形态）

use super::host_bridge::HostBridge;
use super::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const ASK_TIMEOUT: Duration = Duration::from_secs(300);
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);

fn tools_host_bridge(services: &ToolServices) -> Arc<HostBridge> {
    services.host.clone()
}

pub struct AskUserTool;

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }
    fn description(&self) -> &str {
        "一次提交 1-4 个澄清问题并等待用户统一回答（人机协作）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "一次列出所有待确认问题；不要拆成连续的单题调用",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string" },
                            "options": {
                                "type": "array",
                                "description": "1-4 个互斥候选；宿主会自动提供其他/自定义输入",
                                "items": { "type": "string" },
                                "minItems": 1,
                                "maxItems": 4
                            }
                        },
                        "required": ["question", "options"]
                    },
                    "minItems": 1,
                    "maxItems": 4
                }
            },
            "required": ["questions"]
        })
    }
    fn domain(&self) -> &str {
        "host"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let questions = normalize_questions(&input)?;
        let stream = services.current_stream.lock().unwrap().clone();
        let response = tools_host_bridge(services)
            .request(
                &stream,
                "ask_user",
                ask_user_payload(&questions),
                ASK_TIMEOUT,
            )
            .await?;
        let answers = normalize_answers(&response, &questions);
        Ok(json!({ "success": true, "answers": answers }))
    }
}

fn normalized_strings(value: Option<&Value>, limit: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(limit)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_questions(input: &Value) -> Result<Vec<(String, Vec<String>)>> {
    let mut questions = Vec::new();
    if let Some(values) = input.get("questions").and_then(Value::as_array) {
        anyhow::ensure!(!values.is_empty(), "questions must be a non-empty array");
        for (index, value) in values.iter().take(4).enumerate() {
            let question = value
                .get("question")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!("question[{index}] must include a non-empty question")
                })?;
            let options = normalized_strings(value.get("options"), 4);
            anyhow::ensure!(
                !options.is_empty(),
                "question[{index}] must include at least one option"
            );
            questions.push((question.to_string(), options));
        }
    } else if let Some(question) = input
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // Compatibility for native calls persisted before the Electron schema
        // became canonical across clients.
        questions.push((
            question.to_string(),
            normalized_strings(input.get("choices"), 4),
        ));
    }
    anyhow::ensure!(!questions.is_empty(), "questions must be a non-empty array");
    Ok(questions)
}

fn ask_user_payload(questions: &[(String, Vec<String>)]) -> Value {
    let bundled: Vec<_> = questions
        .iter()
        .enumerate()
        .map(|(index, (question, options))| {
            json!({
                "id": format!("q_{}", index + 1),
                "question": question,
                "options": options
            })
        })
        .collect();
    let (question, choices) = &questions[0];
    // The first-question aliases let an older host still answer a one-question
    // request while current hosts consume the complete `questions` batch.
    json!({
        "questions": bundled,
        "question": question,
        "choices": choices
    })
}

fn answer_text(value: &Value) -> String {
    for key in [
        "customAnswer",
        "custom_answer",
        "selectedOption",
        "selected_option",
        "answer",
    ] {
        if let Some(answer) = value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|answer| !answer.is_empty())
        {
            return answer.to_string();
        }
    }
    value
        .as_str()
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn normalize_answers(response: &Value, questions: &[(String, Vec<String>)]) -> Vec<Value> {
    let items = response
        .get("answers")
        .and_then(Value::as_array)
        .or_else(|| response.as_array());
    questions
        .iter()
        .enumerate()
        .map(|(index, (question, _))| {
            let answer = items
                .and_then(|answers| answers.get(index))
                .map(answer_text)
                .unwrap_or_else(|| {
                    if questions.len() == 1 {
                        answer_text(response)
                    } else {
                        String::new()
                    }
                });
            json!({ "question": question, "answer": answer })
        })
        .collect()
}

pub struct ReadCurrentPageTool;

#[async_trait]
impl Tool for ReadCurrentPageTool {
    fn name(&self) -> &str {
        "read_current_page"
    }
    fn description(&self) -> &str {
        "读取宿主 WebView 当前页面快照（url/title/文本/可交互元素）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "max_chars": { "type": "integer" } }
        })
    }
    fn domain(&self) -> &str {
        "host"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        read_page_snapshot(&input, services).await
    }
}

pub struct InteractCurrentPageTool;

#[async_trait]
impl Tool for InteractCurrentPageTool {
    fn name(&self) -> &str {
        "interact_current_page"
    }
    fn description(&self) -> &str {
        "对宿主 WebView 执行交互动作（click/input/scroll/evaluate/press_key 等）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string" },
                "selector": { "type": "string" },
                "text": { "type": "string" },
                "append": { "type": "boolean" },
                "top": { "type": "number" },
                "left": { "type": "number" },
                "timeout_ms": { "type": "integer" },
                "value": { "type": "string" },
                "label": { "type": "string" },
                "index": { "type": "integer" },
                "fields": { "type": "array", "items": { "type": "object" } },
                "offset": { "type": "integer" },
                "max_chars": { "type": "integer" },
                "script": { "type": "string" },
                "key": { "type": "string" }
            },
            "required": ["action"]
        })
    }
    fn domain(&self) -> &str {
        "host"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let actions = normalize_page_actions(&input)?;
        interact_page_actions(actions, services).await
    }
}

fn optional_trimmed(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_field(value: &Value, index: usize) -> Result<Value> {
    let selector = value
        .get("selector")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("fields[{index}].selector is required"))?;
    let text = value
        .get("text")
        .or_else(|| value.get("value"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("fields[{index}].text is required"))?;
    Ok(json!({
        "selector": selector,
        "text": text,
        "value": text,
        "append": value.get("append").and_then(Value::as_bool).unwrap_or(false),
    }))
}

fn canonical_page_action(input: &Value) -> Result<Vec<Value>> {
    let action = input
        .get("action")
        .or_else(|| input.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("action is required"))?;
    let selector = optional_trimmed(input, "selector");
    match action {
        "click" | "hover" | "focus" => {
            let selector =
                selector.ok_or_else(|| anyhow::anyhow!("selector is required for {action}"))?;
            Ok(vec![json!({ "type": action, "selector": selector })])
        }
        "input" | "fill" => {
            let selector =
                selector.ok_or_else(|| anyhow::anyhow!("selector is required for input"))?;
            let text = input
                .get("text")
                .or_else(|| input.get("value"))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("text is required for input"))?;
            Ok(vec![json!({
                "type": "input",
                "selector": selector,
                "text": text,
                "value": text,
                "append": input.get("append").and_then(Value::as_bool).unwrap_or(false),
            })])
        }
        "select" => {
            let selector =
                selector.ok_or_else(|| anyhow::anyhow!("selector is required for select"))?;
            anyhow::ensure!(
                input.get("value").and_then(Value::as_str).is_some()
                    || input.get("label").and_then(Value::as_str).is_some()
                    || input.get("index").and_then(Value::as_i64).is_some(),
                "select requires value, label, or index"
            );
            Ok(vec![json!({
                "type": "select",
                "selector": selector,
                "value": input.get("value"),
                "label": input.get("label"),
                "index": input.get("index"),
            })])
        }
        "batch_input" => {
            let fields = input
                .get("fields")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("fields must be an array for batch_input"))?;
            anyhow::ensure!(!fields.is_empty(), "at least one field is required");
            let fields = fields
                .iter()
                .enumerate()
                .map(|(index, field)| normalize_field(field, index))
                .collect::<Result<Vec<_>>>()?;
            Ok(vec![json!({ "type": "batch_input", "fields": fields })])
        }
        "extract" => Ok(vec![json!({
            "type": "extract",
            "selector": selector,
            "offset": input.get("offset").and_then(Value::as_u64).unwrap_or(0),
            "maxChars": input.get("max_chars").and_then(Value::as_u64).unwrap_or(60_000),
        })]),
        "evaluate" => {
            let script = input
                .get("script")
                .or_else(|| input.get("js"))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("script is required for evaluate"))?;
            Ok(vec![
                json!({ "type": "evaluate", "script": script, "js": script }),
            ])
        }
        "press_key" => {
            let key = input
                .get("key")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow::anyhow!("key is required for press_key"))?;
            Ok(vec![
                json!({ "type": "press_key", "selector": selector, "key": key }),
            ])
        }
        "scroll" => {
            let top = input.get("top").and_then(Value::as_f64).unwrap_or(0.0);
            let left = input.get("left").and_then(Value::as_f64).unwrap_or(0.0);
            Ok(vec![
                json!({ "type": "scroll", "top": top, "left": left, "dy": top }),
            ])
        }
        "wait" => {
            let timeout = input
                .get("timeout_ms")
                .or_else(|| input.get("timeoutMs"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            Ok(vec![json!({ "type": "wait", "timeoutMs": timeout })])
        }
        _ => anyhow::bail!("Unsupported page action: {action}"),
    }
}

pub(crate) fn normalize_page_actions(input: &Value) -> Result<Vec<Value>> {
    if let Some(actions) = input.get("actions").and_then(Value::as_array) {
        anyhow::ensure!(!actions.is_empty(), "actions must be a non-empty array");
        let mut normalized = Vec::new();
        for action in actions {
            normalized.extend(canonical_page_action(action)?);
        }
        Ok(normalized)
    } else {
        canonical_page_action(input)
    }
}

fn truncate_page_preview(result: &mut Value, max_chars: usize) {
    let page = if result.get("page").is_some() {
        result.get_mut("page")
    } else {
        Some(result)
    };
    let Some(page) = page.and_then(Value::as_object_mut) else {
        return;
    };
    let Some(text) = page.get("textPreview").and_then(Value::as_str) else {
        return;
    };
    if text.chars().count() <= max_chars {
        return;
    }
    let omitted = text.chars().count() - max_chars;
    page.insert(
        "textPreview".into(),
        Value::String(format!(
            "{}\n\n[truncated {omitted} chars]",
            text.chars().take(max_chars).collect::<String>()
        )),
    );
}

pub(crate) async fn read_page_snapshot(input: &Value, services: &ToolServices) -> Result<Value> {
    let max_chars = input
        .get("max_chars")
        .and_then(Value::as_u64)
        .unwrap_or(8_000)
        .clamp(400, 60_000) as usize;
    let stream = services.current_stream.lock().unwrap().clone();
    let mut result = tools_host_bridge(services)
        .request(
            &stream,
            "page_automation",
            json!({ "action": "read", "maxChars": max_chars }),
            PAGE_TIMEOUT,
        )
        .await?;
    truncate_page_preview(&mut result, max_chars);
    if result.get("page").is_some() {
        if let Some(map) = result.as_object_mut() {
            map.entry("guidance").or_insert_with(|| {
                json!("Use interact_current_page for page actions and extract pagination.")
            });
        }
        Ok(result)
    } else {
        Ok(json!({
            "ok": true,
            "page": result,
            "guidance": "Use interact_current_page for page actions and extract pagination."
        }))
    }
}

pub(crate) async fn interact_page_actions(
    actions: Vec<Value>,
    services: &ToolServices,
) -> Result<Value> {
    anyhow::ensure!(!actions.is_empty(), "at least one page action is required");
    let stream = services.current_stream.lock().unwrap().clone();
    let action_result = tools_host_bridge(services)
        .request(
            &stream,
            "page_automation",
            json!({ "action": "interact", "actions": actions }),
            PAGE_TIMEOUT,
        )
        .await?;
    ensure_page_action_succeeded(&action_result)?;
    let snapshot = read_page_snapshot(&json!({ "max_chars": 8_000 }), services).await?;
    Ok(page_interaction_output(action_result, snapshot))
}

fn ensure_page_action_succeeded(action_result: &Value) -> Result<()> {
    if action_result.get("ok").and_then(Value::as_bool) != Some(false) {
        return Ok(());
    }
    let message = action_result
        .get("error")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("page automation action failed");
    anyhow::bail!("{message}")
}

fn page_interaction_output(action_result: Value, snapshot: Value) -> Value {
    let mut output = json!({
        "ok": true,
        "action_result": action_result.clone(),
        "page": snapshot.get("page").cloned().unwrap_or(snapshot),
    });
    // Flutter promotes a single action's result (including batch filled /
    // skipped counts) onto its response. Preserve those fields at the Rust
    // tool boundary while retaining Electron's action_result envelope.
    if let (Some(target), Some(result)) = (output.as_object_mut(), action_result.as_object()) {
        for (key, value) in result {
            if key != "page" && key != "results" {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_questions_are_normalized_as_one_batch() {
        let questions = normalize_questions(&json!({
            "questions": [
                { "question": "Mode?", "options": ["Fast", "Thorough"] },
                { "question": "Format?", "options": ["JSON"] }
            ]
        }))
        .unwrap();
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].0, "Mode?");
        assert_eq!(questions[0].1, vec!["Fast", "Thorough"]);
        let payload = ask_user_payload(&questions);
        assert_eq!(payload["questions"].as_array().unwrap().len(), 2);
        assert_eq!(payload["question"], "Mode?");
    }

    #[test]
    fn batch_and_legacy_host_answers_share_one_result_shape() {
        let questions = vec![
            ("Mode?".to_string(), vec!["Fast".to_string()]),
            ("Format?".to_string(), vec!["JSON".to_string()]),
        ];
        let batch = normalize_answers(
            &json!([
                { "selectedOption": "Fast", "customAnswer": null },
                { "selectedOption": null, "customAnswer": "Markdown" }
            ]),
            &questions,
        );
        assert_eq!(batch[0]["answer"], "Fast");
        assert_eq!(batch[1]["answer"], "Markdown");

        let legacy = normalize_answers(
            &json!({ "answer": "Careful" }),
            &[("Mode?".to_string(), vec!["Careful".to_string()])],
        );
        assert_eq!(legacy[0]["answer"], "Careful");
    }

    #[test]
    fn canonical_batch_input_remains_one_action_with_normalized_fields() {
        let actions = normalize_page_actions(&json!({
            "action": "batch_input",
            "fields": [
                { "selector": "#name", "text": "Ada" },
                { "selector": "#team", "text": "Core", "append": true }
            ]
        }))
        .unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["type"], "batch_input");
        assert_eq!(actions[0]["fields"][0]["text"], "Ada");
        assert_eq!(actions[0]["fields"][0]["value"], "Ada");
        assert_eq!(actions[0]["fields"][1]["append"], true);
    }

    #[test]
    fn canonical_scroll_and_evaluate_include_mobile_aliases() {
        let scroll = normalize_page_actions(&json!({ "action": "scroll", "top": 240 })).unwrap();
        assert_eq!(scroll[0]["dy"], 240.0);
        let evaluate =
            normalize_page_actions(&json!({ "action": "evaluate", "script": "document.title" }))
                .unwrap();
        assert_eq!(evaluate[0]["js"], "document.title");
    }

    #[test]
    fn failed_host_page_action_is_a_tool_error() {
        let error = ensure_page_action_succeeded(&json!({
            "ok": false,
            "error": "Element not found: #missing"
        }))
        .unwrap_err();
        assert!(error.to_string().contains("Element not found"));
    }

    #[test]
    fn batch_result_counts_are_promoted_to_the_tool_result() {
        let output = page_interaction_output(
            json!({
                "ok": true,
                "type": "batch_input",
                "filled": 2,
                "skipped": 1,
                "results": []
            }),
            json!({ "page": { "title": "Form" } }),
        );
        assert_eq!(output["filled"], 2);
        assert_eq!(output["skipped"], 1);
        assert_eq!(output["action_result"]["type"], "batch_input");
        assert_eq!(output["page"]["title"], "Form");
    }
}
