//! JSON-RPC 方法名常量与能力域划分。
//!
//! 域（domain）：`core` 全端可用；`desktop` 域方法/工具在移动端握手（excludes
//! subprocess / port_binding）时被过滤。

pub const INITIALIZE: &str = "initialize";
pub const PING: &str = "ping";
pub const SHUTDOWN: &str = "shutdown";

pub const CONVERSATION_CREATE: &str = "conversation.create";
pub const CONVERSATION_ENSURE: &str = "conversation.ensure";
pub const CONVERSATION_LIST: &str = "conversation.list";
pub const CONVERSATION_MESSAGES: &str = "conversation.messages";
pub const CONVERSATION_SYNC: &str = "conversation.sync";
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
pub const MEMORY_INGEST: &str = "memory.ingest";
/// Electron Agent Workspace memory catalog methods.
pub const MEMORY_LIST: &str = "memory.list";
pub const MEMORY_SAVE: &str = "memory.save";
pub const MEMORY_PIN: &str = "memory.pin";
pub const MEMORY_COMPACT: &str = "memory.compact";
pub const MEMORY_COMPACT_STATUS: &str = "memory.compactStatus";

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
/// Return the Rust-owned MCP connection snapshot used by Electron Settings.
pub const MCP_STATUS: &str = "mcp.status";
/// Connect and rediscover one MCP server, or every enabled server.
pub const MCP_REFRESH: &str = "mcp.refresh";
/// Drop one Rust-owned MCP connection while retaining its discovered metadata.
pub const MCP_DISCONNECT: &str = "mcp.disconnect";

pub const DOC_PARSE: &str = "doc.parse";
pub const DOC_WRITE: &str = "doc.write";

pub const PROJECT_LIST: &str = "project.list";
pub const PROJECT_CREATE: &str = "project.create";
pub const PROJECT_DEV_START: &str = "project.dev.start";
pub const PROJECT_DEV_STOP: &str = "project.dev.stop";
pub const PROJECT_STATUS: &str = "project.status";
pub const PROJECT_GET: &str = "project.get";
pub const PROJECT_TREE: &str = "project.tree";
pub const PROJECT_FILE_READ: &str = "project.file.read";
pub const PROJECT_FILE_WRITE: &str = "project.file.write";
pub const PROJECT_META_UPDATE: &str = "project.meta.update";
pub const PROJECT_DELETE: &str = "project.delete";
pub const PROJECT_BUILD_RUN: &str = "project.build.run";
pub const PROJECT_BUILD_CLEANUP: &str = "project.build.cleanup";
pub const PROJECT_BUILD_REBUILD: &str = "project.build.rebuild";
pub const PROJECT_BUILD_NEEDS_REBUILD: &str = "project.build.needsRebuild";
pub const PROJECT_GATEWAY_SERVICE_MAP: &str = "project.gateway.serviceMap";
pub const PROJECT_GATEWAY_START_ALL: &str = "project.gateway.startAll";
pub const PROJECT_GATEWAY_STOP_ALL: &str = "project.gateway.stopAll";
pub const PROJECT_GATEWAY_SET_RESTART_POLICY: &str = "project.gateway.setRestartPolicy";
pub const PROJECT_PROCESS_SNAPSHOT: &str = "project.process.snapshot";
pub const PROJECT_PROCESS_RESTART: &str = "project.process.restart";
pub const PROJECT_PROCESS_STOP: &str = "project.process.stop";
pub const PROJECT_PROCESS_FORCE_KILL: &str = "project.process.forceKill";
pub const PROJECT_PROCESS_KILL_ORPHAN: &str = "project.process.killOrphan";
pub const PROJECT_PROCESS_CLEANUP_ORPHANS: &str = "project.process.cleanupOrphans";
pub const PROJECT_DATA_QUERY: &str = "project.data.query";
pub const PROJECT_DATA_SUMMARY: &str = "project.data.summary";
pub const PROJECT_DATA_LIST_ALL: &str = "project.data.listAll";
pub const PROJECT_DATA_QUERY_TABLE: &str = "project.data.queryTable";
pub const PROJECT_DATA_SCHEMA: &str = "project.data.schema";
pub const PROJECT_DATA_TABLES: &str = "project.data.tables";
pub const PROJECT_DATA_RECORDS_QUERY: &str = "project.data.records.query";
pub const PROJECT_DATA_RECORDS_SAVE: &str = "project.data.records.save";
pub const PROJECT_LOGS: &str = "project.logs";
/// Append a browser/application log to the Rust-owned project runtime buffer.
/// Electron uses the assigned runtime port rather than a project id because
/// console events identify the loaded local-app URL.
pub const PROJECT_LOGS_APPEND: &str = "project.logs.append";
pub const PROJECT_ANALYZE: &str = "project.analyze";
pub const PROJECT_PACKAGE_EXPORT: &str = "project.package.export";
pub const PROJECT_PACKAGE_IMPORT: &str = "project.package.import";

