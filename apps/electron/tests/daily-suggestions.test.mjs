import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import './register-ts-hooks.mjs'
import { DailySuggestionStore, MAX_GENERATED_SEEDS } from '../src/main/settings/daily-suggestion-store.ts'
import { DailySuggestionService, KNOWLEDGE_CARD_REPLENISH_BATCH, KNOWLEDGE_REPLENISH_BATCH, extractJsonArray, knowledgeCopyLooksBroken, normalizeGeneratedKnowledgeCard, normalizeGeneratedSeed, normalizeKnowledgeSuggestion, normalizeLlmSuggestion } from '../src/main/suggestions/daily-suggestion-service.ts'
import { buildExploreSuggestions, resolveWeeklyTheme, isoWeekNumber } from '../src/main/suggestions/static-suggestions.ts'
import { KNOWLEDGE_DISCIPLINES, KNOWLEDGE_SEEDS, buildKnowledgePool, countUnseenKnowledgeCards, drawKnowledgeSeed, hashString, titleKey } from '../src/main/suggestions/knowledge-seeds.ts'
import { DEFAULT_DAILY_SUGGESTION_PREFERENCES, formatLocalDate, normalizeDailySuggestionPreferences } from '../src/shared/daily-suggestion-types.ts'
import zhCN from '../src/locales/zh-CN/index.ts'
import enUS from '../src/locales/en-US/index.ts'

// Daily suggestions: the opt-in feature must never generate outside the types
// the user selected, must fall back to built-in tips when the model comes up
// short, must serve knowledge cards from a local pool with automatic top-ups,
// and must allow unlimited manual refresh.

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
        const content = typeof reply === 'function' ? reply(calls.length, messages[0].content) : reply
        if (content instanceof Error) throw content
        return { role: 'assistant', content }
      },
      async * chatStream () { throw new Error('unused') },
      getAvailableTools () { return [] }
    }
  }
}

/**
 * `allowReplenish` opts a test into the pool top-ups. Everything else records a
 * failed attempt today (the store's own back-off), so model-call counts stay
 * about the daily / knowledge requests under test.
 */
function createService (t, { reply, preferences = {}, now = () => new Date('2026-09-19T10:00:00'), providerConfig = { apiKey: 'k', baseUrl: 'u', model: 'm', providerId: 'p' }, seedPreferences = true, allowReplenish = false, locale = 'zh-CN' } = {}) {
  const store = new DailySuggestionStore(tempDir(t))
  if (seedPreferences) store.savePreferences(normalizeDailySuggestionPreferences({ ...DEFAULT_DAILY_SUGGESTION_PREFERENCES, ...preferences }))
  if (!allowReplenish) store.setKnowledgeReplenish({ lastAttemptDate: formatLocalDate(now()), lastError: 'SUPPRESSED_FOR_TEST' })
  const { engine, calls } = fakeEngine(reply)
  const changes = []
  const service = new DailySuggestionService({
    store,
    resolveAiEngine: async () => engine,
    resolveProviderConfig: () => providerConfig || undefined,
    listProjects: async () => [{ id: 'proj-1', name: 'Demo', type: 'web', status: 'running', port: 3000 }],
    listConversations: async () => [{ title: 'Fix login bug', updatedAt: '2026-09-18T00:00:00Z', previewText: 'secret text' }],
    getCapabilities: async () => ({ skillNames: [], mcpServerNames: [], scheduledTaskCount: 0, longTermGoalCount: 0, agentGroupCount: 0 }),
    getLocale: () => locale,
    onChanged: snapshot => changes.push(snapshot),
    now
  })
  t.after(() => service.dispose())
  return { service, store, calls, changes }
}

function llmItem (type, index = 0, extra = {}) {
  return { type, title: `${type} #${index}`, description: 'why', prompt: `do ${type} ${index}`, ...extra }
}

/** A model reply for the pool top-up: one seed per discipline, distinct slugs. */
function seedReply (count = KNOWLEDGE_REPLENISH_BATCH, tag = 'a') {
  return JSON.stringify(KNOWLEDGE_DISCIPLINES.slice(0, count).map((discipline, index) => ({
    discipline,
    slug: `${discipline}-topic-${tag}-${index}`,
    title: `为什么 ${discipline} ${tag} ${index}？`,
    description: `hook ${index}`,
    prompt: `我对「${discipline} ${tag} ${index}」有点好奇。`
  })))
}

function isReplenishPrompt (content) {
  return /## Already in the pool/.test(content)
}

