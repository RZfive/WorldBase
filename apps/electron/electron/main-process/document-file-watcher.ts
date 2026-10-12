/**
 * 文档文件监听服务。
 *
 * 覆盖草稿流之外的一切磁盘变化（用户在 WPS/Word 中直接修改、其他程序写盘、
 * 直写工具兜底）：文档页打开时注册路径，变化时通知渲染层展示
 * "文件已在磁盘被修改" 提示条。同一文件的监听按引用计数共享。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEBOUNCE_MS = 400

interface WatchEntry {
  watcher: fs.FSWatcher | null
  poller: NodeJS.Timeout | null
  refCount: number
  /** 去抖定时器：merge 短时间内的多次事件。 */
  pending: NodeJS.Timeout | null
  lastMtimeMs: number
  lastSize: number
}

export interface DocumentFileChange {
  filePath: string
  mtimeMs: number
  size: number
}

export class DocumentFileWatcher {
  private readonly entries = new Map<string, WatchEntry>()
  private readonly listeners = new Set<(change: DocumentFileChange) => void>()

  /**
   * Register (or ref-count) a watch for an absolute file path. Returns false
   * when the file does not exist.
   */
  watch (rawPath: string): boolean {
    const filePath = path.resolve(rawPath)
    const existing = this.entries.get(filePath)
    if (existing) {
      existing.refCount += 1
      return true
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return false
    }
    if (!stat.isFile()) return false

    const entry: WatchEntry = {
      watcher: this.startWatcher(filePath),
      poller: null,
      refCount: 1,
      pending: null,
      lastMtimeMs: stat.mtimeMs,
      lastSize: stat.size
    }
    // fs.watch 在部分平台/文件系统上不可靠（网络盘、某些临时目录），失败时
    // 回退为轮询 stat。
    if (!entry.watcher) {
      entry.poller = setInterval(() => this.check(filePath), 2_000)
    }
    this.entries.set(filePath, entry)
    return true
  }

  unwatch (rawPath: string): void {
    const filePath = path.resolve(rawPath)
    const entry = this.entries.get(filePath)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    this.disposeEntry(filePath, entry)
  }

  dispose (): void {
    for (const [filePath, entry] of this.entries) {
      this.disposeEntry(filePath, entry)
    }
  }

  onChange (listener: (change: DocumentFileChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  watchedPaths (): string[] {
    return [...this.entries.keys()]
  }

  private disposeEntry (filePath: string, entry: WatchEntry): void {
    entry.watcher?.close()
    if (entry.poller) clearInterval(entry.poller)
    if (entry.pending) clearTimeout(entry.pending)
    this.entries.delete(filePath)
  }
  private startWatcher (filePath: string): fs.FSWatcher | null {
    try {
      const watcher = fs.watch(filePath, () => this.check(filePath))
      watcher.on('error', () => {
        // 监听失效（文件被删除/重命名）：保留 entry，由轮询兜底恢复或等 unwatch。
      })
      return watcher
    } catch {
      return null
    }
  }

  private check (filePath: string): void {
    const entry = this.entries.get(filePath)
    if (!entry) return
    if (entry.pending) clearTimeout(entry.pending)
    entry.pending = setTimeout(() => {
      entry.pending = null
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        // 文件消失：不发事件（页面已有 missing 状态卡片处理该情况）。
        return
      }
      if (stat.mtimeMs === entry.lastMtimeMs && stat.size === entry.lastSize) return
      entry.lastMtimeMs = stat.mtimeMs
      entry.lastSize = stat.size
      const change: DocumentFileChange = {
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      }
      for (const listener of this.listeners) {
        try {
          listener(change)
        } catch {
          // 单个监听者异常不影响其他通知。
        }
      }
    }, DEBOUNCE_MS)
  }
}
