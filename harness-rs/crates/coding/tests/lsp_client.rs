use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf,
};
use tokio::sync::oneshot;
use tokio::time::timeout;
use worldbase_coding::lsp_client::{LspClient, LspServerConfig};
use worldbase_coding::{DiagnosticSeverity, PublishDiagnosticsParams};

struct FakeServer {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl FakeServer {
    fn new(stream: DuplexStream) -> Self {
        let (reader, writer) = tokio::io::split(stream);
        Self {
            reader: BufReader::new(reader),
            writer,
        }
    }

    async fn recv(&mut self) -> Option<Value> {
        let mut content_length = None;
        loop {
            let mut line = Vec::new();
            let read = self
                .reader
                .read_until(b'\n', &mut line)
                .await
                .expect("read LSP header");
            if read == 0 {
                return None;
            }
            if line == b"\r\n" {
                break;
            }
            let line = String::from_utf8(line).expect("UTF-8 LSP header");
            if let Some(value) = line.trim_end().strip_prefix("Content-Length:") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .expect("numeric Content-Length"),
                );
            }
        }

        let length = content_length.expect("Content-Length header");
        let mut body = vec![0_u8; length];
        self.reader
            .read_exact(&mut body)
            .await
            .expect("read LSP body");
        Some(serde_json::from_slice(&body).expect("JSON LSP body"))
    }

    async fn send(&mut self, message: Value) {
        let body = serde_json::to_vec(&message).expect("serialize LSP message");
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.writer
            .write_all(header.as_bytes())
            .await
            .expect("write LSP header");
        self.writer.write_all(&body).await.expect("write LSP body");
        self.writer.flush().await.expect("flush LSP frame");
    }

    async fn send_raw(&mut self, bytes: &[u8]) {
        self.writer
            .write_all(bytes)
            .await
            .expect("write raw LSP bytes");
        self.writer.flush().await.expect("flush raw LSP bytes");
    }

    async fn respond(&mut self, id: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await;
    }
}

fn config() -> LspServerConfig {
    LspServerConfig {
        program: "unused-language-server".into(),
        args: Vec::new(),
        root_uri: "file:///workspace".into(),
        initialization_options: Some(json!({ "strict": true })),
    }
}

fn start_pair() -> (LspClient, FakeServer) {
    let (client_stream, server_stream) = tokio::io::duplex(1 << 20);
    let (reader, writer) = tokio::io::split(client_stream);
    let client = LspClient::with_transport(reader, writer, config()).expect("build LSP client");
    (client, FakeServer::new(server_stream))
}

async fn initialize_pair(client: &LspClient, server: &mut FakeServer) -> Value {
    let (result, params) = tokio::join!(client.initialize(), async {
        let request = server.recv().await.expect("initialize request");
        assert_eq!(request["jsonrpc"], "2.0");
        assert_eq!(request["method"], "initialize");
        assert!(request["id"].is_u64());
        assert!(request["params"]["processId"].is_u64());
        assert_eq!(request["params"]["rootUri"], "file:///workspace");
        assert_eq!(
            request["params"]["initializationOptions"],
            json!({ "strict": true })
        );
        let id = request["id"].clone();
        server
            .respond(&id, json!({ "capabilities": { "textDocumentSync": 1 } }))
            .await;

        let initialized = server.recv().await.expect("initialized notification");
        assert_eq!(initialized["jsonrpc"], "2.0");
        assert_eq!(initialized["method"], "initialized");
        assert_eq!(initialized["params"], json!({}));
        request["params"].clone()
    });

    let result = result.expect("initialize response");
    assert_eq!(result["capabilities"]["textDocumentSync"], 1);
    params
}

async fn shutdown_pair(client: &mut LspClient, server: &mut FakeServer) {
    let (result, ()) = tokio::join!(client.shutdown(), async {
        let request = server.recv().await.expect("shutdown request");
        assert_eq!(request["method"], "shutdown");
        let id = request["id"].clone();
        server.respond(&id, Value::Null).await;

        let exit = server.recv().await.expect("exit notification");
        assert_eq!(exit["method"], "exit");
    });
    result.expect("shutdown");
}

