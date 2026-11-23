//! Sending email (sign-in links) through the admin's own mail server (SMTP). Settings live in
//! the encrypted store (`external::Service::Mail`, the password with them); nothing is sent without them.

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};

/// How the connection is secured: TLS from the start (port 465), STARTTLS (587), or none
/// (a local relay only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Security {
    Tls,
    Starttls,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MailConfig {
    pub host: String,
    pub port: u16,
    pub security: Security,
    /// Empty: no sign-in (a local relay).
    pub username: String,
    pub password: String,
    /// "Panda <panda@example.com>".
    pub from: String,
}

impl MailConfig {
    fn transport(&self) -> ApiResult<AsyncSmtpTransport<Tokio1Executor>> {
        let bad = |e: lettre::transport::smtp::Error| ApiError::Validation(format!("mail server: {e}"));
        let mut b = match self.security {
            Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&self.host).map_err(bad)?,
            Security::Starttls => {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.host).map_err(bad)?
            }
            Security::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.host),
        }
        .port(self.port)
        .timeout(Some(std::time::Duration::from_secs(15)));
        if !self.username.is_empty() {
            b = b.credentials(Credentials::new(self.username.clone(), self.password.clone()));
        }
        Ok(b.build())
    }

    pub(crate) fn sender(&self) -> ApiResult<Mailbox> {
        self.from.parse().map_err(|_| ApiError::Validation("the From address isn't valid".into()))
    }

    /// Connect and sign in (no mail sent): used when saving the settings.
    pub(crate) async fn check(&self) -> ApiResult<()> {
        self.sender()?;
        match self.transport()?.test_connection().await {
            Ok(true) => Ok(()),
            Ok(false) => Err(ApiError::Validation("the mail server didn't answer".into())),
            Err(e) => Err(ApiError::Validation(format!("mail server: {e}"))),
        }
    }

    /// Send a plain-text email.
    pub(crate) async fn send(&self, to: &str, subject: &str, body: String) -> ApiResult<()> {
        let to: Mailbox =
            to.parse().map_err(|_| ApiError::Validation("that email address isn't valid".into()))?;
        let msg = Message::builder()
            .from(self.sender()?)
            .to(to)
            .subject(subject)
            .body(body)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        self.transport()?
            .send(msg)
            .await
            .map(|_| ())
            .map_err(|e| ApiError::BadRequest(format!("couldn't send the email: {e}")))
    }
}
