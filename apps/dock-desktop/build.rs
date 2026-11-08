fn main() {
    // The pets' commands (TIN-479), and Float's for the dock's window (TIN-698), so a capability can grant them to the remote page (pets.rs, float.rs).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "pet_agents",
            "pet_bubble",
            "pet_grip",
            "pet_move",
            "pet_open_dock",
            "float_state",
            "float_set",
        ])),
    )
    .expect("the build script could not run tauri-build");
}
