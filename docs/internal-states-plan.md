# Internal states: the plan

The internal-states layer is the autonomous side of the mind. The narrative subsystem (`src/sim/narrative.ts`)
keeps what each person carries inside — facts, who knows what, lies, relations, agreements, agendas, threads,
moods, wardrobes; its runtime (`src/sim/narrative-runtime.ts`) keeps the ledger that makes all of it survive
swipes, edits and deletions. The **director** (`src/sim/narrative-director.ts`, this round) is the light hand on
top: it points the scene at what the story already established, **with no AI call of its own**.

## Objective

Autonomous-seeming direction without another model in the loop and without a second source of truth. The scene's
prompt gets, at most once per turn, one gentle call-back chosen from what the narrative subsystem already holds:
a plan of the speaker's whose time is spent, an open matter of theirs past its due date, a strong feeling of
theirs, or an open matter still quietly waiting. Everything else — where people are, what the clock says, what
the routines do — stays the native simulation's.

## Constraints (all enforced in code)

- **No extra AI calls.** The director reads; it never asks. `narrative-runtime.ts` remains the only thing that
  talks to a model.
- **Pure `directorLines(g, present, speaker?)` → `string[]`.** No writes to the save, the store or the ledger; no
  store is even created (a save without one gets `[]`). No RNG anywhere: the same save, ledger and clock render
  the same lines, every time.
- **The ledger is the only clock.** A "turn" is `ledger.records.length`; the fingerprint is a hash of the
  records' keys. Those keys are exactly what an edit, swipe or deletion upstream already invalidates — the replay
  rebuilds the store, the key set moves, and the director's choices move with it. **No `onNarrativeTurn` hook
  exists, on purpose**: it would be hidden mutable state and a second clock beside the ledger's, and the first
  stale render would be a matter of time.
- **Deadlines follow the game clock** (`day*1440+minutes`, the same clock `reconcileNarrative` catches up to),
  never the ledger and never real time.
- **At most one call-back per turn**, in this priority: ① the speaker's ready agendas (major), ② open threads of
  the speaker past their due date (major), ③ a strong feeling of the speaker's own — |axis| ≥ 6 of ±10 — with the
  reason they earned it (minor), ④ an open thread of the speaker's that is not past due (minor).
- **Cooldown as a slot, not a timer.** A major call-back returns only on every 3rd ledger turn
  (`(turn + hash(anchor)) % 3 === 0`), a minor every 2nd; a cooling major never sneaks back through a weaker
  class. Major events are always real threads/agendas the story established — the director invents nothing.
- **Never** force an outcome or a revelation, resolve a matter by age (a past-due thread is flagged, still open),
  move anyone, or bring anyone in from off-screen. No forced question, no event every turn.
- **Privacy = `narrativeLines`' model.** Without a speaker — or with one this room does not hold — one generic
  guidance line with nothing private in it: no texts, names, goals or feelings, not even a count of open matters.
  With a speaker, exactly one mind opens: the speaker's own. What others feel never appears.
- **Bounded**: any line ≤ 600 characters, the whole block ≤ 1200.

## Acceptance

### Implemented (each covered by `tests/narrative-director.mjs`)

- Pure, deterministic rendering: repeated calls and rebuilt-but-identical saves give identical lines; nothing is
  ever written back (the save is byte-identical after any number of renders).
- The speakerless room and unknown speakers get generic guidance only; no cross-speaker leaks (another person's
  feelings never enter someone's block, and the room is never told a thread's text).
- At most one call-back per turn, always one of the four known shapes, priority: spent plan > due matter >
  strong feeling > open thread; a due matter preempts the lesser candidates.
- Deterministic cooldown: over 12 consecutive ledger turns a major appears exactly 4 times, a minor exactly 6 —
  spacing without a timer and without stored state.
- Due dates from the game clock (not the ledger): the same thread is silent at minute 600 and flagged at 700,
  and stays `open` either way.
- Replay-keyed freshness: when the ledger's key set changes (a swipe rolled the story back), the old matter is
  never mentioned again — the director cannot go stale because it derives everything from keys the replay already
  invalidates.

### Deliberate limits

- **No arbitrary physical simulator.** The director comments; it does not simulate. Places, distances, presence
  and movement belong to the native simulation, and no line of the director may move a body or open a door.
- **No offline generative life yet.** Nothing evolves between chats beyond what the native simulation and the
  ledger's replay already do; the director only surfaces what past story turns established. A world that "lives"
  while nobody plays would need its own bounded generator — deferred, not attempted here.
- **Native routines and time retained.** Routines, the clock and every other native system are untouched; the
  director is a reader of the save, never a writer.
- **Ready agendas stay pending.** A spent plan is surfaced ("its consequence is still unwritten"), never
  executed: the scene plays consequences, not the director.
- **Wired into `prompt.ts`.** `directorLines` and `narrativeLines` share the internal-states block and its token
  budget/cut rules. `index.ts` selects the current group speaker before prompt construction; unknown speakers and
  impersonation receive conservative shared context. The AI-context screen exposes the per-save switch, pending
  extractions, retries and a read-only state inspector.

## API

| Export | What it does |
| --- | --- |
| `directorLines(g, present: { avatar, name }[], speaker?)` | 0–1 guidance lines for the scene's prompt: the speaker's one strongest call-back, or the room's generic guidance line; reads only, ≤ 1200 characters |

## Testing

1. `tsc -p tsconfig.json` — the build must pass. Then `node --test tests/narrative-director.mjs` (both compiled
   files are copied to `.mjs` in the temp folder — `narrative-director.js` has no runtime imports and stands
   alone; `narrative.js` is the real subsystem, so the stores the director reads are built by the true parser
   and replay). Covered: silence without a store, the speakerless generic line, determinism across repeated
   renders and rebuilt saves, unknown-speaker and cross-speaker privacy, the one-call-back priority (spent plan
   over due matter over feeling over thread), slot-based cooldown counts over 12 turns, byte-identical purity,
   game-clock due dates with no resolution by age, and replay-key freshness after a rollback.
