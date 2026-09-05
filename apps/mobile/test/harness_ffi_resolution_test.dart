import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/harness_ffi.dart';

void main() {
  test('FFI development artifacts are ordered by freshness, not profile', () {
    final olderDebug = HarnessFfiLibraryCandidate(
      path: '/repo/target/debug/libworldbase_mobile_ffi.dylib',
      modifiedAt: DateTime.utc(2026, 9, 1),
    );
    final newerRelease = HarnessFfiLibraryCandidate(
      path: '/repo/target/release/libworldbase_mobile_ffi.dylib',
      modifiedAt: DateTime.utc(2026, 9, 2),
    );

    expect(
      orderHarnessFfiCandidates([
        olderDebug,
        newerRelease,
      ]).map((candidate) => candidate.path),
      [newerRelease.path, olderDebug.path],
    );
  });

  test('FFI candidate ordering is deterministic for equal timestamps', () {
    final timestamp = DateTime.utc(2026, 9, 3);
    final ordered = orderHarnessFfiCandidates([
      HarnessFfiLibraryCandidate(path: '/z/library', modifiedAt: timestamp),
      HarnessFfiLibraryCandidate(path: '/a/library', modifiedAt: timestamp),
    ]);

    expect(ordered.map((candidate) => candidate.path), [
      '/a/library',
      '/z/library',
    ]);
  });
}
