export interface RustAskUserRendererQuestion {
  id: string
  question: string
  options: string[]
}

function recordFromUnknown (value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedOptions (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((option): option is string => typeof option === 'string')
    .map(option => option.trim())
    .filter(Boolean))]
    .slice(0, 4)
}

/** Normalizes the bundled Rust payload and the previous single-question form. */
export function normalizeRustAskUserQuestions (
  payload: Record<string, unknown>,
  requestId: string
): RustAskUserRendererQuestion[] {
  const rawQuestions = Array.isArray(payload.questions)
    ? payload.questions
    : [{ question: payload.question, options: payload.choices }]
  const questions: RustAskUserRendererQuestion[] = []
  for (const rawQuestion of rawQuestions.slice(0, 4)) {
    const raw = recordFromUnknown(rawQuestion)
    if (!raw) continue
    const question = typeof raw.question === 'string' ? raw.question.trim() : ''
    const options = normalizedOptions(raw.options ?? raw.choices)
    if (!question || options.length === 0) continue
    questions.push({
      id: typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : `${requestId}-question-${questions.length + 1}`,
      question,
      options
    })
  }
  return questions
}

function answerText (value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const answer = recordFromUnknown(value)
  if (!answer) return ''
  for (const key of ['customAnswer', 'custom_answer', 'selectedOption', 'selected_option', 'answer']) {
    const candidate = answer[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

/**
 * Converts renderer answers to Rust's stable result while retaining `answer`
 * for an older single-question Rust harness.
 */
export function normalizeRustAskUserResponse (
  rawAnswers: unknown,
  questions: RustAskUserRendererQuestion[]
): Record<string, unknown> {
  const items = Array.isArray(rawAnswers) ? rawAnswers : []
  const answers = questions.map((question, index) => {
    const matched = items.find(item => recordFromUnknown(item)?.questionId === question.id)
    const answer = answerText(matched ?? items[index] ?? (questions.length === 1 ? rawAnswers : null))
    return { question: question.question, answer }
  })
  return {
    answers,
    ...(answers.length === 1 ? { answer: answers[0].answer } : {}),
    ...(rawAnswers == null ? { ignored: true } : {})
  }
}
