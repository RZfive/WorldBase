//! Agent-loop integration with the per-run application tool catalog.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use worldbase_core::agent::{run_scheduled_task_with_context, start_chat};
use worldbase_core::hub::Hub;
use worldbase_protocol::types::{
    AppHealth, ApplicationRecord, CallContext, Capabilities, CapabilityAvailability,
    CapabilityRecord, CapabilityResult, CapabilityRisk, ChatRunContext, RuntimeKind, RuntimeLease,
    TrustLevel,
};
use worldbase_providers::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
    TokenUsage,
};
use worldbase_tools::{ApplicationCapabilityProvider, ToolCatalogRuntime, ToolServices};

struct TestContext {
    hub: Arc<Hub>,
    provider: Arc<ScriptedProvider>,
    conversation_id: String,
    _dir: tempfile::TempDir,
}

#[derive(Clone)]
struct CapturedRequest {
    system: String,
    tool_names: Vec<String>,
    dynamic_system_suffix: Option<String>,
}

struct ScriptedProvider {
    turns: Mutex<VecDeque<LlmMessage>>,
    requests: Mutex<Vec<CapturedRequest>>,
}

impl ScriptedProvider {
    fn new(turns: Vec<LlmMessage>) -> Self {
        Self {
            turns: Mutex::new(turns.into()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<CapturedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "application-agent-scripted"
    }

    fn model(&self) -> &str {
        "application-agent-model"
    }

    async fn chat_stream(
        &self,
        system: Option<&str>,
        messages: Vec<LlmMessage>,
        tools: Vec<LlmTool>,
        _max_tokens: u32,
        options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        let prompt = messages
            .iter()
            .rev()
            .find(|message| message.role == LlmRole::User)
            .map(LlmMessage::text_view)
            .unwrap_or_default();
        self.requests.lock().unwrap().push(CapturedRequest {
            system: system.unwrap_or_default().to_string(),
            tool_names: tools.iter().map(|tool| tool.name.clone()).collect(),
            dynamic_system_suffix: options.dynamic_system_suffix.clone(),
        });
        let assistant = self
            .turns
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("unexpected extra model request for {prompt}"))?;
        let stop_reason = if assistant.tool_uses().is_empty() {
            "end_turn"
        } else {
            "tool_use"
        };
        Ok(Box::pin(futures::stream::iter([Ok(
            StreamChunk::Completed {
                stop_reason: stop_reason.into(),
                assistant,
                usage: TokenUsage::default(),
            },
        )])))
    }
}

struct GatedProvider {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl Provider for GatedProvider {
    fn name(&self) -> &str {
        "application-agent-gated"
    }

    fn model(&self) -> &str {
        "application-agent-gated-model"
    }

    async fn chat_stream(
        &self,
        _system: Option<&str>,
        _messages: Vec<LlmMessage>,
        _tools: Vec<LlmTool>,
        _max_tokens: u32,
        _options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(Box::pin(futures::stream::iter([Ok(
            StreamChunk::Completed {
                stop_reason: "end_turn".into(),
                assistant: assistant_text("done"),
                usage: TokenUsage::default(),
            },
        )])))
    }
}

struct EchoProvider;

#[async_trait]
impl ApplicationCapabilityProvider for EchoProvider {
    fn provider_ref(&self) -> &str {
        "test.echo"
    }

    async fn health(&self, _app: &ApplicationRecord) -> anyhow::Result<AppHealth> {
        Ok(AppHealth::ready())
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        _ctx: &CallContext,
    ) -> anyhow::Result<RuntimeLease> {
        Ok(RuntimeLease {
            lease_id: "lease".into(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: RuntimeKind::HostService,
        })
    }

    async fn invoke(
        &self,
        _capability: &CapabilityRecord,
        input: Value,
        _ctx: &CallContext,
        _services: &ToolServices,
    ) -> anyhow::Result<CapabilityResult> {
        Ok(CapabilityResult::ok(input))
    }
}

fn assistant_text(text: &str) -> LlmMessage {
    LlmMessage {
        role: LlmRole::Assistant,
        content: vec![ContentBlock::Text { text: text.into() }],
    }
}

fn tool_call(id: &str, name: &str, input: Value) -> ContentBlock {
    ContentBlock::ToolUse {
        id: id.into(),
        name: name.into(),
        input,
        raw_input: None,
        input_error: None,
    }
}

fn assistant_with_tool(name: &str, input: Value) -> LlmMessage {
    LlmMessage {
        role: LlmRole::Assistant,
        content: vec![tool_call("call-1", name, input)],
    }
}

fn app_record() -> ApplicationRecord {
    ApplicationRecord {
        source_id: "test:echo".into(),
        app_id: "test.echo".into(),
        name: "Echo".into(),
        version: "1.0.0".into(),
        description: "Echo test app".into(),
        tags: vec!["echo".into()],
        trust_level: TrustLevel::Builtin,
        enabled: true,
        platforms: Vec::new(),
        runtime_kind: RuntimeKind::HostService,
        capabilities: vec![CapabilityRecord {
            app_id: "test.echo".into(),
            capability_id: "echo".into(),
            tool_name: "app__test_echo__echo".into(),
            title: "Echo".into(),
            description: "Echo back the input payload".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "message": { "type": "string" } }
            }),
            output_schema: None,
            risk: CapabilityRisk::Read,
            permissions: Vec::new(),
            data_scopes: Vec::new(),
            provider_ref: "test.echo".into(),
            availability: CapabilityAvailability::Available,
            side_effects: false,
            idempotent: true,
            deadline_ms: None,
        }],
        health: AppHealth::ready(),
        last_seen_at: None,
        manifest_hash: String::new(),
        ai_ready: true,
    }
}

