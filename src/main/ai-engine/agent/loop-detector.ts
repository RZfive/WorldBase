/**
 * Loop Detector — 迭代循环检测
 *
 * 使用 SHA-256 哈希对每次迭代的工具调用和结果进行指纹化，
 * 实现更健壮的循环检测，防止 Agent 空转浪费 token。
 */

import { createHash } from 'node:crypto'

export interface IterationFingerprint {
  toolCalls: Array<{
    name: string
    argsHash: string
  }>
  resultHash: string
}

export interface LoopDetectionResult {
  looping: boolean
  reason?: string
  /** 当前连续重复次数 */
  consecutiveCount: number
}

export class LoopDetector {
  private history: IterationFingerprint[] = []
  private readonly maxDuplicates: number
  /** 截断字符串长度 — 容忍细微差异 */
  private static readonly HASH_STRING_LIMIT = 200

  constructor (maxDuplicates = 6) {
    this.maxDuplicates = maxDuplicates
  }

  /** 记录一次迭代并返回检测结果 */
  record (toolExecutions: Array<{ name: string; args: Record<string, unknown>; result: unknown }>): LoopDetectionResult {
    if (toolExecutions.length === 0) {
      return { looping: false, consecutiveCount: 0 }
    }

    const fingerprint = this.buildFingerprint(toolExecutions)
    this.history.push(fingerprint)

    return this.detect()
  }

  /** 检测是否进入死循环 */
  detect (): LoopDetectionResult {
    if (this.history.length < 2) {
      return { looping: false, consecutiveCount: this.history.length }
    }

    // 从尾部向前计算连续重复次数
    const latest = this.history[this.history.length - 1]
    let consecutiveCount = 1
    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.fingerprintsEqual(this.history[i], latest)) {
        consecutiveCount++
      } else {
        break
      }
    }

    if (consecutiveCount >= this.maxDuplicates) {
      return {
        looping: true,
        reason: `Agent 在最近 ${consecutiveCount} 次迭代中重复执行了相同的操作且获得相同的结果。已自动停止以避免无限循环。请调整提示或尝试不同的策略。`,
        consecutiveCount
      }
    }

    return { looping: false, consecutiveCount }
  }

  /** 重置状态 */
  reset (): void {
    this.history = []
  }

  private buildFingerprint (executions: Array<{ name: string; args: Record<string, unknown>; result: unknown }>): IterationFingerprint {
    const combinedResultParts: string[] = []
    const toolCalls = executions.map(exec => {
      const argsHash = this.hashValue(exec.args)
      combinedResultParts.push(this.hashValue(exec.result))
      return { name: exec.name, argsHash }
    })

    return {
      toolCalls,
      resultHash: this.hashString(combinedResultParts.join(':'))
    }
  }

  private fingerprintsEqual (a: IterationFingerprint, b: IterationFingerprint): boolean {
    if (a.toolCalls.length !== b.toolCalls.length) return false
    if (a.resultHash !== b.resultHash) return false

    for (let i = 0; i < a.toolCalls.length; i++) {
      if (a.toolCalls[i].name !== b.toolCalls[i].name) return false
      if (a.toolCalls[i].argsHash !== b.toolCalls[i].argsHash) return false
    }

    return true
  }

  private hashValue (value: unknown): string {
    const normalized = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'string' && v.length > LoopDetector.HASH_STRING_LIMIT) {
        return v.slice(0, LoopDetector.HASH_STRING_LIMIT)
      }
      return v
    }) ?? ''
    return this.hashString(normalized)
  }

  private hashString (input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16)
  }
}
