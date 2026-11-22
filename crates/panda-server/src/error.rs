use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Error type for handlers. Renders as `{"error": "..."}` with a matching status code.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("authentication required")]
    Unauthorized,
    #[error("invalid username or password")]
    InvalidCredentials,
    #[error("you don't have access to this")]
    Forbidden,
    #[error("too many attempts, try again in {0} seconds")]
    TooManyRequests(u64),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Validation(String),
    #[error("{0} is not configured")]
    NotConfigured(&'static str),
    #[error("{0}")]
    Busy(String),
    /// The library's storage (a NAS share) isn't reachable right now.
    #[error("{0}")]
    Offline(String),
    #[error(transparent)]
    Db(#[from] panda_db::Error),
    #[error(transparent)]
    Media(#[from] panda_media::Error),
    #[error(transparent)]
    Arr(#[from] panda_arr::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Auth(#[from] panda_auth::Error),
    #[error(transparent)]
    Metadata(#[from] panda_metadata::Error),
    #[error("{0}")]
    Internal(String),
}

pub(crate) type ApiResult<T> = Result<T, ApiError>;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized | ApiError::InvalidCredentials => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Validation(_)
            | ApiError::Auth(panda_auth::Error::PasswordPolicy | panda_auth::Error::PinPolicy) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            ApiError::NotConfigured(_) | ApiError::Busy(_) | ApiError::Offline(_) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            ApiError::Arr(_) | ApiError::Metadata(_) => StatusCode::BAD_GATEWAY,
            ApiError::Db(_)
            | ApiError::Media(_)
            | ApiError::Io(_)
            | ApiError::Auth(_)
            | ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        // Internal details go to the log, never to the client.
        let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self, "request failed");
            "internal server error".to_string()
        } else {
            if status.is_server_error() {
                tracing::warn!(error = %self, "upstream request failed");
            }
            self.to_string()
        };
        let mut res = (status, Json(json!({ "error": message }))).into_response();
        if let ApiError::TooManyRequests(secs) = self {
            res.headers_mut().insert(axum::http::header::RETRY_AFTER, secs.into());
        }
        res
    }
}
