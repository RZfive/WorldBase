import assert from 'node:assert/strict'
import test from 'node:test'
import './register-ts-hooks.mjs'
import { DailySuggestionStore } from '../src/main/settings/daily-suggestion-store.ts'
import { DailySuggestionService } from '../src/main/suggestions/daily-suggestion-service.ts'
import { DEFAULT_DAILY_SUGGESTION_PREFERENCES, formatLocalDate, normalizeDailySuggestionPreferences } from '../src/shared/daily-suggestion-types.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-suggestions-probe-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeEngine (reply) {
  const calls = []
  return {
    calls,
    engine: {
      async chat (messages, options) {
        calls.push({ messages, options })
        const content = typeof reply === 'function' ? reply(calls.length, messages[0].content) : reply
        if (content instanceof Error) throw content
        return { role: 'assistant', content }
      },
      async * chatStream () { throw new Error('unused') },
      getAvailableTools () { return [] }
    }
  }
}

function createService (t, { reply, preferences = {}, now = () => new Date('2026-09-19T10:00:00'), providerConfig } = {}) {
  const resolvedProviderConfig = providerConfig || { apiKey: 'k', baseUrl: 'u', model: 'm', providerId: 'p' }
  const store = new DailySuggestionStore(tempDir(t))
  store.savePreferences(normalizeDailySuggestionPreferences({ ...DEFAULT_DAILY_SUGGESTION_PREFERENCES, ...preferences }))
  store.setKnowledgeReplenish({ lastAttemptDate: formatLocalDate(now()), lastError: 'SUPPRESSED_FOR_TEST' })
  const { engine, calls } = fakeEngine(reply)
  const service = new DailySuggestionService({
    store,
    resolveAiEngine: async () => engine,
    resolveProviderConfig: () => resolvedProviderConfig,
    listProjects: async () => [],
    listConversations: async () => [],
    getCapabilities: async () => ({ skillNames: [], mcpServerNames: [], scheduledTaskCount: 0, longTermGoalCount: 0, agentGroupCount: 0 }),
    getLocale: () => 'zh-CN',
    onChanged: () => {},
    now
  })
  t.after(() => service.dispose())
  return { service, store, calls }
}

function llmItem (type, index = 0) {
  return { type, title: `${type} #${index}`, description: 'why', prompt: `do ${type} ${index}` }
}

function cards (ids, source = 'work-domain') {
  return ids.map((id, index) => ({
    id, source, discipline: `d${index}`,
    copy: { locale: 'zh-CN', title: `为什么${id}如此反直觉？`, description: 'd', prompt: `我对「${id}」有点好奇。`, createdAt: '2026-09-01T00:00:00.000Z' }
  }))
}

// PROBE A: same-day swap when the source pool is exhausted (both cards already
// drawn into today's batch). Does the replacement duplicate a carried item?
test('PROBE A: exhausted pool swap duplicates the other in-batch card', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: () => { throw new Error('must not be called') },
    preferences: { enabled: false, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 2 } },
    now: () => clock
  })
  store.appendKnowledgeCards(cards(['kc-a', 'kc-b']))
  const hand = await service.generateNow()
  const workCards = hand.knowledge.filter(i => i.knowledge?.source === 'work-domain')
  assert.equal(workCards.length, 2, 'both pool cards drawn')
  const next = await service.refreshKnowledgeCard(workCards[0].id)
  const after = next.knowledge.filter(i => i.knowledge?.source === 'work-domain')
  console.log('PROBE A result:', JSON.stringify(after.map(c => ({ id: c.id, seed: c.knowledge.seedId, title: c.title })), null, 0))
  const seedIds = after.map(c => c.knowledge.seedId)
  assert.equal(new Set(seedIds).size, seedIds.length, 'no duplicated card after swap')
})

// PROBE B: stale fallback day, pool exhausted within the reuse window. The
// replacement may be a card already carried in the displayed batch.
test('PROBE B: stale-day swap can show the same card twice', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: () => { throw new Error('must not be called') },
    preferences: { enabled: true, types: ['new-idea'], knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 2 } },
    now: () => clock
  })
  store.appendKnowledgeCards(cards(['kc-a', 'kc-b']))
  const dayOne = await service.generateNow()
  assert.equal(dayOne.knowledge.filter(i => i.knowledge?.source === 'work-domain').length, 2)
  clock = new Date('2026-09-20T10:00:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  const fallback = service.getSnapshot()
  const displayed = fallback.knowledge.filter(i => i.knowledge?.source === 'work-domain')
  console.log('PROBE B fallback display:', JSON.stringify(displayed.map(c => c.id)))
  const next = await service.refreshKnowledgeCard(displayed[0].id)
  const after = next.knowledge.filter(i => i.knowledge?.source === 'work-domain')
  console.log('PROBE B result:', JSON.stringify(after.map(c => ({ id: c.id, seed: c.knowledge.seedId, title: c.title })), null, 0))
  const seeds = after.map(c => c.knowledge.seedId)
  console.log('PROBE B duplicated seeds?', new Set(seeds).size !== seeds.length)
})

