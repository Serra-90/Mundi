// Narrative engine tests (node --test tests/narrative.mjs — build first: tsc -p tsconfig.json).
// narrative.ts has no runtime imports (its only import is a type), so dist/sim/narrative.js stands alone; the repo
// has no package.json "type": "module", so the compiled file is copied to a .mjs in the temp folder and imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'sim', 'narrative.js');
const tmpDir = join(tmpdir(), 'opencode');
mkdirSync(tmpDir, { recursive: true });
const tmp = join(tmpDir, 'narrative.test.mjs');
writeFileSync(tmp, readFileSync(dist, 'utf8'));
const { parseNarrativeEvents, reconcileNarrative, narrativeLines, narrativeState } = await import(pathToFileURL(tmp).href);

/* ---------- helpers ---------- */

// day 0, minutes 600: the game clock (day*1440+minutes) sits where the test scenes are, unless a test moves it.
const stub = () => ({
    v: 1, world: 'porto', lang: 'en', day: 0, minutes: 600, speed: 1,
    player: { loc: 'cafe', home: { zone: 'mid', kind: 'flat', x: 1, y: 1 }, stats: { energy: 50, mood: 60 }, money: 120, traits: {}, origin: 'new', job: null, rentPaidDay: 1 },
    cast: {
        ana: { avatar: 'ana', name: 'Ana', occupation: null, home: { zone: 'mid', x: 1, y: 1 }, routine: {}, leisure: [], met: true },
        bo: { avatar: 'bo', name: 'Bo', occupation: null, home: { zone: 'mid', x: 2, y: 1 }, routine: {}, leisure: [], met: true },
        carl: { avatar: 'carl', name: 'Carl', occupation: null, home: { zone: 'mid', x: 3, y: 1 }, routine: {}, leisure: [], met: true },
    },
    tick: {}, log: [],
});
const ctx = (at, present, ids = ['ana', 'bo', 'carl', '__you']) => ({ at, place: 'cafe', present, ids });
const run = (obj, context) => parseNarrativeEvents(JSON.stringify(obj), context);
const J = o => JSON.stringify(o);

/* ---------- validation ---------- */

test('an agenda ends only when a later story event explicitly completes it', () => {
    const g = stub();
    const c = ctx(600, ['ana']);
    const plan = { kind: 'agenda', actor: 'ana', id: 'letter', goal: 'Deliver the letter', steps: [{ text: 'Walk to the post box', minutes: 5 }] };
    const first = { key: 'start', context: c, events: run([plan], c) };
    g.minutes = 610;
    reconcileNarrative(g, [first]);
    assert.equal(narrativeState(g).agendas['ana|letter'].status, 'ready');
    const c2 = ctx(610, ['ana']);
    reconcileNarrative(g, [first, { key: 'finish', context: c2, events: run([{ ...plan, status: 'completed' }], c2) }]);
    assert.equal(narrativeState(g).agendas['ana|letter'].status, 'completed');
    assert.ok(!narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }], 'ana').join('\n').includes('Deliver the letter'));
    reconcileNarrative(g, [first]);
    assert.equal(narrativeState(g).agendas['ana|letter'].status, 'ready', 'rollback restores the pending plan');
});

