//! 权限引擎：allow 直接执行 / deny 拒绝 / ask 询问宿主（chat.respond 应答）。

use crate::hub::Hub;
use serde_json::{json, Value};
use std::time::Duration;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::types::PermissionRequest;

const ASK_TIMEOUT: Duration = Duration::from_secs(300);

/// 检查工具执行许可。ask 策略下向流发布 PermissionRequest 事件并等待宿主应答；
/// 非交互宿主（CLI one-shot / 无应答通道）视为拒绝并发布 Notice。
pub async fn check(
    hub: &Hub,
    stream_id: &str,
    policy: &str,
    tool_name: &str,
    args: &Value,
    interactive: bool,
) -> bool {
    match policy {
        "deny" => false,
        "allow" => true,
        _ => {
            if !interactive {
                // 发布询问事件以便宿主 UI 可见，但无应答通道时按拒绝处理
                return false;
            }
            ask_host(hub, stream_id, tool_name, args).await
        }
    }
}

async fn ask_host(hub: &Hub, stream_id: &str, tool_name: &str, args: &Value) -> bool {
    let request_id = uuid::Uuid::new_v4().to_string();
    let args_summary = summarize_args(args);

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    hub.pending_permissions
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    // 发布 PermissionRequest 事件（流通道供 resume，全局广播供宿主转发）
    let frame_kind = EventKind::PermissionRequest {
        request_id: request_id.clone(),
        tool_name: tool_name.to_string(),
        args_summary: args_summary.clone(),
    };
    let channel = hub.streams.lock().unwrap().get(stream_id).cloned();
    let seq = match &channel {
        Some(ch) => ch.publish(stream_id, frame_kind.clone()).await,
        None => 0,
    };
    let _ = hub.event_tx.send(worldbase_protocol::event::EventFrame {
        stream_id: stream_id.to_string(),
        seq,
        ts: worldbase_protocol::event::now_rfc3339(),
        kind: frame_kind,
    });

    match tokio::time::timeout(ASK_TIMEOUT, rx).await {
        Ok(Ok(allow)) => allow,
        _ => {
            hub.pending_permissions.lock().unwrap().remove(&request_id);
            false
        }
    }
}

fn summarize_args(args: &Value) -> String {
    match args {
        Value::Object(map) => map
            .iter()
            .take(4)
            .map(|(k, v)| {
                let vs = v.to_string();
                let vs = if vs.len() > 80 {
                    format!("{}…", &vs[..80])
                } else {
                    vs
                };
                format!("{k}={vs}")
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => {
            let s = other.to_string();
            if s.len() > 100 {
                format!("{}…", &s[..100])
            } else {
                s
            }
        }
    }
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