// PROBE C: failed regeneration on a stale day must not double-carry.
test('PROBE C: failed regen on stale day has unique items', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: (call) => (call <= 1 ? JSON.stringify([llmItem('new-idea', 1), llmItem('new-idea', 2)]) : new Error('boom')),
    preferences: { enabled: true, types: ['new-idea'], countPerType: 2, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  await service.generateNow()
  clock = new Date('2026-09-20T10:00:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  await service.generateNow().catch(() => {})
  const snap = service.getSnapshot()
  const allIds = [...snap.daily.map(i => i.id), ...snap.knowledge.map(i => i.id)]
  console.log('PROBE C ids:', JSON.stringify(allIds))
  assert.equal(new Set(allIds).size, allIds.length, 'no duplicated ids')
  console.log('PROBE C daily count:', snap.daily.length, 'status:', snap.lastGeneration.status)
})

// PROBE D: swap on a failed-today day, then a second failed regeneration.
// Does the display keep or lose the swapped card?
test('PROBE D: swap then failed regen on a failed-today day', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: (call) => (call <= 1 ? JSON.stringify([llmItem('new-idea', 1), llmItem('new-idea', 2)]) : new Error('boom')),
    preferences: { enabled: true, types: ['new-idea'], countPerType: 2, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  store.appendKnowledgeCards(cards(['kc-a', 'kc-b', 'kc-c']))
  await service.generateNow()
  clock = new Date('2026-09-20T10:00:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  await service.generateNow().catch(() => {}) // fails: daily boom, knowledge from pool
  const afterFail = service.getSnapshot()
  console.log('PROBE D after first fail:', afterFail.lastGeneration.status, JSON.stringify(afterFail.knowledge.map(i => i.id)))
  const workCard = afterFail.knowledge.find(i => i.knowledge?.source === 'work-domain')
  const swapped = await service.refreshKnowledgeCard(workCard.id)
  const afterSwap = swapped.knowledge.filter(i => i.knowledge?.source === 'work-domain')
  console.log('PROBE D after swap:', JSON.stringify(afterSwap.map(i => ({ id: i.id, seed: i.knowledge.seedId }))))
  await service.generateNow().catch(() => {}) // fails again
  const afterFail2 = service.getSnapshot()
  const work2 = afterFail2.knowledge.filter(i => i.knowledge?.source === 'work-domain')
  console.log('PROBE D after second fail:', afterFail2.lastGeneration.status, JSON.stringify(work2.map(i => ({ id: i.id, seed: i.knowledge.seedId }))))
  console.log('PROBE D daily survives?', afterFail2.daily.length, JSON.stringify(afterFail2.daily.map(i => i.title)))
})

// PROBE E: dismissed items stay dismissed across a stale-day swap.
test('PROBE E: dismissed card not resurrected by stale-day swap', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: () => { throw new Error('must not be called') },
    preferences: { enabled: true, types: ['new-idea'], knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  store.appendKnowledgeCards(cards(['kc-a', 'kc-b', 'kc-c', 'kc-d']))
  const dayOne = await service.generateNow()
  clock = new Date('2026-09-20T10:00:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  const fallback = service.getSnapshot()
  const dailyItem = fallback.daily[0]
  service.dismiss(dailyItem.id)
  const workCard = fallback.knowledge.find(i => i.knowledge?.source === 'work-domain')
  const next = await service.refreshKnowledgeCard(workCard.id)
  console.log('PROBE E daily after dismiss+swap:', next.daily.length, next.daily.map(i => i.title))
  assert.ok(!next.daily.some(i => i.id === dailyItem.id), 'dismissed daily item stays hidden')
})

// PROBE F: swap on a missing-today day creates today's batch with status ok.
// Does the scheduled generation still run later that day?
test('PROBE F: swap on missing-today day suppresses scheduled runIfDue', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: () => { throw new Error('must not be called') },
    preferences: { enabled: true, types: ['new-idea'], trigger: { kind: 'time', timeOfDay: '22:00' }, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  store.appendKnowledgeCards(cards(['kc-a', 'kc-b', 'kc-c']))
  const dayOne = await service.generateNow()
  clock = new Date('2026-09-20T09:00:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  const fallback = service.getSnapshot()
  assert.equal(fallback.lastGeneration.date, '2026-09-19', 'no batch for today yet')
  const workCard = fallback.knowledge.find(i => i.knowledge?.source === 'work-domain')
  await service.refreshKnowledgeCard(workCard.id)
  const afterSwap = service.getSnapshot()
  console.log('PROBE F after swap: status', afterSwap.lastGeneration.status, 'date', afterSwap.lastGeneration.date, 'manualRefresh', afterSwap.lastGeneration.manualRefreshCount)
  // Now the scheduled time passes; runIfDue('schedule') checks getBatch(today).
  clock = new Date('2026-09-20T22:05:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  await service['runIfDue']('schedule')
  const afterSchedule = service.getSnapshot()
  console.log('PROBE F after scheduled run: status', afterSchedule.lastGeneration.status, 'date', afterSchedule.lastGeneration.date, 'model calls', calls.length)
  console.log('PROBE F daily titles:', JSON.stringify(afterSchedule.daily.map(i => i.title)))
})

// PROBE G: two failed regens in a row on a stale missing-today day — carried items stable?
test('PROBE G: repeated failed regens keep items stable', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: (call) => (call <= 1 ? JSON.stringify([llmItem('new-idea', 1)]) : new Error('boom')),
    preferences: { enabled: true, types: ['new-idea'], countPerType: 1, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  store.appendKnowledgeCards(cards(['kc-a', 'kc-b', 'kc-c']))
  await service.generateNow()
  clock = new Date('2026-09-20T10:00:00')
  store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20' })
  await service.generateNow().catch(() => {})
  const s1 = service.getSnapshot()
  await service.generateNow().catch(() => {})
  const s2 = service.getSnapshot()
  console.log('PROBE G run1:', JSON.stringify([...s1.daily.map(i => i.id), ...s1.knowledge.map(i => i.id)]))
  console.log('PROBE G run2:', JSON.stringify([...s2.daily.map(i => i.id), ...s2.knowledge.map(i => i.id)]))
  assert.deepEqual(s2.daily.map(i => i.id), s1.daily.map(i => i.id))
  assert.deepEqual(s2.knowledge.map(i => i.id), s1.knowledge.map(i => i.id))
})
