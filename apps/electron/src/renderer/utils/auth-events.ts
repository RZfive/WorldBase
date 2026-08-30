export interface AuthResolutionPayload {
  requestId: string
  approved: boolean
}

const AUTH_RESOLUTION_EVENT = 'the-world:auth-resolution'

export function emitAuthResolution (payload: AuthResolutionPayload): void {
  window.dispatchEvent(new CustomEvent<AuthResolutionPayload>(AUTH_RESOLUTION_EVENT, {
    detail: payload
  }))
}

export function onAuthResolution (callback: (payload: AuthResolutionPayload) => void): () => void {
  const handler: EventListener = (event) => {
    const detail = (event as CustomEvent<AuthResolutionPayload>).detail
    if (!detail) return
    callback(detail)
  }

  window.addEventListener(AUTH_RESOLUTION_EVENT, handler)
  return () => {
    window.removeEventListener(AUTH_RESOLUTION_EVENT, handler)
  }
}