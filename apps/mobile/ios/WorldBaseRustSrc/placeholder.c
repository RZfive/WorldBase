// 占位编译单元：WorldBaseRust pod 的实际产物是构建期生成的
// rust-build/libworldbase_mobile_ffi.a（见 scripts/build_rust_ios.sh），
// 经 user_target_xcconfig 的 -force_load 链接进 Runner。
int worldbase_rust_placeholder(void) { return 0; }
