// Published generator for tough-eval-ledger.json. Not standalone in this repo.
// Run from the Automaton checkout:
//   bun scripts/replay-tough-eval.ts
// Uses a temp sqlite path. Does not read ~/.automaton/staff.sqlite.

import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyThreads, jobKindForKit, resetIdsForTests, staffWithSisters } from '../src/domain'
import { ensureMouth, resetMouthForTests, type ChatFn } from '../src/runtime/mouth'
import { openStaffStore, type LedgerMetrics, type RememberInput } from '../src/runtime/store'
import { claimTaskKey } from '../src/runtime/working-set'
import { completeMouth, pendingMouthTurns, send, type Session } from '../src/session'

const PRODUCT_ROOT = join(import.meta.dir, '..')
export const TOUGH_EVAL_SEED = 20260827
export const MISS_COST_USD = 0.001
const MOCK_KEYS = [{ key: 'sk-or-test', source: 'automaton' as const }]

export const WORKLOAD_DESCRIPTION =
  'Seeded mixed recall workload against Automaton ensureMouth + StaffStore + queryFirst. Several hundred turns: paraphrases of stored findings, follow-ups, changed requirements, evolved repositories, stale findings, conflicting claims, and unrelated questions. Measures current gates (RECALL_REQUEST, uniqueSpeakable, skip stale, taskKey, owner) without retuning queryFirst. Temp sqlite only; never ~/.automaton/staff.sqlite. This is not the 19/20 repeated-work replay and does not validate 95%.'

export const INTERPRETATION =
  'This mix will NOT be 95%. 95% was the easy repeated-domain recall; this scores safety of reuse. False hits are more important than avoidance. 40% avoidance with ~0 false hits is better than 90% that sometimes serves the wrong commit. A conservative miss is not a false hit. queryFirst was not retuned to inflate avoidance.'

type OwnerId = 'kernel' | 'research'
type GoldReason =
  | 'paraphrase'
  | 'followup'
  | 'changed-req'
  | 'evolved-repo'
  | 'stale'
  | 'conflict'
  | 'unrelated'

export type GoldTurn = {
  expect: 'hit' | 'miss'
  claimId?: string
  reason: GoldReason
  currentRevision?: string
  currentRepo?: string
  owner?: OwnerId
}

type Finding = {
  key: string
  owner: OwnerId
  topic: string
  text: string
  repo: string
  revision: string
  jobId: string
  freshness: 'fresh' | 'stale'
  artifactKind: 'analyze'
}

/** Staff chat. Naming Research/wiki/search books an analyze job via looksLikeExplicitLookup. */
function who(owner: OwnerId): string {
  return owner === 'kernel' ? 'Kernel' : 'you'
}

function asRemember(finding: Finding): RememberInput {
  return {
    ownerAgentId: finding.owner,
    text: finding.text,
    source: 'job',
    jobId: finding.jobId,
    taskKey: claimTaskKey({ ownerAgentId: finding.owner, kind: 'analyze', goal: finding.topic }),
    repo: finding.repo,
    revision: finding.revision,
    artifactKind: finding.artifactKind,
    freshness: finding.freshness,
  }
}

/** Findings whose topic tokens appear in the spoken line, so paraphrases can hit. */
const HIT_FINDINGS: Finding[] = [
  { key: 'ledger-replay', owner: 'kernel', topic: 'ledger replay', text: 'The ledger replay is deterministic.', repo: 'dugout', revision: 'a11a11a', jobId: 'job_ledger', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'parser-timeout', owner: 'kernel', topic: 'parser timeout', text: 'The parser timeout is thirty milliseconds.', repo: 'marionette', revision: 'b22b22b', jobId: 'job_parser', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'cite-catalog', owner: 'research', topic: 'cite catalog', text: 'The cite catalog is complete.', repo: 'handbook', revision: 'c33c33c', jobId: 'job_cite', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'auth-cookie', owner: 'kernel', topic: 'auth cookie', text: 'The auth cookie is httponly.', repo: 'puppetmaster', revision: 'd44d44d', jobId: 'job_auth', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'rfc-draft', owner: 'research', topic: 'rfc draft', text: 'The rfc draft needs one more example.', repo: 'handbook', revision: 'e55e55e', jobId: 'job_rfc', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'queue-drain', owner: 'kernel', topic: 'queue drain', text: 'The queue drain is single threaded.', repo: 'dugout', revision: 'f66f66f', jobId: 'job_queue', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'blob-clock', owner: 'kernel', topic: 'blob clock', text: 'The blob clock uses monotonic ticks.', repo: 'marionette', revision: '111aaaa', jobId: 'job_blob', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'rank-order', owner: 'research', topic: 'rank order', text: 'The rank order prefers recency.', repo: 'handbook', revision: '222bbbb', jobId: 'job_rank', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'lease-expiry', owner: 'kernel', topic: 'lease expiry', text: 'The lease expiry is five minutes.', repo: 'puppetmaster', revision: '333cccc', jobId: 'job_lease', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'source-map', owner: 'research', topic: 'source map', text: 'The source map omits generated columns.', repo: 'handbook', revision: '444dddd', jobId: 'job_source', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'bloom-filter', owner: 'kernel', topic: 'bloom filter', text: 'The bloom filter is enabled.', repo: 'dugout', revision: '555eeee', jobId: 'job_bloom', freshness: 'fresh', artifactKind: 'analyze' },
  { key: 'style-guide', owner: 'research', topic: 'style guide', text: 'The style guide bans trailing commas.', repo: 'handbook', revision: '666ffff', jobId: 'job_style', freshness: 'fresh', artifactKind: 'analyze' },
]

