#!/usr/bin/env node
// 一键同步四处版本号，避免发版时手动改漏：
//   node scripts/bump-version.mjs 1.6.7           # 四处统一改为 1.6.7
//   node scripts/bump-version.mjs v1.6.7          # 兼容带 v 前缀
//   node scripts/bump-version.mjs --check         # 校验四处一致（main CI 漂移检查）
//   node scripts/bump-version.mjs --check v1.6.7  # 校验四处等于 tag（release 用）
// 覆盖：根/ Electron package.json、harness-rs [workspace.package]、Flutter pubspec
// （pubspec 的 build number 按现有规律派生：1.6.6+10606 → M*10000+m*100+p）。

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

const FILES = {
  rootPackage: 'package.json',
  electronPackage: 'apps/electron/package.json',
  cargo: 'harness-rs/Cargo.toml',
  pubspec: 'apps/mobile/pubspec.yaml',
};

const LABELS = {
  rootPackage: 'root package.json',
  electronPackage: 'electron package.json',
  cargo: 'harness-rs Cargo.toml',
  pubspec: 'pubspec.yaml',
};

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(input.trim());
  if (!m) fail(`invalid version "${input}", expected x.y.z`);
  return { major: +m[1], minor: +m[2], patch: +m[3], text: `${+m[1]}.${+m[2]}.${+m[3]}` };
}

// 从文件内容中读当前版本；找不到返回 null
function readVersion(kind, content) {
  const patterns = {
    rootPackage: /^\s*"version":\s*"([^"]+)"/m,
    electronPackage: /^\s*"version":\s*"([^"]+)"/m,
    cargo: /^version = "([^"]+)"/m,
    pubspec: /^version:\s*([^\s+]+)\+/m, // 只取 + 前面的版本部分
  };
  const m = patterns[kind].exec(content);
  return m ? m[1] : null;
}

// Cargo.lock 中 17 个 crate 均继承 workspace 版本（name = "worldbase-*"），同步之
function syncCargoLock(version) {
  const lockPath = `${ROOT}harness-rs/Cargo.lock`;
  let lock;
  try {
    lock = readFileSync(lockPath, 'utf8');
  } catch {
    console.log('  Cargo.lock 不存在，跳过');
    return;
  }
  try {
    // 有 cargo 时交给 cargo 官方同步（--offline 避免联网），失败再走手工替换
    execFileSync('cargo', ['update', '-w', '--offline', '--manifest-path', `${ROOT}harness-rs/Cargo.toml`], { stdio: 'pipe' });
    console.log('  Cargo.lock 已通过 cargo update -w 同步');
    return;
  } catch {
    // 无 cargo 或 cargo 失败：按 [[package]] name = "worldbase-*" 块内替换 version
    const blocks = lock.split('[[package]]');
    const fixed = blocks.map((block) => {
      if (!/^\s*name = "worldbase-/m.test(block)) return block;
      return block.replace(/^(\s*version = )"[^"]*"/m, `$1"${version}"`);
    });
    writeFileSync(lockPath, fixed.join('[[package]]'));
    console.log('  Cargo.lock 已手工同步（cargo 不可用）');
  }
}

const arg = process.argv[2];
if (!arg) fail(`usage: node scripts/bump-version.mjs <x.y.z | --check [tag]>`);

if (arg === '--check') {
  // 校验模式：有 tag 则要求四处等于 tag，否则要求四处互相一致
  const target = process.argv[3] ? parseVersion(process.argv[3]) : null;
  const contents = Object.fromEntries(
    Object.entries(FILES).map(([k, p]) => [k, readFileSync(`${ROOT}${p}`, 'utf8')])
  );
  const versions = Object.fromEntries(
    Object.entries(FILES).map(([k]) => [k, readVersion(k, contents[k])])
  );
  for (const [k, v] of Object.entries(versions)) console.log(`${LABELS[k]} = ${v ?? '(未找到)'}`);
  const bad = Object.entries(versions).filter(([, v]) => !v || (target ? v !== target.text : v !== versions.rootPackage));
  if (bad.length > 0) {
    for (const [k, v] of bad) {
      const expected = target ? target.text : versions.rootPackage;
      console.error(`Error: ${LABELS[k]} version is ${v} but expected ${expected}`);
    }
    process.exit(1);
  }
  console.log(target ? `OK: 四处版本均为 ${target.text}` : 'OK: 四处版本一致');
} else {
  // 写入模式
  const target = parseVersion(arg);
  const buildNumber = target.major * 10000 + target.minor * 100 + target.patch;
  for (const [k, p] of Object.entries(FILES)) {
    const path = `${ROOT}${p}`;
    const content = readFileSync(path, 'utf8');
    const current = readVersion(k, content);
    if (!current) fail(`${p} 中未找到版本号`);
    if (current === target.text) {
      console.log(`${LABELS[k]}: 已是 ${target.text}，跳过`);
      continue;
    }
    let updated;
    if (k === 'pubspec') {
      updated = content.replace(/^version:\s*\S+/m, `version: ${target.text}+${buildNumber}`);
    } else if (k === 'cargo') {
      updated = content.replace(/^version = "[^"]*"/m, `version = "${target.text}"`);
    } else {
      updated = content.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${target.text}"`);
    }
    if (updated === content) fail(`${p} 版本号替换失败`);
    writeFileSync(path, updated);
    console.log(`${LABELS[k]}: ${current} -> ${target.text}${k === 'pubspec' ? `+${buildNumber}` : ''}`);
  }
  syncCargoLock(target.text);
  console.log(`完成：四处版本已统一为 ${target.text}`);
}