test('parse: bounds, junk and the allowlist', () => {
    const c = ctx(600, ['ana', 'bo']);
    assert.deepEqual(parseNarrativeEvents('', c), []);
    assert.deepEqual(parseNarrativeEvents('not json at all', c), []);
    assert.deepEqual(parseNarrativeEvents('{"kind":"fact"}', c), []);                    // not an array
    assert.deepEqual(parseNarrativeEvents('x'.repeat(24001), c), []);                   // too big to even look at
    // the AI wrapped its JSON in prose and a code fence: one honest try to find the array
    const wrapped = 'Sure — here you go:\n```json\n' + J([{ kind: 'thread', id: 't1', text: 'who broke the vase?', actors: ['ana'], status: 'open' }]) + '\n```';
    assert.equal(parseNarrativeEvents(wrapped, c).length, 1);
    assert.deepEqual(run({ kind: 'fact', id: 'f1', text: 'x', subjects: ['bo'], witnesses: ['ana'] }, c), []);   // an object, not an array
    assert.equal(run([{ kind: 'nonsense' }], c).length, 0);                              // unknown kind
    assert.equal(run([{ kind: 'lie', id: 'l1', actor: 'ghost', target: 'bo', text: 'x' }], c).length, 0);   // unknown actor
    assert.equal(run([{ kind: 'fact', id: 'f2', text: 'x', subjects: [], witnesses: ['carl'] }], c).length, 0);   // every witness must be in the scene
    assert.equal(run([{ kind: 'fact', id: 'f3', text: 'x', subjects: ['ana'], witnesses: ['ana', 'bo'] }], c).length, 1);   // who acts may also witness
    assert.equal(run([{ kind: 'relation', actor: 'ana', target: 'bo', trust: 'lots', reason: 'x' }], c).length, 0);   // strings are not numbers
    assert.equal(run([{ kind: 'relation', actor: 'ana', target: 'bo', trust: null, reason: 'x' }], c).length, 0);
    assert.equal(run([{ kind: 'learn', fact: 'f1', actor: 'ana', source: 'bo', via: 'telepathy' }], c).length, 0);    // no mind reading
    assert.equal(run([{ kind: 'agenda', actor: 'ana', id: 'a1', goal: 'buy', steps: [{ text: 'walk', minutes: 2.5 }] }], c).length, 0);   // minutes are whole minutes
    assert.equal(run([{ kind: 'agreement', a: 'ana', b: 'bo', mode: 'secret', terms: 'x' }], c).length, 0);   // unknown mode
    // only the FIRST 24 events of a source array are even read — invalid ones are not skipped past
    assert.equal(run(Array.from({ length: 30 }, (_, i) => ({ kind: 'thread', id: `t${i}`, text: 'x', actors: ['ana'], status: 'open' })), c).length, 24);
    const junk = Array.from({ length: 100 }, () => ({ kind: 'nope' }));
    junk.push({ kind: 'thread', id: 't9', text: 'x', actors: ['ana'], status: 'open' });
    assert.equal(run(junk, c).length, 0, 'the first 24 are read, not the first 24 valid');
});

test('parse: small safe normalizations only', () => {
    const c = ctx(600, ['ana', 'bo']);
    // out-of-range VAD is clamped, not rejected; a wardrobe "planned" agenda is an active one (runtime compat)
    const evs = run([
        { kind: 'emotion', actor: 'ana', valence: 2, arousal: -3, dominance: 0.5, reason: 'joy' },
        { kind: 'agenda', actor: 'ana', id: 'bread', goal: 'buy bread', steps: [{ text: 'walk', minutes: 10 }], status: 'planned' },
        { kind: 'relation', actor: 'ana', target: 'bo', trust: 99, reason: 'a lot' },
    ], c);
    assert.equal(evs.length, 3);
    assert.equal(evs[0].valence, 1);
    assert.equal(evs[0].arousal, -1);
    assert.equal(evs[1].status, 'active');
    assert.equal(evs[2].trust, 10);   // a single event is capped before it is even applied
});

/* ---------- entities: real avatars, reserved keys, prototype-free maps ---------- */

test('entities: real avatars (unicode, spaces, .png) are who the scene says they are', () => {
    const A = 'Sera Philina thé.png', B = '武 者二.png';
    const c = ctx(600, [A, B], [A, B, 'ana']);
    const evs = run([
        { kind: 'fact', id: 'f1', text: 'A quiet table by the window.', subjects: [A], witnesses: [A, B] },   // the subject also witnesses
    ], c);
    assert.equal(evs.length, 1);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c }]);
    const st = narrativeState(g);
    assert.ok(st.knowledge[A].f1 && st.knowledge[B].f1, 'the witnesses know, subject or not');
    // a witness the scene does not hold is never invented
    assert.equal(run([{ kind: 'fact', id: 'f2', text: 'x', subjects: [], witnesses: [A, 'ana'] }], ctx(600, [A, B], [A, B, 'ana'])).length, 0);
    assert.equal(run([{ kind: 'relation', actor: A, target: B, trust: 2, reason: 'x' }], c).length, 1);
    // reserved keys never become ids of any kind
    assert.equal(run([{ kind: 'fact', id: '__proto__', text: 'x', subjects: [], witnesses: [A] }], c).length, 0);
    assert.equal(run([{ kind: 'thread', id: 'constructor', text: 'x', actors: [A], status: 'open' }], c).length, 0);
    // and the store's maps have no prototype to pollute
    assert.equal(Object.getPrototypeOf(st.facts), null);
    assert.equal(Object.getPrototypeOf(st.knowledge[A]), null);
});

