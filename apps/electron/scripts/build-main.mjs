import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bytenode from 'bytenode'

const BYTECODE_FLAG = '--bytecode'
const isBytecodeBuild = process.argv.includes(BYTECODE_FLAG)
const workspaceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputDir = path.join(workspaceRoot, 'dist-electron/electron')
const mainModulePath = path.join(outputDir, 'main.js')
const mainLoaderPath = path.join(outputDir, 'main.cjs')
const mainBytecodeSourcePath = path.join(outputDir, 'main.bytecode.cjs')
const mainBytecodePath = path.join(outputDir, 'main.jsc')

await mkdir(outputDir, { recursive: true })
await Promise.all([
  rm(mainLoaderPath, { force: true }),
  rm(mainBytecodeSourcePath, { force: true }),
  rm(mainBytecodePath, { force: true }),
  ...(isBytecodeBuild ? [rm(mainModulePath, { force: true })] : [])
])

const bundleOutfile = isBytecodeBuild ? mainBytecodeSourcePath : mainModulePath

await build({
  entryPoints: [path.join(workspaceRoot, 'electron/main.ts')],
  bundle: true,
  platform: 'node',
  format: isBytecodeBuild ? 'cjs' : 'esm',
  outfile: bundleOutfile,
  banner: isBytecodeBuild
    ? {
        js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;"
      }
    : {
        js: "import { createRequire as __esbuildCreateRequire } from 'node:module'; const require = __esbuildCreateRequire(import.meta.url);"
      },
  define: isBytecodeBuild
    ? {
        'import.meta.url': 'import_meta_url'
      }
    : undefined,
  external: [
    'electron',
    'sharp',
    'pnpm'
  ],
  target: ['node22'],
  treeShaking: true,
  minify: true,
  legalComments: 'none',
  sourcemap: false
})

