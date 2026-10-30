# Narrative states

The narrative states subsystem gives the people of a world a memory of their own story: facts established in the
conversation, who knows what (and who was told a lie), relations that moved, agreements, agendas, open threads,
feelings and wardrobes. It is **independent from any preset**: nothing is installed in the chat's prompt or in the
character cards — it is Mundi code that watches the chat, asks one small question per reply and keeps its own
state on the save. SillyTavern's generation, swipes, editing and streaming stay exactly as they are.

Two modules, two jobs:

- **`src/sim/narrative.ts`** — the subsystem itself: the event schema, the parser (`parseNarrativeEvents`), the
  state kept on the save and its `reconcileNarrative` (a replay — dropping entries rolls the state back), the
  scene's prompt lines (`narrativeLines`, `narrativeState`).
- **`src/sim/narrative-runtime.ts`** — the runtime described here: when to ask, what to ask, what to remember,
  and how to survive swipes, edits, deletions, hiding and chat switches. It never writes the engine's own state
  (stats, positions, romance, facts): **the native systems remain native**, so the diary and the engine's atomic
  facts never count the same event twice.

## How it runs

```
install (or a chat opens) ─▶ the ledger is created NOW: the baseline is the chat before the first reply
message lands (MESSAGE_RECEIVED/SENT) ─▶ the message is stamped with its scene (m.extra.mundiNarrativeContext)
reply completes / a variant appears ──▶ syncNarrative()
                     │  serialize + coalesce (one run at a time; a reply landing mid-run is folded in, not dropped)
                     │  rebuild the ledger against the chat as it is now (hidden lines and replies included)
                     │  pending sources, OLDEST FIRST (events depend on the ones before them):
                     │     the state is replayed (reconcileNarrative) before every call
                     │     one quiet call per source: only the event schema + that reply + the user's line
                     │     before it + a bounded snapshot of the state (ids WITH texts and provenance)
                     │     no HTML, no instructions preset, empty system prompt, exact:true, ~1800 tokens answer,
                     │     source text capped around 10k characters
                     │  the envelope is validated BEFORE the parser: malformed ≠ "[]"; a non-empty array that
                     │     validates to zero events is a failure, never a no-op
                     │  re-check after the await: same save, same chat, same ledger, same message, same
                     │     dependency prefix — or nothing is written
                     └▶ reconcileNarrative() + saveGame() + refreshPrompt() (dynamic import: no static cycle)

a burst longer than one pass ──▶ AUTO-DRAIN: while sources never tried in this drain remain, another extract
                                 pass is chained (bounded: PER_RUN per pass, at most DRAIN_RUNS extra passes),
                                 so a six-reply group turn finishes by itself and ends idle. A key that FAILED
                                 in the drain is never retried inside it — only fresh keys chain the next pass;
                                 failures wait for a later event (their tries stay counted, max 3).
the clock moves on ──▶ rebuild-only syncs replay the ledger when the state's clock lags the game's, so moods
                       cool and agendas advance even with no new record (and no AI call).
```

A group turn (several replies in a row) is processed one completed response at a time, in story order; a burst
longer than one pass is auto-drained (see below) until the sync ends idle.

## The scene of a message

The moment a message lands it is stamped with the scene as it was **then** — `m.extra.mundiNarrativeContext`:
`{ at, place, present }`, context only, never events and never a secret — and the stamp is persisted with the
chat (once per message, not per snapshot). The first line of a new game can arrive before the save was even set
(CHAT_CHANGED ran early): the stamp ensures the ledger first, so the first reply is narrative, never history.
Its extraction (and every later edit or swipe of it) uses that original context, not wherever the player happens
to be now. A source without a stamp (the event was missed, or an old chat was loaded) invents no history: only
the **latest** message of a chat may fall back to the live scene, and anything older stays pending, shown by the
diagnostics as "without a captured context".

`context.present` always includes `__you` (the player); `context.ids` is the actor universe — `['__you', ...the
save's cast]` — the only entities events may name.

## What the extractor sees

Ids alone say nothing, so the prompt carries a bounded **snapshot with meaning**: the facts of this scene as
*someone's knowledge* — `fact id: "text"` next to `who knows id (via, from whom)` with provenance — plus open
threads, agendas, agreements, lies and wardrobe pieces of the people present. A truth nobody present knows is
never offered as one. This snapshot goes to the technical extractor only; what the scene's own prompt shows the
storyteller is `narrativeLines`' business, which keeps secrets private (a room is never told what one person
knows).

