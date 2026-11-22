//! Tell TV apps on the local network where this server is: an mDNS (Bonjour/NSD) service,
//! `_panda._tcp.local.`, named after this computer, with the port and version. Apple TV and
//! Android TV browse for it; apps that can't (LG, Samsung) scan the TV's own network for
//! `/api/info` instead. Off with `[server] advertise = false`, and never for a server bound to
//! loopback only (nobody else could reach it).

use std::sync::OnceLock;

use mdns_sd::{ServiceDaemon, ServiceInfo};

use crate::state::AppState;

/// The service type TV apps look for.
pub(crate) const SERVICE_TYPE: &str = "_panda._tcp.local.";

/// Kept for the life of the program: dropping it would withdraw the announcement.
static DAEMON: OnceLock<ServiceDaemon> = OnceLock::new();

/// This computer's name, as people see it ("Living-Room-Mac"; never its network domain).
pub(crate) fn server_name() -> String {
    let name = gethostname::gethostname().to_string_lossy().into_owned();
    // The first label only: "Mac.example.com" is "Mac" (a network's domain is no name).
    let name = name.split('.').next().unwrap_or_default().trim();
    if name.is_empty() { "Panda".to_string() } else { name.to_string() }
}

pub(crate) fn spawn(state: &AppState) {
    let bind = state.config.server.bind;
    if !state.config.server.advertise || bind.ip().is_loopback() {
        return;
    }
    let name = server_name();
    let host = format!("{}.local.", name.replace(' ', "-"));
    let props = [("version", env!("CARGO_PKG_VERSION")), ("path", "/")];
    let info = ServiceInfo::new(SERVICE_TYPE, &name, &host, "", bind.port(), &props[..])
        .map(ServiceInfo::enable_addr_auto);
    let result = info.and_then(|info| {
        let daemon = ServiceDaemon::new()?;
        daemon.register(info)?;
        Ok(daemon)
    });
    match result {
        Ok(daemon) => {
            let _ = DAEMON.set(daemon);
            tracing::info!(name, port = bind.port(), "announced on the local network ({SERVICE_TYPE})");
        }
        Err(e) => {
            tracing::warn!(error = %e, "couldn't announce on the local network; TVs can still use the address");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_is_never_empty_or_a_domain() {
        let n = server_name();
        assert!(!n.is_empty() && !n.contains('.'), "{n}");
    }
}