function isCardPrompt (content) {
  return /## Cards already in the pool/.test(content)
}

/** A model reply for the card-pool top-up: distinct Chinese cards for one source. */
function cardReply (source = 'cross-discipline', count = KNOWLEDGE_CARD_REPLENISH_BATCH, tag = 'a') {
  return JSON.stringify(Array.from({ length: count }, (_, index) => ({
    source,
    discipline: `领域${tag}${index}`,
    title: `为什么${source}${tag}${index}如此反直觉？`,
    description: `hook ${index}`,
    prompt: `我对「${source}${tag}${index}」有点好奇。`
  })))
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

test('manual regeneration is unlimited and keeps counting the runs', async t => {
  const reply = JSON.stringify([llmItem('new-idea', 1), llmItem('new-idea', 2), llmItem('new-idea', 3)])
  const { service } = createService(t, { reply, preferences: { enabled: true, types: ['new-idea'], countPerType: 3 } })
  await service.generateNow()
  assert.equal(service.getSnapshot().lastGeneration.manualRefreshCount, 0)
  for (let index = 0; index < 6; index++) {
    await service.generateNow()
  }
  const state = service.getSnapshot().lastGeneration
  assert.equal(state.manualRefreshCount, 6, 'every press counts, none is rejected')
  assert.equal(state.status, 'ok')
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

  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'work-domain' }, prefs, now, 'en-US'), null, 'not selected')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'random' }, prefs, now, 'en-US'), null, 'random is never model-generated')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'interest' }, prefs, now, 'en-US'), null, 'no interests declared')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, source: 'cross-discipline', title: '' }, prefs, now, 'en-US'), null)

  const ok = normalizeKnowledgeSuggestion({ ...base, source: 'cross-discipline' }, prefs, now, 'en-US')
  assert.equal(ok.layer, 'knowledge')
  assert.equal(ok.type, 'knowledge')
  assert.equal(ok.source, 'llm')
  assert.deepEqual(ok.knowledge, { source: 'cross-discipline', discipline: 'physics' })
  assert.equal(ok.scene, undefined, 'knowledge cards never carry a scene')

  const withInterests = normalizeKnowledgeSuggestion({ ...base, source: 'interest' }, { ...prefs, interests: ['astronomy'] }, now, 'en-US')
  assert.equal(withInterests.knowledge.source, 'interest')
})

test('broken model copy is rejected: template placeholders and wrong-language prompts', () => {
  const now = new Date('2026-09-19T10:00:00')
  const prefs = { enabled: true, sources: ['cross-discipline'], interests: [], profession: '', countPerSource: 1 }
  const base = { source: 'cross-discipline', title: '为什么热水结冰更快？', description: 'd', discipline: 'physics', prompt: '我对「姆潘巴效应」有点好奇。' }

  // The model echoed the prompt template with the placeholder X still in it.
  assert.equal(normalizeKnowledgeSuggestion({ ...base, prompt: 'I\'m curious about X. Start with an everyday analogy, then tell me the most counter-intuitive thing.' }, prefs, now, 'zh-CN'), null, 'English template for a zh locale')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, prompt: '关于X，先讲讲它是什么。' }, prefs, now, 'zh-CN'), null, 'bare placeholder X kept')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, prompt: '我对「X」有点好奇。' }, prefs, now, 'zh-CN'), null, 'quoted placeholder kept')
  assert.equal(knowledgeCopyLooksBroken('zh-CN', '热冰悖论', '我对「X光」的发现史有点好奇。'), false, 'X-ray style compounds stay fine')

  const good = normalizeKnowledgeSuggestion({ ...base, prompt: '我对「姆潘巴效应」有点好奇，先用日常类比讲讲它。' }, prefs, now, 'zh-CN')
  assert.ok(good, 'clean Chinese copy passes')
  assert.equal(normalizeKnowledgeSuggestion({ ...base, title: 'Why hot water freezes faster?' }, prefs, now, 'en-US') !== null, true, 'clean English copy passes for en locale')

  const card = normalizeGeneratedKnowledgeCard(base, prefs, 'zh-CN', now, new Set())
  assert.equal(card.source, 'cross-discipline')
  assert.match(card.id, /^kc-/)
  assert.equal(card.copy.locale, 'zh-CN')
  assert.equal(normalizeGeneratedKnowledgeCard(base, prefs, 'zh-CN', now, new Set([`cross-discipline|zh-CN|${titleKey(card.copy.title)}`])), null, 'duplicate title dropped')
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
  assert.equal(snapshot.providerMissing, false, 'the random card alone does not need a provider')
  // Same day → same card.
  assert.equal(service.getSnapshot().knowledge[0].id, snapshot.knowledge[0].id)
})

