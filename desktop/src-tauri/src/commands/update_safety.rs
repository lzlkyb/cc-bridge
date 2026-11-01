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
}

/// Read live backend state rather than counting whichever conversation page is mounted.
#[tauri::command]
pub async fn update_activity(state: State<'_, Arc<AppState>>) -> Result<UpdateActivity, String> {
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
    Ok(UpdateActivity {
        conversations,
        agents,
        commands,
        transfers: state.ssh_transfers.len(),
    })
}
