//! HTTP-level regression checks shared by the three OpenCode adapters.

use crate::{ChatOptions, LlmMessage, LlmRole, Provider, StreamChunk};
use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub(crate) fn opencode_client(address: std::net::SocketAddr) -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .resolve("opencode.ai", address)
        .build()
        .unwrap()
}

async fn read_request(socket: &mut TcpStream) -> (String, String) {
    let mut buffer = Vec::new();
    loop {
        let mut chunk = [0u8; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(count > 0);
        buffer.extend_from_slice(&chunk[..count]);
        if let Some(end) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..end]).to_string();
            let length = header(&head, "content-length")
                .unwrap()
                .parse::<usize>()
                .unwrap();
            if buffer.len() >= end + 4 + length {
                return (
                    head,
                    String::from_utf8_lossy(&buffer[end + 4..]).to_string(),
                );
            }
        }
    }
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// Exercise the actual adapter, including its retry loop and SSE parser.
/// The first request fails transiently; two turns share a conversation ID,
/// a fork uses another ID, and a standalone operation gets an independent ID.
pub(crate) async fn assert_opencode_sessions(
    provider: &dyn Provider,
    listener: TcpListener,
    path: &'static str,
    sse: &'static str,
) {
    let server = tokio::spawn(async move {
        let mut sessions = Vec::new();
        for index in 0..5 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (head, body) = read_request(&mut socket).await;
            assert!(head.starts_with(&format!("POST {path} HTTP/1.1")));
            assert_eq!(header(&head, "authorization"), Some("Bearer test-key"));
            assert_eq!(
                header(&head, "user-agent"),
                Some(concat!("WorldBase/", env!("CARGO_PKG_VERSION")))
            );
            if path.ends_with("/messages") {
                assert_eq!(header(&head, "x-api-key"), Some("test-key"));
                assert_eq!(header(&head, "anthropic-version"), Some("2023-06-01"));
            }
            let session = header(&head, "x-opencode-session").unwrap().to_string();
            assert!(!session.is_empty());
            sessions.push(session);
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert!(
                body.get("session_id").is_none(),
                "session identity belongs in headers"
            );
            let (status, content_type, payload) = if index == 0 {
                (
                    "503 Service Unavailable",
                    "application/json",
                    r#"{"error":{"message":"temporary"}}"#,
                )
            } else {
                ("200 OK", "text/event-stream", sse)
            };
            socket.write_all(format!(
                "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            ).as_bytes()).await.unwrap();
        }
        sessions
    });
    for session in [
        Some("conversation-a"),
        Some("conversation-a"),
        Some("conversation-fork"),
        None,
    ] {
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                Vec::new(),
                16,
                ChatOptions {
                    session_id: session.map(str::to_owned),
                    ..ChatOptions::default()
                },
            )
            .await
            .unwrap();
        let mut completed = false;
        while let Some(chunk) = stream.next().await {
            if let StreamChunk::Completed { assistant, .. } = chunk.unwrap() {
                assert_eq!(assistant.text_view(), "ok");
                completed = true;
            }
        }
        assert!(completed);
    }
    let sessions = server.await.unwrap();
    assert_eq!(
        &sessions[..3],
        &["conversation-a", "conversation-a", "conversation-a"]
    );
    assert_eq!(sessions[3], "conversation-fork");
    assert!(uuid::Uuid::parse_str(&sessions[4]).is_ok());
}
