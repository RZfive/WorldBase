export const USER_ABORT_MESSAGE = 'AI generation stopped by user'
export const AI_REQUEST_CANCELLED_MESSAGE = 'AI request was cancelled'

export function normalizeAbortReason (reason: unknown, fallbackMessage = AI_REQUEST_CANCELLED_MESSAGE): Error {
  if (reason instanceof Error) {
    return reason
  }
  if (typeof reason === 'string' && reason.length > 0) {
    return new Error(reason)
  }
  return new Error(fallbackMessage)
}
