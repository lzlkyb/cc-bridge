//! Per-task control uses CLI task IDs, never process IDs or a session interrupt.
use super::{proto::CcEvent, tasks::TaskUpdate};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

type Reply = Result<String, String>;
struct Pending {
    task_id: String,
    token: String,
    reply: oneshot::Sender<Reply>,
}
#[derive(Default)]
struct State {
    tasks: HashMap<String, TaskUpdate>,
    pending: HashMap<String, Pending>,
}
#[derive(Default)]
pub struct TaskControl(Mutex<State>);
struct Cleanup<'a>(&'a TaskControl, &'a str);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        self.0.cancel(self.1);
    }
}
fn active(task: &TaskUpdate) -> bool {
    matches!(task.status.as_deref(), Some("running" | "pending"))
}
fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "stopped" | "killed")
}

impl TaskControl {
    pub fn active_count(&self) -> Result<usize, String> {
        self.0
            .lock()
            .map(|state| state.tasks.values().filter(|task| active(task)).count())
            .map_err(|_| "无法读取后台成员状态".into())
    }

    /// Only live events mint tokens. A persisted/replayed task cannot control a new process.
    pub fn observe(&self, event: &mut CcEvent) {
        let Ok(mut state) = self.0.lock() else { return };
        match event {
            CcEvent::Exit { .. } => {
                state.tasks.clear();
                for (_, pending) in state.pending.drain() {
                    let _ = pending
                        .reply
                        .send(Err("会话连接已结束，停止尚未确认".into()));
                }
            }
            CcEvent::TaskUpdate { task } => Self::merge(&mut state, task),
            CcEvent::TaskSnapshot { tasks } => {
                // Absence is not a terminal status; do not invent a successful stop.
                let ids: Vec<_> = tasks.iter().map(|t| t.task_id.clone()).collect();
                state
                    .tasks
                    .retain(|id, task| task.background != Some(true) || ids.contains(id));
                for task in tasks {
                    Self::merge(&mut state, task);
                }
            }
            CcEvent::ControlResponse {
                request_id,
                error: Some(error),
                ..
            } => {
                if let Some(pending) = state.pending.remove(request_id) {
                    let _ = pending.reply.send(Err(error.clone()));
                }
                // An ACK alone doesn't prove termination. Await a task lifecycle event.
            }
            _ => {}
        }
    }

