//! Exercise the real HTTP embedding adapter, not FakeEmbeddingProvider. All
//! requests use a loopback fixture; no credentials or real memories are sent.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use worldbase_memory::{EmbeddingProvider, MemoryEmbeddingQueue, OpenAIEmbeddingProvider, Store};
use worldbase_protocol::types::MemoryEmbeddingRuntimeConfig;

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start(handler: impl Fn(&Value) -> (u16, Value) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (body_start, content_length) = loop {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0, "embedding client closed before sending headers");
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        assert!(headers.starts_with("POST /v1/embeddings "));
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .expect("content-length");
                        break (end + 4, length);
                    }
                };
                while bytes.len() < body_start + content_length {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0, "embedding client closed before sending JSON");
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let payload: Value =
                    serde_json::from_slice(&bytes[body_start..body_start + content_length])
                        .unwrap();
                captured.lock().unwrap().push(payload.clone());
                let (status, response) = handler(&payload);
                let response = response.to_string();
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }

    fn provider(&self) -> OpenAIEmbeddingProvider {
        OpenAIEmbeddingProvider::new(
            "test",
            &self.url,
            "test-key",
            "test-embedding",
            Some(2),
            Some("cosine"),
            false,
            None,
            None,
        )
    }

    fn sizes(&self) -> Vec<usize> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|value| value["input"].as_array().unwrap().len())
            .collect()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn success(payload: &Value) -> (u16, Value) {
    // Return reverse order with request-local indices. Each HTTP response
    // restarts at index 0; the final output must still match the caller's order.
    let data = payload["input"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .rev()
        .map(|(index, value)| {
            let text = value.as_str().unwrap();
            let marker = text.parse::<f32>().unwrap_or(text.len() as f32);
            json!({ "index": index, "embedding": [marker, 1.0] })
        })
        .collect::<Vec<_>>();
    (200, json!({ "data": data }))
}

fn count_limited(payload: &Value, max: usize) -> (u16, Value) {
    let count = payload["input"].as_array().unwrap().len();
    if count <= max {
        return success(payload);
    }
    (
        400,
        json!({ "error": {
            "code": "InvalidParameter", "param": "input", "type": "BadRequest",
            "message": format!("The parameter `input` specified in the request are not valid: Embeddings API input limit exceeded: max {max}, got {count}. Request id: test-request")
        }}),
    )
}

fn inputs(count: usize) -> Vec<String> {
    (0..count).map(|index| index.to_string()).collect()
}
fn expected(count: usize) -> Vec<Vec<f32>> {
    (0..count).map(|index| vec![index as f32, 1.0]).collect()
}

#[tokio::test]
async fn twelve_inputs_split_into_ten_and_two_with_correct_vector_order() {
    let server = Server::start(|payload| count_limited(payload, 10)).await;
    let vectors = server
        .provider()
        .embed_documents(&inputs(12))
        .await
        .unwrap();
    assert_eq!(server.sizes(), vec![10, 2]);
    assert_eq!(vectors, expected(12));
}

#[tokio::test]
async fn larger_input_lists_are_bounded_and_empty_lists_do_not_call_the_api() {
    let server = Server::start(|payload| count_limited(payload, 10)).await;
    let provider = server.provider();
    assert!(provider.embed_documents(&[]).await.unwrap().is_empty());
    assert!(server.sizes().is_empty());
    assert_eq!(
        provider.embed_documents(&inputs(31)).await.unwrap(),
        expected(31)
    );
    assert_eq!(server.sizes(), vec![10, 10, 10, 1]);
}

#[tokio::test]
async fn smaller_reported_batch_limits_are_used_for_the_remaining_inputs() {
    let server = Server::start(|payload| count_limited(payload, 3)).await;
    assert_eq!(
        server
            .provider()
            .embed_documents(&inputs(12))
            .await
            .unwrap(),
        expected(12)
    );
    assert_eq!(server.sizes(), vec![10, 3, 3, 3, 3]);
}

#[tokio::test]
async fn payload_too_large_halves_batches_without_losing_order() {
    let server = Server::start(|payload| {
        if payload["input"].as_array().unwrap().len() > 2 {
            (413, json!({"error": {"message": "request body too large"}}))
        } else {
            success(payload)
        }
    })
    .await;
    assert_eq!(
        server
            .provider()
            .embed_documents(&inputs(12))
            .await
            .unwrap(),
        expected(12)
    );
    assert_eq!(server.sizes(), vec![10, 5, 2, 2, 2, 2, 2, 2]);
}

#[tokio::test]
async fn authentication_rate_limits_and_non_batch_errors_are_not_split_retried() {
    for (status, message) in [
        (401, "invalid API key"),
        (429, "rate limit exceeded"),
        (400, "invalid model"),
        (400, "input token limit exceeded: max 10, got 200"),
        (500, "internal server error"),
    ] {
        let server = Server::start(move |_| (status, json!({"error": {"message": message}}))).await;
        let error = server
            .provider()
            .embed_documents(&inputs(12))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(message),
            "keep useful diagnostics: {error}"
        );
        assert_eq!(
            server.sizes().len(),
            1,
            "do not amplify {status} into many requests"
        );
    }
}

