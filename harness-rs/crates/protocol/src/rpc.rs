//! JSON-RPC 2.0 信封。stdio 上为 NDJSON，日志走 stderr；WS 上每帧一条消息。

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;
/// 应用层错误起点（harness 自定义错误 ≥ -32000）。
pub const SERVER_ERROR: i32 = -32000;

/// JSON-RPC id：整数或字符串。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Num(i64),
    Str(String),
    Null,
}

/// 宿主 → harness 请求（也用于 harness → 宿主的反向请求）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// 无 id 的通知。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorObject {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i32, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(INTERNAL_ERROR, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(METHOD_NOT_FOUND, format!("method not found: {method}"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(INVALID_PARAMS, message)
    }
}

/// harness → 宿主 响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Response {
    Success {
        jsonrpc: String,
        id: RequestId,
        result: Value,
    },
    Error {
        jsonrpc: String,
        id: RequestId,
        error: ErrorObject,
    },
}

impl Response {
    pub fn success(id: RequestId, result: Value) -> Self {
        Response::Success {
            jsonrpc: "2.0".into(),
            id,
            result,
        }
    }

    pub fn error(id: RequestId, error: ErrorObject) -> Self {
        Response::Error {
            jsonrpc: "2.0".into(),
            id,
            error,
        }
    }

    pub fn to_message(&self) -> String {
        serde_json::to_string(self).expect("response serialize")
    }
}

/// 解析一行/一帧输入，返回请求或通知。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Incoming {
    Request(Request),
    Notification(Notification),
}

pub fn notification(method: &str, params: Value) -> String {
    let n = Notification {
        jsonrpc: "2.0".into(),
        method: method.into(),
        params,
    };
    serde_json::to_string(&n).expect("notification serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let raw = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let incoming: Incoming = serde_json::from_str(raw).unwrap();
        match incoming {
            Incoming::Request(r) => {
                assert_eq!(r.method, "initialize");
                assert_eq!(r.id, RequestId::Num(1));
            }
            _ => panic!("expected request"),
        }
    }

    #[test]
    fn notification_without_id() {
        let raw = r#"{"jsonrpc":"2.0","method":"ping"}"#;
        let incoming: Incoming = serde_json::from_str(raw).unwrap();
        assert!(matches!(incoming, Incoming::Notification(_)));
    }

    #[test]
    fn string_ids_supported() {
        let raw = r#"{"jsonrpc":"2.0","id":"abc","method":"ping"}"#;
        let incoming: Incoming = serde_json::from_str(raw).unwrap();
        match incoming {
            Incoming::Request(r) => assert_eq!(r.id, RequestId::Str("abc".into())),
            _ => panic!("expected request"),
        }
    }
}
