//! 跨网络 chunk 的 SSE 解析器。
//!
//! TCP chunk 与 SSE 事件边界不对齐，必须先按行缓冲再解析；
//! P0 版本按 chunk 直接 `lines()` 导致事件被截断，这里修复。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: String,
    current_event: Option<String>,
    current_data: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段 UTF-8 文本，返回解析完整的事件。
    pub fn feed(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buf.push_str(chunk);
        let mut events = Vec::new();

        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                // 空行 = 事件结束
                if !self.current_data.is_empty() {
                    events.push(SseEvent {
                        event: self.current_event.take(),
                        data: self.current_data.join("\n"),
                    });
                    self.current_data.clear();
                } else {
                    self.current_event = None;
                }
                continue;
            }
            if let Some(rest) = line.strip_prefix("event:") {
                self.current_event = Some(rest.trim_start().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.current_data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            }
            // 其他字段（id:/retry:/注释）忽略
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_across_chunk_boundaries() {
        let mut p = SseParser::new();
        // 事件 1 被拆到两个 chunk
        assert!(p.feed("event: content_block_de").is_empty());
        let e1 = p.feed("lta\ndata: {\"a\":1}\n\n");
        assert_eq!(e1.len(), 1);
        assert_eq!(e1[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(e1[0].data, "{\"a\":1}");
    }

    #[test]
    fn multiple_data_lines_joined() {
        let mut p = SseParser::new();
        let evs = p.feed("data: line1\ndata: line2\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "line1\nline2");
    }

    #[test]
    fn ignores_comments_and_unknown_fields() {
        let mut p = SseParser::new();
        let evs = p.feed(": ping\nid: 5\ndata: x\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "x");
    }
}
