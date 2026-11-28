export const ROOM_ALL_MENTIONS = ['all', 'everyone', '全组', '全员', '全部agent', '所有agent']
export const ROOM_DEFAULT_MENTIONS = ['主Agent', '主协调', '协调Agent', 'coordinator', 'mainagent']

const REDUNDANT_HANDOFF_INSTRUCTION_PATTERNS = [
  /(?:请|请你|请务必)?\s*以[^。\n]{0,80}?(?:本人|专家|agent|助手|角色)?(?:的)?身份[^。\n]{0,80}?(?:回复|发言|问候|介绍|面向用户)[^。\n]*[。.]?/giu,
  /(?:可|可以|并|并且)?\s*(?:简单)?(?:说明|介绍)(?:一下)?(?:你的|自己的)?(?:专家)?身份[^。\n]*[。.]?/giu,
  /(?:回复|发送|给出)(?:一句)?[^。\n]{0,40}?问候[^。\n]*[。.]?/giu,
  /(?:由你本人发言|不要代[^。\n]{0,20}协调人发言|不虚构任何工作成果|不要虚构[^。\n]{0,20}成果|不展开无关建议)[^。\n]*[。.]?/giu,
  /(?:验收标准|acceptance criteria)\s*[:：][^。\n]*(?:问候|自我介绍|本人发言|虚构|无关建议)[^。\n]*[。.]?/giu
]

export function normalizeMentionToken (value: string): string {
  return value
    .replace(/^[@＠]+/, '')
    .replace(/[【】\[\]（）(){}<>《》「」『』"'“”‘’`~!?,.:;，。！？、：；]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

/**
 * Role, greeting and delivery-style instructions belong in the runtime
 * system prompt, not in a visible handoff message. Strip the common forms
 * models emit when asked to transfer a turn to a specialist.
 */
export function stripRedundantHandoffInstructions (value: string): string {
  let result = value
  for (const pattern of REDUNDANT_HANDOFF_INSTRUCTION_PATTERNS) {
    result = result.replace(pattern, '')
  }
  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s；;，,。]+/u, '')
    .trim()
}

function normalizeForwardComparable (value: string): string {
  return value
    .replace(/[@＠][^\s，。！？,.!?；;：:、]+/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

/**
 * Reject a handoff that merely forwards the user's whole request. A useful
 * delegation names the recipient's specific responsibility instead.
 */
export function isVerbatimRoomForward (task: string, userRequest: string): boolean {
  const normalizedTask = normalizeForwardComparable(task)
  const normalizedRequest = normalizeForwardComparable(userRequest)
  if (!normalizedTask || !normalizedRequest) return false
  if (normalizedTask === normalizedRequest) return true
  const shorter = normalizedTask.length <= normalizedRequest.length ? normalizedTask : normalizedRequest
  const longer = shorter === normalizedTask ? normalizedRequest : normalizedTask
  return shorter.length >= 12
    && longer.includes(shorter)
    && shorter.length / longer.length >= 0.82
}

/**
 * A room handoff is a normal member message that directly @mentions the
 * recipient. The task body stays visible in the transcript so it can be read
 * by people and by other members instead of being hidden inside a UI card.
 */
export function formatRoomHandoffMessage (toAgentName: string, task: string): string {
  const name = toAgentName.trim().replace(/^[@＠]+\s*/u, '')
  const body = stripRedundantHandoffInstructions(task)
  return body ? `@${name} ${body}` : `@${name}`
}

export function resolveRoomAddress (
  text: string,
  members: ReadonlyArray<{ id: string; name: string }>,
  defaultAgentId: string
): { agentIds: string[]; request: string; explicit: boolean; broadcast: boolean } {
  const membersByToken = new Map<string, string>()
  for (const member of members) {
    const aliases = member.id === defaultAgentId ? ROOM_DEFAULT_MENTIONS : []
    for (const value of [member.id, member.name, ...aliases]) {
      const token = normalizeMentionToken(value)
      if (token) membersByToken.set(token, member.id)
    }
  }
  const allTokens = new Set(ROOM_ALL_MENTIONS)
  const tokens = [...new Set([...membersByToken.keys(), ...allTokens])]
    .sort((left, right) => right.length - left.length)
  const matches: Array<{ start: number; end: number; token: string }> = []
  for (const match of text.matchAll(/[@＠]([^@＠]*)/gu)) {
    if (match.index === undefined || /[A-Za-z0-9_]/.test(text.charAt(match.index - 1))) continue
    const candidate = match[1]
    for (const token of tokens) {
      let found = false
      for (let end = 1; end <= candidate.length; end++) {
        const prefix = normalizeMentionToken(candidate.slice(0, end))
        if (prefix.length > token.length) break
        if (prefix !== token || /[A-Za-z0-9_-]/.test(candidate.charAt(end))) continue
        const delimiter = candidate.slice(end).match(/^[\s:：,，、]+/u)?.[0] || ''
        matches.push({ start: match.index, end: match.index + 1 + end + delimiter.length, token })
        found = true
        break
      }
      if (found) break
    }
  }
  const broadcast = matches.some(match => allTokens.has(match.token))
  const addressedIds = new Set(matches.flatMap(match => membersByToken.get(match.token) || []))
  let request = text
  for (const { start, end } of matches.reverse()) {
    request = `${request.slice(0, start)} ${request.slice(end)}`
  }
  const defaultMember = members.find(member => member.id === defaultAgentId) || members[0]
  return {
    agentIds: broadcast ? members.map(member => member.id) : addressedIds.size ? [...addressedIds] : defaultMember ? [defaultMember.id] : [],
    request: request.trim() || text.trim(),
    explicit: matches.length > 0,
    broadcast
  }
}

export function findGroupMentionQuery (text: string, caret: number): { start: number; end: number; query: string } | null {
  const match = /[@＠]([^\s@＠]*)$/u.exec(text.slice(0, caret))
  return match ? { start: match.index, end: caret, query: match[1] } : null
}
