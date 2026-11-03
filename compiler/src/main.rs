//! This project's rbxtsc: rbxts-rs's command line (`rbxts_cli`) with the project's plugins compiled in.

#[global_allocator]
static GLOBAL: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

fn main() -> std::process::ExitCode {
    rbxts_cli::Cli::new()
        // .plugin(my_plugin::MyPlugin::new())
        .run()
}
