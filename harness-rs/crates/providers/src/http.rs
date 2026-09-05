use anyhow::{bail, Context, Result};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use reqwest::{header::RETRY_AFTER, Client, RequestBuilder, Response, StatusCode};
use std::pin::Pin;
use std::time::Duration;

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_ATTEMPTS: usize = 3;
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

pub(crate) type ByteStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send + 'static>>;

#[cfg(not(test))]
const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
#[cfg(test)]
const RETRY_BASE_DELAY: Duration = Duration::from_millis(10);

pub(crate) fn client() -> Client {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(STREAM_IDLE_TIMEOUT)
        .build()
        .expect("static provider HTTP client configuration must be valid")
}

pub(crate) async fn send_with_retry<F>(provider: &str, request: F) -> Result<Response>
where
    F: FnMut() -> RequestBuilder,
{
    send_with_retry_timeout(provider, REQUEST_TIMEOUT, request).await
}

pub(crate) async fn send_with_retry_timeout<F>(
    provider: &str,
    request_timeout: Duration,
    mut request: F,
) -> Result<Response>
where
    F: FnMut() -> RequestBuilder,
{
    send_fallible_with_retry_timeout(provider, request_timeout, || Ok(request())).await
}

pub(crate) async fn send_fallible_with_retry_timeout<F>(
    provider: &str,
    request_timeout: Duration,
    mut request: F,
) -> Result<Response>
where
    F: FnMut() -> Result<RequestBuilder>,
{
    for attempt in 1..=MAX_ATTEMPTS {
        let request = request().with_context(|| format!("failed to build {provider} request"))?;
        match tokio::time::timeout(request_timeout, request.send()).await {
            Ok(Ok(response)) => {
                if is_retryable_status(response.status()) && attempt < MAX_ATTEMPTS {
                    let delay = retry_delay(attempt, &response);
                    drop(response);
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Ok(response);
            }
            Ok(Err(error)) => {
                if is_retryable_error(&error) && attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                return Err(error).with_context(|| {
                    format!("{provider} request failed after {attempt} attempt(s)")
                });
            }
            Err(_) if attempt < MAX_ATTEMPTS => {
                tokio::time::sleep(backoff(attempt)).await;
            }
            Err(_) => {
                bail!(
                    "{provider} request timed out waiting for response headers after {}s ({attempt} attempts)",
                    request_timeout.as_secs()
                );
            }
        }
    }

    unreachable!("the bounded retry loop always returns on its final attempt")
}

pub(crate) fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub(crate) async fn next_stream_chunk(
    provider: &str,
    stream: &mut ByteStream,
) -> Result<Option<Bytes>> {
    next_stream_chunk_with_timeout(provider, stream, STREAM_IDLE_TIMEOUT).await
}

async fn next_stream_chunk_with_timeout(
    provider: &str,
    stream: &mut ByteStream,
    idle_timeout: Duration,
) -> Result<Option<Bytes>> {
    match tokio::time::timeout(idle_timeout, stream.next()).await {
        Ok(Some(Ok(chunk))) => Ok(Some(chunk)),
        Ok(Some(Err(error))) => {
            Err(error).with_context(|| format!("{provider} stream read failed"))
        }
        Ok(None) => Ok(None),
        Err(_) => bail!(
            "{provider} stream idle timed out after {}s",
            idle_timeout.as_secs_f64()
        ),
    }
}

fn is_retryable_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_request()
}

fn retry_delay(attempt: usize, response: &Response) -> Duration {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .map(|delay| delay.min(MAX_RETRY_AFTER))
        .unwrap_or_else(|| backoff(attempt))
}

fn backoff(attempt: usize) -> Duration {
    RETRY_BASE_DELAY.saturating_mul(1 << attempt.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn retry_statuses_cover_transient_http_failures_only() {
        for status in [408, 429, 500, 501, 503, 511] {
            assert!(is_retryable_status(StatusCode::from_u16(status).unwrap()));
        }
        for status in [400, 401, 404, 409, 422] {
            assert!(!is_retryable_status(StatusCode::from_u16(status).unwrap()));
        }
    }

    #[tokio::test]
    async fn retries_transient_response_before_returning_success() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for status in ["503 Service Unavailable", "200 OK"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let _ = socket.read(&mut request).await.unwrap();
                let body = if status.starts_with("200") {
                    "ready"
                } else {
                    "retry"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let client = client();
        let url = format!("http://{address}/retry");
        let response = send_with_retry("test", || client.get(&url)).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "ready");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn retries_a_connection_that_closes_before_response_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = first.read(&mut request).await.unwrap();
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            let _ = second.read(&mut request).await.unwrap();
            second
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await
                .unwrap();
        });

        let client = client();
        let url = format!("http://{address}/network-retry");
        let response = send_with_retry("test", || client.get(&url)).await.unwrap();

        assert_eq!(response.text().await.unwrap(), "ok");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stream_reads_fail_after_the_idle_deadline() {
        let mut stream: ByteStream = Box::pin(futures::stream::pending());

        let error = next_stream_chunk_with_timeout("test", &mut stream, Duration::from_millis(1))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("stream idle timed out"));
    }
}
