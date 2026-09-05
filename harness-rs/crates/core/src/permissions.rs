//! 权限引擎：allow 直接执行 / deny 拒绝 / ask 询问宿主（chat.respond 应答）。

use crate::hub::Hub;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::types::PermissionRequest;

const ASK_TIMEOUT: Duration = Duration::from_secs(300);

struct PendingPermissionGuard<'a> {
    hub: &'a Hub,
    request_id: String,
}

impl Drop for PendingPermissionGuard<'_> {
    fn drop(&mut self) {
        self.hub
            .pending_permissions
            .lock()
            .unwrap()
            .remove(&self.request_id);
    }
}

/// 检查工具执行许可。ask 策略下向流发布 PermissionRequest 事件并等待宿主应答；
/// 非交互宿主（CLI one-shot / 无应答通道）视为拒绝并发布 Notice。
pub async fn check(
    hub: &Hub,
    stream_id: &str,
    policy: &str,
    tool_name: &str,
    args: &Value,
    interactive: bool,
    abort: Option<&CancellationToken>,
) -> bool {
    match policy {
        "deny" => false,
        "allow" => true,
        _ => {
            if !interactive {
                // 发布询问事件以便宿主 UI 可见，但无应答通道时按拒绝处理
                return false;
            }
            ask_host(hub, stream_id, tool_name, args, abort).await
        }
    }
}

async fn ask_host(
    hub: &Hub,
    stream_id: &str,
    tool_name: &str,
    args: &Value,
    abort: Option<&CancellationToken>,
) -> bool {
    let request_id = uuid::Uuid::new_v4().to_string();
    let args_summary = summarize_args(args);

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    hub.pending_permissions
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);
    let _pending_guard = PendingPermissionGuard {
        hub,
        request_id: request_id.clone(),
    };

    // Publish through Hub so direct `tool.call` requests also get a registered
    // stream and monotonically increasing sequence numbers. Flutter dedupes
    // events by `(stream_id, seq)` and would otherwise drop the second ask.
    let frame_kind = EventKind::PermissionRequest {
        request_id: request_id.clone(),
        tool_name: tool_name.to_string(),
        args_summary: args_summary.clone(),
    };
    hub.emit(stream_id, frame_kind).await;

    let response = async { tokio::time::timeout(ASK_TIMEOUT, rx).await };
    let result = match abort {
        Some(abort) => {
            tokio::select! {
                biased;
                _ = abort.cancelled() => return false,
                result = response => result,
            }
        }
        None => response.await,
    };
    let allowed = match result {
        Ok(Ok(allow)) => allow,
        _ => false,
    };
    allowed && !abort.is_some_and(CancellationToken::is_cancelled)
}

fn summarize_args(args: &Value) -> String {
    match args {
        Value::Object(map) => map
            .iter()
            .take(4)
            .map(|(k, v)| {
                let vs = v.to_string();
                let vs = truncate_utf8(vs, 80);
                format!("{k}={vs}")
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => {
            let s = other.to_string();
            truncate_utf8(s, 100)
        }
    }
}

fn truncate_utf8(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let boundary = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or_default();
    format!("{}…", &value[..boundary])
}

/// 宿主应答入口（dispatcher 的 chat.respond 调用）。
pub fn respond(hub: &Hub, request_id: &str, allow: bool) -> bool {
    if let Some(tx) = hub.pending_permissions.lock().unwrap().remove(request_id) {
        let _ = tx.send(allow);
        true
    } else {
        false
    }
}

/// 生成权限询问的 JSON payload（反向请求用）。
pub fn request_payload(request: &PermissionRequest) -> Value {
    json!({
        "requestId": request.request_id,
        "toolName": request.tool_name,
        "argsSummary": request.args_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::summarize_args;
    use serde_json::json;

    #[test]
    fn argument_summary_truncates_unicode_at_a_character_boundary() {
        let object = summarize_args(&json!({ "prompt": "界".repeat(100) }));
        assert!(object.ends_with('…'));
        assert!(object.starts_with("prompt=\"界"));

        let scalar = summarize_args(&json!("🙂".repeat(100)));
        assert!(scalar.ends_with('…'));
        assert!(scalar.starts_with("\"🙂"));
    }
}