/// Rust-owned preview APIs for an Electron-selected folder workspace.
pub const WORKSPACE_LIST: &str = "workspace.list";
pub const WORKSPACE_READ: &str = "workspace.read";

pub const EXEC_RUN: &str = "exec.run";

// 供应商 / Agent / Studio / 分叉 / 宿主应答（对齐桌面端能力）
pub const PROVIDER_LIST: &str = "provider.list";
pub const PROVIDER_FETCH_MODELS: &str = "provider.fetchModels";
pub const PROVIDER_SAVE: &str = "provider.save";
pub const PROVIDER_DELETE: &str = "provider.delete";
pub const PROVIDER_SET_ACTIVE: &str = "provider.setActive";

pub const AGENT_LIST: &str = "agent.list";
pub const AGENT_GET: &str = "agent.get";
pub const AGENT_SAVE: &str = "agent.save";
pub const AGENT_DELETE: &str = "agent.delete";

/// Durable Agent Workspace group catalog (distinct from the live `group.*`
/// collaboration-session methods above).
pub const AGENT_GROUP_LIST: &str = "agentGroup.list";
pub const AGENT_GROUP_GET: &str = "agentGroup.get";
pub const AGENT_GROUP_SAVE: &str = "agentGroup.save";
pub const AGENT_GROUP_DELETE: &str = "agentGroup.delete";

