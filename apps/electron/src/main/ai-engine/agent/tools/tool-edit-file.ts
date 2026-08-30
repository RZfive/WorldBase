import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { ReadFileTracker } from './read-tracker.js'

interface ToolServices {
  projectFS: ProjectFS
}

interface EditFileArgs {
  project_id: string
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences (haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}

/**
 * Tool: edit_project_file — 对项目文件做精确字符串替换
 *
 * Aligns with Claude Code's Edit tool: the model copies an exact snippet of the
 * file as old_string and supplies its replacement. Compared with line-range
 * patches, exact-string matching is far less error-prone because the model never
 * has to count or track line numbers — it just reproduces text it has read.
 *
 * Safety constraints:
 *  - the file must have been read this session (so edits are never blind);
 *  - old_string must match the current file content byte-for-byte;
 *  - old_string must be unique unless replace_all is set.
 *
 * The legacy patch_project_file (line-range) tool remains available for callers
 * that prefer it, but edit_project_file is the preferred editor.
 */
export function toolEditFile (services: ToolServices, readTracker?: ReadFileTracker): Tool {
  return {
    definition: {
      name: 'edit_project_file',
      description: [
        'Performs exact string replacements in a project file. This is the preferred way to edit existing files.',
        'You must use read_project_file on the file earlier in the conversation before editing it; editing an unread file is rejected.',
        'old_string must match the current file content exactly, character for character (including indentation and whitespace). Do NOT include the line-number + tab prefix that read_project_file adds — match only the real content after it.',
        'If old_string is not unique in the file, the edit fails: provide a larger snippet with enough surrounding context to be unique, or set replace_all: true to replace every occurrence (useful for renaming a variable across a file).',
        'Use write_project_file only when creating a new file or rewriting most of a file. Do not add unrequested comments or emoji in the replacement.'
      ].join(' '),
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
          old_string: {
            type: 'string',
            description: 'The exact text to replace. Must match the file content verbatim and be unique unless replace_all is true.'
          },
          new_string: {
            type: 'string',
            description: 'The text to replace it with. Must differ from old_string.'
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences of old_string instead of requiring a unique match. Default: false.'
          }
        },
        required: ['project_id', 'file_path', 'old_string', 'new_string']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, file_path, old_string, new_string, replace_all } = args as unknown as EditFileArgs

      if (typeof old_string !== 'string' || typeof new_string !== 'string') {
        throw new Error('edit_project_file requires string old_string and new_string.')
      }
      if (old_string === '') {
        throw new Error('old_string must not be empty. To create a new file, use write_project_file instead.')
      }
      if (old_string === new_string) {
        throw new Error('old_string and new_string are identical — nothing to change.')
      }

      if (readTracker && !readTracker.hasRead(project_id, file_path)) {
        throw new Error(
          `You must read ${file_path} with read_project_file before editing it, so the edit matches its current content.`
        )
      }

      onProgress?.('📝 正在读取文件...', file_path)
      const originalContent = await services.projectFS.readFile(project_id, file_path)

      const occurrences = countOccurrences(originalContent, old_string)
      if (occurrences === 0) {
        throw new Error(
          `old_string was not found in ${file_path}. It must match the current file content exactly (including whitespace) and must not include the line-number prefix from read_project_file. Re-read the file and copy the exact snippet.`
        )
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string is not unique in ${file_path} (${occurrences} matches). Add more surrounding context to make it unique, or set replace_all: true to replace all ${occurrences} occurrences.`
        )
      }

      // Replace without String.prototype.replace so that `$`-sequences in
      // new_string (e.g. "$&", "$1") are inserted literally, not interpreted.
      let newContent: string
      if (replace_all) {
        newContent = originalContent.split(old_string).join(new_string)
      } else {
        const index = originalContent.indexOf(old_string)
        newContent = originalContent.slice(0, index) + new_string + originalContent.slice(index + old_string.length)
      }

      const replacements = replace_all ? occurrences : 1
      onProgress?.('📝 正在写入文件...', `${replacements} 处替换`)
      await services.projectFS.writeFile(project_id, file_path, newContent)

      // The file's current content is now known to the agent.
      readTracker?.markRead(project_id, file_path)
      onProgress?.('✅ 文件已保存', file_path)

      return {
        success: true,
        file_path,
        replacements,
        message: `Replaced ${replacements} occurrence(s) in ${file_path}.`
      }
    }
  }
}
