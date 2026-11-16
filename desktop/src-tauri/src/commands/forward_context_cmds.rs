use crate::config::{BridgeConfig, ForwardRule, SshConnection};
use crate::forward_ownership::{self as ownership, ForwardContext, ManagedForward};
use crate::stable_connect;
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::State;

pub(super) fn context_for(
    config: &BridgeConfig,
    state: &AppState,
    connection: &SshConnection,
    rules: &[ForwardRule],
) -> ForwardContext {
    let mut managed = Vec::new();
    for record in super::stable_connect_cmds::stable_records(config, state) {
        if !record.configured
            && state
                .stable_operations
                .get(&record.connection_id)
                .is_none_or(|op| !op.active.load(Ordering::SeqCst))
        {
            continue;
        }
        let Some(owner) = config
            .ssh_connections
            .iter()
            .find(|c| c.id == record.connection_id)
        else {
            continue;
        };
        if !ownership::same_server(owner, connection) {
            continue;
        }
        let mut claims = vec![stable_connect::rule(record.port, config)];
        // An unapplied local-service edit must also reserve the live tunnel's old target.
        if let Some(tunnel) = state
            .ssh_tunnels
            .get(&stable_connect::runtime_id(&owner.id))
        {
            for status in &tunnel
                .status
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .rules
            {
                if !claims
                    .iter()
                    .any(|r| ownership::same_route(r, &status.rule))
                {
                    claims.push(status.rule.clone());
                }
            }
        }
        for rule in claims {
            managed.push(ManagedForward {
                connection_id: owner.id.clone(),
                rule,
                phase: record.phase.clone(),
                enabled: record.enabled,
                message: record.message.clone(),
            });
        }
    }
    let mut context = ownership::context(connection, rules, managed);
    context.manual_status = state.ssh_tunnels.get(&connection.id).and_then(|t| {
        let mut status = t.status.lock().unwrap_or_else(|p| p.into_inner()).clone();
        status.rules.retain(|r| {
            !context
                .managed
                .iter()
                .any(|m| ownership::same_route(&r.rule, &m.rule))
        });
        (!status.rules.is_empty()).then_some(status)
    });
    context
}

#[tauri::command]
pub async fn ssh_forward_context(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<ForwardContext, String> {
    let config = state.config.read().await;
    let connection = config
        .ssh_connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or("服务器不存在，请重新选择")?;
    Ok(context_for(
        &config,
        &state,
        connection,
        &connection.forwards,
    ))
}

#[cfg(test)]
#[path = "forward_context_tests.rs"]
mod tests;