pub const STUDIO_GENERATE: &str = "studio.generate";
pub const STUDIO_PROMPT_OPTIMIZE: &str = "studio.prompt.optimize";
pub const STUDIO_LIST: &str = "studio.list";
pub const STUDIO_DELETE: &str = "studio.delete";
pub const STUDIO_TAG: &str = "studio.tag";
pub const STUDIO_FOLDER: &str = "studio.folder";
/// Rust-owned Image Studio library API.  The older `studio.*` methods remain
/// as compact compatibility aliases for mobile and existing integrations.
pub const STUDIO_LIBRARY_QUERY: &str = "studio.library.query";
pub const STUDIO_LIBRARY_READ: &str = "studio.library.read";
pub const STUDIO_LIBRARY_DELETE_MANY: &str = "studio.library.deleteMany";
pub const STUDIO_LIBRARY_SET_FOLDER: &str = "studio.library.setFolder";
pub const STUDIO_LIBRARY_SET_TAGS: &str = "studio.library.setTags";
pub const STUDIO_LIBRARY_LIST_FOLDERS: &str = "studio.library.listFolders";
pub const STUDIO_LIBRARY_CREATE_FOLDER: &str = "studio.library.createFolder";
pub const STUDIO_LIBRARY_RENAME_FOLDER: &str = "studio.library.renameFolder";
pub const STUDIO_LIBRARY_DELETE_FOLDER: &str = "studio.library.deleteFolder";
pub const STUDIO_LIBRARY_LIST_TAGS: &str = "studio.library.listTags";
pub const STUDIO_LIBRARY_EXPORT: &str = "studio.library.export";
/// Rust-owned workbench queue persistence/handoff APIs.  The renderer remains
/// responsible for its visual concurrency scheduler, while queue state and
/// native-agent handoff live in the selected harness.
pub const STUDIO_TASKS_LOAD: &str = "studio.tasks.load";
pub const STUDIO_TASKS_SAVE: &str = "studio.tasks.save";
pub const STUDIO_TASKS_DRAIN: &str = "studio.tasks.drain";

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
        PROJECT_LIST
        | PROJECT_CREATE
        | PROJECT_DEV_START
        | PROJECT_DEV_STOP
        | PROJECT_STATUS
        | PROJECT_GET
        | PROJECT_TREE
        | PROJECT_FILE_READ
        | PROJECT_FILE_WRITE
        | PROJECT_META_UPDATE
        | PROJECT_DELETE
        | PROJECT_BUILD_RUN
        | PROJECT_BUILD_CLEANUP
        | PROJECT_BUILD_REBUILD
        | PROJECT_BUILD_NEEDS_REBUILD
        | PROJECT_GATEWAY_SERVICE_MAP
        | PROJECT_GATEWAY_START_ALL
        | PROJECT_GATEWAY_STOP_ALL
        | PROJECT_GATEWAY_SET_RESTART_POLICY
        | PROJECT_PROCESS_SNAPSHOT
        | PROJECT_PROCESS_RESTART
        | PROJECT_PROCESS_STOP
        | PROJECT_PROCESS_FORCE_KILL
        | PROJECT_PROCESS_KILL_ORPHAN
        | PROJECT_PROCESS_CLEANUP_ORPHANS
        | PROJECT_DATA_QUERY
        | PROJECT_DATA_SUMMARY
        | PROJECT_DATA_LIST_ALL
        | PROJECT_DATA_QUERY_TABLE
        | PROJECT_DATA_SCHEMA
        | PROJECT_DATA_TABLES
        | PROJECT_DATA_RECORDS_QUERY
        | PROJECT_DATA_RECORDS_SAVE
        | PROJECT_LOGS
        | PROJECT_LOGS_APPEND
        | PROJECT_ANALYZE
        | PROJECT_PACKAGE_EXPORT
        | PROJECT_PACKAGE_IMPORT
        | WORKSPACE_LIST
        | WORKSPACE_READ
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
    CONVERSATION_ENSURE,
    CONVERSATION_SYNC,
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
    MEMORY_INGEST,
    MEMORY_LIST,
    MEMORY_SAVE,
    MEMORY_PIN,
    MEMORY_COMPACT,
    MEMORY_COMPACT_STATUS,
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
    MCP_STATUS,
    MCP_REFRESH,
    MCP_DISCONNECT,
    DOC_PARSE,
    DOC_WRITE,
    PROJECT_LIST,
    PROJECT_CREATE,
    PROJECT_DEV_START,
    PROJECT_DEV_STOP,
    PROJECT_STATUS,
    PROJECT_GET,
    PROJECT_TREE,
    PROJECT_FILE_READ,
    PROJECT_FILE_WRITE,
    PROJECT_META_UPDATE,
    PROJECT_DELETE,
    PROJECT_BUILD_RUN,
    PROJECT_BUILD_CLEANUP,
    PROJECT_BUILD_REBUILD,
    PROJECT_BUILD_NEEDS_REBUILD,
    PROJECT_GATEWAY_SERVICE_MAP,
    PROJECT_GATEWAY_START_ALL,
    PROJECT_GATEWAY_STOP_ALL,
    PROJECT_GATEWAY_SET_RESTART_POLICY,
    PROJECT_PROCESS_SNAPSHOT,
    PROJECT_PROCESS_RESTART,
    PROJECT_PROCESS_STOP,
    PROJECT_PROCESS_FORCE_KILL,
    PROJECT_PROCESS_KILL_ORPHAN,
    PROJECT_PROCESS_CLEANUP_ORPHANS,
    PROJECT_DATA_QUERY,
    PROJECT_DATA_SUMMARY,
    PROJECT_DATA_LIST_ALL,
    PROJECT_DATA_QUERY_TABLE,
    PROJECT_DATA_SCHEMA,
    PROJECT_DATA_TABLES,
    PROJECT_DATA_RECORDS_QUERY,
    PROJECT_DATA_RECORDS_SAVE,
    PROJECT_LOGS,
    PROJECT_LOGS_APPEND,
    PROJECT_ANALYZE,
    PROJECT_PACKAGE_EXPORT,
    PROJECT_PACKAGE_IMPORT,
    WORKSPACE_LIST,
    WORKSPACE_READ,
    EXEC_RUN,
    PROVIDER_LIST,
    PROVIDER_FETCH_MODELS,
    PROVIDER_SAVE,
    PROVIDER_DELETE,
    PROVIDER_SET_ACTIVE,
    AGENT_LIST,
    AGENT_GET,
    AGENT_SAVE,
    AGENT_DELETE,
    AGENT_GROUP_LIST,
    AGENT_GROUP_GET,
    AGENT_GROUP_SAVE,
    AGENT_GROUP_DELETE,
    STUDIO_GENERATE,
    STUDIO_PROMPT_OPTIMIZE,
    STUDIO_LIST,
    STUDIO_DELETE,
    STUDIO_TAG,
    STUDIO_FOLDER,
    STUDIO_LIBRARY_QUERY,
    STUDIO_LIBRARY_READ,
    STUDIO_LIBRARY_DELETE_MANY,
    STUDIO_LIBRARY_SET_FOLDER,
    STUDIO_LIBRARY_SET_TAGS,
    STUDIO_LIBRARY_LIST_FOLDERS,
    STUDIO_LIBRARY_CREATE_FOLDER,
    STUDIO_LIBRARY_RENAME_FOLDER,
    STUDIO_LIBRARY_DELETE_FOLDER,
    STUDIO_LIBRARY_LIST_TAGS,
    STUDIO_LIBRARY_EXPORT,
    STUDIO_TASKS_LOAD,
    STUDIO_TASKS_SAVE,
    STUDIO_TASKS_DRAIN,
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