test('shuffling swaps the random seed without a per-day cap and resets the next day', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store } = createService(t, { reply: '[]', now: () => clock })
  const first = service.getSnapshot().knowledge[0].knowledge.seedId
  const seen = new Set([first])
  // Well past the old five-per-day cap: every swap still yields a new seed.
  for (let index = 0; index < 10; index++) {
    const next = service.shuffleKnowledge().knowledge[0].knowledge.seedId
    assert.ok(!seen.has(next), 'each shuffle yields a seed not shown today')
    seen.add(next)
  }
  assert.equal(store.getKnowledgeSeedHistory().length, 11, 'shuffled-away seeds enter the history')

  clock = new Date('2026-09-20T10:00:00')
  assert.ok(!seen.has(service.getSnapshot().knowledge[0].knowledge.seedId), 'tomorrow avoids everything shown today')

  // Dismissing today's random card hides it for the day; no replacement is pushed.
  service.dismiss(service.getSnapshot().knowledge[0].id)
  assert.equal(service.getSnapshot().knowledge.length, 0)
  assert.equal(store.getKnowledgeDismissStreaks().random, 1)
})

test('LLM knowledge sources run as a separate request, respect countPerSource, and bank results into the pool', async t => {
  const knowledgeReply = JSON.stringify([
    { source: 'cross-discipline', discipline: 'biology', title: '为什么蜂巢是六边形？', description: 'd', prompt: '我对「蜂巢猜想」有点好奇。' },
    { source: 'cross-discipline', discipline: 'history', title: '额外的卡片为什么出现了？', description: 'd', prompt: '我对「额外的卡片」有点好奇。' }, // over countPerSource → not shown today, banked into the pool
    { source: 'interest', discipline: 'astronomy', title: '金星为什么比水星更热？', description: 'd', prompt: '我对「金星温室效应」有点好奇。' },
    { source: 'work-domain', discipline: 'x', title: 'not selected', description: 'd', prompt: 'p4' } // not selected → dropped
  ])
  const { service, store, calls } = createService(t, {
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

  // Everything valid the model produced is banked for future draws, even the
  // card that was capped out of today's hand.
  const banked = store.getKnowledgeCards()
  assert.equal(banked.length, 3)
  assert.ok(banked.every(card => card.copy.locale === 'zh-CN' && card.id.startsWith('kc-')))
  assert.equal(snapshot.knowledgePool.cards, 3)
  assert.equal(snapshot.knowledgePool.cardsUnseen, 3, 'nothing has been drawn from the pool yet')
})

test('knowledge LLM sources run even when daily picks are off', async t => {
  const reply = JSON.stringify([{ source: 'work-domain', discipline: 'backend', title: '幂等性为什么重要？', description: 'd', prompt: '我想聊聊幂等性。' }])
  const { service, store, calls } = createService(t, {
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
  assert.equal(store.getKnowledgeCards().length, 1, 'the produced card is banked')

  // Dismissing a knowledge item feeds a per-source streak; picking clears it.
  service.dismiss(snapshot.knowledge[1].id)
  assert.equal(service.getSnapshot().knowledge.length, 1)
})

// ── Knowledge card pool (题库) ─────────────────────────────────────────────
// Every knowledge refresh draws from the local pool without a model call; the
// model only fills the shortfall and banks its output. A pool that has been
// 80% consumed schedules the next batch.

test('a stocked pool serves knowledge cards with zero model calls and rotates on refresh', async t => {
  const { service, store, calls } = createService(t, {
    reply: () => { throw new Error('must not be called') },
    preferences: { enabled: false, knowledge: { enabled: true, sources: ['random', 'cross-discipline'], interests: [], profession: '', countPerSource: 1 } }
  })
  const cards = Array.from({ length: 4 }, (_, index) => ({
    id: `kc-pool-${index}`,
    source: 'cross-discipline',
    discipline: `领域${index}`,
    copy: { locale: 'zh-CN', title: `为什么题目${index}如此反直觉？`, description: 'd', prompt: `我对「题目${index}」有点好奇。`, createdAt: '2026-09-01T00:00:00.000Z' }
  }))
  store.appendKnowledgeCards(cards)
  store.appendKnowledgeCards(cards, []) // duplicates are ignored

  const first = await service.generateNow()
  assert.equal(calls.length, 0, 'pool covers the request → no completion')
  assert.equal(first.knowledge.length, 2, 'random seed plus one pool card')
  assert.match(first.knowledge[1].id, /^kcard:2026-09-19:kc-pool-/)
  assert.equal(first.knowledge[1].source, 'llm')
  assert.equal(first.knowledge[1].knowledge.seedId.startsWith('kc-pool-'), true)
  assert.equal(first.lastGeneration.status, 'ok')
  assert.equal(first.knowledgePool.cards, 4)
  assert.equal(first.knowledgePool.cardsUnseen, 3, 'the drawn card counts as seen')

  const second = await service.generateNow()
  assert.equal(calls.length, 0)
  assert.notEqual(second.knowledge[1].knowledge.seedId, first.knowledge[1].knowledge.seedId, 'the next refresh draws a different card')

  // A dismissed pool card never comes back the same day.
  const shown = second.knowledge[1]
  service.dismiss(shown.id)
  const third = await service.generateNow()
  assert.ok(third.knowledge.every(item => item.id !== shown.id))
})

test('a batch generated before the pool was stocked backfills knowledge cards from the pool', async t => {
  const { service, store, calls } = createService(t, {
    reply: (_call, content) => (/curiosity hooks/.test(content) ? '[]' : JSON.stringify([llmItem('new-idea')])),
    preferences: {
      enabled: true,
      types: ['new-idea'],
      countPerType: 1,
      knowledge: { enabled: true, sources: ['random', 'cross-discipline'], interests: [], profession: '', countPerSource: 1 }
    }
  })
  const stale = await service.generateNow()
  assert.equal(stale.knowledge.length, 1, 'the model returned no pool cards, so only the random seed is visible')

  // Simulate the background pool top-up landing after today's batch was saved.
  store.appendKnowledgeCards([{
    id: 'kc-late',
    source: 'cross-discipline',
    discipline: '历史',
    copy: { locale: 'zh-CN', title: '为什么_longitude_prize_被遗忘了？', description: 'd', prompt: '我对「经度奖」有点好奇。', createdAt: new Date().toISOString() }
  }])
  const cursorBefore = store.getKnowledgeCardCursor()
  const first = service.getSnapshot()
  const backfilled = first.knowledge.find(item => item.knowledge?.source === 'cross-discipline')
  assert.ok(backfilled, 'the late pool card is drawn onto the empty knowledge hand')
  assert.equal(backfilled.knowledge.seedId, 'kc-late')

  const second = service.getSnapshot()
  assert.equal(second.knowledge.find(item => item.knowledge?.seedId === 'kc-late')?.knowledge.seedId, 'kc-late', 'the backfill is persisted and stable')
  assert.equal(store.getKnowledgeCardCursor(), cursorBefore, 'snapshot reads do not rotate the pool cursor')
  assert.equal(calls.length, 2, 'backfill uses the local pool, not another completion')
})

test('a single knowledge card can be swapped for the next pool entry, unlimited', async t => {
  const { service, store } = createService(t, {
    reply: () => { throw new Error('must not be called') },
    preferences: { enabled: false, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } }
  })
  const cards = Array.from({ length: 5 }, (_, index) => ({
    id: `kc-swap-${index}`,
    source: 'work-domain',
    discipline: `后端${index}`,
    copy: { locale: 'zh-CN', title: `为什么套路${index}总被忽视？`, description: 'd', prompt: `我对「套路${index}」有点好奇。`, createdAt: '2026-09-01T00:00:00.000Z' }
  }))
  store.appendKnowledgeCards(cards)
  const hand = await service.generateNow()
  const card = hand.knowledge.find(item => item.knowledge?.source === 'work-domain')

  const seen = new Set([card.knowledge.seedId])
  let current = card
  for (let index = 0; index < 4; index++) {
    const next = await service.refreshKnowledgeCard(current.id)
    const swapped = next.knowledge.find(item => item.knowledge?.source === 'work-domain')
    assert.ok(!seen.has(swapped.knowledge.seedId), 'each swap yields a card not currently shown')
    assert.ok(swapped.id.startsWith('kcard:2026-09-19:'))
    assert.equal(next.knowledge.find(item => item.knowledge?.source === 'random').knowledge.source, 'random', 'the random card is untouched')
    seen.add(swapped.knowledge.seedId)
    current = swapped
  }

  // The random card goes through the seed shuffle instead of the card pool.
  const randomCard = service.getSnapshot().knowledge[0]
  const shuffled = await service.refreshKnowledgeCard(randomCard.id)
  assert.notEqual(shuffled.knowledge[0].knowledge.seedId, randomCard.knowledge.seedId)

  await assert.rejects(() => service.refreshKnowledgeCard('kcard:2026-09-19:kc-missing'), /KNOWLEDGE_CARD_NOT_FOUND/)
})

test('an 80% consumed pool triggers the next batch; a failed attempt backs off until tomorrow', async t => {
  let clock = new Date('2026-09-19T10:00:00')
  const { service, store, calls } = createService(t, {
    reply: (_call, content) => (isCardPrompt(content) ? cardReply() : '[]'),
    allowReplenish: true,
    preferences: { enabled: false, knowledge: { enabled: true, sources: ['cross-discipline'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  const seedPool = Array.from({ length: 5 }, (_, index) => ({
    id: `kc-drain-${index}`,
    source: 'cross-discipline',
    discipline: '历史',
    copy: { locale: 'zh-CN', title: `为什么事件${index}被遗忘了？`, description: 'd', prompt: `我对「事件${index}」有点好奇。`, createdAt: '2026-09-01T00:00:00.000Z' }
  }))
  store.appendKnowledgeCards(seedPool)
  // 4 of 5 shown within the reuse window → 80% consumed.
  store.recordKnowledgeShown('2026-09-18', seedPool.slice(0, 4).map(card => card.id))
  assert.equal(store.getKnowledgeCardCursor(), 0)

  await service.maybeReplenishKnowledgePool()
  const cardCalls = calls.filter(call => isCardPrompt(call.messages[0].content))
  assert.equal(cardCalls.length, 1, 'drained pool → the next batch is generated')
  assert.match(cardCalls[0].messages[0].content, /locale tag "zh-CN"/)
  assert.match(cardCalls[0].messages[0].content, /- cross-discipline: 为什么事件0被遗忘了？/, 'existing titles are listed as covered')
  assert.equal(store.getKnowledgeCards().length, 9, 'the four new cards are banked')
  assert.ok(store.getKnowledgeReplenish().lastSuccessAt, 'success is recorded')

  // A fresh success does not block a further drained-pool top-up, but a full pool is left alone.
  await service.maybeReplenishKnowledgePool()
  assert.equal(calls.filter(call => isCardPrompt(call.messages[0].content)).length, 1, 'pool no longer drained → nothing to do')

  // A failed attempt today stops retries, even when a refresh drains the pool again.
  clock = new Date('2026-09-20T10:00:00')
  const failing = createService(t, {
    reply: () => new Error('boom'),
    allowReplenish: false,
    preferences: { enabled: false, knowledge: { enabled: true, sources: ['cross-discipline'], interests: [], profession: '', countPerSource: 1 } },
    now: () => clock
  })
  failing.store.appendKnowledgeCards(seedPool)
  failing.store.recordKnowledgeShown('2026-09-19', seedPool.slice(0, 4).map(card => card.id))
  failing.store.setKnowledgeReplenish({ lastAttemptDate: '2026-09-20', lastError: 'MODEL_OUTPUT_NOT_JSON' })
  await failing.service.maybeReplenishKnowledgePool()
  assert.equal(failing.calls.length, 0, 'failed today → back off until tomorrow')
})

// ── Random pool replenishment ─────────────────────────────────────────────
// Built-in seeds cover the cold start; once a provider exists the model tops
// the pool up. Generated seeds must draw like built-in ones, dedupe against
// everything already known, respect the locale, and never fire more than
// once a day.

test('normalizeGeneratedSeed derives a stable id from the slug and rejects collisions and bad disciplines', () => {
  const now = new Date('2026-09-19T10:00:00')
  const ids = new Set(KNOWLEDGE_SEEDS.map(seed => seed.id))
  const titles = new Set()
  const base = { discipline: 'physics', slug: 'Physics Mpemba Effect!', title: '热水为什么比冷水先结冰？', description: 'd', prompt: '我对「姆潘巴效应」有点好奇。' }

  const ok = normalizeGeneratedSeed(base, 'zh-CN', now, ids, titles)
  assert.equal(ok.id, 'gen-physics-mpemba-effect')
  assert.equal(ok.discipline, 'physics')
  assert.deepEqual(ok.copy, { locale: 'zh-CN', title: base.title, description: 'd', prompt: base.prompt, createdAt: now.toISOString() })
  assert.ok(ids.has('gen-physics-mpemba-effect'), 'accepted ids extend the set so one reply cannot repeat itself')

  assert.equal(normalizeGeneratedSeed({ ...base }, 'zh-CN', now, ids, titles), null, 'same slug again → dropped')
  assert.equal(normalizeGeneratedSeed({ ...base, slug: 'bio-thermal-inversion', title: '热水为什么比冷水先结冰?' }, 'zh-CN', now, ids, titles), null, 'same title modulo punctuation → dropped')
  assert.equal(normalizeGeneratedSeed({ ...base, slug: 'math-birthday-paradox' }, 'zh-CN', now, ids, titles), null, 'collides with a built-in id')
  assert.equal(normalizeGeneratedSeed({ ...base, slug: 'econ-x', discipline: 'astrology' }, 'zh-CN', now, ids, titles), null, 'unknown discipline')
  assert.equal(normalizeGeneratedSeed({ ...base, slug: 'ab' }, 'zh-CN', now, ids, titles), null, 'slug too short')
  assert.equal(normalizeGeneratedSeed({ ...base, slug: 'econ-no-prompt', title: 'x', prompt: '' }, 'zh-CN', now, ids, titles), null, 'prompt required')
})

test('the draw covers generated seeds of the current locale and a generated card carries literal text', () => {
  const generated = [
    { id: 'gen-physics-a', discipline: 'physics', copy: { locale: 'zh-CN', title: 'zh', description: '', prompt: 'p', createdAt: '2026-09-01T00:00:00.000Z' } },
    { id: 'gen-physics-b', discipline: 'physics', copy: { locale: 'en-US', title: 'en', description: '', prompt: 'p', createdAt: '2026-09-01T00:00:00.000Z' } }
  ]
  const pool = buildKnowledgePool(generated, 'zh-CN')
  assert.equal(pool.length, KNOWLEDGE_SEEDS.length + 1, 'only seeds written for the active locale join the pool')

  // Everything built-in shown recently → the only fresh candidate is the generated one.
  const history = KNOWLEDGE_SEEDS.map(seed => ({ seedId: seed.id, date: '2026-09-15' }))
  const drawn = drawKnowledgeSeed('2026-09-19', 'salt', history, 0, pool)
  assert.equal(drawn.id, 'gen-physics-a')
})

test('automatic top-up runs once a provider exists, dedupes against the pool, and is gated to once a day', async t => {
  const replies = []
  const { service, store, calls } = createService(t, {
    reply: (call, content) => {
      replies.push(content)
      return isReplenishPrompt(content) ? seedReply() : '[]'
    },
    allowReplenish: true
  })
  service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 1, 'the only model call at startup is the pool top-up')
  assert.ok(isReplenishPrompt(calls[0].messages[0].content))
  assert.match(calls[0].messages[0].content, /- math-birthday-paradox/, 'built-in ids are listed as already covered')
  assert.match(calls[0].messages[0].content, /locale tag "zh-CN"/)

  const generated = store.getGeneratedSeeds()
  assert.equal(generated.length, KNOWLEDGE_REPLENISH_BATCH)
  assert.ok(generated.every(seed => seed.id.startsWith('gen-') && seed.copy.locale === 'zh-CN'))
  const pool = service.getSnapshot().knowledgePool
  assert.equal(pool.builtin, KNOWLEDGE_SEEDS.length)
  assert.equal(pool.generated, KNOWLEDGE_REPLENISH_BATCH)
  assert.equal(pool.unseen, KNOWLEDGE_SEEDS.length + KNOWLEDGE_REPLENISH_BATCH - 1, 'today\'s pinned seed is the only one seen')
  assert.ok(pool.lastReplenishAt)
  assert.equal(pool.lastReplenishError, null)

  // Same day: nothing else triggers another top-up, not even a manual generation.
  store.savePreferences(normalizeDailySuggestionPreferences({ ...DEFAULT_DAILY_SUGGESTION_PREFERENCES, enabled: true, types: ['new-idea'] }))
  await service.generateNow()
  assert.equal(calls.filter(call => isReplenishPrompt(call.messages[0].content)).length, 1, 'once a day')

  // The next call lists the generated ids too and the same reply yields nothing new.
  store.setKnowledgeReplenish({ lastAttemptDate: '' , lastSuccessAt: '2026-09-01T00:00:00.000Z' })
  await assert.rejects(() => service.replenishKnowledgePoolNow(), /MODEL_OUTPUT_EMPTY/)
  const second = calls.filter(call => isReplenishPrompt(call.messages[0].content))[1]
  assert.match(second.messages[0].content, /- gen-math-topic-a-0: 为什么 math a 0？/, 'generated seeds are listed with their title for the same locale')
  assert.equal(store.getGeneratedSeeds().length, KNOWLEDGE_REPLENISH_BATCH, 'duplicates are not appended')
  assert.match(service.getSnapshot().knowledgePool.lastReplenishError, /MODEL_OUTPUT_EMPTY/)
})

test('top-up stays quiet without a provider or with both pools off, and skips when the pool is fresh and full', async t => {
  const noProvider = createService(t, { reply: seedReply(), providerConfig: null, allowReplenish: true })
  noProvider.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(noProvider.calls.length, 0, 'no provider → the built-in pool alone')
  assert.equal(noProvider.service.getSnapshot().knowledgePool.generated, 0)
  await assert.rejects(() => noProvider.service.replenishKnowledgePoolNow(), /PROVIDER_MISSING/)

  // Random off but a model-backed source on: the card pool is the one topped up.
  const randomOff = createService(t, {
    reply: (_call, content) => (isCardPrompt(content) ? cardReply('work-domain') : seedReply()),
    allowReplenish: true,
    preferences: { knowledge: { enabled: true, sources: ['work-domain'], interests: [], profession: '', countPerSource: 1 } }
  })
  randomOff.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const seedCalls = () => randomOff.calls.filter(call => isReplenishPrompt(call.messages[0].content))
  assert.equal(seedCalls().length, 0, 'random source off → no seed top-up')
  assert.equal(randomOff.store.getKnowledgeCards().length, KNOWLEDGE_CARD_REPLENISH_BATCH, 'empty card pool → one batch generated at startup')

  // Turning the random source on afterwards: today's slot was used by the card
  // batch, so the seed top-up waits for tomorrow (or a manual run).
  randomOff.service.savePreferences({ ...DEFAULT_DAILY_SUGGESTION_PREFERENCES, knowledge: { enabled: true, sources: ['random', 'work-domain'], interests: [], profession: '', countPerSource: 1 } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(seedCalls().length, 0, 'one replenish slot per day across pools')
  // Clearing the day's attempt (tomorrow, or a manual run) lets the seeds top up.
  randomOff.store.setKnowledgeReplenish({ lastAttemptDate: '', lastError: '', lastSuccessAt: '' })
  await randomOff.service.maybeReplenishKnowledgePool()
  assert.equal(seedCalls().length, 1, 'due again once the day gate clears')
  assert.ok(randomOff.store.getGeneratedSeeds().length > 0)

  // A recent successful top-up with plenty of unseen seeds → nothing to do.
  const fresh = createService(t, { reply: seedReply(), allowReplenish: true })
  fresh.store.setKnowledgeReplenish({ lastSuccessAt: '2026-09-17T09:00:00.000Z' })
  fresh.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fresh.calls.length, 0, 'topped up two days ago and 35 unseen seeds → skip')

  // Older than a week → due again even though the pool is not low.
  const stale = createService(t, { reply: seedReply(), allowReplenish: true })
  stale.store.setKnowledgeReplenish({ lastSuccessAt: '2026-09-10T09:00:00.000Z' })
  stale.service.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(stale.calls.length, 1, 'weekly refresh')
})

test('a generated seed survives as today\'s card across locale switches and pool eviction keeps it', async t => {
  let locale = 'zh-CN'
  const { service, store } = createService(t, { reply: seedReply(), allowReplenish: true, locale })
  // Redirect the service's locale through a mutable binding.
  service.options.getLocale = () => locale
  await service.replenishKnowledgePoolNow()

  // Everything built-in was shown recently, so today's draw must be a generated seed.
  for (const seed of KNOWLEDGE_SEEDS) store.setKnowledgeToday('2026-09-01', seed.id, false)
  const today = service.getSnapshot()
  const card = today.knowledge[0]
  assert.match(card.knowledge.seedId, /^gen-/)
  assert.equal(card.source, 'llm', 'generated seeds carry literal text')
  assert.match(card.title, /^为什么/)
  assert.ok(KNOWLEDGE_DISCIPLINES.includes(card.knowledge.discipline))
  assert.match(card.id, /^knowledge:2026-09-19:gen-/)

  // Dismiss / pick resolve the card through the generated pool.
  service.recordPick(card.id)
  service.dismiss(card.id)
  assert.equal(store.getKnowledgeDismissStreaks().random, 1)

  // Switching locale mid-day keeps the pinned card; the pool for the draw shrinks to built-in only.
  locale = 'en-US'
  const switched = service.getSnapshot()
  assert.equal(switched.knowledgePool.generated, 0, 'en-US has no generated seeds')
  assert.equal(store.getKnowledgeToday('2026-09-19').seedId, card.knowledge.seedId, 'pinned seed is kept for the day')

  // Overflowing the cap evicts the oldest seeds but never today's pinned one.
  locale = 'zh-CN'
  const filler = Array.from({ length: MAX_GENERATED_SEEDS }, (_, index) => ({
    id: `gen-filler-${index}`,
    discipline: 'math',
    copy: { locale: 'zh-CN', title: `filler ${index}`, description: '', prompt: 'p', createdAt: '2026-09-02T00:00:00.000Z' }
  }))
  store.appendGeneratedSeeds(filler, [card.knowledge.seedId])
  const remaining = store.getGeneratedSeeds()
  assert.equal(remaining.length, MAX_GENERATED_SEEDS)
  assert.ok(remaining.some(seed => seed.id === card.knowledge.seedId), 'today\'s seed survives eviction')
  const survivingOriginals = remaining.filter(seed => seed.id.startsWith('gen-') && !seed.id.startsWith('gen-filler-'))
  assert.deepEqual(survivingOriginals.map(seed => seed.id), [card.knowledge.seedId], 'older unpinned seeds are evicted first')
})

test('the store drops malformed generated seeds and keeps the newest within the cap', t => {
  const store = new DailySuggestionStore(tempDir(t))
  const good = { id: 'gen-ok', discipline: 'design', copy: { locale: 'zh-CN', title: 't', description: 'd', prompt: 'p', createdAt: '2026-09-19T00:00:00.000Z' } }
  assert.equal(store.appendGeneratedSeeds([good, good]), 1, 'duplicates within one call collapse')
  assert.equal(store.appendGeneratedSeeds([good]), 0)

  const filePath = path.join(store.filePath ? path.dirname(store.filePath) : tempDir(t), 'daily-suggestions.json')
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  raw.knowledgeGeneratedSeeds.push(
    { id: 'no-prefix', discipline: 'design', copy: good.copy },
    { id: 'gen-bad-discipline', discipline: 'astrology', copy: good.copy },
    { id: 'gen-no-copy', discipline: 'design' },
    { id: 'gen-Colon:Id', discipline: 'design', copy: good.copy },
    { id: 'gen-fine', discipline: 'design', copy: { ...good.copy, description: undefined } }
  )
  fs.writeFileSync(filePath, JSON.stringify(raw))
  const reloaded = new DailySuggestionStore(path.dirname(filePath))
  assert.deepEqual(reloaded.getGeneratedSeeds().map(seed => seed.id), ['gen-ok', 'gen-fine'])
  assert.equal(reloaded.getGeneratedSeeds()[1].copy.description, '')
})

test('the card pool persists, dedupes by source+locale+title, and shown cards leave the unseen count', t => {
  const store = new DailySuggestionStore(tempDir(t))
  const card = (id, title) => ({
    id,
    source: 'cross-discipline',
    discipline: '历史',
    copy: { locale: 'zh-CN', title, description: 'd', prompt: 'p', createdAt: '2026-09-19T00:00:00.000Z' }
  })
  assert.equal(store.appendKnowledgeCards([card('kc-a', '为什么A成立？'), card('kc-a', '重复id'), card('kc-b', '为什么A成立？')]), 1, 'same id and same title dedupe')
  assert.equal(store.appendKnowledgeCards([card('kc-c', '为什么B成立？')]), 1)
  assert.equal(store.getKnowledgeCards().length, 2)

  const filePath = path.dirname(store.filePath)
  const reloaded = new DailySuggestionStore(filePath)
  assert.deepEqual(reloaded.getKnowledgeCards().map(entry => entry.id), ['kc-a', 'kc-c'])
  assert.equal(reloaded.getKnowledgeCardCursor(), 0)
  assert.equal(reloaded.bumpKnowledgeCardCursor(), 1)

  const history = [{ seedId: 'kc-a', date: '2026-09-18' }]
  const pool = buildKnowledgePool(reloaded.getGeneratedSeeds(), 'zh-CN')
  assert.equal(countUnseenKnowledgeCards(reloaded.getKnowledgeCards(), '2026-09-19', history), 1, 'kc-a shown yesterday → only kc-c unseen')
  assert.ok(pool.length >= KNOWLEDGE_SEEDS.length)
})
