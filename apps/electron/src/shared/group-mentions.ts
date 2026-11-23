export const ROOM_ALL_MENTIONS = ['all', 'everyone', '全组', '全员', '全部agent', '所有agent']
export const ROOM_DEFAULT_MENTIONS = ['主Agent', '主协调', '协调Agent', 'coordinator', 'mainagent']

export function normalizeMentionToken (value: string): string {
  return value
    .replace(/^[@＠]+/, '')
    .replace(/[【】\[\]（）(){}<>《》「」『』"'“”‘’`~!?,.:;，。！？、：；]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
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
