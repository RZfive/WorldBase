Pod::Spec.new do |s|
  s.name             = 'WorldBaseRust'
  s.version          = '0.1.0'
  s.summary          = 'WorldBase Rust harness 静态库（FFI 进程内嵌入）'
  s.description      = '构建期交叉编译 worldbase-mobile-ffi（iOS 模拟器/真机），链接进 Runner。'
  s.homepage         = 'https://github.com/worldbase/the-world'
  s.license          = { :type => 'MIT' }
  s.authors          = { 'WorldBase Team' => 'dev@worldbase.dev' }
  s.source           = { :git => 'https://github.com/worldbase/the-world.git', :tag => 'v0.1.0' }
  s.ios.deployment_target = '13.0'
  s.source_files = 'WorldBaseRustSrc/*'

  rust_build_dir = File.join(__dir__, 'rust-build')
  rust_lib       = File.join(rust_build_dir, 'libworldbase_mobile_ffi.a')
  build_script   = File.expand_path(File.join('..', '..', '..', 'scripts', 'build_rust_ios.sh'), __dir__)

  s.script_phase = {
    :name => 'Build Rust Harness',
    :script => "RUST_OUT_DIR='#{rust_build_dir}' '#{build_script}'",
    :execution_position => :before_compile,
    :output_files => [rust_lib],
  }
  s.libraries = 'z'
  s.frameworks = 'Security', 'SystemConfiguration', 'CoreFoundation', 'CFNetwork'
  # 静态库符号需强制载入并导出，dlsym 才能在主程序里找到 FFI 入口
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => "-force_load #{rust_lib} -Wl,-export_dynamic"
  }
end
