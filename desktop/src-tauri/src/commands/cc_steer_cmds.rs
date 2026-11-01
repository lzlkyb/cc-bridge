use super::cc_cmds::CcStartReq;
use crate::cc_session::{session::UserImage, steering::SteeringInput};
use crate::state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn cc_steer(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    session_id: u64,
    input: CcSteerReq,
) -> Result<String, String> {
    let cc = state.cc.get(session_id).ok_or("会话已关闭，草稿已保留")?;
    let req = input.req;
    let thumbs = if req.images.iter().all(|i| !i.thumb.trim().is_empty()) {
        req.images.iter().map(|i| i.thumb.clone()).collect()
    } else {
        vec![]
    };
    let clean = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    cc.steer(
        &app,
        SteeringInput {
            message_id: input.message_id,
            expected_session_id: input.expected_session_id,
            mode: input.mode,
            connection_id: clean(req.connection_id).unwrap_or_default(),
            cwd: clean(req.cwd),
            text: req.text.trim().to_string(),
            images: req
                .images
                .into_iter()
                .map(|i| UserImage {
                    media_type: i.media_type,
                    data: i.data,
                })
                .collect(),
            thumbs,
        },
    )
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSteerReq {
    message_id: String,
    expected_session_id: String,
    mode: String,
    req: CcStartReq,
}
