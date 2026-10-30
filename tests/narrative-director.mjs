// Narrative director tests (node --test tests/narrative-director.mjs — build first: tsc -p tsconfig.json).
// narrative-director.ts has no runtime imports (its only import is a type), so its compiled file stands alone;
// narrative.js is the real subsystem, so the stores the director reads are built by the true parser and replay.
// The repo has no package.json "type": "module", so both compiled files are copied to .mjs in the temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(tmpdir(), 'opencode');
mkdirSync(tmpDir, { recursive: true });
const dirPath = join(tmpDir, 'narrative-director.test.mjs');
writeFileSync(dirPath, readFileSync(join(here, '..', 'dist', 'sim', 'narrative-director.js'), 'utf8'));
const narPath = join(tmpDir, 'narrative-director.nar.mjs');
writeFileSync(narPath, readFileSync(join(here, '..', 'dist', 'sim', 'narrative.js'), 'utf8'));
const { directorLines } = await import(pathToFileURL(dirPath).href);
const { parseNarrativeEvents, reconcileNarrative, narrativeState } = await import(pathToFileURL(narPath).href);

/* ---------- helpers: the same little world narrative.mjs runs in ---------- */

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
const cast = [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }, { avatar: 'carl', name: 'Carl' }];
const THREAD = (id, text, actors, due) => [{ kind: 'thread', id, text, actors, status: 'open', ...(due !== undefined ? { due } : {}) }];
const REL = [{ kind: 'relation', actor: 'ana', target: 'bo', resentment: 7, reason: 'the hidden quarrel' }];
const AGENDA = [{ kind: 'agenda', actor: 'ana', id: 'bread', goal: 'buy bread', steps: [{ text: 'walk to the bakery', minutes: 10 }] }];

// The director reads the ledger the runtime keeps; the tests mirror what the runtime would have written: the
// entries given to reconcileNarrative ARE the ledger's records, one key per processed source.
const play = (g, entries) => {
    reconcileNarrative(g, entries);
    g.narrativeLedger = { version: 1, baseline: 0, anchor: '', records: entries.map((e, i) => ({ key: e.key, index: i, events: e.events, context: e.context })), cache: [] };
};
// n padding sources after the real ones: the same story with more ledger turns (the count the director paces on).
const pads = (n, at = 600) => Array.from({ length: n }, (_, i) => ({ key: `pad${i}`, events: [], context: ctx(at, ['ana']) }));
// The four call-back shapes, by their distinctive words.
const SHAPES = ['spent its time', 'past its time', 'still carries', 'An open matter remains'];
const says = (g, who) => directorLines(g, cast, who).join('\n');

/* ---------- silence, and the speakerless room ---------- */

test('a save without a narrative store gets nothing; a room without a speaker gets generic guidance only', () => {
    const g = stub();
    assert.deepEqual(directorLines(g, cast), [], 'no store: the director has nothing to say');
    narrativeState(g);                              // the subsystem exists now — empty, but real
    const room = directorLines(g, cast);
    assert.equal(room.length, 1, 'one generic guidance line');
    assert.ok(room[0].startsWith('[Director]'));
    assert.ok(!room[0].includes('Ana') && !room[0].includes('vase'), 'no names, no matters: nothing private in it');
    assert.deepEqual(directorLines(g, cast, 'ana'), [], 'an empty mind has no call-backs yet');
    assert.deepEqual(directorLines(g, []), [], 'an empty room is directed by no one');
});

/* ---------- determinism ---------- */

test('deterministic: the same save and ledger render the same lines, again and again', () => {
    const build = () => {
        const g = stub();
        const e1 = { key: 'm1', events: run(THREAD('vase', 'Who broke the vase?', ['ana', 'bo'], 550), ctx(600, ['ana', 'bo'])), context: ctx(600, ['ana', 'bo']) };
        const e2 = { key: 'm2', events: run(AGENDA, ctx(600, ['ana'])), context: ctx(600, ['ana']) };
        const e3 = { key: 'm3', events: run(REL, ctx(610, ['ana', 'bo'])), context: ctx(610, ['ana', 'bo']) };
        play(g, [e1, e2, e3, ...pads(5, 700)]);      // the pads' clock makes the bread agenda ready
        return g;
    };
    const g = build();
    for (let n = 0; n <= 5; n++) {
        const a = directorLines(g, cast, 'ana'), b = directorLines(g, cast, 'ana'), c = directorLines(build(), cast, 'ana');
        assert.deepEqual(a, b, `render ${n}: identical back to back`);
        assert.deepEqual(a, c, `render ${n}: identical on a rebuilt save`);
        assert.ok(a.length <= 1 && a.join('').length <= 1200, `render ${n}: at most one line, within budget`);
    }
});