/* ---------- knowledge: witnesses, secrets, no learning from ignorance ---------- */

test('facts: witnesses know, subjects alone do not; a secret stays with who knows it', () => {
    const c0 = ctx(600, ['ana']);
    const evs = run([{ kind: 'fact', id: 'kiss', text: 'Bo kissed Carl at the party.', subjects: ['bo'], witnesses: ['ana'], secret: true }], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }]);
    const st = narrativeState(g);
    assert.equal(st.schemaVersion, 1);
    assert.ok(st.knowledge.ana.kiss.via === 'witness');
    assert.ok(!st.knowledge.bo?.kiss && !st.knowledge.carl?.kiss, 'the subject was not told by the universe');
    const cast = [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }];
    assert.ok(!narrativeLines(g, cast).join('\n').includes('kissed'), 'a secret is not told to the room');
    assert.ok(narrativeLines(g, cast, 'ana').join('\n').includes('kissed'), 'the witness sees their own secret');
    assert.ok(!narrativeLines(g, cast, 'bo').join('\n').includes('kissed'), 'the subject does not know it');
});

test('learn: nobody tells what they do not know; evidence needs the actor present', () => {
    const c0 = ctx(600, ['ana', 'bo']);
    const fact = run([{ kind: 'fact', id: 'f1', text: 'Ana lost the key.', subjects: ['ana'], witnesses: ['bo'] }], c0);
    const fromIgnorant = run([{ kind: 'learn', fact: 'f1', actor: 'ana', source: 'carl', via: 'told' }], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: [...fact, ...fromIgnorant], context: c0 }]);
    assert.ok(narrativeState(g).knowledge.bo.f1, 'the witness knows');
    assert.ok(!narrativeState(g).knowledge.ana?.f1, 'ignorance teaches nothing');
    // once bo tells it (both present), ana knows — with provenance
    const c1 = ctx(700, ['ana', 'bo']);
    const told = run([{ kind: 'learn', fact: 'f1', actor: 'ana', source: 'bo', via: 'told', confidence: 0.9 }], c1);
    reconcileNarrative(g, [{ key: 'm1', events: [...fact, ...fromIgnorant], context: c0 }, { key: 'm2', events: told, context: c1 }]);
    const k = narrativeState(g).knowledge.ana.f1;
    assert.equal(k.via, 'told'); assert.equal(k.source, 'bo'); assert.equal(k.confidence, 0.9);
    // now the whole room (ana and bo) knows: the intersection shows it
    assert.ok(narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }]).join('\n').includes('lost the key'));
    // evidence found while the actor is away teaches nothing
    const g2 = stub();
    const away = ctx(700, ['bo']);
    const found = run([{ kind: 'learn', fact: 'f1', actor: 'ana', source: 'the broken lock', via: 'evidence' }], away);
    reconcileNarrative(g2, [{ key: 'm1', events: fact, context: c0 }, { key: 'm2', events: found, context: away }]);
    assert.ok(!narrativeState(g2).knowledge.ana?.f1);
});

/* ---------- relations, pacts and their violations ---------- */

