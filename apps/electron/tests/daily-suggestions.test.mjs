import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import './register-ts-hooks.mjs'
import { DailySuggestionStore } from '../src/main/settings/daily-suggestion-store.ts'
import { DailySuggestionService, extractJsonArray, normalizeKnowledgeSuggestion, normalizeLlmSuggestion } from '../src/main/suggestions/daily-suggestion-service.ts'
import { buildExploreSuggestions, resolveWeeklyTheme, isoWeekNumber } from '../src/main/suggestions/static-suggestions.ts'
import { KNOWLEDGE_SEEDS, drawKnowledgeSeed, hashString } from '../src/main/suggestions/knowledge-seeds.ts'
import { DEFAULT_DAILY_SUGGESTION_PREFERENCES, KNOWLEDGE_SHUFFLE_LIMIT, normalizeDailySuggestionPreferences } from '../src/shared/daily-suggestion-types.ts'
import zhCN from '../src/locales/zh-CN/index.ts'
import enUS from '../src/locales/en-US/index.ts'

// Daily suggestions: the opt-in feature must never generate outside the types
// the user selected, must fall back to built-in tips when the model comes up
// short, and must enforce the per-day manual regeneration limit.

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-suggestions-'))
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
        const content = typeof reply === 'function' ? reply(calls.length) : reply
        if (content instanceof Error) throw content
        return { role: 'assistant', content }
      },
      async * chatStream () { throw new Error('unused') },
      getAvailableTools () { return [] }
    }
  }
}

function createService (t, { reply, preferences = {}, now = () => new Date('2026-09-19T10:00:00'), providerConfig = { apiKey: 'k', baseUrl: 'u', model: 'm', providerId: 'p' }, seedPreferences = true } = {}) {
  const store = new DailySuggestionStore(tempDir(t))
  if (seedPreferences) store.savePreferences(normalizeDailySuggestionPreferences({ ...DEFAULT_DAILY_SUGGESTION_PREFERENCES, ...preferences }))
  const { engine, calls } = fakeEngine(reply)
  const changes = []
  const service = new DailySuggestionService({
    store,
    resolveAiEngine: async () => engine,
    resolveProviderConfig: () => providerConfig || undefined,
    listProjects: async () => [{ id: 'proj-1', name: 'Demo', type: 'web', status: 'running', port: 3000 }],
    listConversations: async () => [{ title: 'Fix login bug', updatedAt: '2026-09-18T00:00:00Z', previewText: 'secret text' }],
    getCapabilities: async () => ({ skillNames: [], mcpServerNames: [], scheduledTaskCount: 0, longTermGoalCount: 0, agentGroupCount: 0 }),
    getLocale: () => 'zh-CN',
    onChanged: snapshot => changes.push(snapshot),
    now
  })
  t.after(() => service.dispose())
  return { service, store, calls, changes }
}

function llmItem (type, index = 0, extra = {}) {
  return { type, title: `${type} #${index}`, description: 'why', prompt: `do ${type} ${index}`, ...extra }
}

test('preferences normalize to safe defaults and never end up with zero types', () => {
  const prefs = normalizeDailySuggestionPreferences({ enabled: true, types: ['bogus'], countPerType: 7, trigger: { kind: 'time', timeOfDay: '25:99' }, context: { conversationSummaries: true } })
  assert.equal(prefs.enabled, true)
  assert.deepEqual(prefs.types, DEFAULT_DAILY_SUGGESTION_PREFERENCES.types)
  assert.equal(prefs.countPerType, 3)
  assert.deepEqual(prefs.trigger, { kind: 'time', timeOfDay: '09:00' })
  assert.equal(prefs.context.conversationSummaries, true)
  assert.equal(prefs.context.projects, true)
})

test('extractJsonArray tolerates prose and code fences around the array', () => {
  assert.deepEqual(extractJsonArray('Here you go:\n```json\n[{"a":1}]\n```'), [{ a: 1 }])
  assert.deepEqual(extractJsonArray('[{"a":1}] trailing'), [{ a: 1 }])
  assert.equal(extractJsonArray('no array here'), null)
})