/* ---------- privacy ---------- */

test('privacy: an unknown speaker opens no mind; no one else\'s feelings ever leak', () => {
    const e1 = {
        key: 'm1',
        events: run([
            ...THREAD('vase', 'Who broke the vase?', ['ana', 'bo'], 550),
            ...REL,
            { kind: 'relation', actor: 'bo', target: 'carl', trust: 8, reason: 'the secret pact' },
        ], ctx(600, ['ana', 'bo'])),
        context: ctx(600, ['ana', 'bo']),
    };
    const generic = (() => { const g = stub(); play(g, [e1, ...pads(11)]); return directorLines(g, cast, 'ghost'); })();
    assert.equal(generic.length, 1, 'an unknown speaker gets the generic line, not a mind');
    const said = generic.join('\n');
    assert.ok(!said.includes('vase') && !said.includes('quarrel') && !said.includes('pact') && !said.includes('bread'), 'nothing private reaches it');
    for (let n = 0; n <= 11; n++) {
        const g = stub(); play(g, [e1, ...pads(n)]);
        assert.ok(!says(g, 'ana').includes('secret pact'), `turn ${n}: what Bo feels is Bo's, never Ana's block`);
        const room = directorLines(g, cast).join('\n');
        assert.ok(!room.includes('vase') && !room.includes('quarrel') && !room.includes('pact'), `turn ${n}: the room is told nothing private`);
    }
});

/* ---------- one call-back, and its priority ---------- */

test('at most one call-back a turn, and a due matter outranks everything but a spent plan', () => {
    const mk = due => n => {
        const g = stub();
        const e1 = {
            key: 'm1',
            events: run([...THREAD('vase', 'Who broke the vase?', ['ana', 'bo'], due), ...THREAD('ring', 'Who keeps the ring?', ['ana']), ...REL], ctx(600, ['ana', 'bo'])),
            context: ctx(600, ['ana', 'bo']),
        };
        play(g, [e1, ...pads(n)]);
        return directorLines(g, cast, 'ana');
    };
    const due = mk(550), fresh = mk(700);           // 550 < the clock 600: past due; 700: still ahead
    let dueShown = 0, freshShown = 0;
    for (let n = 0; n <= 11; n++) {
        const d = due(n), f = fresh(n);
        assert.ok(d.length <= 1 && f.length <= 1, `turn ${n}: at most one line`);
        for (const line of [...d, ...f]) {
            assert.ok(line.length <= 600, 'each line is bounded');
            assert.ok(SHAPES.some(s => line.includes(s)), 'a known call-back shape, nothing invented');
        }
        if (d.length && d[0].includes('past its time')) {
            dueShown++;
            assert.ok(!f[0]?.includes('past its time'), `turn ${n}: a future due date is no pressure`);
            assert.ok(!d[0].includes('ring'), `turn ${n}: the due matter preempts the lesser candidates`);
        }
        if (f.length) freshShown++;
    }
    assert.ok(dueShown >= 1 && freshShown >= 1, 'both states do speak somewhere over the turns');
    // a spent plan outranks even the due matter: whenever it speaks, nothing else does
    const e1 = { key: 'm1', events: run(THREAD('vase', 'Who broke the vase?', ['ana', 'bo'], 550), ctx(600, ['ana', 'bo'])), context: ctx(600, ['ana', 'bo']) };
    const e2 = { key: 'm2', events: run(AGENDA, ctx(600, ['ana'])), context: ctx(600, ['ana']) };
    let planShown = 0;
    for (let n = 0; n <= 11; n++) {
        const g = stub(); play(g, [e1, e2, ...pads(n, 700)]);
        const said = says(g, 'ana');
        if (said.includes('spent its time')) { planShown++; assert.ok(!said.includes('past its time'), `turn ${n}: the spent plan outranks the due matter`); }
    }
    assert.ok(planShown >= 1, 'the spent plan does surface');
});

