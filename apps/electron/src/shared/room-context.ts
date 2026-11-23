export function nativeRoomId (group: { id: string; roomContextId?: string }): string {
  return group.roomContextId ? `room:${group.roomContextId}` : `room-${group.id}`
}

export function localRoomSessionKey (group: { id: string; roomContextId?: string }): string {
  return group.roomContextId ? nativeRoomId(group) : group.id
}