test('normalizeLlmSuggestion drops types outside the allow-list and unknown project ids', () => {
  const now = new Date('2026-09-19T10:00:00')
  const allowed = new Set(['new-idea'])
  const projects = new Set(['proj-1'])
  assert.equal(normalizeLlmSuggestion(llmItem('automation'), allowed, projects, now), null)
  const ok = normalizeLlmSuggestion(llmItem('new-idea', 1, { scene: { targetProjectId: 'nope', planMode: true, computerUse: 'yes' } }), allowed, projects, now)
  assert.equal(ok.type, 'new-idea')
  assert.equal(ok.layer, 'daily')
  assert.equal(ok.source, 'llm')
  assert.equal(ok.fresh, true)
  assert.deepEqual(ok.scene, { planMode: true })
  const withProject = normalizeLlmSuggestion(llmItem('new-idea', 2, { scene: { targetProjectId: 'proj-1' } }), allowed, projects, now)
  assert.equal(withProject.scene.targetProjectId, 'proj-1')
})

test('weekly theme rotates by ISO week and explore items lead with the theme', () => {
  const week = isoWeekNumber(new Date('2026-09-19T00:00:00'))
  assert.equal(week, 38)
  const theme = resolveWeeklyTheme(new Date('2026-09-19T00:00:00'))
  const explore = buildExploreSuggestions(new Date('2026-09-19T00:00:00'))
  assert.equal(explore.theme, theme.id)
  assert.deepEqual(explore.items.slice(0, theme.itemIds.length).map(item => item.id), theme.itemIds.map(id => `static:${id}`))
  assert.ok(explore.items.every(item => item.source === 'static' && item.layer === 'explore'))
  assert.ok(explore.items.every(item => item.title.startsWith('chatUi.suggestions.static.')))
})

test('disabled feature shows only the explore pool and never calls the model', async t => {
  const { service, calls } = createService(t, { reply: '[]' })
  service.start()
  await new Promise(resolve => setImmediate(resolve))
  const snapshot = service.getSnapshot()
  assert.equal(snapshot.preferences.enabled, false)
  assert.deepEqual(snapshot.daily, [])
  assert.ok(snapshot.explore.length > 0)
  assert.equal(calls.length, 0)
  await assert.rejects(() => service.generateNow(), /DAILY_SUGGESTIONS_DISABLED/)
})

test('generation is constrained to selected types, capped per type, and topped up with built-in fallbacks', async t => {
  const reply = JSON.stringify([
    llmItem('new-idea', 1), llmItem('new-idea', 2), llmItem('new-idea', 3),
    llmItem('automation', 1), // not selected → dropped
    llmItem('feature-tip', 1) // one short of 2 → fallback fills the gap
  ])
  const { service, calls } = createService(t, { reply, preferences: { enabled: true, types: ['new-idea', 'feature-tip'], countPerType: 2, context: { projects: true, conversationTitles: true, conversationSummaries: false } } })
  const snapshot = await service.generateNow()

  assert.equal(calls.length, 1)
  const prompt = calls[0].messages[0].content
  assert.match(prompt, /"new-idea"/)
  assert.match(prompt, /"feature-tip"/)
  assert.doesNotMatch(prompt, /"automation":/)
  assert.match(prompt, /proj-1 \| Demo \| web \| running on port 3000/)
  assert.match(prompt, /Fix login bug/)
  assert.doesNotMatch(prompt, /secret text/, 'previews stay out unless conversationSummaries is on')
  assert.deepEqual(calls[0].options.allowedToolNames, ['__daily_suggestions_no_tools__'])

  assert.equal(snapshot.lastGeneration.status, 'partial')
  const byType = new Map()
  for (const item of snapshot.daily) byType.set(item.type, [...(byType.get(item.type) || []), item])
  assert.deepEqual([...byType.keys()], ['new-idea', 'feature-tip'])
  assert.equal(byType.get('new-idea').length, 2)
  assert.ok(byType.get('new-idea').every(item => item.source === 'llm'))
  assert.equal(byType.get('feature-tip').length, 2)
  assert.deepEqual(byType.get('feature-tip').map(item => item.source), ['llm', 'static'])
  assert.ok(snapshot.daily.every(item => item.type !== 'automation'))
})

