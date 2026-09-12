/** A small metadata-only update. Null explicitly clears a saved override. */
export interface ConversationMetadataPatch {
  authMode?: 'strict' | 'auto' | null
  providerId?: string | null
  selectedModel?: string | null
  reasoningStrength?: 'low' | 'medium' | 'high' | 'max' | null
  temperature?: number | null
  targetProjectId?: string | null
  agentId?: string | null
  groupId?: string | null
  channelBindingId?: string | null
}

const STRING_FIELDS = new Set(['providerId', 'selectedModel', 'targetProjectId', 'agentId', 'groupId', 'channelBindingId'])

export function validateConversationMetadata (input: unknown): ConversationMetadataPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid conversation metadata')
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const valid = STRING_FIELDS.has(key)
      ? value === null || (typeof value === 'string' && value.length <= 2048)
      : key === 'authMode'
        ? value === null || value === 'strict' || value === 'auto'
        : key === 'reasoningStrength'
          ? value === null || ['low', 'medium', 'high', 'max'].includes(value as string)
          : key === 'temperature'
            ? value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2)
            : false
    if (!valid) throw new Error(`Invalid conversation metadata field: ${key}`)
    patch[key] = value
  }
  return patch
}
