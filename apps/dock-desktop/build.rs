fn main() {
    // The pets' commands (TIN-479), so a capability can grant them to the pets' remote page (pets.rs).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "pet_agents",
            "pet_bubble",
            "pet_grip",
            "pet_move",
            "pet_open_dock",
        ])),
    )
    .expect("the build script could not run tauri-build");
}