#[tokio::test]
async fn singleton_and_invalid_batch_limits_terminate_without_looping() {
    for message in [
        "Embeddings API input limit exceeded: max 0, got 1",
        "Embeddings API input limit exceeded: max 10, got 12",
    ] {
        let server = Server::start(move |_| (400, json!({"error": {"message": message}}))).await;
        assert!(server.provider().embed_documents(&inputs(1)).await.is_err());
        assert_eq!(server.sizes(), vec![1]);
    }
}

#[tokio::test]
async fn malformed_response_indices_cannot_silently_attach_vectors_to_wrong_memories() {
    for indices in [[0, 0], [0, 2]] {
        let server = Server::start(move |_| (200, json!({"data": indices.iter().map(|index| json!({"index": index, "embedding": [1.0, 2.0]})).collect::<Vec<_>>()}))).await;
        assert!(server.provider().embed_documents(&inputs(2)).await.is_err());
        assert_eq!(server.sizes(), vec![2]);
    }
}

#[tokio::test]
async fn twelve_memories_reach_an_active_index_through_the_real_http_adapter() {
    let server = Server::start(|payload| count_limited(payload, 10)).await;
    let dir =
        std::env::temp_dir().join(format!("worldbase-http-embedding-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(Store::open(&dir.join("app.sqlite")).unwrap());
    for index in 0..12 {
        store
            .save_workspace_memory(
                &serde_json::from_value(json!({
                    "id": format!("fact-{index}"), "scopeType": "user", "scopeId": "local-user",
                    "title": format!("事实 {index}"), "summary": format!("用户保存的事实 {index}")
                }))
                .unwrap(),
            )
            .unwrap();
    }
    let queue = MemoryEmbeddingQueue::new(store.clone());
    queue
        .set_config(Some(MemoryEmbeddingRuntimeConfig {
            provider_id: "test".into(),
            base_url: server.url.clone(),
            api_key: "test-key".into(),
            model_id: "test-embedding".into(),
            dimensions: Some(2),
            distance: Some("cosine".into()),
            normalized: None,
            query_prefix: None,
            document_prefix: None,
        }))
        .await;
    assert_eq!(queue.drain_once().await, 12);
    let status = queue.index_status().await.unwrap();
    assert_eq!(status["state"], "ready", "{status}");
    assert_eq!(status["documents"]["indexed"], 12);
    assert_eq!(status["documents"]["failed"], 0);
    assert_eq!(
        store
            .count_embedding_jobs_by_status()
            .unwrap()
            .get("succeeded"),
        Some(&12)
    );
    assert_eq!(server.sizes(), vec![10, 2]);
    drop(queue);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
