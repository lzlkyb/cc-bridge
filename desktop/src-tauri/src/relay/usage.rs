//! Read Anthropic usage from a bounded copy while the original response is forwarded.

use serde::{Deserialize, Serialize};

const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: Option<u64>,
    pub cache_write: Option<u64>,
    pub cache_read: Option<u64>,
    pub output: Option<u64>,
    pub partial: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageCollectionIssue {
    ResponseTooLarge,
    UnsupportedEncoding,
}

#[derive(Deserialize, Default)]
struct Counts {
    input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[derive(Deserialize, Default)]
struct Message {
    model: Option<String>,
    usage: Option<Counts>,
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type", default)]
    kind: String,
    message: Option<Message>,
    usage: Option<Counts>,
}

#[derive(Default)]
pub(super) struct ObservedUsage {
    pub tokens: Option<TokenUsage>,
    pub model: Option<String>,
    pub stream_error: bool,
    pub limit_reached: bool,
}

pub(super) struct UsageObserver {
    stream: bool,
    buffer: Vec<u8>,
    event_data: Vec<u8>,
    skip_line: bool,
    skip_event: bool,
    after_carriage_return: bool,
    terminal: bool,
    final_output: bool,
    counts: TokenUsage,
    model: Option<String>,
    stream_error: bool,
}

impl UsageObserver {
    pub fn new(stream: bool) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
            event_data: Vec::new(),
            skip_line: false,
            skip_event: false,
            after_carriage_return: false,
            terminal: false,
            final_output: false,
            counts: TokenUsage::default(),
            model: None,
            stream_error: false,
        }
    }

    fn merge(&mut self, counts: Option<Counts>) {
        if let Some(counts) = counts {
            // message_delta is cumulative. A missing field keeps the last reported value.
            self.counts.input = counts.input_tokens.or(self.counts.input);
            self.counts.cache_write = counts
                .cache_creation_input_tokens
                .or(self.counts.cache_write);
            self.counts.cache_read = counts.cache_read_input_tokens.or(self.counts.cache_read);
            self.counts.output = counts.output_tokens.or(self.counts.output);
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if !self.stream {
            if bytes.len() + self.buffer.len() > MAX_JSON_BYTES {
                self.buffer.clear();
                self.skip_line = true;
            }
            if !self.skip_line {
                self.buffer.extend_from_slice(bytes);
            }
            return;
        }

        for part in bytes.split_inclusive(|byte| matches!(*byte, b'\r' | b'\n')) {
            let after_carriage_return = std::mem::take(&mut self.after_carriage_return);
            if after_carriage_return && part == b"\n" {
                continue;
            }
            let ends = part.ends_with(b"\n") || part.ends_with(b"\r");
            let line = if ends { &part[..part.len() - 1] } else { part };
            if self.buffer.len() + line.len() > MAX_EVENT_BYTES {
                self.buffer.clear();
                self.skip_line = true;
                self.skip_event = true;
            }
            if !self.skip_line {
                if ends && self.buffer.is_empty() {
                    self.line(line);
                } else {
                    self.buffer.extend_from_slice(line);
                    if ends {
                        let mut buffered = std::mem::take(&mut self.buffer);
                        self.line(&buffered);
                        buffered.clear();
                        self.buffer = buffered;
                    }
                }
            }
            if ends {
                self.skip_line = false;
                self.after_carriage_return = part.ends_with(b"\r");
            }
        }
    }

    fn line(&mut self, line: &[u8]) {
        if line.is_empty() {
            self.dispatch();
        } else if let Some(event) = line.strip_prefix(b"event:") {
            let event = event.strip_prefix(b" ").unwrap_or(event);
            // Standard Anthropic streams identify the event up front. Skip content deltas.
            self.skip_event = !matches!(
                event,
                b"message_start" | b"message_delta" | b"message_stop" | b"error"
            );
        } else if !self.skip_event {
            if let Some(data) = line.strip_prefix(b"data:") {
                let data = data.strip_prefix(b" ").unwrap_or(data);
                if self.event_data.len() + data.len() >= MAX_EVENT_BYTES {
                    self.skip_event = true;
                } else {
                    if !self.event_data.is_empty() {
                        self.event_data.push(b'\n');
                    }
                    self.event_data.extend_from_slice(data);
                }
            }
        }
    }

    fn dispatch(&mut self) {
        if !self.skip_event {
            if self.event_data == b"[DONE]" {
                self.terminal = true;
            } else if let Ok(event) = serde_json::from_slice::<Event>(&self.event_data) {
                match event.kind.as_str() {
                    "message_start" => {
                        if let Some(message) = event.message {
                            self.model = message.model;
                            self.merge(message.usage);
                        }
                    }
                    "message_delta" => {
                        self.final_output |= event
                            .usage
                            .as_ref()
                            .is_some_and(|usage| usage.output_tokens.is_some());
                        self.merge(event.usage);
                    }
                    "message_stop" => self.terminal = true,
                    "error" => self.stream_error = true,
                    _ => {}
                }
            }
        }
        self.event_data.clear();
        self.skip_event = false;
    }

    pub fn finish(mut self) -> ObservedUsage {
        if self.stream {
            // Compatible gateways occasionally omit the closing blank line.
            if !self.buffer.is_empty() && !self.skip_line {
                let pending = std::mem::take(&mut self.buffer);
                self.line(&pending);
            }
            self.dispatch();
        } else if !self.skip_line {
            if let Ok(message) = serde_json::from_slice::<Message>(&self.buffer) {
                self.model = message.model;
                self.merge(message.usage);
                self.terminal = true;
            }
        }

        let reported = self.counts.input.is_some()
            || self.counts.cache_write.is_some()
            || self.counts.cache_read.is_some()
            || self.counts.output.is_some();
        self.counts.partial = !self.terminal
            || (self.stream && !self.final_output)
            || self.stream_error
            || self.counts.input.is_none()
            || self.counts.output.is_none();
        ObservedUsage {
            tokens: reported.then_some(self.counts),
            model: self
                .model
                .filter(|model| !model.is_empty() && model.len() <= 256),
            stream_error: self.stream_error || (self.stream && !self.terminal),
            limit_reached: !self.stream && self.skip_line,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_sse_keeps_cumulative_counts_and_metadata() {
        let mut observer = UsageObserver::new(true);
        let stream = concat!(
            "event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"actual\",\"usage\":{\"input_tokens\":0,\"cache_creation_input_tokens\":8,\"cache_read_input_tokens\":20,\"output_tokens\":1}}}\r\n\r\n",
            "event: content_block_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":999}}\n\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\n",
            "data: {\"type\":\"message_delta\",\n",
            "data: \"usage\":{\"output_tokens\":12}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        for bytes in stream.as_bytes().chunks(11) {
            observer.push(bytes);
        }
        let result = observer.finish();
        let usage = result.tokens.unwrap();
        assert_eq!(result.model.as_deref(), Some("actual"));
        assert_eq!(
            (
                usage.input,
                usage.cache_write,
                usage.cache_read,
                usage.output
            ),
            (Some(0), Some(8), Some(20), Some(12))
        );
        assert!(!usage.partial);
    }

    #[test]
    fn json_usage_and_interrupted_stream_preserve_zero_and_missing() {
        let mut json = UsageObserver::new(false);
        json.push(br#"{"model":"actual","content":[{"text":"untouched"}],"usage":{"input_tokens":2,"output_tokens":0}}"#);
        let usage = json.finish().tokens.unwrap();
        assert_eq!(usage.output, Some(0));
        assert_eq!(usage.cache_read, None);
        assert!(!usage.partial);

        let mut stream = UsageObserver::new(true);
        stream.push(
            b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":6}}}\n\n",
        );
        let result = stream.finish();
        assert!(result.stream_error);
        let usage = result.tokens.unwrap();
        assert!(usage.partial);
        assert_eq!(usage.output, None);
    }

    #[test]
    fn skipped_large_event_does_not_hide_later_usage() {
        let mut observer = UsageObserver::new(true);
        observer.push(b"event: content_block_delta\ndata: ");
        observer.push(&vec![b'x'; MAX_EVENT_BYTES]);
        observer.push(b"\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":2,\"output_tokens\":4}}\n\ndata: [DONE]\n\n");
        assert_eq!(observer.finish().tokens.unwrap().output, Some(4));
    }

    #[test]
    fn large_valid_json_is_distinguished_from_missing_usage() {
        let mut observer = UsageObserver::new(false);
        observer.push(&vec![b' '; MAX_JSON_BYTES]);
        observer.push(br#"{"usage":{"input_tokens":1,"output_tokens":4}}"#);
        let result = observer.finish();
        assert!(result.limit_reached);
        assert!(result.tokens.is_none());
        assert!(!result.stream_error);
    }

    #[test]
    fn carriage_return_only_is_a_valid_sse_line_ending() {
        let mut observer = UsageObserver::new(true);
        observer.push(b"data: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":2,\"output_tokens\":4}}\r");
        observer.push(b"\rdata: {\"type\":\"message_stop\"}\r\r");
        let result = observer.finish();
        assert!(!result.stream_error);
        assert!(!result.tokens.unwrap().partial);
    }
}