test('relations: one direction, capped at ±10, earned or refused', () => {
    const c0 = ctx(600, ['ana', 'bo']);
    const e1 = run([{ kind: 'relation', actor: 'ana', target: 'bo', trust: 6, reason: 'helped with the boxes' }], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }]);
    assert.equal(narrativeState(g).relations.ana.bo.trust, 6);
    assert.ok(!narrativeState(g).relations.bo?.ana, 'feelings are directional');
    // clamped, both the single event and the running total
    const e2 = run([{ kind: 'relation', actor: 'ana', target: 'bo', trust: 8, affection: 20, reason: 'more' }], c0);
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }, { key: 'm2', events: e2, context: c0 }]);
    const rel = narrativeState(g).relations.ana.bo;
    assert.equal(rel.trust, 10); assert.equal(rel.affection, 10);
    // "because of that fact": the actor must actually know it
    const factCtx = ctx(650, ['carl']);
    const fact = run([{ kind: 'fact', id: 'money', text: 'Bo took the money.', subjects: ['bo'], witnesses: ['carl'] }], factCtx);
    const res = run([{ kind: 'relation', actor: 'ana', target: 'bo', resentment: 5, reason: 'the money', fact: 'money' }], ctx(650, ['ana', 'bo']));
    const learned = run([{ kind: 'learn', fact: 'money', actor: 'ana', source: 'the empty drawer', via: 'evidence' }], ctx(660, ['ana']));
    reconcileNarrative(g, [
        { key: 'm1', events: e1, context: c0 }, { key: 'm2', events: e2, context: c0 }, { key: 'm3', events: fact, context: factCtx },
        { key: 'm4', events: res, context: ctx(650, ['ana', 'bo']) }, { key: 'm5', events: learned, context: ctx(660, ['ana']) },
        { key: 'm6', events: res, context: ctx(670, ['ana']) },
    ]);
    assert.equal(narrativeState(g).relations.ana.bo.resentment, 5, 'refused before the knowledge, applied after it');
    // and a feeling from someone who is not even there never lands
    const absent = run([{ kind: 'relation', actor: 'carl', target: 'ana', fear: 4, reason: 'x' }], ctx(650, ['ana']));
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }, { key: 'm7', events: absent, context: ctx(650, ['ana']) }]);
    assert.ok(!narrativeState(g).relations.carl?.ana);
});

test('a broken pact bites only when the truth is known', () => {
    const c0 = ctx(600, ['ana', 'bo', 'carl']);
    const setup = run([
        { kind: 'agreement', a: 'ana', b: 'bo', mode: 'exclusive', terms: 'they only date each other' },
        { kind: 'fact', id: 'fling', text: 'Bo spent the night with Carl.', subjects: ['bo'], witnesses: ['carl'], tags: ['agreement-break'] },
    ], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: setup, context: c0 }]);
    assert.ok(!(narrativeState(g).relations.ana?.bo?.resentment > 0), 'a tag alone changes nothing');
    const c1 = ctx(700, ['ana', 'carl']);
    const told = run([{ kind: 'learn', fact: 'fling', actor: 'ana', source: 'carl', via: 'told' }], c1);
    reconcileNarrative(g, [{ key: 'm1', events: setup, context: c0 }, { key: 'm2', events: told, context: c1 }]);
    assert.equal(narrativeState(g).relations.ana.bo.resentment, 3, 'learning of it does bite, a little');
    // learning it again adds nothing: once per pact and fact
    const again = run([{ kind: 'learn', fact: 'fling', actor: 'ana', source: 'the chat log', via: 'evidence' }], ctx(800, ['ana']));
    reconcileNarrative(g, [{ key: 'm1', events: setup, context: c0 }, { key: 'm2', events: told, context: c1 }, { key: 'm3', events: again, context: ctx(800, ['ana']) }]);
    assert.equal(narrativeState(g).relations.ana.bo.resentment, 3);
});

test('pact violations: a witness already knows; open pacts and older facts do not count', () => {
    // the pact exists first; the injured party is the WITNESS (no learn event at all)
    const c0 = ctx(600, ['ana', 'bo', 'carl']);
    const pact = run([{ kind: 'agreement', a: 'ana', b: 'bo', mode: 'exclusive', terms: 'only each other' }], c0);
    const seen = ctx(700, ['ana', 'carl']);
    const fact = run([{ kind: 'fact', id: 'fling', text: 'Bo spent the night with Carl.', subjects: ['bo'], witnesses: ['ana'], tags: ['agreement-break'] }], seen);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: pact, context: c0 }, { key: 'm2', events: fact, context: seen }]);
    assert.equal(narrativeState(g).relations.ana?.bo?.resentment, 3, 'seeing it with their own eyes is knowing it');
    // an open pact has nothing to break
    const g2 = stub();
    const open = run([{ kind: 'agreement', a: 'ana', b: 'bo', mode: 'open', terms: 'free to see others' }], c0);
    reconcileNarrative(g2, [{ key: 'm1', events: open, context: c0 }, { key: 'm2', events: fact, context: seen }]);
    assert.ok(!(narrativeState(g2).relations.ana?.bo?.resentment > 0), 'an open pact cannot be broken');
    // a fact from before the pact is not a violation of it
    const g3 = stub();
    const before = ctx(500, ['ana', 'carl']);
    const oldFact = run([{ kind: 'fact', id: 'fling', text: 'Bo spent the night with Carl.', subjects: ['bo'], witnesses: ['ana'], tags: ['agreement-break'] }], before);
    reconcileNarrative(g3, [{ key: 'm0', events: oldFact, context: before }, { key: 'm1', events: pact, context: c0 }]);
    assert.ok(!(narrativeState(g3).relations.ana?.bo?.resentment > 0), 'what happened before the pact does not count');
});

