use anyhow::Context;

// mimalloc handles the many short-lived allocations of HTTP + JSON better than the system allocator.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("--version" | "-V") => {
            println!("panda {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("bench") => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            return panda_server::bench::run(panda_server::bench::parse_args(&args)?).await;
        }
        Some("--help" | "-h") => {
            println!(
                "panda {}: self-hosted media server\n\n\
                 Runs the server; settings come from $PANDA_CONFIG, ./panda.toml or panda.toml in\n\
                 the data folder. Environment: PANDA_DATA_DIR, PANDA_CACHE_DIR, PANDA_BIND,\n\
                 PANDA_FFMPEG, PANDA_TMDB_TOKEN.\n\n\
                 panda bench [--max N] [--seconds S]: how many streams this machine can serve at\n\
                 once (1080p and 4K, re-encoded or repackaged), with files from your library.",
                env!("CARGO_PKG_VERSION")
            );
            return Ok(());
        }
        _ => {}
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "panda=info,panda_server=info,tower_http=info".into()),
        )
        .init();

    let config = panda_server::Config::load().context("loading config")?;
    let state = panda_server::AppState::init(config).await?;
    panda_server::serve(state).await
}
