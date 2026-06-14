import type { MessageContent } from '../../src/main/ai-engine/providers/openai-provider.js'

export function getMessageText (content: MessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join(' ')
    .trim()
}

export function serializeMessageContentForDisplay (content: MessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part, index) => {
      if (part.type === 'text') {
        return part.text || ''
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        return `![内部讨论图片 ${index + 1}](<${encodeURI(part.image_url.url)}>)`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function getTaskLabelFromMessages (messages: Array<{ role: string; content: MessageContent }>): string {
  if (messages.length === 0) {
    return '未命名任务'
  }

  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx]
    if (message.role !== 'user') continue
    const text = getMessageText(message.content).replace(/\s+/g, ' ').trim()
    if (text) {
      return text.length > 40 ? `${text.slice(0, 40)}…` : text
    }
  }
  return '未命名任务'
}

export function getConversationTitleFromMessages (messages: Array<{ role: string; content: MessageContent }>): string {
  const firstUserMessage = messages.find(message => message.role === 'user')
  if (!firstUserMessage) return '新对话'
  const text = getMessageText(firstUserMessage.content)
  if (!text) return '新对话'
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

export function getLastUserMessageText (messages: Array<{ role: string; content: MessageContent }>): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = getMessageText(message.content)
    if (text) return text
  }

  return ''
}

export function getAllUserMessageTexts (messages: Array<{ role: string; content: MessageContent }>): string[] {
  return messages
    .filter(message => message.role === 'user')
    .map(message => getMessageText(message.content))
    .filter(Boolean)
}

export function firstNonEmptyLine (value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
}

export function truncateSectionText (value: string, maxChars = 6000): string {
  const normalized = value.trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}\n...[truncated ${normalized.length - maxChars} chars]`
}
