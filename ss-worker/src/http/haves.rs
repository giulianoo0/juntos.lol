use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use super::{fail, AppState};

/// GET /v1/t/{ticket}/haves: the raw piece bitfield, for the buffered
/// ranges bar. Piece count and length ride in headers.
pub async fn get(State(state): State<Arc<AppState>>, Path(ticket): Path<String>) -> Response {
    let ticket = match state.verify(&ticket) {
        Ok(t) => t,
        Err(e) => return fail(StatusCode::UNAUTHORIZED, "*", &e.to_string()),
    };
    match state.engine.haves(&ticket.infohash) {
        Ok((bits, total, piece_len)) => {
            let mut response = (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::HeaderName::from_static("x-bitfield-len"), total.to_string()),
                    (header::HeaderName::from_static("x-piece-length"), piece_len.to_string()),
                ],
                bits,
            )
                .into_response();
            super::cors::apply(&mut response, &ticket.audience);
            response
        }
        Err(e) => fail(StatusCode::SERVICE_UNAVAILABLE, &ticket.audience, &format!("{e:#}")),
    }
}