/* ---------- lies ---------- */

test('lies: the hearer is told the words; the truth stays with the liar', () => {
    const c0 = ctx(600, ['ana', 'bo']);
    const evs = run([{ kind: 'lie', id: 'l1', actor: 'ana', target: 'bo', text: 'I never met Carl.', fact: 'Ana met Carl at the docks.' }], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }]);
    const cast = [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }];
    const boLines = narrativeLines(g, cast, 'bo').join('\n');
    assert.ok(boLines.includes('I never met Carl.'), 'the hearer remembers the words');
    assert.ok(!boLines.includes('lie'), 'but is never told it was one');
    assert.ok(!boLines.includes('docks'), 'and never sees the truth');
    const anaLines = narrativeLines(g, cast, 'ana').join('\n');
    assert.ok(anaLines.includes('Lie Ana told Bo: "I never met Carl."'), 'the liar knows what they said');
    assert.ok(anaLines.includes('the docks'), 'and carries the truth of it');
    // a lie needs both faces in the room
    const away = run([{ kind: 'lie', id: 'l2', actor: 'ana', target: 'bo', text: 'x' }], ctx(600, ['ana']));
    const g2 = stub();
    reconcileNarrative(g2, [{ key: 'm1', events: away, context: ctx(600, ['ana']) }]);
    assert.equal(Object.keys(narrativeState(g2).lies).length, 0);
});

/* ---------- time: agendas and moods ---------- */

test('agendas and moods move with the clock, and only the clock', () => {
    const c0 = ctx(600, ['ana']);
    const e1 = run([
        { kind: 'agenda', actor: 'ana', id: 'bread', goal: 'buy bread', steps: [{ text: 'walk to the bakery', minutes: 10 }, { text: 'choose the loaf', minutes: 10 }] },
        { kind: 'emotion', actor: 'ana', valence: 0.8, arousal: -0.6, dominance: 0, reason: 'a good morning' },
    ], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }]);
    assert.equal(narrativeState(g).agendas['ana|bread'].status, 'active');
    // 10 minutes later: the walk is done, the choice is next — but the engine does not play it out
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }, { key: 'm2', events: [], context: ctx(610, ['ana']) }]);
    let st = narrativeState(g);
    assert.equal(st.agendas['ana|bread'].spent, 10);
    assert.equal(st.agendas['ana|bread'].status, 'active');
    // 15 more minutes: the time is spent — ready, consequence still pending, never auto-completed
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }, { key: 'm2', events: [], context: ctx(610, ['ana']) }, { key: 'm3', events: [], context: ctx(625, ['ana']) }]);
    st = narrativeState(g);
    assert.equal(st.agendas['ana|bread'].status, 'ready');
    assert.equal(st.agendas['ana|bread'].consequence, 'pending');
    assert.equal(g.player.loc, 'cafe'); assert.equal(g.day, 0); assert.equal(g.minutes, 600);   // nobody was moved by a plan
    // four hours later the mood has half-cooled (0.8 → ~0.4)
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }, { key: 'm4', events: [], context: ctx(850, ['ana']) }]);
    const e = narrativeState(g).emotions.ana;
    assert.ok(Math.abs(e.valence - 0.4) < 0.02 && Math.abs(e.arousal + 0.3) < 0.02, `decayed: v=${e.valence} a=${e.arousal}`);
});

