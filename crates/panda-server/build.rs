//! Bundles the admin web UI into the binary: the built site (`clients/admin/dist`, from
//! `pnpm build`) is copied to `$OUT_DIR/web`, which `routes/web.rs` embeds. Without a build the
//! folder is empty and the server serves the UI from disk (or tells you to run `pnpm dev`).
//! The TV app's browser build (`clients/tv/dist/server`, `pnpm build:server`) goes to
//! `$OUT_DIR/tv` the same way, served at `/tv`, and the web app for watching (`clients/web/dist`,
//! `pnpm build`) to `$OUT_DIR/watch`, served at `/watch`.

use std::path::{Path, PathBuf};

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if entry.path().extension().is_some_and(|e| e == "map") {
            // Source maps are for debugging the site, not for shipping in the binary.
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn main() {
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../clients/admin/dist");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("web");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).expect("create web dir");
    if dist.join("index.html").is_file() {
        copy_dir(&dist, &out).expect("copy admin UI build");
    } else {
        println!("cargo:warning=admin UI not built (clients/admin/dist); the binary won't include it");
    }
    println!("cargo:rerun-if-changed={}", dist.display());

    let tv = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../clients/tv/dist/server");
    let tv_out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("tv");
    let _ = std::fs::remove_dir_all(&tv_out);
    std::fs::create_dir_all(&tv_out).expect("create tv dir");
    if tv.join("index.html").is_file() {
        copy_dir(&tv, &tv_out).expect("copy TV app build");
    } else {
        println!("cargo:warning=TV app not built (clients/tv: pnpm build:server); /tv won't be served");
    }
    println!("cargo:rerun-if-changed={}", tv.display());

    let watch = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../clients/web/dist");
    let watch_out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("watch");
    let _ = std::fs::remove_dir_all(&watch_out);
    std::fs::create_dir_all(&watch_out).expect("create watch dir");
    if watch.join("index.html").is_file() {
        copy_dir(&watch, &watch_out).expect("copy web app build");
    } else {
        println!("cargo:warning=web app not built (clients/web: pnpm build); /watch won't be served");
    }
    println!("cargo:rerun-if-changed={}", watch.display());
    println!("cargo:rerun-if-changed=build.rs");
}