/** Old + new revision share a taskKey so uniqueSpeakable / keyed lookup refuse to pick the old commit. */
const EVOLVED_PAIRS: { old: Finding; next: Finding }[] = [
  {
    old: { key: 'widget-paint-old', owner: 'kernel', topic: 'widget paint', text: 'The widget paint is gpu bound.', repo: 'dugout', revision: 'c0ffee1', jobId: 'job_paint_old', freshness: 'fresh', artifactKind: 'analyze' },
    next: { key: 'widget-paint-new', owner: 'kernel', topic: 'widget paint', text: 'The widget paint is cpu bound.', repo: 'dugout', revision: 'c0ffee2', jobId: 'job_paint_new', freshness: 'fresh', artifactKind: 'analyze' },
  },
  {
    old: { key: 'socket-backlog-old', owner: 'kernel', topic: 'socket backlog', text: 'The socket backlog is 128.', repo: 'marionette', revision: 'deadbe1', jobId: 'job_sock_old', freshness: 'fresh', artifactKind: 'analyze' },
    next: { key: 'socket-backlog-new', owner: 'kernel', topic: 'socket backlog', text: 'The socket backlog is 512.', repo: 'marionette', revision: 'deadbe2', jobId: 'job_sock_new', freshness: 'fresh', artifactKind: 'analyze' },
  },
  {
    old: { key: 'quota-window-old', owner: 'research', topic: 'quota window', text: 'The quota window is one hour.', repo: 'handbook', revision: 'badc0d1', jobId: 'job_quota_old', freshness: 'fresh', artifactKind: 'analyze' },
    next: { key: 'quota-window-new', owner: 'research', topic: 'quota window', text: 'The quota window is fifteen minutes.', repo: 'handbook', revision: 'badc0d2', jobId: 'job_quota_new', freshness: 'fresh', artifactKind: 'analyze' },
  },
]

const STALE_FINDINGS: Finding[] = [
  { key: 'cron-window', owner: 'kernel', topic: 'cron window', text: 'The cron window is nightly.', repo: 'dugout', revision: 'aaaa111', jobId: 'job_cron', freshness: 'stale', artifactKind: 'analyze' },
  { key: 'index-freeze', owner: 'kernel', topic: 'index freeze', text: 'The index freeze is offline.', repo: 'marionette', revision: 'bbbb222', jobId: 'job_index', freshness: 'stale', artifactKind: 'analyze' },
  { key: 'feed-cursor', owner: 'research', topic: 'feed cursor', text: 'The feed cursor is inclusive.', repo: 'handbook', revision: 'cccc333', jobId: 'job_feed', freshness: 'stale', artifactKind: 'analyze' },
]