test('the game clock (day*1440+minutes) moves agendas and moods without entries', () => {
    const g = stub();
    const c0 = ctx(600, ['ana']);
    const e1 = run([
        { kind: 'agenda', actor: 'ana', id: 'tea', goal: 'make tea', steps: [{ text: 'boil the water', minutes: 5 }] },
        { kind: 'emotion', actor: 'ana', valence: 0.5, arousal: 0, dominance: 0, reason: 'a quiet hour' },
    ], c0);
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }]);
    assert.equal(narrativeState(g).agendas['ana|tea'].status, 'active');
    g.minutes = 700;   // the game itself moved on: no second entry needed
    reconcileNarrative(g, [{ key: 'm1', events: e1, context: c0 }]);
    const st = narrativeState(g);
    assert.equal(st.agendas['ana|tea'].status, 'ready');
    assert.equal(st.agendas['ana|tea'].consequence, 'pending');
    assert.ok(Math.abs(st.emotions.ana.valence - 0.5 * Math.pow(0.5, 100 / 240)) < 0.01, 'the mood cooled 100 minutes');
});

test('threads: a past due date is flagged, never resolved by the clock', () => {
    const c0 = ctx(600, ['ana', 'bo']);
    const evs = run([{ kind: 'thread', id: 'ring', text: 'Who owns the ring?', actors: ['ana', 'bo'], status: 'open', due: 650 }], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }, { key: 'm2', events: [], context: ctx(800, ['ana', 'bo']) }]);
    const th = narrativeState(g).threads.ring;
    assert.equal(th.status, 'open', 'expired is not resolved');
    assert.ok(narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }], 'ana').join('\n').includes('past due, still open'));
    // a thread of people who are not here is not this room's business
    const other = run([{ kind: 'thread', id: 'vase', text: 'The vase in the hall.', actors: ['carl'], status: 'open' }], ctx(600, ['carl']));
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }, { key: 'm3', events: other, context: ctx(600, ['carl']) }]);
    assert.ok(!narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }]).join('\n').includes('vase'));
});

test('threads: nobody closes another room\'s matter', () => {
    const c0 = ctx(600, ['ana', 'bo']);
    const t = run([{ kind: 'thread', id: 'vase', text: 'The broken vase.', actors: ['ana', 'bo'], status: 'open' }], c0);
    const away = ctx(700, ['carl']);
    const close = run([{ kind: 'thread', id: 'vase', text: 'The broken vase.', actors: ['ana', 'bo'], status: 'resolved' }], away);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: t, context: c0 }, { key: 'm2', events: close, context: away }]);
    assert.equal(narrativeState(g).threads.vase.status, 'open', 'Carl was not even there');
});

/* ---------- wardrobe ---------- */

test('wardrobe: plain data that persists across replays', () => {
    const c0 = ctx(600, ['ana']);
    const w1 = run([{ kind: 'wardrobe', actor: 'ana', items: [{ id: 'dress', name: 'red dress', state: 'worn', location: '__you', condition: 'clean' }] }], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: w1, context: c0 }]);
    let item = narrativeState(g).wardrobe.ana.dress;
    assert.equal(item.state, 'worn'); assert.equal(item.condition, 'clean');
    // a later entry only changes what it says; the rest of the wardrobe stays
    const w2 = run([{ kind: 'wardrobe', actor: 'ana', items: [{ id: 'dress', name: 'red dress', state: 'stored', location: 'the wardrobe at home', condition: 'clean' }] }], ctx(800, ['ana']));
    reconcileNarrative(g, [{ key: 'm1', events: w1, context: c0 }, { key: 'm2', events: w2, context: ctx(800, ['ana']) }]);
    item = narrativeState(g).wardrobe.ana.dress;
    assert.equal(item.state, 'stored'); assert.equal(item.location, 'the wardrobe at home');
    // and it is still there after a replay that does not mention it
    reconcileNarrative(g, [{ key: 'm1', events: w1, context: c0 }, { key: 'm2', events: w2, context: ctx(800, ['ana']) }, { key: 'm3', events: [], context: ctx(900, ['ana']) }]);
    assert.ok(narrativeState(g).wardrobe.ana.dress);
    // but a wardrobe change for someone who is not there never lands
    const g2 = stub();
    const far = run([{ kind: 'wardrobe', actor: 'bo', items: [{ id: 'cap', name: 'cap', state: 'worn', location: '__you' }] }], ctx(600, ['ana']));
    reconcileNarrative(g2, [{ key: 'm1', events: far, context: ctx(600, ['ana']) }]);
    assert.ok(!narrativeState(g2).wardrobe.bo);
});

