import type { OnlineGroupBackground } from '../../../../shared/online-group-types.js'

export const ONLINE_GROUP_BACKGROUNDS: Array<{
  id: OnlineGroupBackground
  label: string
}> = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'forest', label: 'Forest' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'rose', label: 'Rose' }
]

export const ONLINE_GROUP_AVATARS = ['🙂', '👩‍💻', '🧑‍🚀', '🦊', '🐼', '🌸', '⚡', '🎯']
export const ONLINE_GROUP_TAG_PRESETS = ['产品', '研发', '设计', 'AI', '项目', '远程', '创业', '学生']

export function onlineGroupBackgroundGradient (value?: OnlineGroupBackground): string {
  switch (value) {
    case 'ocean':
      return 'linear-gradient(135deg, color-mix(in srgb, #57b7ff 34%, var(--app-panel)), color-mix(in srgb, #42d7d4 28%, var(--app-panel)))'
    case 'sunset':
      return 'linear-gradient(135deg, color-mix(in srgb, #ffb36b 36%, var(--app-panel)), color-mix(in srgb, #ff7ca8 26%, var(--app-panel)))'
    case 'forest':
      return 'linear-gradient(135deg, color-mix(in srgb, #62c98b 34%, var(--app-panel)), color-mix(in srgb, #4cc4b0 26%, var(--app-panel)))'
    case 'graphite':
      return 'linear-gradient(135deg, color-mix(in srgb, #8894a8 32%, var(--app-panel)), color-mix(in srgb, #5f6b7d 22%, var(--app-panel)))'
    case 'rose':
      return 'linear-gradient(135deg, color-mix(in srgb, #f598c4 34%, var(--app-panel)), color-mix(in srgb, #d7a3ff 28%, var(--app-panel)))'
    case 'aurora':
    default:
      return 'linear-gradient(135deg, color-mix(in srgb, #7c9cff 34%, var(--app-panel)), color-mix(in srgb, #b88cff 29%, var(--app-panel)))'
  }
}

export function profileInitial (displayName?: string): string {
  return Array.from((displayName || '').trim())[0]?.toUpperCase() || 'W'
}