async fn wait_for_version(
    client: &LspClient,
    path: &Path,
    version: i64,
) -> PublishDiagnosticsParams {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match client
            .diagnostics_for(path, Duration::from_millis(50))
            .await
        {
            Ok(params) if params.version == Some(version) => return params,
            Ok(_) => {}
            Err(error) => {
                assert!(
                    error.to_string().contains("timed out"),
                    "diagnostics failed: {error:#}"
                );
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for diagnostics version {version}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn initialize_performs_handshake_and_sends_initialized() {
    let (mut client, mut server) = start_pair();
    let params = initialize_pair(&client, &mut server).await;

    assert_eq!(params["rootUri"], "file:///workspace");
    assert_eq!(
        params["capabilities"]["workspace"]["configuration"],
        json!(true)
    );
    assert_eq!(
        params["capabilities"]["textDocument"]["publishDiagnostics"]["versionSupport"],
        json!(true)
    );

    shutdown_pair(&mut client, &mut server).await;
}

#[tokio::test]
async fn open_change_and_close_documents_send_versions() {
    let (mut client, mut server) = start_pair();
    initialize_pair(&client, &mut server).await;
    let path = Path::new("/workspace/src/App.ts");

    let (opened, ()) = tokio::join!(
        client.open_document(path, "typescript", "const value = 1;\n"),
        async {
            let message = server.recv().await.expect("didOpen notification");
            assert_eq!(message["method"], "textDocument/didOpen");
            let document = &message["params"]["textDocument"];
            assert_eq!(document["uri"], "file:///workspace/src/App.ts");
            assert_eq!(document["languageId"], "typescript");
            assert_eq!(document["version"], 1);
            assert_eq!(document["text"], "const value = 1;\n");
        }
    );
    opened.expect("open document");

    let (changed, ()) = tokio::join!(client.change_document(path, "const value = 2;\n"), async {
        let message = server.recv().await.expect("didChange notification");
        assert_eq!(message["method"], "textDocument/didChange");
        assert_eq!(
            message["params"]["textDocument"]["uri"],
            "file:///workspace/src/App.ts"
        );
        assert_eq!(message["params"]["textDocument"]["version"], 2);
        assert_eq!(
            message["params"]["contentChanges"][0]["text"],
            "const value = 2;\n"
        );
    });
    changed.expect("change document");

    assert!(client
        .change_document(Path::new("/workspace/src/Unopened.ts"), "")
        .await
        .is_err());

    let (closed, ()) = tokio::join!(client.close_document(path), async {
        let message = server.recv().await.expect("didClose notification");
        assert_eq!(message["method"], "textDocument/didClose");
        assert_eq!(
            message["params"]["textDocument"]["uri"],
            "file:///workspace/src/App.ts"
        );
    });
    closed.expect("close document");

    shutdown_pair(&mut client, &mut server).await;
}

#[tokio::test]
async fn publish_diagnostics_are_stored_normalized_and_replaced() {
    let (mut client, mut server) = start_pair();
    initialize_pair(&client, &mut server).await;
    let path = Path::new("/workspace/src/App.ts");
    let uri = "file:///workspace/src/App.ts";

    client
        .open_document(path, "typescript", "const value: number = 'x';\n")
        .await
        .expect("open document");
    let open = server.recv().await.expect("didOpen notification");
    assert_eq!(open["method"], "textDocument/didOpen");

    let diagnostic = json!({
        "range": {
            "start": { "line": 11, "character": 6 },
            "end": { "line": 11, "character": 7 }
        },
        "severity": 1,
        "code": "TS2304",
        "source": "typescript",
        "message": "Cannot find name 'missingValue'."
    });
    let warning = json!({
        "range": {
            "start": { "line": 0, "character": 0 },
            "end": { "line": 0, "character": 5 }
        },
        "severity": 2,
        "message": "Unused variable."
    });
    server
        .send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "version": 1,
                "diagnostics": [diagnostic.clone(), diagnostic, warning.clone()],
            }
        }))
        .await;

    let params = client
        .diagnostics_for(path, Duration::from_secs(1))
        .await
        .expect("published diagnostics");
    assert_eq!(params.uri, uri);
    assert_eq!(params.version, Some(1));
    assert_eq!(params.diagnostics.len(), 3, "raw publish keeps duplicates");

    let normalized = client
        .normalized_diagnostics_for(path, Duration::from_secs(1))
        .await
        .expect("normalized diagnostics");
    assert_eq!(normalized.len(), 2, "duplicate diagnostics are merged");
    assert_eq!(normalized[0].severity, DiagnosticSeverity::Error);
    assert_eq!(normalized[0].code.as_deref(), Some("TS2304"));
    assert_eq!(normalized[0].file.as_deref(), Some(path));
    assert_eq!(normalized[0].line, Some(12));
    assert_eq!(normalized[0].column, Some(7));
    assert_eq!(normalized[0].message, "Cannot find name 'missingValue'.");
    assert_eq!(normalized[1].severity, DiagnosticSeverity::Warning);

    client
        .change_document(path, "const value: number = 2;\n")
        .await
        .expect("change document");
    let change = server.recv().await.expect("didChange notification");
    assert_eq!(change["method"], "textDocument/didChange");
    assert_eq!(change["params"]["textDocument"]["version"], 2);

    server
        .send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "version": 2,
                "diagnostics": [warning],
            }
        }))
        .await;

    let replaced = wait_for_version(&client, path, 2).await;
    assert_eq!(replaced.diagnostics.len(), 1);
    assert_eq!(replaced.diagnostics[0].severity, Some(2));

    server
        .send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "version": 1,
                "diagnostics": [{
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 0, "character": 1 }
                    },
                    "severity": 1,
                    "message": "stale diagnostic"
                }]
            }
        }))
        .await;
    server
        .send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": "file:///workspace/src/Other.ts",
                "version": 1,
                "diagnostics": []
            }
        }))
        .await;
    client
        .diagnostics_for(Path::new("/workspace/src/Other.ts"), Duration::from_secs(1))
        .await
        .expect("second document diagnostics");

    let after_stale = client
        .diagnostics_for(path, Duration::from_secs(1))
        .await
        .expect("diagnostics after stale publish");
    assert_eq!(
        after_stale.version,
        Some(2),
        "older published versions must not replace newer diagnostics"
    );
    assert_eq!(after_stale.diagnostics.len(), 1);

    shutdown_pair(&mut client, &mut server).await;
}