const CONFLICT_PAIRS: { left: Finding; right: Finding }[] = [
  {
    left: { key: 'cache-lru', owner: 'kernel', topic: 'cache eviction', text: 'The cache eviction is LRU.', repo: 'dugout', revision: 'd0d0d01', jobId: 'job_cache_lru', freshness: 'fresh', artifactKind: 'analyze' },
    right: { key: 'cache-lfu', owner: 'kernel', topic: 'cache eviction', text: 'The cache eviction is LFU.', repo: 'dugout', revision: 'd0d0d02', jobId: 'job_cache_lfu', freshness: 'fresh', artifactKind: 'analyze' },
  },
  {
    left: { key: 'mutex-address', owner: 'kernel', topic: 'mutex order', text: 'The mutex order is address based.', repo: 'marionette', revision: 'e0e0e01', jobId: 'job_mutex_a', freshness: 'fresh', artifactKind: 'analyze' },
    right: { key: 'mutex-ranked', owner: 'kernel', topic: 'mutex order', text: 'The mutex order is lock ranked.', repo: 'marionette', revision: 'e0e0e02', jobId: 'job_mutex_b', freshness: 'fresh', artifactKind: 'analyze' },
  },
  {
    left: { key: 'hint-btree', owner: 'research', topic: 'index hint', text: 'The index hint is btree.', repo: 'handbook', revision: 'f0f0f01', jobId: 'job_hint_btree', freshness: 'fresh', artifactKind: 'analyze' },
    right: { key: 'hint-hash', owner: 'research', topic: 'index hint', text: 'The index hint is hash.', repo: 'handbook', revision: 'f0f0f02', jobId: 'job_hint_hash', freshness: 'fresh', artifactKind: 'analyze' },
  },
]

const NONCE_REQ = [
  'retries',
  'pagination',
  'backoff',
  'checksums',
  'timezone',
  'protobuf',
  'wasm',
  'telemetry',
  'sharding',
  'failover',
  'compaction',
  'hydration',
]

const UNRELATED = [
  'Hello, what is your name?',
  'What is the weather in Chicago?',
  'How do I cook pasta?',
  'Tell me a joke.',
  'Good morning.',
  'What time is it?',
  'Can you help me pack a suitcase?',
  'Who won the World Series in 2016?',
  'How are you today?',
  'What is two plus two?',
  'Please summarize the news.',
  'Where should we eat lunch?',
  'Is it going to rain tomorrow?',
  'How long does sourdough take?',
  'What is the capital of Portugal?',
  'Can you recommend a book?',
  'How do I tune a guitar?',
  'What is the airspeed of a swallow?',
  'Good night.',
  'Thanks for your time.',
  'Do you like coffee or tea?',
  'How do I get to the airport?',
  'What movie should I watch?',
  'Is the office open on Sunday?',
  'Can you count to twenty?',
  'What color is the sky at noon?',
  'How many days are in June?',
  'Where is the nearest library?',
  'Do cats eat grass?',
  'What is a good stretching routine?',
  'Can you set a timer for pizza?',
  'How do I fold a fitted sheet?',
  'What is the smallest prime?',
  'Is water wet?',
  'How do I parallel park?',
  'What should I pack for camping?',
  'Can you name a river in Egypt?',
  'How cold is too cold for lettuce?',
  'What is the opposite of east?',
  'Do you have a favorite number?',
  'How do I sharpen a pencil?',
  'What is a haiku?',
]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

function pick<T>(items: readonly T[], i: number): T {
  return items[i % items.length]!
}

const PARAPHRASE = [
  (f: Finding) => `what did ${who(f.owner)} find about ${f.topic}`,
  (f: Finding) => `what was ${who(f.owner)} finding about ${f.topic}`,
  (f: Finding) => `remember ${who(f.owner)} finding about ${f.topic}`,
  (f: Finding) => `what did ${who(f.owner)} find for ${f.topic}`,
  (f: Finding) => `${who(f.owner)} last result about ${f.topic}`,
  (f: Finding) => `remember the ${who(f.owner)} finding for ${f.topic}`,
  (f: Finding) => `what did ${who(f.owner)} find from ${f.topic}`,
  (f: Finding) => `what was ${who(f.owner)} last job about ${f.topic}`,
  (f: Finding) => `what did ${who(f.owner)} find about the ${f.topic}`,
  (f: Finding) => `remember the ${who(f.owner)} finding about the ${f.topic}`,
]

const FOLLOWUP = [
  (f: Finding) => `why is ${f.text.slice(0, -1)}?`,
  (f: Finding) => `how should we change ${f.topic}?`,
  (f: Finding) => `does ${f.topic} still work on main?`,
  (f: Finding) => `explain ${f.topic} in more detail`,
  (f: Finding) => `should we publish ${f.topic} today`,
  (f: Finding) => `what happens if ${f.topic} fails`,
]

export type PlannedTurn = {
  query: string
  gold: GoldTurn
}