test('manual regeneration is limited per day and the first run of a day does not count', async t => {
  const { service } = createService(t, { reply: JSON.stringify([llmItem('new-idea', 1)]), preferences: { enabled: true, types: ['new-idea'], countPerType: 2 } })
  await service.generateNow()
  assert.equal(service.getSnapshot().lastGeneration.manualRefreshCount, 0)
  await service.generateNow()
  await service.generateNow()
  await service.generateNow()
  assert.equal(service.getSnapshot().lastGeneration.manualRefreshCount, 3)
  await assert.rejects(() => service.generateNow(), /DAILY_SUGGESTIONS_REFRESH_LIMIT/)
})

test('a failed generation keeps the previous good batch visible and reports the failure', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service } = createService(t, {
    reply: (call) => (call === 1 ? JSON.stringify([llmItem('new-idea', 1), llmItem('new-idea', 2)]) : new Error('boom')),
    preferences: { enabled: true, types: ['new-idea'], countPerType: 2 },
    now: () => clock
  })
  await service.generateNow()
  const first = service.getSnapshot()
  assert.equal(first.lastGeneration.status, 'ok')
  assert.equal(first.daily.length, 2)

  clock = new Date('2026-09-20T10:00:00')
  await service.generateNow().catch(() => {})
  const second = service.getSnapshot()
  assert.equal(second.lastGeneration.status, 'failed')
  assert.match(second.lastGeneration.error, /boom/)
  assert.equal(second.daily.length, 2, 'yesterday\'s items stay while today failed')
  assert.equal(second.daily[0].title, 'new-idea #1')
})

test('missing provider marks the batch failed with PROVIDER_MISSING and no model call', async t => {
  const { service, calls } = createService(t, { reply: '[]', providerConfig: null, preferences: { enabled: true } })
  await service.generateNow()
  const snapshot = service.getSnapshot()
  assert.equal(calls.length, 0)
  assert.equal(snapshot.providerMissing, true)
  assert.equal(snapshot.lastGeneration.status, 'failed')
  assert.equal(snapshot.lastGeneration.error, 'PROVIDER_MISSING')
})

test('dismiss hides an item, streaks feed the prompt, and pick resets the streak', async t => {
  const reply = JSON.stringify([llmItem('new-idea', 1), llmItem('new-idea', 2), llmItem('new-idea', 3)])
  const { service, store, calls } = createService(t, { reply, preferences: { enabled: true, types: ['new-idea'], countPerType: 3 } })
  await service.generateNow()
  const items = service.getSnapshot().daily
  assert.equal(items.length, 3)

  service.dismiss(items[0].id)
  service.dismiss(items[1].id)
  service.dismiss(items[2].id)
  assert.equal(service.getSnapshot().daily.length, 0)
  assert.equal(store.getTypeDismissStreaks()['new-idea'], 3)

  await service.generateNow()
  assert.match(calls.at(-1).messages[0].content, /recently dismissed several items of this type/)

  const fresh = service.getSnapshot().daily[0]
  service.recordPick(fresh.id)
  assert.equal(store.getTypeDismissStreaks()['new-idea'], undefined)
  assert.equal(service.getSnapshot().daily[0].fresh, false, 'picking clears the new badge')

  // Explore items can be dismissed too.
  const explore = service.getSnapshot().explore[0]
  service.dismiss(explore.id)
  assert.ok(service.getSnapshot().explore.every(item => item.id !== explore.id))
})

test('a time trigger only catches up at startup once its slot has passed; enabling generates right away', async t => {
  const reply = JSON.stringify([llmItem('new-idea', 1)])
  const timePrefs = { enabled: true, types: ['new-idea'], countPerType: 2, trigger: { kind: 'time', timeOfDay: '09:00' } }

  const early = createService(t, { reply, preferences: timePrefs, now: () => new Date('2026-09-19T08:00:00') })
  early.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(early.calls.length, 0, '09:00 has not passed yet, so no catch-up run')

  const late = createService(t, { reply, preferences: timePrefs, now: () => new Date('2026-09-19T10:00:00') })
  late.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(late.calls.length, 1, 'past 09:00 with no batch today → catch up on startup')

  const fresh = createService(t, { reply, now: () => new Date('2026-09-19T08:00:00') })
  fresh.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fresh.calls.length, 0, 'disabled by default')
  fresh.service.savePreferences({ ...DEFAULT_DAILY_SUGGESTION_PREFERENCES, ...timePrefs })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fresh.calls.length, 1, 'turning the feature on shows something today, not tomorrow')
  const freshDaily = fresh.service.getSnapshot().daily
  assert.equal(freshDaily.length, 2, 'one model item topped up to countPerType with a built-in tip')
  assert.deepEqual(freshDaily.map(item => item.source), ['llm', 'static'])
})