test('wardrobe in lines: worn with condition for the room; stored with where and how for the wearer', () => {
    const c0 = ctx(600, ['ana', 'bo', 'carl']);
    const evs = run([
        { kind: 'wardrobe', actor: 'ana', items: [{ id: 'coat', name: 'grey coat', state: 'worn', location: '__you', condition: 'rain-wet' }] },
        { kind: 'wardrobe', actor: 'ana', items: [{ id: 'boots', name: 'leather boots', state: 'stored', location: 'the hallway closet', condition: 'muddy' }] },
    ], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }]);
    const cast = [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }, { avatar: 'carl', name: 'Carl' }];
    const room = narrativeLines(g, cast).join('\n');
    assert.ok(room.includes('grey coat (rain-wet)'), 'a worn coat is observable, condition included');
    assert.ok(!room.includes('hallway closet'), 'a closed closet is not the room\'s business');
    const mine = narrativeLines(g, cast, 'ana').join('\n');
    assert.ok(mine.includes('grey coat (rain-wet)'));
    assert.ok(mine.includes('leather boots — the hallway closet (muddy)'), 'the wearer knows where and how things are put away');
});

/* ---------- the replay: idempotent, and rollback really undoes ---------- */

test('replay: idempotent, and rolling an entry back really undoes it', () => {
    const c0 = ctx(600, ['ana', 'bo']), c1 = ctx(700, ['ana']), c2 = ctx(800, ['bo', 'ana']);
    const e1 = run([{ kind: 'fact', id: 'f1', text: 'Ana found the ring.', subjects: ['ana'], witnesses: ['bo'] }], c0);
    const e2 = run([{ kind: 'relation', actor: 'ana', target: 'bo', affection: 4, reason: 'the ring' }], c1);
    const e3 = run([{ kind: 'thread', id: 't1', text: 'Who owns the ring?', actors: ['ana', 'bo'], status: 'open' }], c2);
    const full = [{ key: 'm1', events: e1, context: c0 }, { key: 'm2', events: e2, context: c1 }, { key: 'm3', events: e3, context: c2 }];
    const g1 = stub(), g2 = stub();
    reconcileNarrative(g1, full); reconcileNarrative(g2, full);
    const snap = J(narrativeState(g1));
    assert.equal(snap, J(narrativeState(g2)), 'two saves, same story, same states');
    reconcileNarrative(g1, full);
    assert.equal(snap, J(narrativeState(g1)), 'replaying the same entries changes nothing');
    // roll back the last entry (a message deleted or re-generated)
    reconcileNarrative(g1, full.slice(0, 2)); reconcileNarrative(g2, full.slice(0, 2));
    assert.equal(J(narrativeState(g1)), J(narrativeState(g2)));
    assert.ok(!narrativeState(g1).threads.t1, 'the thread is gone with its entry');
    // the same key twice: the last version of a source is the one that counts
    const alt = run([{ kind: 'relation', actor: 'ana', target: 'bo', affection: 1, reason: 'a colder take' }], c1);
    reconcileNarrative(g1, [...full.slice(0, 2), { key: 'm2', events: alt, context: c1 }]);
    assert.equal(narrativeState(g1).relations.ana.bo.affection, 1);
    // and forward again
    reconcileNarrative(g1, full);
    assert.equal(snap, J(narrativeState(g1)));
});

/* ---------- the save outside the subsystem ---------- */

test('nothing outside (g as any).narrative is ever touched', () => {
    const g = stub();
    const before = J({ ...g, narrative: undefined });
    const c0 = ctx(600, ['ana', 'bo']);
    const evs = run([
        { kind: 'fact', id: 'f1', text: 'A quiet afternoon.', subjects: [], witnesses: ['ana', 'bo'] },
        { kind: 'relation', actor: 'ana', target: 'bo', trust: 3, reason: 'calm' },
        { kind: 'emotion', actor: 'bo', valence: 0.3, arousal: 0, dominance: 0, reason: 'calm' },
        { kind: 'wardrobe', actor: 'bo', items: [{ id: 'cap', name: 'flat cap', state: 'worn', location: '__you' }] },
        { kind: 'agenda', actor: 'bo', id: 'walk', goal: 'walk home', steps: [{ text: 'say goodbye', minutes: 5 }] },
        { kind: 'thread', id: 't1', text: 'Dinner on Friday?', actors: ['ana', 'bo'], status: 'open' },
    ], c0);
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }, { key: 'm2', events: [], context: ctx(700, ['ana', 'bo']) }]);
    narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }], 'bo');
    assert.equal(J({ ...g, narrative: undefined }), before, 'player, cast, clock, log: all untouched');
    assert.ok(g.narrative && g.narrative.schemaVersion === 1);
});

