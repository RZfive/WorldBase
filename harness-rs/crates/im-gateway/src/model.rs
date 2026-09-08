use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

/// Connectors supported by the Electron gateway contract.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectorType {
    Feishu,
    Wechat,
    Wecom,
    Slack,
    Discord,
    Telegram,
    #[default]
    Custom,
}

impl ConnectorType {
    pub const ALL: [Self; 7] = [
        Self::Feishu,
        Self::Wechat,
        Self::Wecom,
        Self::Slack,
        Self::Discord,
        Self::Telegram,
        Self::Custom,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Feishu => "feishu",
            Self::Wechat => "wechat",
            Self::Wecom => "wecom",
            Self::Slack => "slack",
            Self::Discord => "discord",
            Self::Telegram => "telegram",
            Self::Custom => "custom",
        }
    }
}

impl fmt::Display for ConnectorType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ConnectorType {
    type Err = UnknownConnector;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "feishu" => Ok(Self::Feishu),
            "wechat" => Ok(Self::Wechat),
            "wecom" => Ok(Self::Wecom),
            "slack" => Ok(Self::Slack),
            "discord" => Ok(Self::Discord),
            "telegram" => Ok(Self::Telegram),
            "custom" => Ok(Self::Custom),
            _ => Err(UnknownConnector(value.to_string())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown IM connector: {0}")]
pub struct UnknownConnector(pub String);

/// Connector credentials and routing metadata. Field names deliberately match
/// Electron's `ChannelBinding` JSON contract.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBinding {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub connector_type: ConnectorType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub external_channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incoming_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outgoing_webhook_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypt_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_user_id: Option<String>,
    #[serde(default)]
    pub auto_reply: bool,
    #[serde(default = "default_require_approval")]
    pub require_approval_for_risky_tools: bool,
}

fn default_require_approval() -> bool {
    true
}

impl ChannelBinding {
    pub fn legacy(connector_type: ConnectorType, secret: impl Into<String>) -> Self {
        let secret = secret.into();
        let mut binding = Self {
            id: "legacy".into(),
            connector_type,
            auto_reply: true,
            require_approval_for_risky_tools: true,
            ..Self::default()
        };
        if !secret.is_empty() {
            match connector_type {
                ConnectorType::Feishu | ConnectorType::Wechat | ConnectorType::Wecom => {
                    binding.verification_token = Some(secret);
                }
                ConnectorType::Slack
                | ConnectorType::Discord
                | ConnectorType::Telegram
                | ConnectorType::Custom => binding.incoming_secret = Some(secret),
            }
        }
        binding
    }
}

/// Transport-independent webhook request used by connector parsers and tests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRequest {
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Value,
    /// Exact UTF-8 request body used by Feishu and Slack signature checks.
    #[serde(default)]
    pub raw_body: String,
    /// Optional deterministic receipt time for generated IDs and timestamps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_at: Option<String>,
}

fn default_method() -> String {
    "POST".into()
}

impl Default for InboundRequest {
    fn default() -> Self {
        Self {
            method: default_method(),
            headers: BTreeMap::new(),
            query: BTreeMap::new(),
            body: Value::Null,
            raw_body: String::new(),
            received_at: None,
        }
    }
}

impl InboundRequest {
    pub fn json(body: Value) -> Self {
        let raw_body = serde_json::to_string(&body).unwrap_or_default();
        let mut request = Self {
            body,
            raw_body,
            ..Self::default()
        };
        request
            .headers
            .insert("content-type".into(), "application/json".into());
        request
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers
            .insert(name.into().to_ascii_lowercase(), value.into());
        self
    }

    pub fn with_query(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.insert(name.into(), value.into());
        self
    }

    pub fn header(&self, name: &str) -> &str {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
            .unwrap_or_default()
    }

    pub fn query(&self, name: &str) -> &str {
        self.query.get(name).map_or("", |value| value.trim())
    }

    pub fn raw_body(&self) -> String {
        if !self.raw_body.is_empty() {
            self.raw_body.clone()
        } else if self.body.is_null() {
            String::new()
        } else {
            serde_json::to_string(&self.body).unwrap_or_default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEventAttachment {
    pub name: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

/// Normalized inbound event, matching Electron's `ChannelEvent` shape plus
/// transport-only reply metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEvent {
    pub connector_type: ConnectorType,
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub message_id: String,
    pub sender_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChannelEventAttachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_webhook_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InboundOutcome {
    Ignored,
    JsonChallenge { body: Value },
    TextChallenge { body: String },
    Message { event: Box<ChannelEvent> },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InboundError {
    #[error("invalid IM webhook signature or secret")]
    Unauthorized,
    #[error("invalid IM webhook payload: {0}")]
    InvalidPayload(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundHttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineResponse {
    pub content_type: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutboundPlan {
    None,
    Http {
        request: OutboundHttpRequest,
    },
    Inline {
        response: InlineResponse,
    },
    FeishuAppReply {
        token_request: OutboundHttpRequest,
        message_id: String,
        text: String,
    },
}
