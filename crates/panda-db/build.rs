// Rebuild when a migration is added: sqlx::migrate! embeds the folder at compile time.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