test('the store survives a corrupt file and persists batches newest-first', t => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'daily-suggestions.json'), '{ not json')
  const store = new DailySuggestionStore(dir)
  assert.equal(store.getPreferences().enabled, false)
  store.saveBatch({ date: '2026-09-18', status: 'ok', items: [], generatedAt: 'x', manualRefreshCount: 0 })
  store.saveBatch({ date: '2026-09-19', status: 'ok', items: [], generatedAt: 'y', manualRefreshCount: 1 })
  const reloaded = new DailySuggestionStore(dir)
  assert.deepEqual(reloaded.getBatches().map(batch => batch.date), ['2026-09-19', '2026-09-18'])
  assert.equal(reloaded.getBatch('2026-09-19').manualRefreshCount, 1)
})

// ── Knowledge exploration ──────────────────────────────────────────────────

test('knowledge preferences default to the random source and clamp interests / profession', () => {
  const defaults = normalizeDailySuggestionPreferences({})
  assert.deepEqual(defaults.knowledge, { enabled: true, sources: ['random'], interests: [], profession: '', countPerSource: 1 })

  const prefs = normalizeDailySuggestionPreferences({
    knowledge: {
      enabled: true,
      sources: ['bogus', 'interest', 'cross-discipline'],
      interests: [' Astronomy ', 'astronomy', '', 'x'.repeat(50), ...Array.from({ length: 20 }, (_, i) => `topic ${i}`)],
      profession: 'p'.repeat(100),
      countPerSource: 7
    }
  })
  assert.deepEqual(prefs.knowledge.sources, ['cross-discipline', 'interest'])
  assert.equal(prefs.knowledge.interests.length, 10)
  assert.equal(prefs.knowledge.interests[0], 'Astronomy')
  assert.equal(prefs.knowledge.interests[1].length, 30)
  assert.equal(prefs.knowledge.profession.length, 60)
  assert.equal(prefs.knowledge.countPerSource, 1)

  const empty = normalizeDailySuggestionPreferences({ knowledge: { sources: [] } })
  assert.deepEqual(empty.knowledge.sources, ['random'], 'an empty source list falls back to random')
})

test('every knowledge seed has zh-CN and en-US copy and a unique id', () => {
  const ids = new Set()
  for (const seed of KNOWLEDGE_SEEDS) {
    assert.ok(!ids.has(seed.id), `duplicate seed id ${seed.id}`)
    ids.add(seed.id)
    for (const [name, locale] of [['zh-CN', zhCN], ['en-US', enUS]]) {
      const copy = locale.chatUi.suggestions.knowledgeSeeds[seed.id]
      assert.ok(copy, `${name} copy missing for ${seed.id}`)
      assert.ok(copy.title && copy.description && copy.prompt, `${name} copy incomplete for ${seed.id}`)
      assert.ok(locale.chatUi.suggestions.disciplines[seed.discipline], `${name} discipline label missing for ${seed.discipline}`)
    }
  }
  assert.ok(KNOWLEDGE_SEEDS.length >= 36)
})

