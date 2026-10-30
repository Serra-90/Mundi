// Narrative runtime tests (node --test tests/narrative-runtime.mjs — build first: tsc -p tsconfig.json).
// The runtime talks to SillyTavern (bridge), the store, the world, the scene and the prompt; those modules are
// stubbed: the compiled dist file is copied to the temp folder with its import specifiers rewritten to stub
// files (a temp import transform), and the stubs delegate to state the tests control. narrative.js itself is the
// real compiled subsystem, so extraction, replay and rollback run against the true parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const distRuntime = join(here, '..', 'dist', 'sim', 'narrative-runtime.js');
const distNarrative = join(here, '..', 'dist', 'sim', 'narrative.js');
const tmpDir = join(tmpdir(), 'opencode');
mkdirSync(tmpDir, { recursive: true });

// the real narrative subsystem (its only import is a type: the compiled file stands alone)
const narrativePath = join(tmpDir, 'narrative.real.nrt.mjs');
writeFileSync(narrativePath, readFileSync(distNarrative, 'utf8'));

/* ---------- stub modules the compiled runtime is rewired to ---------- */

const write = (name, code) => {
    const p = join(tmpDir, `nrt.${name}.mjs`);
    writeFileSync(p, code);
    return pathToFileURL(p).href;
};
const bridgeUrl = write('bridge', `
// the parts of st/bridge the runtime uses, delegated to state the tests hold
export const chat = () => globalThis.__nrt.chatList;
export const currentChatId = () => globalThis.__nrt.chatId;
export const quiet = (...a) => globalThis.__nrt.quiet(...a);
export const speakerOf = m => { if (!m || m.is_user || m.is_system) return null; if (m.original_avatar) return m.original_avatar; return (globalThis.__nrt.characters || []).find(c => c.name === m.name)?.avatar ?? null; };
export const personaName = () => globalThis.__nrt.me;
export const nameOf = a => (globalThis.__nrt.characters || []).find(c => c.avatar === a)?.name ?? '?';
export const saveChat = () => { globalThis.__nrt.chatSaves++; };
// handlers go to a registry that survives the per-test resets (install runs once per process)
export const on = (name, fn) => { ((globalThis.__nrtHandlers ??= {})[name] ??= []).push(fn); };
`);
const storeUrl = write('store', `
export const game = () => globalThis.__nrt.game ?? null;
export const cfg = g => (g.cfg ??= {});
export const saveGame = () => { globalThis.__nrt.saveCount++; };
export const state = { generating: false };
export const nowAbs = g => g.day * 1440 + g.minutes;
`);
const worldUrl = write('world', `
export const getWorld = () => globalThis.__nrt.world ?? null;
`);
const peopleUrl = write('people', `
export const presentAt = () => (globalThis.__nrt.present || []).map(a => ({ avatar: a }));
`);
const factsUrl = write('facts', `
export const placeName = (g, w, id) => id;
`);
const promptUrl = write('prompt', `
export const refreshPrompt = () => { globalThis.__nrt.refreshCount++; };
`);