export function allSeedClaims(): RememberInput[] {
  const evolved = EVOLVED_PAIRS.flatMap((pair) => [pair.old, pair.next])
  const conflict = CONFLICT_PAIRS.flatMap((pair) => [pair.left, pair.right])
  return [...HIT_FINDINGS, ...evolved, ...STALE_FINDINGS, ...conflict].map(asRemember)
}

export function planToughTurns(seed = TOUGH_EVAL_SEED): PlannedTurn[] {
  const rng = mulberry32(seed)
  const planned: PlannedTurn[] = []
  const hit = (query: string, gold: GoldTurn): void => {
    planned.push({ query, gold })
  }

  for (let i = 0; i < 90; i += 1) {
    const finding = pick(HIT_FINDINGS, i)
    hit(pick(PARAPHRASE, Math.floor(i / HIT_FINDINGS.length) + i)(finding), {
      expect: 'hit',
      claimId: finding.key,
      reason: 'paraphrase',
      owner: finding.owner,
      currentRevision: finding.revision,
      currentRepo: finding.repo,
    })
  }
  for (let i = 0; i < 45; i += 1) {
    const finding = pick(HIT_FINDINGS, i + 3)
    hit(pick(FOLLOWUP, i)(finding), { expect: 'miss', reason: 'followup', owner: finding.owner })
  }
  for (let i = 0; i < 45; i += 1) {
    const finding = pick(HIT_FINDINGS, i + 7)
    const nonce = pick(NONCE_REQ, i)
    hit(`what did ${who(finding.owner)} find about ${finding.topic} ${nonce}`, {
      expect: 'miss',
      reason: 'changed-req',
      owner: finding.owner,
    })
  }
  for (let i = 0; i < 36; i += 1) {
    const pair = pick(EVOLVED_PAIRS, i)
    if (i % 2 === 0) {
      hit(`what did ${who(pair.old.owner)} find about ${pair.old.topic}`, {
        expect: 'miss',
        reason: 'evolved-repo',
        owner: pair.old.owner,
        currentRevision: pair.next.revision,
        currentRepo: pair.next.repo,
      })
    } else {
      hit(`what did ${who(pair.old.owner)} find about ${pair.old.topic} at ${pair.next.revision}`, {
        expect: 'miss',
        reason: 'evolved-repo',
        owner: pair.old.owner,
        currentRevision: pair.next.revision,
        currentRepo: pair.next.repo,
      })
    }
  }
  for (let i = 0; i < 36; i += 1) {
    const finding = pick(STALE_FINDINGS, i)
    hit(`what did ${who(finding.owner)} find about ${finding.topic}`, {
      expect: 'miss',
      reason: 'stale',
      owner: finding.owner,
      claimId: finding.key,
    })
  }
  for (let i = 0; i < 36; i += 1) {
    const pair = pick(CONFLICT_PAIRS, i)
    hit(`what did ${who(pair.left.owner)} find about ${pair.left.topic}`, {
      expect: 'miss',
      reason: 'conflict',
      owner: pair.left.owner,
    })
  }
  for (let i = 0; i < 42; i += 1) {
    hit(pick(UNRELATED, i), { expect: 'miss', reason: 'unrelated' })
  }

  if (planned.length < 300) {
    throw new Error(`planned ${planned.length} turns, need at least 300`)
  }
  const mixed = shuffle(planned, rng).map((row, i) => ({
    ...row,
    query: i % 17 === 0 ? `${row.query}.` : row.query,
  }))
  for (const row of mixed) {
    const kind = jobKindForKit('coordinator', row.query)
    if (kind) {
      throw new Error(`query books ${kind}, not staff chat: ${JSON.stringify(row.query)}`)
    }
  }
  return mixed
}

export type ToughEvalTurnRow = {
  n: number
  query: string
  outcome: 'hit' | 'miss'
  inferenceAvoided: boolean
  inferenceAttempted: boolean
  chatCalls: number
  costUsd: number
  spoken: string
  servedClaimId?: string
  servedRevision?: string
  servedRepo?: string
  servedFreshness?: string
  falseHit: boolean
  staleHit: boolean
  gold: GoldTurn
}

export type ToughEvalSummary = {
  turns: number
  avoidance: number
  falseHitRate: number
  staleHitRate: number
  inferenceCalls: number
  inferenceAvoided: number
  costUsd: number
  hits: number
  misses: number
  falseHits: number
  staleHits: number
  notes: string
}