#[tokio::test]
async fn matches_response_ids_and_tolerates_server_requests() {
    let (client, mut server) = start_pair();
    let (ready_tx, ready_rx) = oneshot::channel();

    let server_task = tokio::spawn(async move {
        let initialize = server.recv().await.expect("initialize request");
        let id = initialize["id"].clone();

        server
            .send(json!({
                "jsonrpc": "2.0",
                "id": 9999,
                "result": { "unexpected": true }
            }))
            .await;
        server
            .respond(&id, json!({ "capabilities": { "textDocumentSync": 1 } }))
            .await;

        let initialized = server.recv().await.expect("initialized notification");
        assert_eq!(initialized["method"], "initialized");

        server
            .send(json!({
                "jsonrpc": "2.0",
                "id": "cfg-1",
                "method": "workspace/configuration",
                "params": { "items": [{ "section": "typescript" }] }
            }))
            .await;
        let configuration = server.recv().await.expect("configuration response");
        assert_eq!(configuration["id"], "cfg-1");
        assert_eq!(configuration["result"], Value::Null);
        assert!(configuration.get("error").is_none());

        server
            .send(json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "custom/unknown",
                "params": {}
            }))
            .await;
        let unknown = server.recv().await.expect("unknown request response");
        assert_eq!(unknown["id"], 7);
        assert_eq!(unknown["error"]["code"], -32601);
        assert!(unknown["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("custom/unknown"));

        server
            .send(json!({
                "jsonrpc": "2.0",
                "method": "$/progress",
                "params": {}
            }))
            .await;
        ready_tx.send(()).expect("signal client");

        let open = server.recv().await.expect("didOpen notification");
        assert_eq!(open["method"], "textDocument/didOpen");
        server
            .send(json!({
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": "file:///workspace/src/App.ts",
                    "version": 1,
                    "diagnostics": []
                }
            }))
            .await;
    });

    let path = Path::new("/workspace/src/App.ts");
    let (params, ()) = tokio::join!(
        async move {
            let result = client.initialize().await.expect("initialize response");
            assert_eq!(result["capabilities"]["textDocumentSync"], 1);

            ready_rx.await.expect("server ready");
            client
                .open_document(path, "typescript", "let value = 1;")
                .await
                .expect("open document");
            client
                .diagnostics_for(path, Duration::from_secs(1))
                .await
                .expect("diagnostics after server requests")
        },
        async move {
            server_task.await.expect("server task");
        }
    );

    assert_eq!(params.version, Some(1));
    assert!(params.diagnostics.is_empty());
}

