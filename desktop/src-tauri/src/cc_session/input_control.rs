//! Input delivery receipts are distinct from model application and from process termination.
use super::proto::CcEvent;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
#[derive(Default)]
struct State {
    messages: HashMap<String, (String, String)>,
    controls: HashMap<String, oneshot::Sender<Reply>>,
}

#[derive(Default)]
pub struct InputControl(Mutex<State>);
struct Cleanup<'a>(&'a InputControl, &'a str);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        self.0.cancel(self.1);
    }
}
pub fn pending(state: &str) -> bool {
    matches!(state, "preparing" | "written" | "received" | "processing")
}

impl InputControl {
    pub fn repeated(&self, id: &str, fingerprint: &str) -> Result<Option<String>, String> {
        let state = self.0.lock().map_err(|_| "消息状态不可用")?;
        if let Some((previous, status)) = state.messages.get(id) {
            if previous != fingerprint {
                return Err("消息标识已用于其他内容".into());
            }
            if status != "failed" {
                return Ok(Some(status.clone()));
            }
        }
        Ok(None)
    }
    pub fn begin(&self, id: &str, fingerprint: String) -> Result<bool, String> {
        let mut state = self.0.lock().map_err(|_| "消息状态不可用")?;
        if let Some((previous, status)) = state.messages.get(id) {
            if previous != &fingerprint {
                return Err("消息标识已用于其他内容，请重新编辑后发送".into());
            }
            if status != "failed" {
                return Ok(false);
            }
        }
        if state
            .messages
            .values()
            .any(|(_, status)| status == "preparing")
        {
            return Err("上一条补充正在发送，请稍候".into());
        }
        if state.messages.len() >= 128 {
            let old: Vec<_> = state
                .messages
                .iter()
                .filter(|(_, (_, status))| matches!(status.as_str(), "complete" | "failed"))
                .map(|(id, _)| id.clone())
                .take(32)
                .collect();
            for id in old {
                state.messages.remove(&id);
            }
            if state.messages.len() >= 128 {
                return Err("待确认消息过多，请先查看已有消息状态".into());
            }
        }
        state
            .messages
            .insert(id.into(), (fingerprint, "preparing".into()));
        Ok(true)
    }
    pub fn status(&self, id: &str) -> Option<String> {
        self.0
            .lock()
            .ok()?
            .messages
            .get(id)
            .map(|(_, status)| status.clone())
    }
    pub fn has_pending(&self) -> bool {
        self.0
            .lock()
            .map(|s| s.messages.values().any(|(_, status)| pending(status)))
            .unwrap_or(false)
    }
    pub fn observe(&self, event: &CcEvent) -> Vec<CcEvent> {
        let Ok(mut state) = self.0.lock() else {
            return vec![];
        };
        match event {
            CcEvent::InputStatus {
                message_id, status, ..
            } => {
                if let Some((_, previous)) = state.messages.get_mut(message_id) {
                    // A late local "written" receipt must never downgrade a CLI acknowledgment.
                    let rank = |s: &str| match s {
                        "preparing" => 0,
                        "written" => 1,
                        "received" => 2,
                        "processing" => 3,
                        "complete" => 4,
                        _ => -1,
                    };
                    let stale_write = previous == "unconfirmed"
                        && matches!(status.as_str(), "preparing" | "written");
                    if previous != "complete"
                        && !stale_write
                        && (rank(status) < 0 || rank(status) >= rank(previous))
                    {
                        *previous = status.clone();
                    }
                }
            }
            CcEvent::ControlResponse {
                request_id,
                error,
                data,
            } => {
                if let Some(reply) = state.controls.remove(request_id) {
                    let _ = reply.send(
                        error
                            .as_ref()
                            .map_or_else(|| Ok(data.clone()), |error| Err(error.clone())),
                    );
                }
            }
            CcEvent::Exit { .. } => {
                // idle and result can arrive in either order; only Exit proves observation has ended.
                let affected: Vec<_> = state
                    .messages
                    .iter()
                    .filter(|(_, (_, status))| pending(status))
                    .map(|(id, _)| id.clone())
                    .collect();
                let result = affected
                    .into_iter()
                    .map(|id| CcEvent::InputStatus {
                        message_id: id,
                        status: "unconfirmed".into(),
                        detail: Some("连接已结束，无法确认这条补充是否处理".into()),
                    })
                    .collect();
                for (_, reply) in state.controls.drain() {
                    let _ = reply.send(Err("会话连接已结束".into()));
                }
                return result;
            }
            _ => {}
        }
        vec![]
    }
    pub fn register_control(&self) -> Result<(String, oneshot::Receiver<Reply>), String> {
        let (sender, receiver) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        self.0
            .lock()
            .map_err(|_| "控制通道不可用")?
            .controls
            .insert(id.clone(), sender);
        Ok((id, receiver))
    }
    pub fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.controls.remove(id);
        }
    }
    pub async fn wait(&self, id: &str, receiver: oneshot::Receiver<Reply>) -> Reply {
        let _cleanup = Cleanup(self, id);
        match tokio::time::timeout(std::time::Duration::from_secs(10), receiver).await {
            Ok(Ok(result)) => result,
            _ => Err("控制请求尚未确认，草稿已保留；不会自动结束进程或重发".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn status(id: &str, status: &str) -> CcEvent {
        CcEvent::InputStatus {
            message_id: id.into(),
            status: status.into(),
            detail: None,
        }
    }

    #[test]
    fn retries_are_idempotent_and_content_is_bound_to_uuid() {
        let control = InputControl::default();
        assert!(control.begin("one", "hash".into()).unwrap());
        assert!(!control.begin("one", "hash".into()).unwrap());
        assert!(control.begin("one", "changed".into()).is_err());
        assert!(
            control.begin("two", "other".into()).is_err(),
            "serialize control preparation"
        );
        control.observe(&status("one", "written"));
        assert!(control.begin("two", "other".into()).unwrap());
    }
    #[test]
    fn failed_before_write_can_retry_but_unknown_write_cannot() {
        let control = InputControl::default();
        control.begin("one", "hash".into()).unwrap();
        control.observe(&status("one", "failed"));
        assert!(control.begin("one", "hash".into()).unwrap());
        control.observe(&status("one", "unconfirmed"));
        assert!(!control.begin("one", "hash".into()).unwrap());
    }
    #[test]
    fn local_write_cannot_downgrade_fast_cli_receipt() {
        let control = InputControl::default();
        control.begin("one", "hash".into()).unwrap();
        control.observe(&status("one", "processing"));
        control.observe(&status("one", "written"));
        assert_eq!(control.status("one").as_deref(), Some("processing"));
        control.observe(&status("one", "complete"));
        control.observe(&status("one", "unconfirmed"));
        assert_eq!(control.status("one").as_deref(), Some("complete"));
        assert!(!control.has_pending());
    }
    #[test]
    fn idle_does_not_invalidate_result_that_arrives_later() {
        let control = InputControl::default();
        control.begin("one", "hash".into()).unwrap();
        control.observe(&status("one", "received"));
        assert!(control
            .observe(&CcEvent::SessionState { running: false })
            .is_empty());
        assert!(control.has_pending());
        control.observe(&status("one", "complete"));
        assert!(!control.has_pending());
    }

    #[test]
    fn local_write_after_exit_cannot_revive_an_uncertain_input() {
        let control = InputControl::default();
        control.begin("one", "hash".into()).unwrap();
        for receipt in control.observe(&CcEvent::Exit { code: None }) {
            control.observe(&receipt);
        }
        control.observe(&status("one", "written"));
        assert_eq!(control.status("one").as_deref(), Some("unconfirmed"));
        assert!(!control.has_pending());
    }
    #[tokio::test]
    async fn control_ack_carries_background_result_and_exit_rejects_waiters() {
        let control = InputControl::default();
        let (id, receiver) = control.register_control().unwrap();
        control.observe(&CcEvent::ControlResponse {
            request_id: id.clone(),
            error: None,
            data: json!({"backgrounded":false}),
        });
        assert_eq!(
            control.wait(&id, receiver).await.unwrap(),
            json!({"backgrounded":false})
        );
        control.begin("one", "hash".into()).unwrap();
        let (id, receiver) = control.register_control().unwrap();
        let receipts = control.observe(&CcEvent::Exit { code: None });
        assert!(
            matches!(&receipts[..], [CcEvent::InputStatus { status, .. }] if status == "unconfirmed")
        );
        for receipt in receipts {
            control.observe(&receipt);
        }
        assert!(!control.has_pending());
        assert!(control
            .wait(&id, receiver)
            .await
            .unwrap_err()
            .contains("连接"));
    }
    #[tokio::test]
    async fn rejected_control_never_counts_as_delivery() {
        let control = InputControl::default();
        let (id, receiver) = control.register_control().unwrap();
        control.observe(&CcEvent::ControlResponse {
            request_id: id.clone(),
            error: Some("unsupported".into()),
            data: Value::Null,
        });
        assert_eq!(
            control.wait(&id, receiver).await.unwrap_err(),
            "unsupported"
        );
        assert!(!control.has_pending());
    }
}
