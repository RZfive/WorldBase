import type { OnlineGroupBackground } from '../../shared/online-group-types.js'

export const ONLINE_GROUP_BACKGROUND_IDS: OnlineGroupBackground[] = [
  'aurora',
  'ocean',
  'sunset',
  'forest',
  'graphite',
  'rose'
]

export function normalizeOnlineGroupAvatar (value: unknown): string {
  if (typeof value !== 'string') return ''
  return Array.from(value.trim()).slice(0, 4).join('')
}

export function normalizeOnlineGroupBackground (value: unknown): OnlineGroupBackground {
  return ONLINE_GROUP_BACKGROUND_IDS.includes(value as OnlineGroupBackground)
    ? value as OnlineGroupBackground
    : 'aurora'
}

export function normalizeOnlineGroupTags (value: unknown): string[] {
  const tags = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().slice(0, 16)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
    if (result.length >= 6) break
  }
  return result
}
