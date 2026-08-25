use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;

use super::{fail, ok_json, AppState};

#[derive(Deserialize)]
pub struct Hint {
    #[serde(rename = "readOffset")]
    pub read_offset: u64,
    #[serde(default)]
    pub gen: u64,
}

/// POST /v1/hint/{ticket}: the remux's read offset moved. Carries the
/// reader's offset, not the room's playhead — the remux runs ahead of
/// playback, and the pieces it is blocked on are the ones to fetch. The
/// body is read as text so the browser sends it without a preflight.
pub async fn post(State(state): State<Arc<AppState>>, Path(ticket): Path<String>, body: String) -> Response {
    let ticket = match state.verify(&ticket) {
        Ok(t) => t,
        Err(e) => return fail(StatusCode::UNAUTHORIZED, "*", &e.to_string()),
    };
    let hint: Hint = match serde_json::from_str(&body) {
        Ok(h) => h,
        Err(_) => return fail(StatusCode::BAD_REQUEST, &ticket.audience, "hint body"),
    };
    match state.engine.hint(&ticket.infohash, ticket.file_index, hint.read_offset, hint.gen).await {
        Ok(()) => ok_json(&ticket.audience, serde_json::json!({ "ok": true })),
        Err(e) => fail(StatusCode::NOT_FOUND, &ticket.audience, &format!("{e:#}")),
    }
}