export type ToughEvalLedger = {
  workload: {
    description: string
    seed: number
    turns: number
    interpretation: string
    liveMixedLedger: { hits: number; turns: number; note: string }
    repeatedWorkReplay: { hits: number; turns: number; note: string }
    seededClaims: RememberInput[]
    gates: string[]
  }
  turns: ToughEvalTurnRow[]
  summary: ToughEvalSummary
  store: { path: string; liveHomeStore: false }
  gitSha: string
  capturedAt: string
  ledger: LedgerMetrics
}

export const DEFAULT_LEDGER_PATH = join(PRODUCT_ROOT, 'artifacts', 'tough-eval-ledger.json')

function gitSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: PRODUCT_ROOT,
    encoding: 'utf8',
  }).trim()
}

function emptySession(): Session {
  const agents = staffWithSisters()
  return {
    agents,
    activeAgentId: 'staff',
    threads: emptyThreads(agents),
    jobs: [],
    pendingFanout: null,
  }
}

function logicalKeyForText(text: string): string | undefined {
  const all = [
    ...HIT_FINDINGS,
    ...EVOLVED_PAIRS.flatMap((pair) => [pair.old, pair.next]),
    ...STALE_FINDINGS,
    ...CONFLICT_PAIRS.flatMap((pair) => [pair.left, pair.right]),
  ]
  return all.find((row) => row.text === text)?.key
}

function scoreTurn(input: {
  gold: GoldTurn
  outcome: 'hit' | 'miss'
  spoken: string
  claims: { id: string; text: string; ownerAgentId: string; repo?: string; revision?: string; freshness: string }[]
}): {
  falseHit: boolean
  staleHit: boolean
  servedClaimId?: string
  servedRevision?: string
  servedRepo?: string
  servedFreshness?: string
} {
  if (input.outcome !== 'hit') {
    return { falseHit: false, staleHit: false }
  }
  const served = input.claims.find((row) => row.text === input.spoken)
  const servedKey = logicalKeyForText(input.spoken)
  const staleHit =
    served?.freshness === 'stale' ||
    Boolean(input.gold.currentRevision && served?.revision && served.revision !== input.gold.currentRevision)
  let falseHit = false
  if (!served) falseHit = true
  else if (input.gold.expect === 'miss') falseHit = true
  else if (input.gold.claimId && servedKey && servedKey !== input.gold.claimId) falseHit = true
  else if (input.gold.owner && served.ownerAgentId !== input.gold.owner) falseHit = true
  else if (input.gold.currentRepo && served.repo && served.repo !== input.gold.currentRepo) falseHit = true
  else if (input.gold.currentRevision && served.revision && served.revision !== input.gold.currentRevision) {
    falseHit = true
  }
  return {
    falseHit,
    staleHit,
    servedClaimId: served?.id,
    servedRevision: served?.revision,
    servedRepo: served?.repo,
    servedFreshness: served?.freshness,
  }
}

async function playTurn(input: {
  session: Session
  store: ReturnType<typeof openStaffStore>
  query: string
  chat: ChatFn
  chatCalls: { n: number }
}): Promise<{ session: Session; outcome: 'hit' | 'miss'; spoken: string; chatCalls: number; costUsd: number; inferenceAvoided: boolean; inferenceAttempted: boolean }> {
  const before = input.chatCalls.n
  let session = send(input.session, input.query)
  const turn = pendingMouthTurns(session)[0]
  if (!turn) {
    throw new Error(`no pending mouth turn for ${JSON.stringify(input.query)}`)
  }
  if (turn.agentId !== 'staff' || turn.mode !== 'chat') {
    throw new Error(`expected staff chat turn, got ${turn.agentId}/${turn.mode} for ${JSON.stringify(input.query)}`)
  }
  let spoken = ''
  await ensureMouth(
    session,
    input.store,
    {
      onComplete: (_agentId, text) => {
        spoken = text
      },
      onFail: (_agentId, text) => {
        spoken = text
      },
    },
    input.chat,
    MOCK_KEYS,
  )
  const receipt = input.store.receipt(turn.itemId)
  if (!receipt) throw new Error(`missing receipt for ${turn.itemId}`)
  session = completeMouth(session, turn.agentId, spoken || 'Done.')
  return {
    session,
    outcome: receipt.outcome,
    spoken,
    chatCalls: input.chatCalls.n - before,
    costUsd: receipt.costUsd ?? 0,
    inferenceAvoided: receipt.inferenceAvoided,
    inferenceAttempted: receipt.inferenceAttempted,
  }
}