#[tokio::test]
async fn malformed_json_frame_returns_error_without_hanging() {
    let (client, mut server) = start_pair();
    initialize_pair(&client, &mut server).await;
    let path = Path::new("/workspace/src/App.ts");

    let (failed, ()) = tokio::join!(
        async {
            timeout(
                Duration::from_secs(2),
                client.diagnostics_for(path, Duration::from_secs(60)),
            )
            .await
            .expect("diagnostics wait must not hang")
        },
        async {
            server.send_raw(b"Content-Length: 5\r\n\r\n{oops").await;
        }
    );

    let error = failed.expect_err("malformed JSON must fail the wait");
    assert!(
        error.to_string().contains("invalid JSON"),
        "unexpected error: {error:#}"
    );
}

#[tokio::test]
async fn missing_content_length_returns_error_without_hanging() {
    let (client, mut server) = start_pair();
    initialize_pair(&client, &mut server).await;
    let path = Path::new("/workspace/src/App.ts");

    let (failed, ()) = tokio::join!(
        async {
            timeout(
                Duration::from_secs(2),
                client.diagnostics_for(path, Duration::from_secs(60)),
            )
            .await
            .expect("diagnostics wait must not hang")
        },
        async {
            server
                .send_raw(b"Content-Type: application/vscode-jsonrpc\r\n\r\n")
                .await;
        }
    );

    let error = failed.expect_err("missing Content-Length must fail the wait");
    assert!(
        error.to_string().contains("Content-Length"),
        "unexpected error: {error:#}"
    );
}

#[tokio::test]
async fn eof_returns_error_without_hanging() {
    let (client, mut server) = start_pair();
    initialize_pair(&client, &mut server).await;
    let path = Path::new("/workspace/src/App.ts");
    drop(server);

    let failed = timeout(
        Duration::from_secs(2),
        client.diagnostics_for(path, Duration::from_secs(60)),
    )
    .await
    .expect("diagnostics wait must not hang")
    .expect_err("EOF must fail the wait");

    assert!(
        failed.to_string().contains("closed the connection"),
        "unexpected error: {failed:#}"
    );
}

#[tokio::test]
async fn diagnostics_timeout_returns_error_and_reader_remains_usable() {
    let (mut client, mut server) = start_pair();
    initialize_pair(&client, &mut server).await;
    let path = Path::new("/workspace/src/App.ts");

    let failed = timeout(
        Duration::from_secs(2),
        client.diagnostics_for(path, Duration::from_millis(75)),
    )
    .await
    .expect("diagnostics wait must not hang")
    .expect_err("diagnostics must time out");
    assert!(
        failed.to_string().contains("timed out"),
        "unexpected error: {failed:#}"
    );

    server
        .send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": "file:///workspace/src/App.ts",
                "diagnostics": [{
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 0, "character": 1 }
                    },
                    "severity": 1,
                    "message": "late diagnostic"
                }]
            }
        }))
        .await;

    let params = client
        .diagnostics_for(path, Duration::from_secs(1))
        .await
        .expect("late diagnostics");
    assert_eq!(params.diagnostics.len(), 1);
    assert_eq!(params.diagnostics[0].message, "late diagnostic");

    shutdown_pair(&mut client, &mut server).await;
}

#[tokio::test]
#[ignore = "requires WORLDBASE_LSP_TEST_PROGRAM to point at a language server"]
async fn real_language_server_process_round_trip() {
    let Some(program) = std::env::var_os("WORLDBASE_LSP_TEST_PROGRAM") else {
        eprintln!("set WORLDBASE_LSP_TEST_PROGRAM to run this ignored test");
        return;
    };
    let args = std::env::var("WORLDBASE_LSP_TEST_ARGS")
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let root = std::env::current_dir().expect("current directory");
    let config = LspServerConfig {
        program: program.to_string_lossy().into_owned(),
        args,
        root_uri: worldbase_coding::path_to_file_uri(&root),
        initialization_options: None,
    };

    let mut client = LspClient::start(config)
        .await
        .expect("start language server");
    let result = client.initialize().await.expect("initialize");
    assert!(result.get("capabilities").is_some());
    client.shutdown().await.expect("shutdown");
}