// the runtime, with its imports rewired to the stubs above
let src = readFileSync(distRuntime, 'utf8');
for (const [from, to] of Object.entries({
    '../st/bridge.js': bridgeUrl, '../core/store.js': storeUrl, '../core/world.js': worldUrl,
    './people.js': peopleUrl, './facts.js': factsUrl, './narrative.js': pathToFileURL(narrativePath).href, './prompt.js': promptUrl,
})) src = src.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`);
const runtimePath = join(tmpDir, 'narrative-runtime.nrt.mjs');
writeFileSync(runtimePath, src);
const rt = await import(pathToFileURL(runtimePath).href);
const runtimeStore = await import(storeUrl);
const { narrativeState } = await import(pathToFileURL(narrativePath).href);

/* ---------- the little world the tests run in ---------- */

const gameStub = () => ({
    v: 1, world: 'porto', lang: 'en', day: 0, minutes: 600, speed: 1,
    player: { loc: 'cafe', home: { zone: 'mid', kind: 'flat', x: 1, y: 1 }, stats: {}, money: 0, traits: {}, origin: 'new', job: null, rentPaidDay: 1 },
    cast: {
        ana: { avatar: 'ana', name: 'Ana', occupation: null, home: { zone: 'mid', x: 1, y: 1 }, routine: {}, leisure: [], met: true },
        bo: { avatar: 'bo', name: 'Bo', occupation: null, home: { zone: 'mid', x: 2, y: 1 }, routine: {}, leisure: [], met: true },
    },
    tick: {}, log: [],
});
let sendDate = 1;
const youMsg = text => ({ is_user: true, mes: text, send_date: sendDate++ });
const aiMsg = (avatar, text, extra = {}) => ({ is_user: false, name: avatar, original_avatar: avatar, mes: text, send_date: sendDate++, swipes: [text], swipe_id: 0, gen_started: 'x', ...extra });
const fire = (name, ...args) => { for (const fn of globalThis.__nrtHandlers?.[name] ?? []) fn(...args); };
// Fresh state; the quiet stub records every call and answers from `answer` or `quietImpl(prompt)`.
function reset(over = {}) {
    globalThis.__nrt = {
        chatList: [], chatId: 'c1', game: gameStub(), world: { name: 'Porto' }, present: ['ana'],
        characters: [{ avatar: 'ana', name: 'Ana' }, { avatar: 'bo', name: 'Bo' }], me: 'Al',
        quietCalls: [], saveCount: 0, refreshCount: 0, chatSaves: 0, answer: '[]', quietImpl: null, quiet: runQuiet,
        ...over,
    };
    rt.ensureNarrativeLedger();                      // the runtime installs on the current (empty) chat
}
const runQuiet = async (prompt, len, sys, opts) => {
    const t = globalThis.__nrt;
    t.quietCalls.push({ prompt, len, sys, opts });
    return t.quietImpl ? t.quietImpl(prompt) : t.answer;
};
const quietSaw = () => globalThis.__nrt.quietCalls;
const tick = () => new Promise(r => setTimeout(r, 10));   // let fire-and-forget refreshes land
const sync = () => rt.syncNarrative();
const ledger = () => globalThis.__nrt.game.narrativeLedger;
const recKeys = () => (ledger()?.records ?? []).map(r => r.key);
const state2 = () => narrativeState(globalThis.__nrt.game);

// the scenes of the tests: present are always __you and ana (facts name bo as a mere subject)
const FACT_ANA = JSON.stringify([{ kind: 'fact', id: 'f-kiss', text: 'Ana kissed Bo at the café.', subjects: ['bo'], witnesses: ['ana', '__you'], secret: true }]);
const FACT_BO = JSON.stringify([{ kind: 'fact', id: 'f-key', text: 'Bo lost the key.', subjects: ['bo'], witnesses: ['ana', '__you'] }]);
const THREAD_ANA = JSON.stringify([{ kind: 'thread', id: 't-vase', text: 'Who broke the vase?', actors: ['ana'], status: 'open' }]);

reset();
rt.installNarrativeRuntime();                        // wiring is installed once; handlers live in __nrtHandlers
assert.ok(globalThis.__nrtHandlers.MESSAGE_RECEIVED?.length, 'the runtime subscribed to SillyTavern events');

/* ---------- the first reply, and the ids the model may name ---------- */

test('a story generation takes priority between technical calls', async () => {
    reset();
    for (let i = 0; i < 6; i++) {
        globalThis.__nrt.chatList.push(aiMsg('ana', `Priority reply ${i}`));
        rt.stampNarrative(i);
    }
    globalThis.__nrt.quietImpl = async () => {
        runtimeStore.state.generating = true;
        return '[]';
    };
    try {
        await sync();
        assert.equal(quietSaw().length, 1, 'no further extraction starts after the story requests priority');
        assert.equal(ledger().records.length, 1);
    } finally { runtimeStore.state.generating = false; }
});

test('first reply: baseline written before it, default player ids, original context', async () => {
    reset();
    assert.equal(ledger().baseline, 0, 'history ends before the first message (install-time, not after)');
    const g = globalThis.__nrt.game;
    globalThis.__nrt.chatList.push(youMsg('Ana, did you see that?'));
    const reply = aiMsg('ana', 'Yes! Bo kissed me right here. *blushes*');
    globalThis.__nrt.chatList.push(reply);
    globalThis.__nrt.answer = FACT_ANA;
    fire('MESSAGE_RECEIVED', 1);                      // the stamp (and the sync) start the moment the message lands
    g.player.loc = 'square';                          // the player moves on: the stamp must not care
    await sync();
    assert.equal(quietSaw().length, 1, 'one quiet call for one reply');
    assert.equal(quietSaw()[0].len, 1800); assert.equal(quietSaw()[0].sys, ''); assert.deepEqual(quietSaw()[0].opts, { exact: true });
    assert.ok(quietSaw()[0].prompt.includes('__you (Al, the player)'), 'the player id is in the legend');
    const rec = ledger().records[0];
    assert.deepEqual([...rec.context.ids].sort(), ['__you', 'ana', 'bo'], 'ids: the player plus the cast, nothing else');
    assert.ok(rec.context.present.includes('__you'), 'the player is present in the scene');
    assert.equal(rec.context.place, 'cafe', 'the ORIGINAL place, from the stamp, not where the player is now');
    assert.equal(reply.extra.mundiNarrativeContext.place, 'cafe', 'the stamp lives on the message (context only)');
    assert.ok(!('events' in reply.extra.mundiNarrativeContext) && !('secret' in reply.extra.mundiNarrativeContext), 'the stamp carries no events, no secrets');
    assert.equal(state2().facts['f-kiss'].text, 'Ana kissed Bo at the café.', 'the event reached the real subsystem');
    await tick();
    assert.ok(globalThis.__nrt.refreshCount >= 1, 'the prompt was refreshed after the commit');
});

test('[] is a no-op record; malformed and all-invalid answers are not', async () => {
    // an honest [] is processed, as nothing
    reset();
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'Hello there.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = '[]';
    await sync();
    assert.deepEqual(ledger().records[0].events, [], 'a no-op is still a record');
    // malformed: prose, an object, a truncated array — retried up to FAIL_MAX, then left alone
    for (const bad of ['Sure, here you go!', '{"kind":"fact"}', '[{"kind":"fact"']) {
        reset();
        globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'Hello there.'));
        rt.stampNarrative(1);
        globalThis.__nrt.answer = bad;
        await sync(); await sync(); await sync(); await sync();
        assert.equal(ledger().records.length, 0, `not processed: ${bad}`);
        assert.equal(quietSaw().length, 3, `three tries, then it stops paying: ${bad}`);
        assert.equal(Object.values(ledger().failed)[0], 3, 'the tries are counted');
        assert.ok(rt.narrativeDiagnostics(globalThis.__nrt.game).includes('failed 1'), 'the failure is visible in diagnostics');
    }
    // a non-empty array that validates to zero events is a failure too (the parser answers [] to garbage)
    reset();
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'Hello there.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = '[{"kind":"fact"},{"kind":"nonsense"}]';
    await sync();
    assert.equal(ledger().records.length, 0, 'zero valid events out of a non-empty array: not processed');
    assert.ok(ledger().err, 'and the failure is remembered');
});

/* ---------- order, dependencies and the prefix chain ---------- */

test('extraction is oldest-first, with the state replayed before each call', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('one'), aiMsg('ana', 'First things first.'), youMsg('two'), aiMsg('bo', 'Second things second.'));
    rt.stampNarrative(1); rt.stampNarrative(3);
    const seen = [];
    globalThis.__nrt.quietImpl = prompt => {
        seen.push({ reply: /The reply, by \w+:\n(.*)$/m.exec(prompt)?.[1] ?? '', hasFirstFact: prompt.includes('f-first') });
        return prompt.includes('First things first.') ? FACT_ANA.replace('f-kiss', 'f-first') : FACT_BO;
    };
    await sync();
    assert.deepEqual(seen.map(s => s.reply), ['First things first.', 'Second things second.'], 'oldest first');
    assert.equal(seen[0].hasFirstFact, false, 'the first call starts from an empty state');
    assert.equal(seen[1].hasFirstFact, true, 'the second call sees the first fact (replayed before it)');
    assert.ok(state2().facts['f-first'] && state2().facts['f-key'], 'both landed');
});

test('a user edit upstream invalidates every descendant', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('What happened?'), aiMsg('ana', 'The vase broke.'), youMsg('And then?'), aiMsg('bo', 'We cleaned it up.'));
    rt.stampNarrative(1); rt.stampNarrative(3);
    globalThis.__nrt.quietImpl = p => /by Ana:\nThe vase broke\./.test(p) ? THREAD_ANA : FACT_BO;
    await sync();
    const before = [...recKeys()];
    assert.equal(quietSaw().length, 2);
    globalThis.__nrt.chatList[0].mes = 'What happened to the vase, exactly?';   // the USER's line is edited
    await sync();
    assert.equal(quietSaw().length, 4, 'both replies depend on it: both re-extracted');
    assert.notDeepEqual(recKeys(), before, 'every key downstream moved');
    assert.equal(ledger().records.length, 2, 'the old variants are gone from the ledger');
    assert.ok(state2().threads['t-vase'] && state2().facts['f-key'], 'the state was rebuilt from the new answers');
});

test('swipe away re-extracts, swipe back rolls back from the cache', async () => {
    reset();
    const m = aiMsg('ana', 'The vase broke.');
    globalThis.__nrt.chatList.push(youMsg('What happened?'), m);
    rt.stampNarrative(1);
    globalThis.__nrt.answer = THREAD_ANA;
    await sync();
    assert.ok(state2().threads['t-vase'], 'the first variant landed');
    // swipe to a new variant
    m.swipes = ['The vase broke.', 'The cat did it, honestly.']; m.swipe_id = 1; m.mes = m.swipes[1];
    globalThis.__nrt.answer = FACT_ANA;
    fire('MESSAGE_SWIPED');                           // a new variant is pending work: extracted, not just rebuilt
    await sync();
    assert.ok(!state2().threads['t-vase'] && state2().facts['f-kiss'], 'the old entry rolled back, the new one applied');
    // and back again: the cache restores the first variant with no AI call
    const calls = quietSaw().length;
    m.swipe_id = 0; m.mes = m.swipes[0];
    fire('MESSAGE_SWIPED');
    await sync();
    assert.equal(quietSaw().length, calls, 'no quiet call: the cache had it');
    assert.ok(state2().threads['t-vase'] && !state2().facts['f-kiss'], 'rolled forward again, purely from the ledger');
});

/* ---------- hiding, missing stamps, races ---------- */

test('a hidden reply (/hide flips is_system) keeps its record and its author', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('What happened?'), aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = THREAD_ANA;
    await sync();
    assert.equal(ledger().records.length, 1);
    globalThis.__nrt.chatList[1].is_system = true;    // hidden from the AI's eyes — not from the story
    await rt.syncNarrative({ extract: false });
    assert.equal(ledger().records.length, 1, 'the record survives the hiding');
    assert.ok(state2().threads['t-vase'], 'and so does the state');
    assert.ok(!rt.narrativeDiagnostics(globalThis.__nrt.game).includes('pending 1'), 'nothing became pending');
});

test('a source without a stamp invents no history; only the live latest may fall back', async () => {
    reset();
    globalThis.__nrt.chatList.push(aiMsg('ana', 'An old reply of a loaded chat.'), youMsg('moving on'));
    await sync();
    assert.equal(quietSaw().length, 0, 'an old unstamped reply is not guessed at');
    assert.ok(rt.narrativeDiagnostics(globalThis.__nrt.game).includes('without a captured context'), 'diagnostics say what is missing');
    reset();
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'A fresh reply the event missed.'));
    await sync();                                     // no stamp, but it IS the latest message
    assert.equal(quietSaw().length, 1, 'the latest message alone may use the live scene');
    assert.equal(ledger().records[0].context.place, 'cafe');
});

test('a chat switch or an edit mid-call commits nothing', async () => {
    // the chat changes under the call
    reset();
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.quietImpl = () => { globalThis.__nrt.chatId = 'other'; return THREAD_ANA; };
    await sync();
    assert.equal(ledger().records.length, 0, 'another chat took over: nothing written');
    // the message itself is edited under the call
    reset();
    const m = aiMsg('ana', 'The vase broke.');
    globalThis.__nrt.chatList.push(youMsg('hi'), m);
    rt.stampNarrative(1);
    globalThis.__nrt.quietImpl = () => { m.mes = 'A different thing entirely.'; m.swipes[0] = m.mes; return THREAD_ANA; };
    await sync();
    assert.equal(ledger().records.length, 0, 'its own fingerprint moved: the answer is dropped');
    assert.equal(quietSaw().length, 1, 'the call was made once');
    // a message merely ADDED after ours does not waste the answer
    reset();
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.quietImpl = () => { globalThis.__nrt.chatList.push(youMsg('a late user line')); return THREAD_ANA; };
    await sync();
    assert.equal(ledger().records.length, 1, 'a trailing addition changes no prefix');
    assert.ok(state2().threads['t-vase']);
});

test('generation events of our own quiet call never loop, and arrivals while busy are coalesced', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('one'), aiMsg('ana', 'First.'), youMsg('two'), aiMsg('bo', 'Second.'));
    rt.stampNarrative(1); rt.stampNarrative(3);
    globalThis.__nrt.quietImpl = p => {
        fire('GENERATION_ENDED');                     // SillyTavern would emit this for the quiet call itself
        return p.includes('First.') ? FACT_ANA : FACT_BO;
    };
    const p = sync();                                 // a reply lands while the run is busy: coalesced, not dropped
    fire('MESSAGE_RECEIVED', 3);
    await p;
    assert.equal(quietSaw().length, 2, 'two sources, two calls — the loop never grew');
    assert.equal(ledger().records.length, 2);
    assert.equal(rt.narrativeBusy(), false);
});

test('reset clears the ledger and the derived state, and the off switch stops the calls', async () => {
    reset();
    const g = globalThis.__nrt.game;
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = THREAD_ANA;
    await sync();
    assert.ok(g.narrative && g.narrativeLedger);
    rt.resetNarrative(g);
    assert.ok(!g.narrativeLedger && !g.narrative, 'both the ledger and the derived state are gone');
    await tick();
    assert.ok(globalThis.__nrt.refreshCount >= 1, 'the prompt was refreshed to the emptied state');
    g.cfg.narrativeStates = false;
    await sync();
    assert.ok(rt.narrativeDiagnostics(g).includes('off'), 'and the save can turn the whole thing off');
});

/* ---------- the drain: bursts larger than one pass ---------- */

test('auto-drain: six group replies with a slow quiet are all drained by one sync, then idle', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('Everyone, report!'));
    for (let i = 0; i < 6; i++) { globalThis.__nrt.chatList.push(aiMsg('ana', `Report number ${i}.`)); rt.stampNarrative(globalThis.__nrt.chatList.length - 1); }
    globalThis.__nrt.quietImpl = async () => {
        const n = quietSaw().length;
        await new Promise(r => setTimeout(r, 300));   // slower than the 250ms deferral: only the drain can finish this
        return JSON.stringify([{ kind: 'thread', id: `t${n}`, text: `matter ${n}`, actors: ['ana'], status: 'open' }]);
    };
    await sync();                                     // PER_RUN is 4: the drain must chain the second pass by itself
    assert.equal(quietSaw().length, 6, 'all six replies asked, not four');
    assert.equal(ledger().records.length, 6);
    assert.equal(Object.keys(state2().threads).length, 6, 'every answer applied');
    assert.equal(rt.narrativeBusy(), false, 'idle again');
    assert.ok(rt.narrativeDiagnostics(globalThis.__nrt.game).includes('pending 0'));
    await sync();
    assert.equal(quietSaw().length, 6, 'and nothing more is asked once idle');
});

test('a failure never retriggers the drain: tried once per drain, left for a later event', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('Everyone, report!'));
    for (let i = 0; i < 6; i++) { globalThis.__nrt.chatList.push(aiMsg('ana', `Report number ${i}.`)); rt.stampNarrative(globalThis.__nrt.chatList.length - 1); }
    globalThis.__nrt.quietImpl = () => (quietSaw().length <= 3 ? 'not json at all' : FACT_BO);
    await sync();
    assert.equal(quietSaw().length, 6, 'each source tried exactly once in the drain');
    assert.equal(ledger().records.length, 3, 'the good answers landed');
    assert.equal(Object.keys(ledger().failed).length, 3, 'the bad ones are counted, not looped over');
});

test('a reset mid-flight kills the commit', async () => {
    reset();
    const g = globalThis.__nrt.game;
    globalThis.__nrt.chatList.push(youMsg('hi'), aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.quietImpl = () => { rt.resetNarrative(g); return THREAD_ANA; };
    await sync();
    assert.equal(quietSaw().length, 1);
    assert.equal(g.narrativeLedger, undefined, 'the old ledger\'s answer died with it: nothing committed');
    assert.equal(g.narrative, undefined, 'and no derived state was rebuilt from it');
});

test('the clock ticks moods and agendas on rebuild-only syncs, without asking the AI', async () => {
    reset();
    const g = globalThis.__nrt.game;
    globalThis.__nrt.chatList.push(youMsg('A quiet hour.'), aiMsg('ana', 'A lovely one.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = JSON.stringify([{ kind: 'emotion', actor: 'ana', valence: 0.8, arousal: 0, dominance: 0, reason: 'joy' }]);
    await sync();
    assert.equal(state2().emotions.ana.valence, 0.8, 'the mood as it landed (the clock sat at the same minute)');
    g.minutes = 900;                                  // three quiet hours pass, no new message
    await rt.syncNarrative({ extract: false });
    const st = state2();
    assert.equal(st.lastAt, 900, 'the state followed the clock');
    assert.ok(st.emotions.ana.valence < 0.8, 'the mood cooled');
    assert.equal(quietSaw().length, 1, 'and the AI was not asked again');
});

test('hiding the user\'s line (/hide) changes no key and re-extracts nothing', async () => {
    reset();
    globalThis.__nrt.chatList.push(youMsg('Tell me what happened.'), aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = THREAD_ANA;
    await sync();
    const before = recKeys();
    globalThis.__nrt.chatList[0].is_system = true;    // /hide on the user's line
    await rt.syncNarrative({ extract: false });
    assert.deepEqual(recKeys(), before, 'hiding is not a change of story: the key holds');
    assert.equal(quietSaw().length, 1);
});

test('the first line of a new game ensures the baseline before the first reply', async () => {
    reset();
    delete globalThis.__nrt.game.narrativeLedger;     // CHAT_CHANGED ran before the save was set: no ledger yet
    globalThis.__nrt.chatList.push(youMsg('hello'));
    rt.stampNarrative(0);                             // MESSAGE_SENT: the stamp ensures the ledger first
    assert.equal(ledger().baseline, 1, 'history is just the user\'s own line');
    assert.ok(globalThis.__nrt.chatSaves >= 1, 'the stamp is persisted with the chat');
    globalThis.__nrt.chatList.push(aiMsg('ana', 'The vase broke.'));
    rt.stampNarrative(1);
    globalThis.__nrt.answer = THREAD_ANA;
    await sync();
    assert.equal(ledger().records.length, 1, 'the first reply is narrative, never history');
});
