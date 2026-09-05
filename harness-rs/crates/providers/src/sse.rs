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
    buf: Vec<u8>,
    current_event: Option<String>,
    current_data: Vec<String>,
    saw_first_line: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw network bytes and return complete events. Keeping incomplete
    /// lines as bytes ensures a multi-byte UTF-8 codepoint may span chunks
    /// without being replaced by U+FFFD.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, std::str::Utf8Error> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();

        while let Some(pos) = self.buf.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = std::str::from_utf8(&line)?;
            // The SSE specification permits one UTF-8 BOM at the start of the
            // stream. TextDecoder removes it for Electron; match that behavior
            // so the first `data:` field is not silently ignored in Rust.
            let line = if self.saw_first_line {
                line
            } else {
                self.saw_first_line = true;
                line.strip_prefix('\u{feff}').unwrap_or(line)
            };
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
                self.current_data
                    .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            }
            // 其他字段（id:/retry:/注释）忽略
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_across_chunk_boundaries() {
        let mut p = SseParser::new();
        // 事件 1 被拆到两个 chunk
        assert!(p.feed(b"event: content_block_de").unwrap().is_empty());
        let e1 = p.feed(b"lta\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(e1.len(), 1);
        assert_eq!(e1[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(e1[0].data, "{\"a\":1}");
    }

    #[test]
    fn multiple_data_lines_joined() {
        let mut p = SseParser::new();
        let evs = p.feed(b"data: line1\ndata: line2\n\n").unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "line1\nline2");
    }

    #[test]
    fn ignores_comments_and_unknown_fields() {
        let mut p = SseParser::new();
        let evs = p.feed(b": ping\nid: 5\ndata: x\n\n").unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "x");
    }

    #[test]
    fn preserves_utf8_codepoints_split_across_chunks() {
        let mut parser = SseParser::new();
        let wire = "data: {\"text\":\"上海\"}\n\n".as_bytes();
        let split = wire.iter().position(|byte| *byte >= 0x80).unwrap() + 1;

        assert!(parser.feed(&wire[..split]).unwrap().is_empty());
        let events = parser.feed(&wire[split..]).unwrap();

        assert_eq!(events[0].data, "{\"text\":\"上海\"}");
        assert!(!events[0].data.contains('\u{fffd}'));
    }

    #[test]
    fn ignores_a_utf8_bom_split_across_network_chunks() {
        let mut parser = SseParser::new();
        let wire = b"\xef\xbb\xbfdata: {\"text\":\"ready\"}\n\n";

        assert!(parser.feed(&wire[..1]).unwrap().is_empty());
        assert!(parser.feed(&wire[1..2]).unwrap().is_empty());
        let events = parser.feed(&wire[2..]).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"text\":\"ready\"}");
    }

    #[test]
    fn rejects_invalid_utf8_instead_of_replacing_it() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b"data: \xff\n\n").is_err());
    }
}
