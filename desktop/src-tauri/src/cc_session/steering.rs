//! Mid-turn input uses the existing CLI, never the process-tree stop path.
use super::manager::{record_local, CcSession};
use super::proto::CcEvent;
use super::session::{check_images, user_message_line_images, UserImage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use tauri::AppHandle;

pub struct SteeringInput {
    pub message_id: String,
    pub expected_session_id: String,
    pub connection_id: String,
    pub cwd: Option<String>,
    pub mode: String,
    pub text: String,
    pub images: Vec<UserImage>,
    pub thumbs: Vec<String>,
}

/// Only foreground, unfinished background-capable tools may be moved aside.
pub fn foreground_tool(events: &[CcEvent]) -> Option<String> {
    let mut active: Vec<(String, String)> = vec![];
    for event in events {
        match event {
            CcEvent::Init { .. } | CcEvent::TurnEnd { .. } | CcEvent::Exit { .. } => active.clear(),
            CcEvent::ToolUse {
                tool_use_id, name, ..
            } => {
                if !active.iter().any(|(id, _)| id == tool_use_id) {
                    active.push((tool_use_id.clone(), name.clone()));
                }
            }
            CcEvent::ToolResult { tool_use_id, .. } => active.retain(|(id, _)| id != tool_use_id),
            _ => {}
        }
    }
    active
        .into_iter()
        .rev()
        .find(|(_, name)| matches!(name.as_str(), "Bash" | "Agent" | "Task"))
        .map(|(id, _)| id)
}

impl CcSession {
    fn check_input_target(&self, input: &SteeringInput, epoch: u64) -> Result<(), String> {
        if self.shared().is_deleted()
            || self.steering_epoch.load(Ordering::SeqCst) != epoch
            || self.shared().resume_id().as_deref() != Some(input.expected_session_id.as_str())
            || !self
                .shared()
                .same_target(&input.connection_id, input.cwd.as_deref())
        {
            return Err("会话或工作目录已切换，补充没有发送，草稿已保留".into());
        }
        Ok(())
    }

    async fn input_control(
        &self,
        input: &SteeringInput,
        epoch: u64,
        request: Value,
    ) -> Result<Value, String> {
        let (id, receiver) = {
            let guard = self.live.lock().map_err(|_| "会话状态不可用")?;
            self.check_input_target(input, epoch)?;
            let transport = guard
                .as_ref()
                .filter(|t| t.is_alive())
                .ok_or("会话连接已结束，草稿已保留")?;
            let (id, receiver) = self.shared().input_control.register_control()?;
            let line =
                json!({"type":"control_request", "request_id":id, "request":request}).to_string();
            if let Err(error) = transport.write_line(&line) {
                self.shared().input_control.cancel(&id);
                return Err(error);
            }
            (id, receiver)
        };
        // Stdout must stay free to resolve the control response while we wait.
        self.shared().input_control.wait(&id, receiver).await
    }

    fn input_status(&self, app: &AppHandle, id: &str, status: &str, detail: Option<String>) {
        record_local(
            app,
            self.shared(),
            CcEvent::InputStatus {
                message_id: id.into(),
                status: status.into(),
                detail,
            },
        );
    }

    pub async fn steer(&self, app: &AppHandle, input: SteeringInput) -> Result<String, String> {
        if uuid::Uuid::parse_str(&input.message_id).is_err() {
            return Err("消息标识无效".into());
        }
        if !matches!(input.mode.as_str(), "steer" | "now") {
            return Err("未知的补充方式".into());
        }
        if input.text.trim().is_empty() && input.images.is_empty() {
            return Err("消息不能为空".into());
        }
        // Slash and shell commands can clear or reconfigure the conversation; they belong in the deferred queue.
        if input.text.trim_start().starts_with(['/', '!']) {
            return Err("命令请使用下一轮发送".into());
        }
        check_images(&input.images)?;
        let mut message: Value =
            serde_json::from_str(&user_message_line_images(&input.text, &input.images))
                .map_err(|e| e.to_string())?;
        message["uuid"] = json!(input.message_id);
        let line = message.to_string();
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}:{}:{}:{}:{}",
                input.mode,
                input.expected_session_id,
                input.connection_id,
                input.cwd.as_deref().unwrap_or(""),
                line
            ))
        );
        let epoch = self.steering_epoch.load(Ordering::SeqCst);
        {
            let guard = self.live.lock().map_err(|_| "会话状态不可用")?;
            if let Some(status) = self
                .shared()
                .input_control
                .repeated(&input.message_id, &fingerprint)?
            {
                return Ok(status);
            }
            self.check_input_target(&input, epoch)?;
            if !guard.as_ref().is_some_and(|t| t.is_alive()) {
                return Err("会话连接已结束，草稿已保留".into());
            }
            if !self
                .shared()
                .input_control
                .begin(&input.message_id, fingerprint)?
            {
                return Ok(self
                    .shared()
                    .input_control
                    .status(&input.message_id)
                    .unwrap_or_else(|| "unconfirmed".into()));
            }
            record_local(
                app,
                self.shared(),
                CcEvent::InputMessage {
                    message_id: input.message_id.clone(),
                    text: input.text.clone(),
                    mode: input.mode.clone(),
                },
            );
            self.input_status(app, &input.message_id, "preparing", None);
            self.shared().refresh_input_activity();
        }
        if input.mode == "now" {
            let tool = foreground_tool(&self.shared().ring.snapshot().events);
            let adjustment = async {
                let backgrounded = if let Some(id) = tool {
                    self.input_control(
                        &input,
                        epoch,
                        json!({"subtype":"background_tasks", "tool_use_id":id}),
                    )
                    .await?
                    .get("backgrounded")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                } else {
                    false
                };
                if !backgrounded {
                    self.input_control(&input, epoch, json!({"subtype":"interrupt"}))
                        .await?;
                }
                Ok::<_, String>(())
            }
            .await;
            if let Err(error) = adjustment {
                if self.check_input_target(&input, epoch).is_ok() {
                    self.input_status(app, &input.message_id, "failed", Some(error.clone()));
                }
                return Ok("failed".into());
            }
        }
        let written = {
            let guard = self.live.lock().map_err(|_| "会话状态不可用".to_string());
            guard.and_then(|guard| {
                self.check_input_target(&input, epoch)?;
                let transport = guard
                    .as_ref()
                    .filter(|t| t.is_alive())
                    .ok_or_else(|| "会话连接已结束".to_string())?;
                self.shared().set_turn_active(true);
                transport.write_line(&line)?;
                // Keep reset/stop behind the transcript receipt as well as the actual write.
                record_local(
                    app,
                    self.shared(),
                    CcEvent::UserMessage {
                        text: input.text.clone(),
                        images: input.thumbs.clone(),
                    },
                );
                self.input_status(app, &input.message_id, "written", None);
                Ok(())
            })
        };
        if let Err(error) = written {
            // A partial pipe write is ambiguous. Never retry it automatically.
            if self.check_input_target(&input, epoch).is_ok() {
                self.input_status(app, &input.message_id, "unconfirmed", Some(error.clone()));
            }
            return Ok("unconfirmed".into());
        }
        Ok(self
            .shared()
            .input_control
            .status(&input.message_id)
            .unwrap_or_else(|| "written".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_target_generation_and_deleted_session_reject_input() {
        let session = CcSession::new();
        session.shared().set_resume_id("cli-1");
        let mut input = SteeringInput {
            message_id: uuid::Uuid::new_v4().to_string(),
            expected_session_id: "cli-1".into(),
            connection_id: String::new(),
            cwd: None,
            mode: "steer".into(),
            text: "correction".into(),
            images: vec![],
            thumbs: vec![],
        };
        assert!(session.check_input_target(&input, 0).is_ok());
        input.cwd = Some("another-project".into());
        assert!(session.check_input_target(&input, 0).is_err());
        input.cwd = None;
        assert!(session.check_input_target(&input, 1).is_err());
        session.shared().mark_deleted();
        assert!(session.check_input_target(&input, 0).is_err());
    }
    #[test]
    fn only_open_foreground_background_capable_tools_are_selected() {
        let tool = |id: &str, name: &str| CcEvent::ToolUse {
            tool_use_id: id.into(),
            name: name.into(),
            input: Value::Null,
        };
        let mut events = vec![tool("bash", "Bash"), tool("edit", "Edit")];
        assert_eq!(foreground_tool(&events).as_deref(), Some("bash"));
        events.push(CcEvent::ToolResult {
            tool_use_id: "bash".into(),
            content: String::new(),
            is_error: false,
            duration_ms: None,
        });
        assert_eq!(foreground_tool(&events), None);
        events.push(tool("agent", "Agent"));
        assert_eq!(foreground_tool(&events).as_deref(), Some("agent"));
        events.push(CcEvent::Exit { code: None });
        assert_eq!(foreground_tool(&events), None);
    }
}
