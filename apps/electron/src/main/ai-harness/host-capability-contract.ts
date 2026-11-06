export const HOST_CAPABILITY_PROTOCOL_VERSION = 1

export const HOST_CAPABILITY_IDS = [
  'host.fs.pick_file',
  'host.shell.open_external',
  'host.notification.show'
] as const

export type HostCapabilityId = (typeof HOST_CAPABILITY_IDS)[number]

export const HOST_CAPABILITY_MAX_INPUT_BYTES = 64 * 1024
export const HOST_CAPABILITY_MAX_OUTPUT_BYTES = 64 * 1024
export const HOST_CAPABILITY_MAX_DEADLINE_MS = 60_000
export const HOST_CAPABILITY_MAX_CALL_ID_LENGTH = 200

export interface HostCapabilityInvokeRequest {
  protocolVersion: number
  registeredHostCapabilityId: HostCapabilityId
  callId: string
  deadline: number
  input: unknown
}

export type HostCapabilityInvokeStatus = 'ok' | 'error'

export interface HostCapabilityInvokeResponse {
  status: HostCapabilityInvokeStatus
  output: unknown
  warnings: string[]
  /** Rust reads these top-level fields to map the failure to a stable code. */
  errorCode?: string
  message?: string
}

export type HostCapabilityParseResult =
  | { ok: true, request: HostCapabilityInvokeRequest }
  | { ok: false, code: string, message: string }

export function isHostCapabilityId (value: unknown): value is HostCapabilityId {
  return typeof value === 'string' &&
    (HOST_CAPABILITY_IDS as readonly string[]).includes(value)
}

export function normalizeHostCapabilityDeadline (value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.max(Math.floor(value), 1), HOST_CAPABILITY_MAX_DEADLINE_MS)
}

export function measureHostCapabilityValue (value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    return Buffer.byteLength(serialized, 'utf8')
  } catch {
    return null
  }
}

export function parseHostCapabilityInvokeRequest (payload: unknown): HostCapabilityParseResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'invalid_request', message: 'host capability payload must be an object' }
  }
  const record = payload as Record<string, unknown>
  if (record.protocolVersion !== HOST_CAPABILITY_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'unsupported_protocol_version',
      message: `host capability protocol version must be ${HOST_CAPABILITY_PROTOCOL_VERSION}`
    }
  }
  if (!isHostCapabilityId(record.registeredHostCapabilityId)) {
    return {
      ok: false,
      code: 'unknown_host_capability',
      message: 'host capability is not in the Electron allowlist'
    }
  }
  const callId = typeof record.callId === 'string' ? record.callId.trim() : ''
  if (!callId) {
    return { ok: false, code: 'invalid_call_id', message: 'host capability callId is required' }
  }
  if (callId.length > HOST_CAPABILITY_MAX_CALL_ID_LENGTH) {
    return { ok: false, code: 'invalid_call_id', message: 'host capability callId is too long' }
  }
  const deadline = normalizeHostCapabilityDeadline(record.deadline)
  if (deadline === null) {
    return { ok: false, code: 'invalid_deadline', message: 'host capability deadline must be a positive number' }
  }
  const input = record.input === undefined ? null : record.input
  const inputBytes = measureHostCapabilityValue(input)
  if (inputBytes === null) {
    return { ok: false, code: 'invalid_input', message: 'host capability input must be JSON serializable' }
  }
  if (inputBytes > HOST_CAPABILITY_MAX_INPUT_BYTES) {
    return { ok: false, code: 'input_too_large', message: 'host capability input exceeds the size limit' }
  }
  return {
    ok: true,
    request: {
      protocolVersion: HOST_CAPABILITY_PROTOCOL_VERSION,
      registeredHostCapabilityId: record.registeredHostCapabilityId,
      callId,
      deadline,
      input
    }
  }
}

export function hostCapabilityErrorResponse (
  code: string,
  message: string,
  warnings: string[] = []
): HostCapabilityInvokeResponse {
  return { status: 'error', output: { code, message }, warnings, errorCode: code, message }
}
