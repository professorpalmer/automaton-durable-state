# Durable state for agents: query completed work before inference

Always-on agents keep paying for work that already finished. A first look
at a repo or bug should cost a full model call. Later turns on the same
domain usually should not.

Completed findings live in a local SQLite store (claims, artifacts,
receipts). Every turn queries that store first. A hit returns the stored
result with no model call. A miss builds a small bounded context, infers
once, then persists.

This repo is the architecture note plus a captured receipt ledger, not a
drop-in you can run. The 19/20 (95%) figure is a constructed repeated-work
replay, not a live mixed workload (that mix was 1 hit / 51 turns). Details
are in [Measured repeated-work replay](#measured-repeated-work-replay).

> Treat context as a cache, not as its database.

The expensive design is a permanent head seat that carries permanent role
runtimes, internal transcripts, and self-correction history. Each new turn
replays more context, and the system pays again for work that another worker
already completed.

The solution is to move memory and completed work out of the model context and
into durable state.

## The architecture

### 1. Roles are ephemeral; records are durable

Do not keep every agent alive as a transcript-carrying participant. A mouth
handles a turn, then the runtime can disappear. The durable backend keeps the
things that have future value:

- session snapshots and thread state
- claims: verified spoken lines and findings
- task results and artifact references
- agent ownership and job provenance
- per-turn usage receipts

In Automaton, this is a local SQLite store. A completed job becomes a
job-sourced claim instead of remaining only inside a worker transcript.
Inserting the same claim again is idempotent.

### 2. Query durable state before invoking a model

The request path is deliberately ordered:

```text
user turn
    |
    v
owner-scoped claim lookup
    |                         \
    | hit                      \ miss
    v                           v
return stored result       build bounded working set
write zero-call receipt    call the mouth once
                                |
                                v
                         persist result and receipt
```

On a relevant claim hit, the system returns the stored result without making
an OpenRouter request. The receipt records `outcome=hit` and
`inferenceAvoided=true`. This is a real zero-call cache hit, not a prompt that
asks a model to remember something.

Only a miss reaches inference. The miss prompt contains:

- the system instruction
- relevant claims retrieved from durable state
- the selected story, when the compaction layer has one
- a small recent-message tail

It does not carry the entire historical transcript. The shipped Automaton
mouth used a recent tail of eight messages.

### 3. Reuse work by identity, not by hope

The same rule applies to jobs. A previous artifact is reusable only when its
identity and freshness match the new request:

- repository and profile
- owning agent
- normalized task
- relevant inputs
- successful, live terminal status
- substantive artifact or finding

Automaton's current analyze-reuse gate enforces the owning agent, normalized
goal, live successful status, and substantive-artifact checks. Extending the
identity with repository, profile, input, and freshness fingerprints is the
next hardening step.

Puppetmaster remains the job runtime, not the ordinary-chat runtime. Job
handles are persisted so a relaunch attaches to an existing job instead of
spawning a duplicate. Analyze launches carry a local launch key for
idempotent recovery. Implement jobs always get fresh sandboxes and are never
reused as prior implementation work.

An attached job with an unavailable status is bounded and fails closed. It is
not watched forever and it is not reported as successful merely because the
worker disappeared.

### 4. Compact old conversation into a retrieval layer

Older conversation should not remain an ever-growing prompt source. The
retention layer uses the catalog-residual shape:

- extractive handles for older material
- a bounded, last-wins selected story
- a session-scoped SQLite FTS vault for lexical retrieval

This layer is derived context. It is not the authority. Claims and verified
job artifacts remain authoritative. FTS hits can help retrieve context but
cannot answer a query directly, and the full vault is never injected into
every prompt.

In the current Automaton checkpoint, the durable claims, bounded working set,
and reuse ledger are shipped; catalog-residual compaction is the next
retention boundary. The separation is intentional: compaction can change
prompt context without changing the truth of a completed job.

### 5. Measure the cache instead of assuming it works

Every turn writes a receipt with:

- hit or miss outcome
- model and terminal status
- nullable prompt tokens, completion tokens, and cost
- whether inference was avoided
- whether inference was attempted

The ledger counts avoided calls and attempted calls separately. Provider usage
that is missing remains unknown; it is not converted into fake zero cost.
This makes the claimed reduction testable:

```text
avoided calls / total turns
known token totals
known provider cost
unknown usage that still needs attribution
```

A missing API key is not an inference attempt. A failed provider call is an
attempt. Those cases must not be collapsed into one misleading number.

## The concrete implementation shape

The important boundaries in Automaton are:

- `StaffStore`: durable sessions, claims, receipts, and aggregate metrics
- `queryFirst`: authoritative claim lookup before inference
- `buildWorkingSet`: system prompt plus recalled claims plus bounded tail
- `ensureMouth`: hit handling, one bounded inference path, and receipts
- `ensureDispatched`: persisted attachment and safe analyze reuse
- `Puppetmaster` adapters: sandbox jobs, artifact references, and status

The product UI is not the cache. The chat transcript is not the artifact
store. Puppetmaster is not the mouth. Each layer has one job.

## Why this produces the reduction

The high-cost system pays for coordination every time:

```text
question -> permanent roles -> growing transcripts -> repeated inference
```

The durable system pays for novel work once:

```text
question -> durable lookup -> hit -> answer
                         \
                          miss -> small prompt -> work -> durable result
```

After one worker has completed a reusable result, the next matching request
is a query. It does not need another head-agent debate, another permanent role
runtime, or another full transcript.

The 95% figure is a measured session-level result on one repeated-work
replay, not a claim that every workload or every Grok Bot user sees 95%. The
receipt ledger is how to verify the number. See [Measured repeated-work replay](#measured-repeated-work-replay).

## Measured repeated-work replay

On this repeated-work replay, 19/20 turns avoided inference (95%).

This is one paid miss plus 19 zero-call recalls of a stored job finding. Turn 1
asks a novel question that is not a recall; `queryFirst` misses and one mocked
mouth call is the paid inference. Chat misses do not `remember()` themselves.
After that miss the replay seeds one job-sourced Kernel claim (`The ledger
replay is deterministic.`) as if a worker had finished. Turns 2–20 ask `what
did Kernel find about ledger replay` and hit with `inferenceAvoided=true` and
no further ChatFn calls.

This is not Cary Palmer's live mixed ledger. That mix was 1 hit / 51 turns, and
it is not this workload.

This 95% is a session-level hit rate on that constructed replay, not a discount
on a single new task. The first look at a repo, paper, or bug still pays a full
mouth call. Later turns that come back to that same finding query the store
and skip the model. One novel task is still one paid call (100% of that turn).
Do not read this as "per task 95% off" or as "Grok Bot users always save 95%."

The captured ledger is in this repo:
[`repeated-work-ledger.json`](./repeated-work-ledger.json).

The replay script is not. It lives in the Automaton tree:

```sh
bun scripts/replay-repeated-work.ts
```

That script uses a temp sqlite path. It does not read `~/.automaton/staff.sqlite`.

A harder mixed workload is in [Tough eval](#tough-eval). Do not read that mix as a 95% result.

## Tough eval

This mix will NOT be 95%. 95% was the easy repeated-domain recall; this
scores safety of reuse. False hits are more important than avoidance.

330 seeded turns against Automaton's real `ensureMouth` + `StaffStore` +
`queryFirst` (mocked ChatFn, temp sqlite, never `~/.automaton/staff.sqlite`).
The generator is not twenty identical recalls. It covers paraphrases of a
stored finding, follow-up questions, slightly changed requirements, evolving
repositories, deliberately stale findings, conflicting agent findings, and
unrelated questions.

It measures the current gates (`RECALL_REQUEST`, `uniqueSpeakable`, skip
stale, `taskKey`, owner). `queryFirst` was not retuned to inflate avoidance.
No false-hit bug showed up in this mix; the matcher was left alone. A
conservative miss is not a false hit.

| metric | value |
| --- | --- |
| turns | 330 |
| avoidance (`inferenceAvoided / turns`) | 83/330 = 25.15% |
| false-hit rate | 0 |
| stale-hit rate | 0 |
| `inferenceCalls` | 247 |
| `costUsd` (mocked $0.001 on a miss, $0 on a hit) | 0.247 |

83 of 90 gold paraphrases hit. The other 7 were conservative misses. Every
follow-up, changed-requirement, evolved-revision, stale, conflict, and
unrelated turn missed. UniqueSpeakable did not pick a side on two speakable
claims. An old revision did not serve when a newer revision of the same task
was also stored.

40% avoidance with ~0 false hits is better than 90% that sometimes serves the
wrong commit.

Files in this repo:

- [`tough-eval-ledger.json`](./tough-eval-ledger.json) — per-turn rows and summary
- [`tough-eval-spec.json`](./tough-eval-spec.json) — seed, claims, and gold labels
- [`replay-tough-eval.ts`](./replay-tough-eval.ts) — generator (run from Automaton)

```sh
bun scripts/replay-tough-eval.ts
```

That is a separate experiment from the 19/20 replay. It does not validate 95%.

## Prescription

> Treat context as a cache, not as the database. Make agent roles ephemeral.
> Persist sessions, claims, task results, artifacts, provenance, and usage
> receipts. Query verified durable state before inference. On a miss, provide
> only relevant claims, the selected story, and a recent tail. Reuse work only
> when repository, profile, task, inputs, and freshness match. Compact old
> history into extractive handles, a last-wins story, and a bounded searchable
> vault. Pay once for work, query it next time, and measure avoided calls,
> tokens, and dollars honestly.

This is a backend and ownership change, not a summarization feature.