test('the seed draw is stable per day, avoids the 30-day history, and relaxes when the pool runs dry', () => {
  assert.equal(hashString('a'), hashString('a'))
  assert.notEqual(hashString('2026-09-19|x|0'), hashString('2026-09-20|x|0'))

  const first = drawKnowledgeSeed('2026-09-19', 'salt', [], 0)
  assert.equal(drawKnowledgeSeed('2026-09-19', 'salt', [], 0).id, first.id, 'same inputs, same seed')

  const recent = [{ seedId: first.id, date: '2026-09-10' }]
  assert.notEqual(drawKnowledgeSeed('2026-09-19', 'salt', recent, 0).id, first.id, 'shown 9 days ago → excluded')

  const old = [{ seedId: first.id, date: '2026-08-01' }]
  assert.equal(drawKnowledgeSeed('2026-09-19', 'salt', old, 0).id, first.id, 'shown 49 days ago → eligible again')

  // Everything shown in the last 30 days except one → that one must be drawn.
  const allButOne = KNOWLEDGE_SEEDS.slice(1).map(seed => ({ seedId: seed.id, date: '2026-09-15' }))
  assert.equal(drawKnowledgeSeed('2026-09-19', 'salt', allButOne, 0).id, KNOWLEDGE_SEEDS[0].id)

  // Everything shown within 30 days, but some older than 14 → relaxed window applies.
  const mixed = KNOWLEDGE_SEEDS.map((seed, index) => ({ seedId: seed.id, date: index < 3 ? '2026-08-25' : '2026-09-15' }))
  const relaxed = drawKnowledgeSeed('2026-09-19', 'salt', mixed, 0)
  assert.ok(KNOWLEDGE_SEEDS.slice(0, 3).some(seed => seed.id === relaxed.id), 'falls back to seeds older than 14 days')

  // Everything shown yesterday → nothing is excluded, but it still returns a seed.
  const all = KNOWLEDGE_SEEDS.map(seed => ({ seedId: seed.id, date: '2026-09-18' }))
  assert.ok(drawKnowledgeSeed('2026-09-19', 'salt', all, 0).id)
})

test('normalizeKnowledgeSuggestion enforces the source allow-list, needs interests for "interest", and ignores scenes', () => {
  const now = new Date('2026-09-19T10:00:00')
  const base = { title: 'Why is the sky blue?', description: 'hook', prompt: 'tell me', discipline: 'physics', scene: { planMode: true } }
  const prefs = { enabled: true, sources: ['random', 'cross-discipline', 'interest'], interests: [], profession: '', countPerSource: 1 }

  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'work-domain' }, prefs, now), null, 'not selected')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'random' }, prefs, now), null, 'random is never model-generated')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'interest' }, prefs, now), null, 'no interests declared')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'cross-discipline', title: '' }, prefs, now), null)

  const ok = normalizeKnowledgeSuggestion({ ...base, source: 'cross-discipline' }, prefs, now)
  assert.equal(ok.layer, 'knowledge')
  assert.equal(ok.type, 'knowledge')
  assert.equal(ok.source, 'llm')
  assert.deepEqual(ok.knowledge, { source: 'cross-discipline', discipline: 'physics' })
  assert.equal(ok.scene, undefined, 'knowledge cards never carry a scene')

  const withInterests = normalizeKnowledgeSuggestion({ ...base, source: 'interest' }, { ...prefs, interests: ['astronomy'] }, now)
  assert.equal(withInterests.knowledge.source, 'interest')
})

test('with no provider the random knowledge card still shows and never calls the model', async t => {
  const { service, calls } = createService(t, { reply: '[]', providerConfig: null })
  service.start()
  await new Promise(resolve => setImmediate(resolve))
  const snapshot = service.getSnapshot()
  assert.equal(calls.length, 0)
  assert.equal(snapshot.knowledge.length, 1)
  assert.equal(snapshot.knowledge[0].knowledge.source, 'random')
  assert.equal(snapshot.knowledge[0].source, 'static')
  assert.match(snapshot.knowledge[0].title, /^chatUi\.suggestions\.knowledgeSeeds\./)
  assert.equal(snapshot.knowledgeShuffleRemaining, KNOWLEDGE_SHUFFLE_LIMIT)
  assert.equal(snapshot.providerMissing, false, 'the random card alone does not need a provider')
  // Same day → same card.
  assert.equal(service.getSnapshot().knowledge[0].id, snapshot.knowledge[0].id)
})

