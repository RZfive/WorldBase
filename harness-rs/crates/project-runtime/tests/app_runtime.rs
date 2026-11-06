use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use worldbase_project_runtime::{
    discover_at, invoke_at, list_manifests, load_manifest, manifest_hash, validate_manifest,
    ProjectRuntime, APP_RPC_DISCOVERY_PATH, APP_RPC_INVOKE_PATH, MAX_APP_RPC_RESPONSE_BYTES,
};
use worldbase_protocol::types::{AppManifest, CallContext};

struct CapturedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Option<Value>,
}

struct FakeResponse {
    status: &'static str,
    body: String,
    delay: Duration,
}

impl FakeResponse {
    fn json(status: &'static str, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }
}

async fn spawn_server(response: FakeResponse) -> (u16, oneshot::Receiver<CapturedRequest>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let header_end = loop {
            let read = match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(end) = buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
            {
                break end;
            }
            if buffer.len() > 1024 * 1024 {
                return;
            }
        };
        let headers = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        while buffer.len() < header_end + content_length {
            let read = match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            buffer.extend_from_slice(&chunk[..read]);
        }
        let body_end = (header_end + content_length).min(buffer.len());
        let body = (!buffer[header_end..body_end].is_empty())
            .then(|| serde_json::from_slice(&buffer[header_end..body_end]).ok())
            .flatten();
        let mut request_line = headers
            .lines()
            .next()
            .unwrap_or_default()
            .split_whitespace();
        let method = request_line.next().unwrap_or_default().to_string();
        let path = request_line.next().unwrap_or_default().to_string();
        let authorization = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("authorization") {
                Some(value.trim().to_string())
            } else {
                None
            }
        });
        let _ = sender.send(CapturedRequest {
            method,
            path,
            authorization,
            body,
        });
        if !response.delay.is_zero() {
            tokio::time::sleep(response.delay).await;
        }
        let payload = response.body.as_bytes();
        let head = format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response.status,
            payload.len()
        );
        let _ = stream.write_all(head.as_bytes()).await;
        let _ = stream.write_all(payload).await;
        let _ = stream.shutdown().await;
    });
    (port, receiver)
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture(name: &str) -> String {
    fs::read_to_string(fixtures_dir().join(name)).unwrap()
}

fn fixture_manifest(name: &str) -> AppManifest {
    serde_json::from_str(&fixture(name)).unwrap()
}

fn write_project(root: &Path, manifest_text: &str) {
    fs::create_dir_all(root.join(".worldbase")).unwrap();
    fs::write(root.join(".worldbase/app-capabilities.json"), manifest_text).unwrap();
}

#[test]
fn manifest_fixtures_load_validate_list_and_reject_invalid_entries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let project = root.join("demo");
    write_project(&project, &fixture("valid-manifest.json"));

    let manifest = load_manifest(&project).unwrap().unwrap();
    assert_eq!(manifest.app.id, "worldbase.tasks");
    assert_eq!(
        manifest.runtime.health_check.as_deref(),
        Some("tasks.health")
    );
    validate_manifest(&manifest).unwrap();

    let listed = list_manifests(root).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].0, "demo");
    assert_eq!(listed[0].1.app.id, "worldbase.tasks");

    for (name, expected) in [
        ("invalid-remote-ref.json", "remote $ref"),
        ("invalid-health-check.json", "healthCheck"),
        ("invalid-managed-builtin.json", "builtin"),
        ("invalid-signature.json", "signature"),
    ] {
        let invalid = root.join("invalid");
        write_project(&invalid, &fixture(name));
        let error = load_manifest(&invalid).unwrap_err().to_string();
        assert!(error.contains(expected), "{name}: {error}");
    }

    let invalid = root.join("invalid");
    write_project(&invalid, &fixture("invalid-remote-ref.json"));
    let listed = list_manifests(root).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].0, "demo");
}

#[test]
fn manifest_hash_is_signature_independent_and_signature_verifies() {
    let manifest = fixture_manifest("valid-manifest.json");
    let hash = manifest_hash(&manifest).unwrap();
    assert_eq!(hash.len(), 64);
    assert_eq!(hash, manifest_hash(&manifest).unwrap());
    validate_manifest(&manifest).unwrap();

    let mut signed = manifest.clone();
    signed.app.signature = Some(hash.clone());
    assert_eq!(hash, manifest_hash(&signed).unwrap());
    validate_manifest(&signed).unwrap();

    signed.app.version = "9.9.9".into();
    let errors = validate_manifest(&signed).unwrap_err();
    assert!(errors.iter().any(|error| error.contains("signature")));
}

#[test]
fn revoked_manifests_are_rejected_by_id_and_hash() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("demo");
    write_project(&project, &fixture("valid-manifest.json"));
    fs::write(
        project.join(".worldbase/app-revocations.json"),
        fixture("revoked-apps.json"),
    )
    .unwrap();
    let error = load_manifest(&project).unwrap_err().to_string();
    assert!(error.contains("revoked"), "{error}");

    let hash = manifest_hash(&fixture_manifest("valid-manifest.json")).unwrap();
    fs::write(
        project.join(".worldbase/app-revocations.json"),
        json!({ "hashes": [hash] }).to_string(),
    )
    .unwrap();
    let error = load_manifest(&project).unwrap_err().to_string();
    assert!(error.contains("revoked"), "{error}");
}

