use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn ssh_output_attach(state: State<'_, Arc<AppState>>, session_id: String, stream_id: String) {
    if let Some(session) = state.ssh_sessions.get(&session_id) {
        session.output.attach(stream_id);
    }
}

#[tauri::command]
pub fn ssh_output_ack(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    stream_id: String,
    sequence: u64,
) {
    if let Some(session) = state.ssh_sessions.get(&session_id) {
        session.output.ack(&stream_id, sequence);
    }
}

#[tauri::command]
pub fn ssh_output_detach(state: State<'_, Arc<AppState>>, session_id: String, stream_id: String) {
    if let Some(session) = state.ssh_sessions.get(&session_id) {
        session.output.detach(Some(&stream_id));
    }
}
