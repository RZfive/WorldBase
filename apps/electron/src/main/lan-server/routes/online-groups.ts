import { Router, type NextFunction, type Request, type Response } from 'express'
import type { OnlineGroupService } from '../../online-groups/online-group-service.js'

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown

function groupToken (req: Request): string {
  const authorization = req.header('authorization')?.trim() || ''
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim()
  }
  return req.header('x-worldbase-group-token')?.trim() || ''
}

function peerId (req: Request): string {
  return req.header('x-worldbase-peer-id')?.trim() || ''
}

function statusForError (error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('令牌') || message.includes('token')) return 403
  if (message.includes('不存在') || message.includes('not found') || message.includes('Not found')) return 404
  return 400
}

function wrap (handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res)
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Peer-to-peer LAN contract. Every group request except invitation inbox
 * delivery is authenticated by the group's shared capability token; the token
 * never appears in discovery announcements.
 */
export function onlineGroupsRouter (service: OnlineGroupService): Router {
  const router = Router()

  router.get('/profile', wrap(async (_req, res) => {
    res.json(await service.handlePublicProfile())
  }))

  router.post('/invitations', wrap(async (req, res) => {
    res.json(await service.handleIncomingInvitation(req.body, peerId(req)))
  }))

  router.post('/join-requests', wrap(async (req, res) => {
    res.json(await service.handleIncomingJoinRequest(req.body, peerId(req)))
  }))

  router.post('/join-responses', wrap(async (req, res) => {
    res.json(service.handleJoinResponse(req.body))
  }))

  router.post('/:groupId/accept-invite', wrap(async (req, res) => {
    res.json(await service.handleAcceptInvite(String(req.params.groupId || ''), req.body))
  }))

  router.get('/:groupId/snapshot', wrap(async (req, res) => {
    res.json(service.getGroupSnapshot(String(req.params.groupId || ''), groupToken(req)))
  }))

  router.post('/:groupId/settings', wrap(async (req, res) => {
    res.json({ group: service.handleIncomingGroupSettings(
      String(req.params.groupId || ''),
      groupToken(req),
      req.body,
      peerId(req)
    ) })
  }))

  router.post('/:groupId/messages', wrap(async (req, res) => {
    res.json(await service.handleIncomingMessage(
      String(req.params.groupId || ''),
      groupToken(req),
      req.body,
      peerId(req)
    ))
  }))

  router.post('/:groupId/members', wrap(async (req, res) => {
    res.json({ group: service.handleIncomingMember(
      String(req.params.groupId || ''),
      groupToken(req),
      req.body,
      peerId(req)
    ) })
  }))

  router.post('/:groupId/members/remove', wrap(async (req, res) => {
    res.json({ group: service.handleMemberRemoval(
      String(req.params.groupId || ''),
      groupToken(req),
      req.body,
      peerId(req)
    ) })
  }))

  router.post('/:groupId/delete', wrap(async (req, res) => {
    res.json(service.handleRemoteGroupDelete(
      String(req.params.groupId || ''),
      groupToken(req),
      req.body,
      peerId(req)
    ))
  }))

  router.post('/:groupId/delegations', wrap(async (req, res) => {
    res.json({ delegation: service.handleIncomingDelegation(
      String(req.params.groupId || ''),
      groupToken(req),
      req.body,
      peerId(req)
    ) })
  }))

  router.post('/:groupId/delegations/:delegationId/decision', wrap(async (req, res) => {
    res.json({ group: service.handleIncomingDelegationDecision(
      String(req.params.groupId || ''),
      groupToken(req),
      { ...req.body, delegationId: req.params.delegationId },
      peerId(req)
    ) })
  }))

  router.get('/:groupId/files/:attachmentId', wrap(async (req, res) => {
    res.json(service.handleAttachmentDownload(
      String(req.params.groupId || ''),
      groupToken(req),
      String(req.params.attachmentId || '')
    ))
  }))

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(statusForError(error)).json({
      error: error instanceof Error ? error.message : String(error)
    })
  })

  return router
}