fn setup(turns: Vec<LlmMessage>) -> TestContext {
    let dir = tempfile::tempdir().expect("create test dir");
    let store = Arc::new(
        worldbase_memory::Store::open(&dir.path().join("app.sqlite")).expect("open test store"),
    );
    let conversation_id = store
        .create_conversation("application agent", None)
        .expect("create conversation")
        .id;
    let hub = Hub::new(dir.path().to_path_buf(), store).expect("create hub");
    let provider = Arc::new(ScriptedProvider::new(turns));
    hub.set_custom_provider(provider.clone());
    TestContext {
        hub,
        provider,
        conversation_id,
        _dir: dir,
    }
}

fn setup_with_skill(
    turns: Vec<LlmMessage>,
    skill_name: &str,
    description: &str,
    instructions: &str,
) -> TestContext {
    let dir = tempfile::tempdir().expect("create test dir");
    let skill_dir = dir.path().join(".worldbase").join("skills");
    std::fs::create_dir_all(&skill_dir).expect("create skill dir");
    std::fs::write(
        skill_dir.join(format!("{skill_name}.md")),
        format!("---\nname: {skill_name}\ndescription: {description}\n---\n\n{instructions}\n"),
    )
    .expect("write skill");
    let store = Arc::new(
        worldbase_memory::Store::open(&dir.path().join("app.sqlite")).expect("open test store"),
    );
    let conversation_id = store
        .create_conversation("application skill", None)
        .expect("create conversation")
        .id;
    let hub = Hub::new(dir.path().to_path_buf(), store).expect("create hub");
    let provider = Arc::new(ScriptedProvider::new(turns));
    hub.set_custom_provider(provider.clone());
    TestContext {
        hub,
        provider,
        conversation_id,
        _dir: dir,
    }
}

fn start(ctx: &TestContext) -> worldbase_core::agent::ChatRun {
    start_chat(
        ctx.hub.clone(),
        ctx.conversation_id.clone(),
        "exercise the catalog".into(),
        Vec::new(),
        Capabilities::desktop(),
        false,
        None,
        None,
        None,
        ChatRunContext::default(),
    )
    .expect("start chat")
}

async fn wait_for_catalog(hub: &Hub, token: &str) -> Arc<dyn ToolCatalogRuntime> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(catalog) = hub.lookup_run_catalog(token) {
                return catalog;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("run catalog was not registered")
}