    fn merge(state: &mut State, update: &mut TaskUpdate) {
        let previous = state.tasks.get(&update.task_id);
        if let (Some(old), Some(new)) = (
            previous.and_then(|t| t.run_id.as_ref()),
            update.run_id.as_ref(),
        ) {
            if new < old {
                return;
            }
        }
        let fresh = previous.is_none()
            || update
                .run_id
                .as_ref()
                .is_some_and(|id| Some(id) != previous.and_then(|t| t.run_id.as_ref()));
        let mut task = if fresh {
            update.clone()
        } else {
            previous.unwrap().clone()
        };
        macro_rules! merge { ($($field:ident),*) => { $(if update.$field.is_some() { task.$field = update.$field.clone(); })* }; }
        merge!(
            run_id,
            parent_task_id,
            tool_use_id,
            task_type,
            name,
            description,
            status,
            last_tool_name,
            summary,
            background
        );
        if !fresh
            && previous.is_some_and(|old| old.status.as_deref().is_some_and(terminal))
            && active(&task)
        {
            task.status = previous.and_then(|old| old.status.clone());
        }
        if fresh {
            task.stop_token = Some(uuid::Uuid::new_v4().to_string());
        }
        update.stop_token = task.stop_token.clone();
        let terminal_status = task
            .status
            .as_deref()
            .filter(|s| terminal(s))
            .map(str::to_owned);
        let token = task.stop_token.clone();
        state.tasks.insert(task.task_id.clone(), task);
        let requests: Vec<_> = state
            .pending
            .iter()
            .filter(|(_, p)| p.task_id == update.task_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in requests {
            let pending = &state.pending[&id];
            let result = if Some(&pending.token) != token.as_ref() {
                Some(Err("成员已进入新的运行，旧停止请求已失效".into()))
            } else {
                terminal_status.as_ref().map(|s| Ok(s.clone()))
            };
            if let Some(result) = result {
                if let Some(pending) = state.pending.remove(&id) {
                    let _ = pending.reply.send(result);
                }
            }
        }
    }

    pub fn prepare(
        &self,
        task_id: &str,
        token: &str,
    ) -> Result<(String, oneshot::Receiver<Reply>), String> {
        let mut state = self.0.lock().map_err(|_| "任务状态不可用")?;
        let task = state
            .tasks
            .get(task_id)
            .ok_or("任务不在当前连接中，请刷新进展")?;
        if task.stop_token.as_deref() != Some(token) {
            return Err("成员运行已变化，请重新查看小队".into());
        }
        if !active(task) {
            return Err("成员已经结束，无需停止".into());
        }
        if task.background != Some(true) || task.task_type.as_deref() != Some("local_agent") {
            return Err("当前仅支持停止独立的后台子 Agent".into());
        }
        if state
            .tasks
            .values()
            .any(|t| t.parent_task_id.as_deref() == Some(task_id) && active(t))
        {
            return Err("该成员仍有运行中的子任务，请先处理子任务".into());
        }
        if state.pending.values().any(|p| p.task_id == task_id) {
            return Err("已发送停止请求，正在等待确认".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receiver) = oneshot::channel();
        state.pending.insert(
            id.clone(),
            Pending {
                task_id: task_id.into(),
                token: token.into(),
                reply,
            },
        );
        Ok((id, receiver))
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.pending.remove(id);
        }
    }

    pub async fn wait(
        &self,
        id: &str,
        receiver: oneshot::Receiver<Reply>,
        timeout: std::time::Duration,
    ) -> Reply {
        let _cleanup = Cleanup(self, id);
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("停止请求已失效，请查看最新任务状态".into()),
            Err(_) => Err("停止尚未确认，请查看最新进展后重试".into()),
        }
    }
}