// The history worker has no Electron imports and must ship alongside both
// main.js and the bytecode loader; never fall back to synchronous main-thread IO.
await build({
  entryPoints: [path.join(workspaceRoot, 'src/main/settings/chat-history-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(outputDir, 'chat-history-worker.cjs'),
  target: ['node22'],
  minify: true,
  legalComments: 'none'
})

if (isBytecodeBuild) {
  await bytenode.compileFile({
    filename: mainBytecodeSourcePath,
    output: mainBytecodePath,
    electron: true,
    compileAsModule: true,
    createLoader: false
  })
  await rm(mainBytecodeSourcePath, { force: true })
}

await writeFile(
  mainLoaderPath,
  `'use strict';

const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const bytecodeEntry = join(__dirname, 'main.jsc');
const moduleEntry = join(__dirname, 'main.js');

// ---- Hot payload bootstrap (docs/desktop-hot-update-design.md 5.2) ----
// This is the only code that decides which asar to load. It must stay tiny,
// dependency-free and never crash: any failure falls back to the installed app.
// Hash verification happened at apply time; here we only check existence and
// version compatibility so cold start stays fast.

function compareSemverCore (left, right) {
  const parse = (value) => String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('+')[0]
    .split('-')[0]
    .split('.')
    .slice(0, 3)
    .map((part) => parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

// 跨平台热包根目录，与 hot-payload-store.ts 的 getHotRoot() 必须保持一致：
// win %LOCALAPPDATA%\\WorldBase\\hot（避开 Roaming）、mac ~/Library/Application Support/WorldBase/hot、
// linux $XDG_DATA_HOME/WorldBase/hot（默认 ~/.local/share）。
function resolveHotRoot () {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'WorldBase', 'hot') : null;
  }
  const home = process.env.HOME || require('node:os').homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'WorldBase', 'hot');
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'WorldBase', 'hot');
}

function tryActivateHotPayload (app) {
  if (!app || !app.isPackaged) return null;

  const hotRoot = resolveHotRoot();
  if (!hotRoot) return null;
  const currentPath = join(hotRoot, 'current.json');

  let current;
  try {
    current = JSON.parse(readFileSync(currentPath, 'utf8'));
  } catch {
    return null;
  }
  const version = typeof current.version === 'string' ? current.version : '';
  const dirName = typeof current.dir === 'string' && current.dir ? current.dir : version;
  if (!version || !dirName) return null;

  const hotDir = join(hotRoot, dirName);
  const clearCurrent = () => {
    try {
      rmSync(currentPath, { force: true });
    } catch {
    }
  };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(hotDir, 'manifest.json'), 'utf8'));
  } catch {
    clearCurrent();
    return null;
  }
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version : '';
  if (
    manifest.kind !== 'hot_payload' ||
    !manifestVersion ||
    manifest.electronVersion !== process.versions.electron ||
    compareSemverCore(manifestVersion, app.getVersion()) <= 0 ||
    !existsSync(join(hotDir, 'app.asar'))
  ) {
    // 安装器升级覆盖了热包版本、Electron 升级、或包损坏：清掉走安装版本。
    try {
      rmSync(hotDir, { recursive: true, force: true });
    } catch {
    }
    clearCurrent();
    return null;
  }

  const bootStatePath = join(hotRoot, 'boot-state.json');
  let bootState = null;
  try {
    bootState = JSON.parse(readFileSync(bootStatePath, 'utf8'));
  } catch {
  }
  if (!bootState || bootState.version !== manifestVersion || typeof bootState.attempts !== 'number') {
    bootState = { version: manifestVersion, attempts: 0 };
  }

  if (bootState.attempts >= 2 && !bootState.lastOkAt) {
    // 连续两次启动都没确认健康：坏包，回退安装版本并记回滚事件，
    // 事件由下一次成功启动的 UpdateService 从 pending-events.json 补发。
    try {
      rmSync(hotDir, { recursive: true, force: true });
    } catch {
    }
    clearCurrent();
    const event = {
      kind: 'hot_payload',
      fromVersion: app.getVersion(),
      toVersion: manifestVersion,
      phase: 'rolled_back',
      error: 'hot payload failed to boot ' + bootState.attempts + ' times'
    };
    try {
      const pendingPath = join(hotRoot, 'pending-events.json');
      let pending = [];
      try {
        const parsed = JSON.parse(readFileSync(pendingPath, 'utf8'));
        if (Array.isArray(parsed)) pending = parsed;
      } catch {
      }
      pending.push(event);
      mkdirSync(hotRoot, { recursive: true });
      writeFileSync(pendingPath, JSON.stringify(pending));
    } catch {
    }
    return null;
  }

  bootState.attempts += 1;
  try {
    mkdirSync(hotRoot, { recursive: true });
    writeFileSync(bootStatePath, JSON.stringify(bootState));
  } catch {
  }

  const hotEntry = join(hotDir, 'app.asar', 'dist-electron', 'electron', 'main.cjs');
  if (!existsSync(hotEntry)) {
    clearCurrent();
    return null;
  }
  process.env.WORLDBASE_HOT_RESOURCES = hotDir;
  return hotEntry;
}

(async () => {
  try {
    let hotEntry = null;
    try {
      const { app } = require('electron');
      hotEntry = tryActivateHotPayload(app);
    } catch {
      hotEntry = null;
    }

    if (hotEntry) {
      // 同步 require 失败直接抛出：boot-state 已计数，连续失败会自动回滚，
      // 不能在主进程半初始化后再 require 安装版本（协议重复注册等会崩）。
      require(hotEntry);
      return;
    }

    if (existsSync(bytecodeEntry)) {
      require('bytenode');
      require(bytecodeEntry);
      return;
    }

    await import(pathToFileURL(moduleEntry).href);
  } catch (error) {
    process.nextTick(() => {
      throw error;
    });
  }
})();
`,
  'utf8'
)

console.log(
  isBytecodeBuild
    ? '[build-main] Main process bundled as minified CommonJS bytecode with a CJS loader'
    : '[build-main] Main process bundled as minified ESM with a CJS loader and runtime-only externals'
)