/* ---------- lines: shape, budget, and the shared room ---------- */

test('lines: autonomous guidance, compact, and never a script', () => {
    const c0 = ctx(600, ['ana', 'bo']);
    const evs = run([
        { kind: 'fact', id: 'f1', text: 'The café was quiet all afternoon.', subjects: [], witnesses: ['ana', 'bo'] },
        { kind: 'relation', actor: 'ana', target: 'bo', trust: 3, affection: 2, reason: 'old friends' },
        { kind: 'emotion', actor: 'ana', valence: 0.4, arousal: -0.2, dominance: 0.1, reason: 'a good morning' },
        { kind: 'agenda', actor: 'ana', id: 'bread', goal: 'buy bread', steps: [{ text: 'walk', minutes: 10 }] },
        { kind: 'wardrobe', actor: 'ana', items: [{ id: 'scarf', name: 'green scarf', state: 'worn', location: '__you' }] },
    ], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }]);
    const cast = [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }];
    const lines = narrativeLines(g, cast);
    assert.ok(lines[0].includes('not a script'), 'the guidance line comes first');
    assert.ok(lines.join('\n').includes('quiet all afternoon'), 'shared knowledge is shared');
    assert.ok(lines.join('\n').includes('green scarf'), 'a worn scarf is observable');
    assert.ok(lines.join('\n').length <= 6500, 'the whole block stays compact');
    // the speaker's block is strictly their own
    const bo = narrativeLines(g, cast, 'bo');
    assert.ok(!bo.join('\n').includes("Ana's private feelings"), 'one voice: no other mind is opened');
    assert.ok(bo.join('\n').includes('Information available to Bo'));
    assert.ok(bo.join('\n').includes('reports are not proof'));
});

test('a shared room sees only what a room can see', () => {
    const c0 = ctx(600, ['ana', 'bo', 'carl']);
    const evs = run([
        { kind: 'fact', id: 'pub', text: 'The café closed early.', subjects: [], witnesses: ['ana', 'bo', 'carl'] },
        { kind: 'relation', actor: 'ana', target: 'bo', resentment: 5, reason: 'the hidden quarrel' },
        { kind: 'emotion', actor: 'ana', valence: -0.6, arousal: 0.4, dominance: 0, reason: 'the hidden quarrel' },
        { kind: 'agenda', actor: 'ana', id: 'evening', goal: 'even the score', steps: [{ text: 'wait', minutes: 30 }] },
        { kind: 'thread', id: 'quarrel', text: 'The hidden quarrel.', actors: ['ana', 'bo'], status: 'open' },
        { kind: 'agreement', a: 'ana', b: 'bo', mode: 'exclusive', terms: 'tell no one about the quarrel' },
    ], c0);
    const g = stub();
    reconcileNarrative(g, [{ key: 'm1', events: evs, context: c0 }]);
    const room = narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }, { avatar: 'carl', name: 'Carl' }]).join('\n');
    assert.ok(room.includes('closed early'), 'shared facts are shared');
    assert.ok(!room.includes('quarrel'), 'no private reasons, threads, pacts or feelings in front of Carl');
    assert.ok(!room.includes('resentment') && !room.includes('mood') && !room.includes('agenda'), 'private states stay private');
    // the same two alone: the pact between them (and only it) surfaces — they both know it, nobody else hears
    const pair = narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }]).join('\n');
    assert.ok(pair.includes('exclusive agreement'), 'a pact shows when everyone present is party to it');
    assert.ok(!pair.includes('resentment') && !pair.includes('mood'), 'but feelings still stay private');
});

test('narrativeState: lazily created, safe before any replay', () => {
    const g = stub();
    const st = narrativeState(g);
    assert.equal(st.schemaVersion, 1);
    assert.equal(Object.keys(st.facts).length, 0);
    assert.equal(narrativeState(g), st, 'the same object, not a new one each call');
    assert.equal(narrativeLines(g, [{ avatar: 'ana', name: 'Ana' }]).length, 1, 'guidance only');
});