pub fn stop_line(request_id: &str, task_id: &str) -> String {
    serde_json::json!({"type":"control_request","request_id":request_id,"request":{"subtype":"stop_task","task_id":task_id}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn feed(control: &TaskControl, value: serde_json::Value) -> Option<String> {
        let mut events = super::super::proto::ProtoState::new().feed(&value.to_string());
        for event in &mut events {
            control.observe(event);
        }
        events.into_iter().find_map(|event| {
            if let CcEvent::TaskUpdate { task } = event {
                task.stop_token
            } else {
                None
            }
        })
    }
    fn start(control: &TaskControl, id: &str) -> String {
        feed(control, json!({"type":"system","subtype":"task_started","task_id":id,"run_id":"r1","task_type":"local_agent","patch":{"status":"running","is_backgrounded":true}})).unwrap()
    }
    #[test]
    fn update_activity_counts_only_live_tasks_and_clears_on_exit() {
        let control = TaskControl::default();
        assert_eq!(control.active_count().unwrap(), 0);
        start(&control, "a");
        start(&control, "b");
        assert_eq!(control.active_count().unwrap(), 2);
        feed(
            &control,
            json!({"type":"system","subtype":"task_updated","task_id":"a","patch":{"status":"completed"}}),
        );
        assert_eq!(control.active_count().unwrap(), 1);
        control.observe(&mut CcEvent::Exit { code: Some(0) });
        assert_eq!(control.active_count().unwrap(), 0);
    }
    #[tokio::test]
    async fn ack_is_not_terminal_and_only_selected_member_settles() {
        let control = TaskControl::default();
        let a = start(&control, "a");
        let b = start(&control, "b");
        let (id, mut reply) = control.prepare("a", &a).unwrap();
        feed(
            &control,
            json!({"type":"control_response","response":{"request_id":id,"subtype":"success"}}),
        );
        assert!(matches!(
            reply.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(control.prepare("a", &a).is_err());
        feed(
            &control,
            json!({"type":"system","subtype":"task_updated","task_id":"a","patch":{"status":"killed"}}),
        );
        assert_eq!(reply.await.unwrap().unwrap(), "killed");
        assert!(control.prepare("b", &b).is_ok());
    }
    #[tokio::test]
    async fn completion_race_and_rejection_preserve_truth() {
        let control = TaskControl::default();
        let token = start(&control, "a");
        let (id, reply) = control.prepare("a", &token).unwrap();
        feed(
            &control,
            json!({"type":"control_response","response":{"request_id":id,"subtype":"error","error":"unsupported request"}}),
        );
        assert_eq!(reply.await.unwrap().unwrap_err(), "unsupported request");
        let (_, reply) = control.prepare("a", &token).unwrap();
        feed(
            &control,
            json!({"type":"system","subtype":"task_notification","task_id":"a","status":"completed"}),
        );
        assert_eq!(reply.await.unwrap().unwrap(), "completed");
    }
    #[tokio::test]
    async fn timeout_disconnect_and_restarted_task_cannot_report_success() {
        let control = TaskControl::default();
        let token = start(&control, "a");
        let (id, reply) = control.prepare("a", &token).unwrap();
        assert!(control
            .wait(&id, reply, std::time::Duration::from_millis(1))
            .await
            .unwrap_err()
            .contains("尚未确认"));
        let (_, reply) = control.prepare("a", &token).unwrap();
        control.observe(&mut CcEvent::Exit { code: None });
        assert!(reply.await.unwrap().is_err());
        assert!(control.prepare("a", &token).is_err());
        let new_token = start(&control, "a");
        assert_ne!(token, new_token);
        assert!(control.prepare("a", &token).is_err());
    }
    #[test]
    fn ownership_background_and_children_are_checked() {
        let control = TaskControl::default();
        let other = TaskControl::default();
        let token = start(&control, "a");
        assert!(other.prepare("a", &token).is_err());
        feed(
            &control,
            json!({"type":"system","subtype":"task_started","task_id":"child","parent_task_id":"a","task_type":"local_agent"}),
        );
        assert!(control.prepare("a", &token).unwrap_err().contains("子任务"));
        let child = control.0.lock().unwrap().tasks["child"]
            .stop_token
            .clone()
            .unwrap();
        assert!(control.prepare("child", &child).is_err());
        let wire: serde_json::Value = serde_json::from_str(&stop_line("req", "a")).unwrap();
        assert_eq!(
            wire,
            json!({"type":"control_request","request_id":"req","request":{"subtype":"stop_task","task_id":"a"}})
        );
    }
    #[tokio::test]
    async fn newer_run_invalidates_old_request_and_terminal_progress_cannot_revive_it() {
        let control = TaskControl::default();
        let old = start(&control, "a");
        let (_, reply) = control.prepare("a", &old).unwrap();
        let new = feed(&control, json!({"type":"system","subtype":"task_started","task_id":"a","run_id":"r2","task_type":"local_agent","patch":{"status":"running","is_backgrounded":true}})).unwrap();
        assert!(reply.await.unwrap().is_err());
        assert_ne!(old, new);
        assert!(control.prepare("a", &old).is_err());
        let (_, reply) = control.prepare("a", &new).unwrap();
        feed(
            &control,
            json!({"type":"system","subtype":"task_notification","task_id":"a","run_id":"r1","status":"stopped"}),
        );
        feed(
            &control,
            json!({"type":"system","subtype":"task_updated","task_id":"a","run_id":"r2","patch":{"status":"killed"}}),
        );
        assert_eq!(reply.await.unwrap().unwrap(), "killed");
        feed(
            &control,
            json!({"type":"system","subtype":"task_progress","task_id":"a","run_id":"r2"}),
        );
        assert!(control.prepare("a", &new).is_err());
    }
}
