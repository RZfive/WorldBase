export interface ScheduledTaskTraceStep {
  at: string
  stage: string
  detail?: string
  kind?: ScheduledTaskProgressEntry['kind']
}

export interface ScheduledTaskTraceTool {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  endedAt?: string
  steps: ScheduledTaskTraceStep[]
}

export type ScheduledTaskTraceItem =
  | { kind: 'stage'; step: ScheduledTaskTraceStep }
  | { kind: 'tool'; tool: ScheduledTaskTraceTool }
  | { kind: 'thinking'; at?: string }

export interface ScheduledTaskTrace {
  items: ScheduledTaskTraceItem[]
  tools: ScheduledTaskTraceTool[]
  stepCount: number
}

function toolNameFor (entry: ScheduledTaskProgressEntry): string {
  return entry.toolName?.trim() || entry.detail?.trim() || entry.stage
}

function toStep (entry: ScheduledTaskProgressEntry): ScheduledTaskTraceStep {
  return {
    at: entry.at,
    stage: entry.stage,
    detail: entry.detail || undefined,
    kind: entry.kind
  }
}

function findRunningTool (running: ScheduledTaskTraceTool[], name: string): number {
  for (let index = running.length - 1; index >= 0; index -= 1) {
    if (running[index].name === name) return index
  }
  return -1
}

/**
 * Collapse the scheduler's flat progress log into the same shape the chat work
 * summary uses: one row per tool call, with its own progress attached, plus the
 * few standalone stages that happen outside a tool call.
 *
 * Tool events may interleave when the harness runs calls in parallel, so a
 * single "active tool" pointer is not enough — match by name first, then fall
 * back to the most recently started call.
 */
export function buildScheduledTaskTrace (
  progress: ScheduledTaskProgressEntry[] = [],
  reportStatus: ScheduledTaskRunReport['status'] = 'completed',
  hasThinking = false
): ScheduledTaskTrace {
  const tools: ScheduledTaskTraceTool[] = []
  const running: ScheduledTaskTraceTool[] = []
  const items: ScheduledTaskTraceItem[] = []
  let thinkingAt: string | undefined
  let stepCount = 0

  for (const entry of progress) {
    if (entry.kind === 'thinking') {
      thinkingAt ||= entry.at
      continue
    }

    if (entry.kind === 'tool_start') {
      const tool: ScheduledTaskTraceTool = {
        id: `tool_${tools.length + 1}`,
        name: toolNameFor(entry),
        status: 'running',
        startedAt: entry.at,
        steps: []
      }
      tools.push(tool)
      running.push(tool)
      items.push({ kind: 'tool', tool })
      continue
    }

    if (entry.kind === 'tool_end') {
      const name = toolNameFor(entry)
      const index = findRunningTool(running, name)
      const tool = index >= 0 ? running.splice(index, 1)[0] : running.pop()
      if (tool) {
        tool.status = 'completed'
        tool.endedAt = entry.at
      }
      continue
    }

    const step = toStep(entry)
    stepCount += 1
    const explicitToolIndex = entry.toolName ? findRunningTool(running, entry.toolName) : -1
    const activeTool = explicitToolIndex >= 0
      ? running[explicitToolIndex]
      : running[running.length - 1]
    if (activeTool) {
      activeTool.steps.push(step)
    } else {
      items.push({ kind: 'stage', step })
    }
  }

  if (hasThinking) {
    items.unshift({ kind: 'thinking', at: thinkingAt || progress[0]?.at })
  }

  const settledStatus = reportStatus === 'failed'
    ? 'failed'
    : reportStatus === 'running' || reportStatus === 'retrying'
      ? 'running'
      : 'completed'

  for (const tool of tools) {
    if (tool.status !== 'running') continue
    tool.status = settledStatus
    if (settledStatus !== 'running' && !tool.endedAt) {
      tool.endedAt = progress[progress.length - 1]?.at
    }
  }

  return {
    items,
    tools,
    stepCount
  }
}
