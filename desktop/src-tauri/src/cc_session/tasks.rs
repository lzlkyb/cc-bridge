//! Task lifecycle normalization; ordinary background commands must not become agents.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_token: Option<String>,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub started: bool,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

pub fn parse(value: &Value, snapshot: bool) -> Option<TaskUpdate> {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    let patch = value.get("patch").unwrap_or(value);
    let status = text(patch, "status").or_else(|| {
        (snapshot || subtype == "task_started" || subtype == "task_progress")
            .then(|| "running".to_string())
    });
    Some(TaskUpdate {
        stop_token: None,
        task_id: text(value, "task_id")?,
        run_id: text(value, "run_id"),
        parent_task_id: text(value, "parent_task_id"),
        tool_use_id: text(value, "tool_use_id"),
        task_type: text(value, "task_type"),
        name: text(value, "subagent_type"),
        description: text(patch, "description"),
        status,
        last_tool_name: text(value, "last_tool_name"),
        summary: text(value, "summary").or_else(|| text(patch, "error")),
        background: if snapshot {
            Some(true)
        } else {
            patch.get("is_backgrounded").and_then(Value::as_bool)
        },
        started: subtype == "task_started",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn partial_updates_preserve_absence_and_run_identity() {
        let update = parse(&json!({"subtype":"task_updated","task_id":"a","run_id":"r2","patch":{"is_backgrounded":true}}), false).unwrap();
        assert_eq!(update.status, None);
        assert_eq!(update.background, Some(true));
        let wire = serde_json::to_value(&update).unwrap();
        assert_eq!(wire["taskId"], "a");
        assert_eq!(wire["runId"], "r2");
        assert!(wire.get("status").is_none());
        assert_eq!(serde_json::from_value::<TaskUpdate>(wire).unwrap(), update);
    }

    #[test]
    fn task_snapshot_keeps_task_type_and_parent() {
        let task = parse(&json!({"task_id":"child","task_type":"local_agent","parent_task_id":"parent","subagent_type":"Explore"}), true).unwrap();
        assert_eq!(task.task_type.as_deref(), Some("local_agent"));
        assert_eq!(task.parent_task_id.as_deref(), Some("parent"));
        assert_eq!(task.background, Some(true));
        assert_eq!(task.status.as_deref(), Some("running"));
        assert!(parse(&json!({"task_type":"local_bash"}), true).is_none());
    }

    #[test]
    fn full_protocol_routes_lifecycle_and_roundtrips_new_events() {
        use crate::cc_session::proto::{CcEvent, ProtoState};
        let mut state = ProtoState::new();
        for value in [
            json!({"type":"system","subtype":"task_started","task_id":"a","run_id":"r1","task_type":"local_agent","description":"Read source"}),
            json!({"type":"system","subtype":"task_progress","task_id":"a","run_id":"r1","subagent_type":"Explore","last_tool_name":"Read","summary":"Reading"}),
            json!({"type":"system","subtype":"task_updated","task_id":"a","patch":{"description":"Check source","is_backgrounded":true}}),
            json!({"type":"system","subtype":"task_notification","task_id":"a","status":"completed","summary":"Done"}),
        ] {
            let events = state.feed(&value.to_string());
            assert_eq!(events.len(), 1);
            assert!(matches!(&events[0], CcEvent::TaskUpdate { task } if task.task_id == "a"));
            let wire = serde_json::to_string(&events).unwrap();
            assert_eq!(serde_json::from_str::<Vec<CcEvent>>(&wire).unwrap(), events);
        }
        assert!(state
            .feed(r#"{"type":"system","subtype":"task_progress"}"#)
            .is_empty());
        let events =
            state.feed(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#);
        assert!(matches!(&events[1], CcEvent::TaskSnapshot { tasks } if tasks.is_empty()));
    }
}