async fn wait_for_run_end(hub: &Hub, stream_id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !hub.runs.lock().unwrap().contains_key(stream_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("run did not clean up");
}

#[tokio::test]
async fn application_agent_discoverable_app_is_hidden_until_search_activates_it() {
    let ctx = setup(vec![
        assistant_with_tool("search_tools", json!({ "query": "echo" })),
        assistant_text("done"),
    ]);
    ctx.hub
        .application_registry
        .register(app_record(), Arc::new(EchoProvider))
        .expect("register app");

    let run = start(&ctx);
    wait_for_run_end(&ctx.hub, &run.stream_id).await;

    let requests = ctx.provider.requests();
    assert!(requests.len() >= 2, "expected at least two model turns");
    let first = &requests[0].tool_names;
    assert!(first.iter().any(|name| name == "search_tools"));
    assert!(first.iter().any(|name| name == "read_file"));
    assert!(
        !first.iter().any(|name| name == "app__test_echo__echo"),
        "discoverable capability leaked into the initial catalog: {first:?}"
    );

    let second = &requests[1].tool_names;
    assert!(
        second.iter().any(|name| name == "app__test_echo__echo"),
        "search did not activate the capability for the next turn: {second:?}"
    );
    assert!(second.iter().any(|name| name == "search_tools"));
    assert!(
        second.iter().any(|name| name == "read_file"),
        "always-on tools must stay in the catalog"
    );
}

#[tokio::test]
async fn application_agent_search_tools_survives_agent_allow_and_deny_lists() {
    let ctx = setup(vec![assistant_text("done")]);
    let run = start_chat(
        ctx.hub.clone(),
        ctx.conversation_id.clone(),
        "respect the agent policy".into(),
        Vec::new(),
        Capabilities::desktop(),
        false,
        None,
        None,
        None,
        ChatRunContext {
            allowed_tool_names: vec!["read_file".into()],
            denied_tool_names: vec!["search_tools".into()],
            ..Default::default()
        },
    )
    .expect("start chat");
    wait_for_run_end(&ctx.hub, &run.stream_id).await;

    let requests = ctx.provider.requests();
    let tools = &requests[0].tool_names;
    assert!(
        tools.iter().any(|name| name == "search_tools"),
        "search_tools must survive an agent deny list: {tools:?}"
    );
    assert!(tools.iter().any(|name| name == "read_file"));
    assert!(
        !tools.iter().any(|name| name == "write_file"),
        "the agent allow list must still hide other always-on tools: {tools:?}"
    );
}

#[tokio::test]
async fn application_agent_search_activates_skill_instructions_into_the_dynamic_suffix() {
    let ctx = setup_with_skill(
        vec![
            assistant_with_tool("search_tools", json!({ "query": "release notes" })),
            assistant_text("done"),
        ],
        "release-notes",
        "Write release notes",
        "Always mention the changelog.",
    );

    let run = start(&ctx);
    wait_for_run_end(&ctx.hub, &run.stream_id).await;

    let requests = ctx.provider.requests();
    assert!(requests.len() >= 2, "expected at least two model turns");
    let first_suffix = requests[0].dynamic_system_suffix.as_deref();
    assert!(
        first_suffix.is_none_or(|suffix| !suffix.contains("Always mention the changelog.")),
        "skill instructions leaked before activation: {first_suffix:?}"
    );
    let second_suffix = requests[1]
        .dynamic_system_suffix
        .as_deref()
        .unwrap_or_default();
    assert!(
        second_suffix.contains("## Active skills"),
        "activated skill was not added to the dynamic suffix: {second_suffix:?}"
    );
    assert!(
        second_suffix.contains("Always mention the changelog."),
        "skill instructions missing from the dynamic suffix: {second_suffix:?}"
    );
}

#[tokio::test]
async fn application_agent_run_token_resolves_catalog_and_is_cleaned_up() {
    let dir = tempfile::tempdir().expect("create test dir");
    let store = Arc::new(
        worldbase_memory::Store::open(&dir.path().join("app.sqlite")).expect("open test store"),
    );
    let conversation_id = store
        .create_conversation("application token", None)
        .expect("create conversation")
        .id;
    let hub = Hub::new(dir.path().to_path_buf(), store).expect("create hub");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    hub.set_custom_provider(Arc::new(GatedProvider {
        started: started.clone(),
        release: release.clone(),
    }));

    let run = start_chat(
        hub.clone(),
        conversation_id,
        "hold the run".into(),
        Vec::new(),
        Capabilities::desktop(),
        false,
        None,
        None,
        None,
        ChatRunContext::default(),
    )
    .expect("start chat");
    let token = run.run_capability_token.clone();
    assert!(!token.is_empty());
    assert_eq!(
        hub.run_capability_token_for_stream(&run.stream_id),
        Some(token.clone()),
        "chat.send must be able to resolve the token synchronously"
    );

    tokio::time::timeout(Duration::from_secs(10), started.notified())
        .await
        .expect("provider did not start");
    let catalog = wait_for_catalog(&hub, &token).await;
    assert!(catalog.active_tool_names().is_empty());
    assert!(hub
        .run_tool_catalogs
        .lock()
        .unwrap()
        .contains_key(&run.stream_id));

    release.notify_one();
    wait_for_run_end(&hub, &run.stream_id).await;

    assert!(
        hub.lookup_run_catalog(&token).is_none(),
        "token must not resolve after the run ends"
    );
    assert!(hub
        .run_capability_token_for_stream(&run.stream_id)
        .is_none());
    assert!(!hub
        .run_tool_catalogs
        .lock()
        .unwrap()
        .contains_key(&run.stream_id));
}

#[tokio::test]
async fn application_agent_abort_removes_the_run_catalog_and_token() {
    let dir = tempfile::tempdir().expect("create test dir");
    let store = Arc::new(
        worldbase_memory::Store::open(&dir.path().join("app.sqlite")).expect("open test store"),
    );
    let conversation_id = store
        .create_conversation("application abort", None)
        .expect("create conversation")
        .id;
    let hub = Hub::new(dir.path().to_path_buf(), store).expect("create hub");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    hub.set_custom_provider(Arc::new(GatedProvider {
        started: started.clone(),
        release: release.clone(),
    }));

    let run = start_chat(
        hub.clone(),
        conversation_id,
        "abort the run".into(),
        Vec::new(),
        Capabilities::desktop(),
        false,
        None,
        None,
        None,
        ChatRunContext::default(),
    )
    .expect("start chat");
    let token = run.run_capability_token.clone();

    tokio::time::timeout(Duration::from_secs(10), started.notified())
        .await
        .expect("provider did not start");
    let _catalog = wait_for_catalog(&hub, &token).await;

    let abort = hub
        .runs
        .lock()
        .unwrap()
        .get(&run.stream_id)
        .map(|run| run.abort.clone())
        .expect("run handle");
    abort.cancel();
    wait_for_run_end(&hub, &run.stream_id).await;

    assert!(hub.lookup_run_catalog(&token).is_none());
    assert!(!hub
        .run_tool_catalogs
        .lock()
        .unwrap()
        .contains_key(&run.stream_id));
    release.notify_one();
}

#[tokio::test]
async fn application_agent_subagent_inherits_parent_active_tools() {
    let ctx = setup(vec![
        assistant_with_tool("search_tools", json!({ "query": "echo" })),
        assistant_with_tool(
            "spawn_subagents",
            json!({
                "tasks": [{
                    "description": "child",
                    "prompt": "inspect the inherited catalog"
                }]
            }),
        ),
        assistant_text("child done"),
        assistant_text("parent done"),
    ]);
    ctx.hub
        .application_registry
        .register(app_record(), Arc::new(EchoProvider))
        .expect("register app");

    let run = start(&ctx);
    wait_for_run_end(&ctx.hub, &run.stream_id).await;

    let requests = ctx.provider.requests();
    assert!(
        requests.len() >= 4,
        "expected parent/child model turns, got {}",
        requests.len()
    );
    let child = requests
        .iter()
        .find(|request| {
            request
                .system
                .contains("spawned subagent at nesting depth 1")
        })
        .expect("child request was not captured");
    assert!(
        child
            .tool_names
            .iter()
            .any(|name| name == "app__test_echo__echo"),
        "child did not inherit the parent's active capability: {:?}",
        child.tool_names
    );
}

#[tokio::test]
async fn application_agent_scheduled_run_builds_and_cleans_its_run_catalog() {
    let dir = tempfile::tempdir().expect("create test dir");
    let store = Arc::new(
        worldbase_memory::Store::open(&dir.path().join("app.sqlite")).expect("open test store"),
    );
    let hub = Hub::new(dir.path().to_path_buf(), store).expect("create hub");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    hub.set_custom_provider(Arc::new(GatedProvider {
        started: started.clone(),
        release: release.clone(),
    }));

    let task_hub = hub.clone();
    let task = tokio::spawn(async move {
        run_scheduled_task_with_context(
            task_hub,
            "schedule-1",
            "catalog test",
            "run the scheduled task",
            None,
            None,
            ChatRunContext::default(),
        )
        .await
    });

    tokio::time::timeout(Duration::from_secs(10), started.notified())
        .await
        .expect("scheduled provider did not start");
    assert_eq!(
        hub.run_tool_catalogs.lock().unwrap().len(),
        1,
        "scheduled runs must register a run catalog, not a separate static catalog"
    );
    assert_eq!(hub.run_tokens.lock().unwrap().len(), 1);

    release.notify_one();
    task.await
        .expect("scheduled task panicked")
        .expect("scheduled task failed");
    assert!(hub.run_tool_catalogs.lock().unwrap().is_empty());
    assert!(hub.run_tokens.lock().unwrap().is_empty());
}

#[tokio::test]
async fn builtin_application_capabilities_are_searchable() {
    let ctx = setup(vec![
        assistant_with_tool("search_tools", json!({ "query": "document" })),
        assistant_text("done"),
    ]);

    let run = start(&ctx);
    wait_for_run_end(&ctx.hub, &run.stream_id).await;

    let requests = ctx.provider.requests();
    assert!(requests.len() >= 2, "expected at least two model turns");
    let second = &requests[1].tool_names;
    assert!(
        second
            .iter()
            .any(|name| name.starts_with("app__worldbase_documents__")),
        "builtin document capabilities were not activated: {second:?}"
    );
}
