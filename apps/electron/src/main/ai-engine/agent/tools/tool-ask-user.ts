import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import { requestUserQuestions, type AskUserQuestion } from './user-question.js'

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

interface AskUserToolContext {
  getMainWindow?: () => BrowserWindow | null
  getSessionState?: () => SessionState
  getAbortSignal?: () => AbortSignal | undefined
}

/**
 * `ask_user` — bundle clarification questions to the user when blocked on a decision
 * the user must make. The renderer surfaces the questions in a panel above the chat
 * input; each question is answerable via a suggested option chip or a free-text "其他"
 * fallback. The tool returns the user's answers as `{ question, answer }[]` so the
 * agent can resume with the user's intent in hand.
 */
export function toolAskUser (context: AskUserToolContext): Tool {
  return {
    definition: {
      name: 'ask_user',
      description: 'Ask the user one or more clarification questions when you are blocked on a decision the user must make (the request is genuinely ambiguous, you cannot pick a sensible default, or proceeding without their answer would force a costly rewrite). BUNDLE every pending question into a single ask_user call — never ask one at a time when more are coming. For each question, propose 2-4 mutually exclusive option strings; the renderer adds an "其他 (自定义)" free-text fallback automatically. Do NOT use this tool when a sensible default exists, or when the answer is obvious from context, or merely to confirm something — pick the obvious choice and proceed instead. Returns `{ answers: [{ question, answer }] }` where `answer` is either the option string the user chose or the free text they typed.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'List of clarification questions to ask the user, all surfaced together in one panel. 1-4 questions; combine related concerns rather than splitting them into multiple calls.',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The complete question to ask the user. Should be specific, end with a question mark, and avoid forward references like "see option A".'
                },
                options: {
                  type: 'array',
                  description: 'Up to 4 distinct candidate answers. Keep each option short (1-6 words) and mutually exclusive. Do NOT include an "其他/Other" option — the renderer always shows a free-text input below the options for that.',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 4
                }
              },
              required: ['question', 'options']
            },
            minItems: 1,
            maxItems: 4
          }
        },
        required: ['questions']
      }
    },
    handler: async (args, onProgress) => {
      const rawQuestions = (args as { questions?: unknown }).questions
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        return { error: 'questions must be a non-empty array of { question, options } entries.' }
      }

      const normalized: AskUserQuestion[] = []
      for (let i = 0; i < Math.min(rawQuestions.length, 4); i++) {
        const item = rawQuestions[i]
        if (!item || typeof item !== 'object') {
          return { error: `question[${i}] must be an object with { question, options }.` }
        }
        const record = item as Record<string, unknown>
        const question = typeof record.question === 'string' ? record.question.trim() : ''
        const optionsRaw = Array.isArray(record.options) ? record.options : []
        const options = optionsRaw
          .map(o => typeof o === 'string' ? o.trim() : '')
          .filter(o => o.length > 0)
          .slice(0, 4)
        if (!question) {
          return { error: `question[${i}] must include a non-empty 'question' string.` }
        }
        if (options.length === 0) {
          return { error: `question[${i}] must include at least one option string.` }
        }
        normalized.push({ id: `q_${i + 1}`, question, options })
      }

      onProgress?.('询问用户', `等待用户回答 ${normalized.length} 个问题`)

      const answers = await requestUserQuestions(
        context.getMainWindow,
        context.getSessionState,
        context.getAbortSignal,
        normalized
      )

      if (!answers) {
        return { error: 'User cancelled or did not respond before the conversation was aborted.' }
      }

      const replies = normalized.map((q, idx) => {
        const matched = answers.find(a => a.questionId === q.id) || answers[idx]
        const answer = (matched?.customAnswer && matched.customAnswer.trim())
          || (matched?.selectedOption && matched.selectedOption.trim())
          || ''
        return { question: q.question, answer }
      })

      onProgress?.('收到用户回复', `共 ${replies.length} 项`)

      return {
        success: true,
        answers: replies
      }
    }
  }
}