test('shuffling swaps the random seed, is limited per day, and resets the next day', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store } = createService(t, { reply: '[]', now: () => clock })
  const first = service.getSnapshot().knowledge[0].knowledge.seedId
  const seen = new Set([first])
  for (let index = 0; index < KNOWLEDGE_SHUFFLE_LIMIT; index++) {
    const next = service.shuffleKnowledge().knowledge[0].knowledge.seedId
    assert.ok(!seen.has(next), 'each shuffle yields a seed not shown today')
    seen.add(next)
  }
  assert.equal(service.getSnapshot().knowledgeShuffleRemaining, 0)
  assert.throws(() => service.shuffleKnowledge(), /KNOWLEDGE_SHUFFLE_LIMIT/)
  assert.equal(store.getKnowledgeSeedHistory().length, KNOWLEDGE_SHUFFLE_LIMIT + 1, 'shuffled-away seeds enter the history')

  clock = new Date('2026-09-20T10:00:00')
  assert.equal(service.getSnapshot().knowledgeShuffleRemaining, KNOWLEDGE_SHUFFLE_LIMIT)
  assert.ok(!seen.has(service.getSnapshot().knowledge[0].knowledge.seedId), 'tomorrow avoids everything shown today')

  // Dismissing today's random card hides it for the day; no replacement is pushed.
  service.dismiss(service.getSnapshot().knowledge[0].id)
  assert.equal(service.getSnapshot().knowledge.length, 0)
  assert.equal(store.getKnowledgeDismissStreaks().random, 1)
})

test('LLM knowledge sources run as a separate request, respect countPerSource, and survive the daily group failing', async t => {
  const knowledgeReply = JSON.stringify([
    { source: 'cross-discipline', discipline: 'biology', title: 'Why hexagons?', description: 'd', prompt: 'p1' },
    { source: 'cross-discipline', discipline: 'history', title: 'Extra', description: 'd', prompt: 'p2' }, // over countPerSource → dropped
    { source: 'interest', discipline: 'astronomy', title: 'Why is Venus hot?', description: 'd', prompt: 'p3' },
    { source: 'work-domain', discipline: 'x', title: 'not selected', description: 'd', prompt: 'p4' }
  ])
  const { service, calls } = createService(t, {
    reply: (call) => (call === 1 ? new Error('daily boom') : knowledgeReply),
    preferences: {
      enabled: true,
      types: ['new-idea'],
      countPerType: 2,
      knowledge: { enabled: true, sources: ['random', 'cross-discipline', 'interest'], interests: ['astronomy'], profession: 'indie developer', countPerSource: 1 }
    }
  })
  const snapshot = await service.generateNow()
  assert.equal(calls.length, 2, 'daily and knowledge are separate completions')
  const knowledgePrompt = calls[1].messages[0].content
  assert.match(knowledgePrompt, /curiosity hooks/)
  assert.match(knowledgePrompt, /indie developer/)
  assert.match(knowledgePrompt, /astronomy/)
  assert.match(knowledgePrompt, /"cross-discipline"/)
  assert.doesNotMatch(knowledgePrompt, /"work-domain":/)
  assert.match(knowledgePrompt, /Already shown today from the built-in pool/)

  assert.equal(snapshot.lastGeneration.status, 'partial', 'daily failed, knowledge succeeded')
  assert.match(snapshot.lastGeneration.error, /daily boom/)
  assert.equal(snapshot.knowledge[0].knowledge.source, 'random', 'random card leads')
  const llm = snapshot.knowledge.filter(item => item.source === 'llm')
  assert.deepEqual(llm.map(item => item.knowledge.source).sort(), ['cross-discipline', 'interest'])
  assert.ok(llm.every(item => item.fresh && item.layer === 'knowledge'))
  assert.deepEqual(snapshot.daily, [], 'a fully failed daily request keeps the previous daily items (none on day one)')
})

test('knowledge LLM sources run even when daily picks are off', async t => {
  const reply = JSON.stringify([{ source: 'work-domain', discipline: 'backend', title: 'Why idempotency?', description: 'd', prompt: 'p' }])
  const { service, calls } = createService(t, {
    reply,
    preferences: { enabled: false, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } }
  })
  service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 1)
  assert.doesNotMatch(calls[0].messages[0].content, /actionable daily suggestions/, 'only the knowledge prompt ran')
  const snapshot = service.getSnapshot()
  assert.deepEqual(snapshot.daily, [])
  assert.equal(snapshot.knowledge.length, 2)
  assert.equal(snapshot.knowledge[1].knowledge.source, 'work-domain')

  // Dismissing a knowledge item feeds a per-source streak; picking clears it.
  service.dismiss(snapshot.knowledge[1].id)
  assert.equal(service.getSnapshot().knowledge.length, 1)
})
