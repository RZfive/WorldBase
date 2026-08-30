//! JSON-RPC 方法名常量与能力域划分。
//!
//! 域（domain）：`core` 全端可用；`desktop` 域方法/工具在移动端握手（excludes
//! subprocess / port_binding）时被过滤。

pub const INITIALIZE: &str = "initialize";
pub const PING: &str = "ping";
pub const SHUTDOWN: &str = "shutdown";

pub const CONVERSATION_CREATE: &str = "conversation.create";
pub const CONVERSATION_LIST: &str = "conversation.list";
pub const CONVERSATION_MESSAGES: &str = "conversation.messages";
pub const CONVERSATION_DELETE: &str = "conversation.delete";
pub const CONVERSATION_RENAME: &str = "conversation.rename";

pub const CHAT_SEND: &str = "chat.send";
pub const CHAT_RESUME: &str = "chat.resume";
pub const CHAT_ABORT: &str = "chat.abort";
/// 宿主应答权限询问。
pub const CHAT_RESPOND: &str = "chat.respond";

pub const TOOL_LIST: &str = "tool.list";
pub const TOOL_CALL: &str = "tool.call";

pub const SETTINGS_GET: &str = "settings.get";
pub const SETTINGS_SET: &str = "settings.set";

pub const MEMORY_SEARCH: &str = "memory.search";
pub const MEMORY_ADD: &str = "memory.add";
pub const MEMORY_DELETE: &str = "memory.delete";

pub const SKILL_LIST: &str = "skill.list";
pub const SKILL_RUN: &str = "skill.run";

pub const SCHEDULE_LIST: &str = "schedule.list";
pub const SCHEDULE_CREATE: &str = "schedule.create";
pub const SCHEDULE_DELETE: &str = "schedule.delete";
pub const SCHEDULE_RUN: &str = "schedule.run";

pub const GROUP_CREATE: &str = "group.create";
pub const GROUP_GET: &str = "group.get";
pub const GROUP_MESSAGE: &str = "group.message";
pub const GROUP_BLACKBOARD_ADD: &str = "group.blackboard.add";

pub const MCP_LIST: &str = "mcp.list";
pub const MCP_CALL: &str = "mcp.call";
pub const MCP_RELOAD: &str = "mcp.reload";

pub const DOC_PARSE: &str = "doc.parse";
pub const DOC_WRITE: &str = "doc.write";

pub const PROJECT_LIST: &str = "project.list";
pub const PROJECT_CREATE: &str = "project.create";
pub const PROJECT_DEV_START: &str = "project.dev.start";
pub const PROJECT_DEV_STOP: &str = "project.dev.stop";
pub const PROJECT_STATUS: &str = "project.status";

pub const EXEC_RUN: &str = "exec.run";

// 供应商 / Agent / Studio / 分叉 / 宿主应答（对齐桌面端能力）
pub const PROVIDER_LIST: &str = "provider.list";
pub const PROVIDER_SAVE: &str = "provider.save";
pub const PROVIDER_DELETE: &str = "provider.delete";
pub const PROVIDER_SET_ACTIVE: &str = "provider.setActive";

pub const AGENT_LIST: &str = "agent.list";
pub const AGENT_GET: &str = "agent.get";
pub const AGENT_SAVE: &str = "agent.save";
pub const AGENT_DELETE: &str = "agent.delete";

pub const STUDIO_GENERATE: &str = "studio.generate";
pub const STUDIO_LIST: &str = "studio.list";
pub const STUDIO_DELETE: &str = "studio.delete";
pub const STUDIO_TAG: &str = "studio.tag";
pub const STUDIO_FOLDER: &str = "studio.folder";

pub const USAGE_SUMMARY: &str = "usage.summary";

pub const LIGHTAPP_LIST: &str = "lightapp.list";
pub const LIGHTAPP_DELETE: &str = "lightapp.delete";

pub const CONVERSATION_FORK: &str = "conversation.fork";

pub const GROUP_INJECT: &str = "group.inject";
pub const GROUP_BOARD_UPDATE: &str = "group.board.update";

pub const SKILL_SAVE: &str = "skill.save";
pub const SKILL_DELETE: &str = "skill.delete";

/// 宿主应答反向请求。
pub const HOST_RESPOND: &str = "host.respond";

/// 反向请求（harness → 宿主）。
pub const HOST_ASK_USER: &str = "host.askUser";
pub const HOST_DIALOG: &str = "host.dialog";
pub const HOST_NOTIFY: &str = "host.notify";

/// 方法所属能力域。
pub fn method_domain(method: &str) -> &'static str {
    match method {
        PROJECT_LIST | PROJECT_CREATE | PROJECT_DEV_START | PROJECT_DEV_STOP | PROJECT_STATUS
        | EXEC_RUN => "desktop",
        _ => "core",
    }
}

/// 全部客户端可调方法（用于 method not found 快速判断与握手回报）。
pub const ALL_METHODS: &[&str] = &[
    INITIALIZE,
    PING,
    SHUTDOWN,
    CONVERSATION_CREATE,
    CONVERSATION_LIST,
    CONVERSATION_MESSAGES,
    CONVERSATION_DELETE,
    CONVERSATION_RENAME,
    CHAT_SEND,
    CHAT_RESUME,
    CHAT_ABORT,
    CHAT_RESPOND,
    TOOL_LIST,
    TOOL_CALL,
    SETTINGS_GET,
    SETTINGS_SET,
    MEMORY_SEARCH,
    MEMORY_ADD,
    MEMORY_DELETE,
    SKILL_LIST,
    SKILL_RUN,
    SCHEDULE_LIST,
    SCHEDULE_CREATE,
    SCHEDULE_DELETE,
    SCHEDULE_RUN,
    GROUP_CREATE,
    GROUP_GET,
    GROUP_MESSAGE,
    GROUP_BLACKBOARD_ADD,
    MCP_LIST,
    MCP_CALL,
    MCP_RELOAD,
    DOC_PARSE,
    DOC_WRITE,
    PROJECT_LIST,
    PROJECT_CREATE,
    PROJECT_DEV_START,
    PROJECT_DEV_STOP,
    PROJECT_STATUS,
    EXEC_RUN,
    PROVIDER_LIST,
    PROVIDER_SAVE,
    PROVIDER_DELETE,
    PROVIDER_SET_ACTIVE,
    AGENT_LIST,
    AGENT_GET,
    AGENT_SAVE,
    AGENT_DELETE,
    STUDIO_GENERATE,
    STUDIO_LIST,
    STUDIO_DELETE,
    STUDIO_TAG,
    STUDIO_FOLDER,
    USAGE_SUMMARY,
    LIGHTAPP_LIST,
    LIGHTAPP_DELETE,
    CONVERSATION_FORK,
    GROUP_INJECT,
    GROUP_BOARD_UPDATE,
    SKILL_SAVE,
    SKILL_DELETE,
    HOST_RESPOND,
];