#[test]
fn app_tokens_are_per_project_stable_and_validated() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = ProjectRuntime::new(dir.path().to_path_buf());
    assert!(runtime.app_token("one").is_none());

    let one = runtime.ensure_app_token("one").unwrap();
    let two = runtime.ensure_app_token("two").unwrap();
    assert_ne!(one, two);
    assert_eq!(one, runtime.ensure_app_token("one").unwrap());
    assert_eq!(runtime.app_token("one"), Some(one));
    assert_eq!(runtime.app_token("two"), Some(two));
    assert!(runtime.ensure_app_token("../escape").is_err());
}

#[tokio::test]
async fn invoke_sends_authenticated_envelope_and_parses_result() {
    let manifest = fixture_manifest("valid-manifest.json");
    let (port, receiver) = spawn_server(FakeResponse::json(
        "200 OK",
        json!({
            "status": "ok",
            "data": { "found": 1 },
            "warnings": ["truncated"]
        }),
    ))
    .await;
    let ctx = CallContext {
        call_id: "call-1".into(),
        conversation_id: Some("conversation-1".into()),
        app_id: manifest.app.id.clone(),
        data_scope: Vec::new(),
        deadline_ms: 5_000,
        idempotency_key: Some("idem-1".into()),
    };

    let result = invoke_at(
        port,
        "secret-token",
        &manifest,
        "tasks.search",
        json!({ "query": "roadmap" }),
        &ctx,
    )
    .await
    .unwrap();
    assert_eq!(result.status, "ok");
    assert_eq!(result.data["found"], 1);
    assert_eq!(result.warnings, vec!["truncated"]);
    assert_eq!(result.app.as_ref().unwrap().id, "worldbase.tasks");

    let request = receiver.await.unwrap();
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, APP_RPC_INVOKE_PATH);
    assert_eq!(
        request.authorization.as_deref(),
        Some("Bearer secret-token")
    );
    let body = request.body.unwrap();
    assert_eq!(body["protocolVersion"], 1);
    assert_eq!(body["callId"], "call-1");
    assert_eq!(body["capabilityId"], "tasks.search");
    assert_eq!(body["idempotencyKey"], "idem-1");
    assert_eq!(body["input"]["query"], "roadmap");
    assert!(body["deadline"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn invoke_rejects_undeclared_capability_before_network() {
    let manifest = fixture_manifest("valid-manifest.json");
    let error = invoke_at(
        9,
        "secret-token",
        &manifest,
        "tasks.delete",
        json!({}),
        &CallContext::default(),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("capability_not_found"), "{error}");
}

#[tokio::test]
async fn invoke_deadline_maps_to_operation_timeout() {
    let manifest = fixture_manifest("valid-manifest.json");
    let (port, _receiver) = spawn_server(FakeResponse {
        status: "200 OK",
        body: json!({ "status": "ok", "data": {} }).to_string(),
        delay: Duration::from_millis(400),
    })
    .await;
    let ctx = CallContext {
        deadline_ms: 60,
        ..CallContext::default()
    };
    let started = std::time::Instant::now();
    let error = invoke_at(
        port,
        "secret-token",
        &manifest,
        "tasks.search",
        json!({}),
        &ctx,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("operation_timeout"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn invoke_rejects_oversized_responses() {
    let manifest = fixture_manifest("valid-manifest.json");
    let (port, _receiver) = spawn_server(FakeResponse {
        status: "200 OK",
        body: "x".repeat(MAX_APP_RPC_RESPONSE_BYTES + 16),
        delay: Duration::ZERO,
    })
    .await;
    let error = invoke_at(
        port,
        "secret-token",
        &manifest,
        "tasks.search",
        json!({}),
        &CallContext::default(),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("response_too_large"), "{error}");
}

#[tokio::test]
async fn invoke_maps_http_and_application_errors() {
    let manifest = fixture_manifest("valid-manifest.json");
    let (port, _receiver) = spawn_server(FakeResponse::json(
        "401 Unauthorized",
        json!({
            "status": "error",
            "errorCode": "permission_required",
            "message": "invalid app token"
        }),
    ))
    .await;
    let error = invoke_at(
        port,
        "wrong-token",
        &manifest,
        "tasks.search",
        json!({}),
        &CallContext::default(),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("permission_required"), "{error}");

    let (port, _receiver) = spawn_server(FakeResponse::json(
        "200 OK",
        json!({
            "status": "error",
            "errorCode": "app_unhealthy",
            "message": "database unavailable"
        }),
    ))
    .await;
    let error = invoke_at(
        port,
        "secret-token",
        &manifest,
        "tasks.search",
        json!({}),
        &CallContext::default(),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("app_unhealthy"), "{error}");
    assert!(error.contains("database unavailable"), "{error}");
}

#[tokio::test]
async fn discovery_reads_manifest_and_handles_missing_descriptor() {
    let body: Value = serde_json::from_str(&fixture("valid-manifest.json")).unwrap();
    let (port, receiver) = spawn_server(FakeResponse::json("200 OK", body)).await;
    let manifest = discover_at(port, Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(manifest.app.id, "worldbase.tasks");
    let request = receiver.await.unwrap();
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, APP_RPC_DISCOVERY_PATH);

    let (missing_port, _receiver) = spawn_server(FakeResponse {
        status: "404 Not Found",
        body: "{}".into(),
        delay: Duration::ZERO,
    })
    .await;
    assert!(discover_at(missing_port, Duration::from_secs(2))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn app_health_without_a_runtime_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("demo");
    write_project(&project, &fixture("valid-manifest.json"));
    let runtime = ProjectRuntime::new(dir.path().to_path_buf());

    let manifest = runtime.app_manifest("demo").unwrap().unwrap();
    assert_eq!(manifest.app.id, "worldbase.tasks");
    let listed = runtime.list_app_manifests().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].0, "demo");

    let health = runtime.app_health("demo").await.unwrap();
    assert_eq!(health.status, "unavailable");
}
