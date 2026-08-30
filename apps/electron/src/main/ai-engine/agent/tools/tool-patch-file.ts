import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface PatchFileArgs {
  project_id: string
  file_path: string
  patches: unknown
}

interface PatchEntry {
  start_line: number
  end_line: number
  content: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: patch_project_file — 增量修改指定项目的文件
 *
 * Instead of rewriting the entire file with write_project_file, this tool
 * replaces only the specified line ranges, saving a significant amount of
 * context tokens for large files.
 */
export function toolPatchFile (services: ToolServices): Tool {
  return {
    definition: {
      name: 'patch_project_file',
      description: 'Apply incremental line-range patches to a project file. Much more token-efficient than rewriting the whole file with write_project_file when only a few sections need to change. Patches are applied in reverse line order so that later patches do not shift the line numbers of earlier ones.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          file_path: {
            type: 'string',
            description: 'File path relative to the project root'
          },
          patches: {
            type: 'array',
            description: 'Array of patches. Each patch replaces lines start_line..end_line (1-based, inclusive) with the given content. For pure insertion before a line without removing anything, set end_line to a value less than start_line (e.g. end_line = 0). Patches must not overlap.',
            items: {
              type: 'object',
              properties: {
                start_line: {
                  type: 'integer',
                  description: 'First line to replace (1-based, inclusive). For insertions, the line before which to insert.'
                },
                end_line: {
                  type: 'integer',
                  description: 'Last line to replace (1-based, inclusive). Set to a value less than start_line (e.g. 0) for pure insertion before start_line without removing any existing line.'
                },
                content: {
                  type: 'string',
                  description: 'Replacement content (may be multi-line). An empty string removes the selected lines.'
                }
              },
              required: ['start_line', 'end_line', 'content']
            }
          }
        },
        required: ['project_id', 'file_path', 'patches']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, file_path } = args as unknown as PatchFileArgs
      const rawPatches = (args as Record<string, unknown>).patches

      const patches = normalizePatchEntries(rawPatches)
      if (patches.length === 0) {
        throw new Error('patch_project_file requires at least one patch entry.')
      }

      onProgress?.('📝 正在读取文件...', file_path)
      const originalContent = await services.projectFS.readFile(project_id, file_path)
      const lines = originalContent.split('\n')
      const totalLines = lines.length

      // Validate and sort patches by start_line descending so we can apply
      // them from bottom to top without shifting earlier line numbers.
      const sortedPatches = [...patches].sort((a, b) => b.start_line - a.start_line)

      // Validate no overlaps (after sorting, each patch's effective range must
      // not reach into the range of the next patch below it).
      for (let i = 0; i < sortedPatches.length - 1; i++) {
        const current = sortedPatches[i]
        const next = sortedPatches[i + 1]
        const currentEffectiveStart = Math.max(1, current.start_line)
        // For insertion patches (end_line < start_line), the effective range is
        // just the insertion point — there is no span of removed lines.
        const isNextInsert = next.end_line < next.start_line
        const nextEffectiveEnd = isNextInsert ? next.start_line - 1 : next.end_line
        if (nextEffectiveEnd >= currentEffectiveStart) {
          throw new Error(
            `Patches overlap: lines ${next.start_line}-${next.end_line} and ${current.start_line}-${current.end_line}. Split into non-overlapping ranges.`
          )
        }
      }

      // Apply patches from bottom to top
      let linesModified = 0
      for (const patch of sortedPatches) {
        const startIdx = Math.max(0, patch.start_line - 1) // 0-based
        const isInsert = patch.end_line < patch.start_line
        const endIdx = isInsert ? startIdx : Math.min(totalLines, patch.end_line) // exclusive upper bound for splice

        const newLines = patch.content === '' ? [] : patch.content.split('\n')

        if (isInsert) {
          // Pure insertion before start_line
          lines.splice(startIdx, 0, ...newLines)
        } else {
          // Replace lines [startIdx, endIdx)
          const removeCount = endIdx - startIdx
          lines.splice(startIdx, removeCount, ...newLines)
        }
        linesModified += newLines.length
      }

      const newContent = lines.join('\n')
      onProgress?.('📝 正在写入文件...', `${patches.length} 个补丁, ${linesModified} 行修改`)
      await services.projectFS.writeFile(project_id, file_path, newContent)
      onProgress?.('✅ 文件已保存', file_path)

      return {
        success: true,
        file_path,
        patches_applied: patches.length,
        original_lines: totalLines,
        new_lines: lines.length,
        message: `Applied ${patches.length} patch(es) to ${file_path}. File went from ${totalLines} to ${lines.length} lines.`
      }
    }
  }
}

function normalizePatchEntries (raw: unknown): PatchEntry[] {
  if (!Array.isArray(raw)) {
    // Try to parse if it was stringified
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          return normalizePatchEntries(parsed)
        }
      } catch { /* fall through */ }
    }
    throw new Error('patches must be an array of { start_line, end_line, content } objects.')
  }

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`patches[${index}] must be an object with start_line, end_line, and content.`)
    }
    const e = entry as Record<string, unknown>
    const startLine = Number(e.start_line)
    const endLine = Number(e.end_line)
    if (!Number.isFinite(startLine) || startLine < 1) {
      throw new Error(`patches[${index}].start_line must be a positive integer.`)
    }
    if (!Number.isFinite(endLine)) {
      throw new Error(`patches[${index}].end_line must be an integer.`)
    }
    if (typeof e.content !== 'string') {
      throw new Error(`patches[${index}].content must be a string.`)
    }
    return { start_line: Math.floor(startLine), end_line: Math.floor(endLine), content: e.content }
  })
}
