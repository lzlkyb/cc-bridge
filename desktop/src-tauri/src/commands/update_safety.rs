use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateActivity {
    conversations: usize,
    agents: usize,
    commands: usize,
    transfers: usize,
    terminals: usize,
    terminal_names: Vec<String>,
    relay_requests: usize,
}

impl UpdateActivity {
    pub(super) fn is_idle(&self) -> bool {
        self.conversations == 0
            && self.agents == 0
            && self.commands == 0
            && self.transfers == 0
            && self.terminals == 0
            && self.relay_requests == 0
    }
}

/// Read live backend state rather than counting whichever conversation page is mounted.
#[tauri::command]
pub async fn update_activity(state: State<'_, Arc<AppState>>) -> Result<UpdateActivity, String> {
    read_update_activity(&state).await
}

pub(super) async fn read_update_activity(state: &AppState) -> Result<UpdateActivity, String> {
    let (conversations, agents) = state.cc.update_activity()?;
    let mut commands = 0;
    let exits: Vec<_> = state
        .running_commands
        .iter()
        .filter(|command| command.child.is_some())
        .map(|command| Arc::clone(&command.exit_code))
        .collect();
    for exit in exits {
        if exit.lock().await.is_none() {
            commands += 1;
        }
    }
    let terminal_names = state
        .ssh_sessions
        .iter()
        .take(8)
        .map(|session| session.label.chars().take(60).collect())
        .collect();
    Ok(UpdateActivity {
        conversations,
        agents,
        commands,
        transfers: state.ssh_transfers.len(),
        terminals: state.ssh_sessions.len(),
        terminal_names,
        relay_requests: state.relay.log().in_flight_count(),
    })
}