## The ledger

Persisted on the save as `(g as any).narrativeLedger`:

```ts
{ version: 1,
  baseline: number,                       // chat length when the runtime was installed (before the first reply)
  anchor: string,                         // fingerprint of the last message at that moment
  records: [{ key, index, events, context }],   // processed sources still in the chat, in chat order
  cache: [{ key, events, context }],      // bounded (48) event variants, keyed with their full dependency prefix
  failed?: { [key]: number },             // keys the AI could not answer for (capped tries: 3)
  err?: { key, msg, at } }                // last failure, for the diagnostics line
```

**Baseline.** Written at install time and at every chat change, *before* the first reply — a fresh save's first
reply is narrative, not history; an old save's thousand messages are never processed. The baseline is anchored to
the fingerprint of the last message seen at that moment: if messages above the baseline are deleted, the anchor
is searched by fingerprint and the baseline follows it down; if the anchor itself is gone, the saved count still
skips the same leading messages.

**Keys (the dependency chain).** A source's key is a hash of *speaker + swipe variant + send_date + canonical
text + the last user line before it + a digest of everything said before it* — never the message index. So:

- **a user message edited, deleted or swiped upstream** gives every descendant a new key: dependents are
  re-extracted, and a cache entry built on another prefix is never reused;
- **swipe away** → the old key vanishes, its record is dropped on rebuild, the new variant is extracted (swipes
  and edits are pending work, not just rebuilds);
- **swipe back** → the old key returns and its events come back from the bounded cache, with **no AI call**;
- **delete** → the record is dropped on the next rebuild;
- **hide** (`/hide` flips `is_system`) → a hidden reply is still a reply: its record and its author survive, and
  a hidden *user line* still counts as the line a reply answered — hiding changes no key and re-extracts nothing.

Only records whose key matches a message currently in the chat stay active; `reconcileNarrative` receives
exactly those, in chat order. Nothing is written to `message.extra` beyond the context stamp — identity is
derived from content, and secrets live only in the save.

**Failures.** A malformed answer, an error, or a non-empty array that validates to zero events is *not* recorded
as processed: the source stays pending, the failure is counted and shown by `narrativeDiagnostics`, and a future
sync retries it — up to three tries per source, then it is left alone (still visible in diagnostics) so a
hopeless message is not paid for forever.

**Races.** Before asking, the runtime captures the save object, the chat id and the source key. After the await
it verifies that the same save is open in the same chat, under the **same ledger** (a `resetNarrative` mid-flight
kills the commit), that the message still exists under the same key, and that its whole dependency prefix is
unchanged (a message merely *added* after ours changes nothing for us; anything changed *before* us drops the
answer). Records are refiltered once more before every commit, so no stale variant ever lands — and a failure is
only remembered while the same chat and ledger are still open: nothing is ever written onto whatever the user
switched to.

## Events

The quiet prompt asks for a JSON array only (`[]` when nothing of consequence happened) and its schema is
exactly `narrative.ts`'s (see that file's header for the full contract). Rules baked into the prompt: only events
clearly established in that text (an intention is not a completed action); the player's private thoughts are not
observable; knowledge changes only through clear communication (`told`, by someone present who knows it) or
evidence; existing ids are reused for the same fact/thread/agenda/wardrobe piece; ordinary small talk is `[]`;
no scanning of other characters' minds or cards.

## Configuration

- Per save, default **on**: `(cfg(g) as any).narrativeStates !== false`. Set it to `false` to pause the
  subsystem for that save (the ledger stays; messages received while off are extracted when it is turned on
  again — or call `resetNarrative` to forget and re-baseline instead).
- `resetNarrative(g)` deletes the ledger **and** the derived narrative state; the next sync baselines at the
  chat as it is then, and the scene's prompt is refreshed to the emptied state.
- Wiring is one line in the entry point: `installNarrativeRuntime()` (idempotent). It follows SillyTavern's own
  events: messages are stamped at receipt; finished generations and new variants (swipes, edits) extract; an
  interrupted generation (`GENERATION_STOPPED`) never extracts — an incomplete reply is only rebuilt around;
  deletions and chat switches rebuild. Generation events that are actually the runtime's own quiet call find the
  busy flag up, so they never loop; everything else coalesces into a running sync instead of being dropped.