export async function runToughEval(input?: {
  storePath?: string
  dest?: string | null
  seed?: number
}): Promise<ToughEvalLedger> {
  resetIdsForTests()
  resetMouthForTests()
  const storePath = input?.storePath ?? join(tmpdir(), `automaton-tough-eval-${Date.now()}.sqlite`)
  if (storePath.includes('.automaton/staff.sqlite')) {
    throw new Error('refusing to touch ~/.automaton/staff.sqlite')
  }
  const store = openStaffStore(storePath)
  for (const claim of allSeedClaims()) store.remember(claim)
  const claims = store.listClaims()
  const chatCalls = { n: 0 }
  const chat: ChatFn = async () => {
    chatCalls.n += 1
    return {
      text: 'Staff. Paid miss.',
      usage: { promptTokens: 11, completionTokens: 4, costUsd: MISS_COST_USD },
    }
  }

  let session = emptySession()
  const planned = planToughTurns(input?.seed ?? TOUGH_EVAL_SEED)
  const turns: ToughEvalTurnRow[] = []
  for (const [i, row] of planned.entries()) {
    const played = await playTurn({
      session,
      store,
      query: row.query,
      chat,
      chatCalls,
    })
    session = played.session
    const scored = scoreTurn({
      gold: row.gold,
      outcome: played.outcome,
      spoken: played.spoken,
      claims,
    })
    turns.push({
      n: i + 1,
      query: row.query,
      outcome: played.outcome,
      inferenceAvoided: played.inferenceAvoided,
      inferenceAttempted: played.inferenceAttempted,
      chatCalls: played.chatCalls,
      costUsd: played.costUsd,
      spoken: played.spoken,
      ...scored,
      gold: row.gold,
    })
  }

  const ledger = store.metrics()
  const falseHits = turns.filter((row) => row.falseHit).length
  const staleHits = turns.filter((row) => row.staleHit).length
  const costUsd = turns.reduce((sum, row) => sum + row.costUsd, 0)
  const summary: ToughEvalSummary = {
    turns: turns.length,
    avoidance: turns.length === 0 ? 0 : ledger.inferenceAvoided / turns.length,
    falseHitRate: turns.length === 0 ? 0 : falseHits / turns.length,
    staleHitRate: turns.length === 0 ? 0 : staleHits / turns.length,
    inferenceCalls: ledger.inferenceCalls,
    inferenceAvoided: ledger.inferenceAvoided,
    costUsd,
    hits: ledger.hits,
    misses: ledger.misses,
    falseHits,
    staleHits,
    notes: INTERPRETATION,
  }

  const report: ToughEvalLedger = {
    workload: {
      description: WORKLOAD_DESCRIPTION,
      seed: input?.seed ?? TOUGH_EVAL_SEED,
      turns: turns.length,
      interpretation: INTERPRETATION,
      liveMixedLedger: {
        hits: 1,
        turns: 51,
        note: "Cary Palmer live ~/.automaton/staff.sqlite mix is 1 hit / 51 turns. That mix is not this workload.",
      },
      repeatedWorkReplay: {
        hits: 19,
        turns: 20,
        note: 'The 19/20 (95%) figure is a separate easy repeated-domain recall. This eval does not validate 95%.',
      },
      seededClaims: allSeedClaims(),
      gates: ['RECALL_REQUEST', 'uniqueSpeakable', 'skip stale', 'taskKey', 'owner'],
    },
    turns,
    summary,
    store: { path: storePath, liveHomeStore: false },
    gitSha: gitSha(),
    capturedAt: new Date().toISOString(),
    ledger,
  }

  if (input?.dest !== null) {
    writeToughEvalLedger(report, input?.dest ?? DEFAULT_LEDGER_PATH)
  }
  return report
}

export function writeToughEvalLedger(report: ToughEvalLedger, dest = DEFAULT_LEDGER_PATH): void {
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`)
}

if (import.meta.main) {
  const report = await runToughEval()
  const { summary } = report
  console.log(
    `tough-eval turns=${summary.turns} avoidance=${summary.avoidance.toFixed(4)} falseHitRate=${summary.falseHitRate.toFixed(4)} staleHitRate=${summary.staleHitRate.toFixed(4)} inferenceCalls=${summary.inferenceCalls} inferenceAvoided=${summary.inferenceAvoided} costUsd=${summary.costUsd.toFixed(4)} sha=${report.gitSha}`,
  )
}