/* ---------- cooldown: deterministic spacing over ledger turns ---------- */

test('cooldown: a call-back paces itself over ledger turns (a slot, not a timer)', () => {
    const one = kind => n => {
        const g = stub();
        const evs = kind === 'major' ? THREAD('vase', 'Who broke the vase?', ['ana'], 550) : REL;
        const e1 = { key: 'm1', events: run(evs, ctx(600, ['ana'])), context: ctx(600, ['ana']) };
        play(g, [e1, ...pads(n)]);
        return says(g, 'ana');
    };
    let major = 0, minor = 0;
    for (let n = 0; n <= 11; n++) {                  // 12 consecutive ledger turns
        if (one('major')(n)) major++;                // a past-due matter: every 3rd turn, never turn after turn
        if (one('minor')(n)) minor++;                // a strong feeling: every other turn
    }
    assert.equal(major, 4, 'the major appears exactly 4 of 12 turns — spaced');
    assert.equal(minor, 6, 'the minor appears exactly 6 of 12 turns');
});

/* ---------- purity ---------- */

test('a pure reader: nothing is ever written, not even the ledger', () => {
    const g = stub();
    const e1 = { key: 'm1', events: run([...THREAD('vase', 'Who broke the vase?', ['ana', 'bo'], 550), ...REL], ctx(600, ['ana', 'bo'])), context: ctx(600, ['ana', 'bo']) };
    play(g, [e1, ...pads(4)]);
    const before = JSON.stringify(g);
    directorLines(g, cast); directorLines(g, cast, 'ana'); directorLines(g, cast, 'ghost'); directorLines(g, [], 'ana');
    assert.equal(JSON.stringify(g), before, 'save, store and ledger: byte-identical');
});

/* ---------- the game clock owns the deadlines ---------- */

test('the game clock decides due dates, and age resolves nothing', () => {
    const saysDue = minutes => {
        for (let n = 0; n <= 5; n++) {
            const g = stub(); g.minutes = minutes;
            const e1 = { key: 'm1', events: run(THREAD('vase', 'Who broke the vase?', ['ana'], 650), ctx(600, ['ana'])), context: ctx(600, ['ana']) };
            play(g, [e1, ...pads(n)]);
            if (says(g, 'ana').includes('past its time')) return g;
        }
        return null;
    };
    assert.ok(!saysDue(600), 'due 650, clock 600: not yet due, whatever the ledger does');
    const past = saysDue(700);
    assert.ok(past, 'clock 700: past due — the game clock, not the ledger, decides');
    directorLines(past, cast, 'ana');
    assert.equal(narrativeState(past).threads.vase.status, 'open', 'a past due date flags; it never resolves by age');
});

/* ---------- the replay: a changed key leaves no stale director ---------- */

test('a changed key leaves no stale director: what was rolled back is not said', () => {
    const mk = (key, evs) => n => {
        const g = stub();
        play(g, [{ key, events: run(evs, ctx(600, ['ana', 'bo'])), context: ctx(600, ['ana', 'bo']) }, ...pads(n)]);
        return g;
    };
    const vase = mk('m1', THREAD('vase', 'Who broke the vase?', ['ana', 'bo']));
    const ring = mk('m2', THREAD('ring', 'Who keeps the ring?', ['ana', 'bo']));   // same turn count, different key and matter
    let vaseShown = false, ringShown = false;
    for (let n = 0; n <= 11; n++) {
        assert.ok(!says(ring(n), 'ana').includes('vase'), `turn ${n}: the rolled-back matter is never mentioned`);
        if (says(vase(n), 'ana').includes('vase')) vaseShown = true;
        if (says(ring(n), 'ana').includes('ring')) ringShown = true;
    }
    assert.ok(vaseShown && ringShown, 'both versions do surface under their own ledger');
});