## API (runtime)

| Export | What it does |
| --- | --- |
| `syncNarrative(options?: { extract?: boolean })` | the entry point; serialized and coalesced; `extract: false` rebuilds only |
| `narrativeBusy()` | true while a sync (and its quiet call) is running — also the recursion guard |
| `narrativeDiagnostics(g)` | one line: on/off, baseline, processed / pending (and how many lack a context) / failed, cache, last error |
| `resetNarrative(g)` | forgets the ledger and the derived state (baseline restarts at the current chat length) |
| `ensureNarrativeLedger()` | writes the baseline now, if this save does not have one yet |
| `stampNarrative(id)` | stamps a message with the scene at receipt (context only) |
| `installNarrativeRuntime()` | subscribes to SillyTavern's events, once |

## Limitations

- **One extra quiet call per completed reply** (~1800 tokens of answer, prompt capped around 10k characters of
  source). On busy group turns the calls are sequential, a few per sync.
- **No autonomous movement.** Agendas and threads are remembered and replayed into the scene's prompt, but
  nobody walks off on their own because of a narrative event: places and routines stay the native simulation's.
- **Replay is narrative-only.** A ledger rebuild (swipe, edit, delete, re-entry) re-reconciles the narrative
  subsystem's own state only; the engine's facts, diary verdicts, stats, romance and positions are native and
  are never rewritten from here.
- **Stamps are persisted with the chat.** The context stamp rides on the message object; after a reload, messages that
  were never stamped are treated as history unless they are the latest one (live fallback) — their events, once
  extracted, keep their captured context in the ledger regardless.
- **A burst costs patience.** A drain may chain up to DRAIN_RUNS extra passes (PER_RUN quiet calls each) before
  it goes idle. A story generation takes priority between technical calls, so it waits only for an extraction
  already in flight, not the whole backlog. Pending work resumes on a later completed generation or manual retry.
- **Knowledge filtering is scoped to this new subsystem.** Native diary, facts, lorebooks and the visible chat
  retain their original behavior. Speaker-filtered internal states reduce accidental omniscience but cannot
  guarantee that the model ignores secrets it also receives through those other channels.

## Testing

1. `tsc -p tsconfig.json` — the build must pass. Then the engine's own suite:
   `node --test tests/narrative.mjs`, and the runtime's: `node --test tests/narrative-runtime.mjs` (the runtime
   is loaded from `dist/` with its imports rewritten to stubs — bridge, store, world, scene, prompt — while
   `narrative.js` is the real subsystem; covered: the first reply and the default ids, `[]` vs malformed vs
   all-invalid answers with retries, oldest-first extraction with the state replayed before each call, a user
   edit invalidating descendants, swipe away/back with cache rollback, hidden-reply and hidden-line retention,
   missing stamps, chat-switch/edit/reset races, no self-recursion, coalesced arrivals, the six-reply auto-drain
   with a slow quiet, failures never retriggering the drain, the clock tick on rebuild-only syncs, reset and the
   off switch).
2. By hand: open a save, play a few replies with real content (a promise, a lie, a change of clothes). In the
   browser console:
   ```js
   const m = await import('/scripts/extensions/third-party/Mundi/dist/sim/narrative-runtime.js');
   const { game } = await import('/scripts/extensions/third-party/Mundi/dist/core/store.js');
   m.narrativeDiagnostics(game());   // processed grows, pending 0
   ```
3. **Baseline**: turn the subsystem on for an old save — diagnostics must show history before the current
   message; no quiet call for the old messages.
4. **Swipe**: swipe a reply away, wait for the sync, swipe back — the second time no quiet call is made (cache
   hit), and diagnostics show the same processed count.
5. **Edit / delete / hide**: edit a reply (re-extracted under a new key), edit the user line before it (its
   descendants re-extract), delete a message (its record disappears; `narrativeState` no longer contains its
   events after the rebuild), hide one (`/hide` — the record stays).
6. **Failure**: point SillyTavern at a model/stub that answers with prose — the reply stays pending, the error
   appears in `narrativeDiagnostics`, and after three tries the source is left alone.
7. **Off switch**: set the save's `cfg.narrativeStates = false` — no further calls, diagnostics say off.
