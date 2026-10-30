// Narrative states: the autonomous layer of the mind. The official systems (facts, romance, social) keep what the
// game measures; this engine keeps what each person carries inside — what they know and how they learned it, the
// lies told to them, private feelings (trust, affection, resentment, fear), pacts, agendas that move with the
// clock, open threads and moods that cool down with time. It is a closed subsystem: everything lives in
// (g as any).narrative (schemaVersion 1) and is rebuilt from a replay of entries (reconcileNarrative), so a save
// rolls back by dropping entries and replaying them — no risk to the rest of the save: player stats, the official
// romance, the native facts, time and positions are never touched here. After the replay the game's own clock
// (day*1440+minutes) moves agendas and moods the rest of the way, without entries of their own.
//
// Event schema (the AI emits a JSON array; parseNarrativeEvents validates it against the scene context; the
// runtime bridge in narrative-runtime.ts asks for exactly these shapes):
//   fact      { id, text, subjects: [entity…], witnesses: [entity…], secret?: boolean, tags?: [word…] }
//             `witnesses` are the people who saw it happen — they know it, and they must ALL be in the scene (a
//             remote witness is never invented). `subjects` — who it is about — may also witness (who acts may
//             assist), but being a subject alone teaches nothing. `tags` (up to 4 short words) only describe the
//             fact; the tags with teeth are "agreement-break" and "betrayal": they are checked when someone
//             KNOWS the fact — as a witness at the moment it happens, or through a later learn — never alone.
//   learn     { fact: id, actor, source, via: 'told' | 'evidence', confidence?: 0..1 }
//             told: source must already know the fact, and actor and source must both be present (a live scene).
//             evidence: actor must be present, and source is the evidence itself (a non-empty description).
//             Nobody ever "just knows" things: no know-all.
//   lie       { id, actor, target, text, fact?: the truth as text, if shown }   — told face to face; the hearer
//             remembers the words, the truth stays with the liar
//   relation  { actor, target, trust? / affection? / resentment? / fear? (±10 each, totals clamped ±10), reason, fact?: id }
//             directional (actor → target); the actor must be present; if `fact` is given, the actor must know it
//   agreement { a, b, mode: 'exclusive' | 'open' | 'conditional', terms }      — struck between two present
//             people; the latest pact between them wins. An open pact cannot be broken; a fact older than the
//             pact never violates it.
//   agenda    { actor, id, goal, steps: [{ text, minutes }], status?: 'active' | 'planned' | 'cancelled' }
//             steps advance deterministically with the minutes of the entries' contexts (and then with the game
//             clock); when the time is spent the agenda is marked ready with a pending consequence — the engine
//             never plays it out (no bought bread, no solved case, no character moved).
//   thread    { id, text, actors: [entity…], status: 'open' | 'resolved' | 'cancelled', due?: absolute minutes }
//             someone in the matter must be present to open, move or close it; a past due date is only flagged:
//             a thread never resolves by itself.
//   emotion   { actor, valence, arousal, dominance (-1..1), reason? }          — halves toward calm every 4 hours
//   wardrobe  { actor, items: [{ id, name, state: 'worn' | 'stored', location, condition? }] }   — plain data
//
// Two kinds of names: an ENTITY (actors, targets, parties, subjects, witnesses) is any string exactly named by
// the context — context.ids or context.present — 1..512 characters, so real avatars ("Sera Philina thé.png") work
// as they are. An ID (facts, threads, agendas, lies, wardrobe pieces) is short, no spaces. Both refuse the
// reserved keys __proto__/prototype/constructor, and every internal map is created without a prototype, so no
// event can pollute one.
//
// Bounds everywhere: input ≤ 24k characters, only the FIRST 24 events of a source array are even looked at,
// texts and arrays capped, numbers must be real finite numbers. Invalid events are dropped, never "fixed": no
// string→number, no invented witness, no guessed presence.
import type { Save } from '../core/store.js';

export interface NarrativeContext { at: number; place: string; present: string[]; ids: string[] }
export interface NarrativeEvent { kind: string; [key: string]: unknown }

/* ---------- bounds ---------- */

const MAX_INPUT = 24000;         // characters of JSON the parser will even look at
const MAX_EVENTS = 24;           // the first events of a source array; the rest is not even read
const REL_CAP = 10;              // every feeling axis lives in [-10, +10]
const VIOLATION_RESENTMENT = 3;  // knowing of a broken pact: resentment, once per pact and fact
const DECAY_HALF = 240;          // minutes for a mood to halve toward calm
const LINES_BUDGET = 6500;       // the whole narrative block stays under ~this many characters
const VIOLATION_TAGS = ['agreement-break', 'betrayal'];
const RESERVED = ['__proto__', 'prototype', 'constructor'];
const ID_RE = /^[\p{L}\p{N}.:_-]{1,64}$/u;

/* ---------- the store (all of it under (g as any).narrative, maps without a prototype) ---------- */

interface NFact { id: string; text: string; subjects: string[]; witnesses: string[]; secret: boolean; tags: string[]; at: number; place: string }
interface NKnow { via: 'witness' | 'told' | 'evidence'; source: string; at: number; confidence?: number }
interface NRel { trust: number; affection: number; resentment: number; fear: number; log: { at: number; what: string; reason: string }[] }
interface NAgenda { actor: string; id: string; goal: string; steps: { text: string; minutes: number }[]; createdAt: number; spent: number; status: 'active' | 'ready' | 'cancelled' | 'completed'; consequence?: 'pending'; updatedAt: number }
interface NThread { id: string; text: string; actors: string[]; status: 'open' | 'resolved' | 'cancelled'; due?: number; updatedAt: number }
interface NAgreement { a: string; b: string; mode: 'exclusive' | 'open' | 'conditional'; terms: string; at: number }
interface NEmotion { valence: number; arousal: number; dominance: number; reason?: string; at: number }
interface NItem { id: string; name: string; state: 'worn' | 'stored'; location: string; condition?: string }
interface NLie { id: string; actor: string; target: string; text: string; fact?: string; at: number }

interface NarrativeStore {
    schemaVersion: 1; lastAt: number;
    facts: Record<string, NFact>;
    knowledge: Record<string, Record<string, NKnow>>;      // who → fact id → how they learned it (provenance)
    lies: Record<string, NLie>;
    relations: Record<string, Record<string, NRel>>;       // actor → target → the four axes (directional)
    agreements: Record<string, NAgreement>;                // by the two parties' key
    agendas: Record<string, NAgenda>;                      // by "actor|id"
    threads: Record<string, NThread>;
    emotions: Record<string, NEmotion>;
    wardrobe: Record<string, Record<string, NItem>>;
    violations: Record<string, true>;                      // "knower|fact|other" already resented
}

const freshStore = (): NarrativeStore => ({
    schemaVersion: 1, lastAt: 0,
    facts: Object.create(null), knowledge: Object.create(null), lies: Object.create(null), relations: Object.create(null),
    agreements: Object.create(null), agendas: Object.create(null), threads: Object.create(null), emotions: Object.create(null),
    wardrobe: Object.create(null), violations: Object.create(null),
});

// The narrative subsystem's whole state. Lazily created (the runtime walks it before any replay: ids only).
export function narrativeState(g: Save): any {
    const cur = (g as any).narrative;
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && cur.schemaVersion === 1) return cur;
    const st = freshStore();
    (g as any).narrative = st;
    return st;
}

/* ---------- validation: an allowlist, not a repair shop ---------- */

const isObj = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o);
const txt = (o: unknown, max: number): string | null => { if (typeof o !== 'string') return null; const t = o.trim(); return t.length >= 1 && t.length <= max ? t : null; };
const fin = (o: unknown): number | null => (typeof o === 'number' && Number.isFinite(o)) ? o : null;
// An event/object/wardrobe id: short, no spaces, never a reserved key.
const ident = (o: unknown): string | null => (typeof o === 'string' && ID_RE.test(o) && !RESERVED.includes(o)) ? o : null;
// A person as the scene names them: any real avatar string (spaces, unicode, ".png") the context actually lists.
const entStr = (o: unknown): string | null => (typeof o === 'string' && o.length >= 1 && o.length <= 512 && !RESERVED.includes(o)) ? o : null;
// The scene's own people, as they are written.
const presentOf = (context: NarrativeContext): Set<string> => {
    const out = new Set<string>();
    for (const x of context?.present ?? []) { const s = entStr(x); if (s) out.add(s); }
    return out;
};

const AXES = ['trust', 'affection', 'resentment', 'fear'] as const;
type Axis = typeof AXES[number];

type Valid =
    | { kind: 'fact'; id: string; text: string; subjects: string[]; witnesses: string[]; secret: boolean; tags: string[] }
    | { kind: 'learn'; fact: string; actor: string; source: string; via: 'told' | 'evidence'; confidence?: number }
    | { kind: 'lie'; id: string; actor: string; target: string; text: string; fact?: string }
    | { kind: 'relation'; actor: string; target: string; trust?: number; affection?: number; resentment?: number; fear?: number; reason: string; fact?: string }
    | { kind: 'agreement'; a: string; b: string; mode: 'exclusive' | 'open' | 'conditional'; terms: string }
    | { kind: 'agenda'; actor: string; id: string; goal: string; steps: { text: string; minutes: number }[]; status: 'active' | 'cancelled' | 'completed' }
    | { kind: 'thread'; id: string; text: string; actors: string[]; status: 'open' | 'resolved' | 'cancelled'; due?: number }
    | { kind: 'emotion'; actor: string; valence: number; arousal: number; dominance: number; reason?: string }
    | { kind: 'wardrobe'; actor: string; items: NItem[] };

function validEvent(raw: unknown, context: NarrativeContext): Valid | null {
    if (!isObj(raw) || typeof raw.kind !== 'string') return null;
    const present = presentOf(context);
    const uni = new Set<string>(present);                  // the people in the scene…
    for (const x of context?.ids ?? []) { const s = entStr(x); if (s) uni.add(s); }   // …and everyone the context names
    const entity = (o: unknown): string | null => { const s = entStr(o); return s !== null && uni.has(s) ? s : null; };
    const entList = (o: unknown, max: number, min: number): string[] | null => {
        if (!Array.isArray(o) || o.length < min || o.length > max) return null;
        const out: string[] = [];
        for (const x of o) { const s = entity(x); if (!s || out.includes(s)) return null; out.push(s); }
        return out;
    };
    const optFact = (o: Record<string, unknown>, asText: boolean): string | undefined => {
        if (o.fact === undefined) return undefined;
        return asText ? (txt(o.fact, 160) ?? undefined) : (ident(o.fact) ?? undefined);
    };
    switch (raw.kind) {
        case 'fact': {
            const id = ident(raw.id), text = txt(raw.text, 240);
            if (!id || !text) return null;
            const subjects = entList(raw.subjects, 6, 0), witnesses = entList(raw.witnesses, 8, 1);
            if (!subjects || !witnesses) return null;
            if (!witnesses.every(w => present.has(w))) return null;          // every witness was in the scene
            let secret = false;
            if (raw.secret !== undefined) { if (typeof raw.secret !== 'boolean') return null; secret = raw.secret; }
            let tags: string[] = [];
            if (raw.tags !== undefined) {
                if (!Array.isArray(raw.tags) || raw.tags.length > 4) return null;
                for (const t of raw.tags) { const w = txt(t, 32); if (!w) return null; tags.push(w); }
            }
            return { kind: 'fact', id, text, subjects, witnesses, secret, tags };
        }
        case 'learn': {
            const fact = ident(raw.fact), actor = entity(raw.actor);
            const via = raw.via === 'told' || raw.via === 'evidence' ? raw.via : null;
            if (!fact || !actor || !via) return null;
            let source: string;
            if (via === 'told') { const s = entity(raw.source); if (!s) return null; source = s; }
            else { const s = txt(raw.source, 160); if (!s) return null; source = s; }
            let confidence: number | undefined;
            if (raw.confidence !== undefined) { const c = fin(raw.confidence); if (c === null) return null; confidence = Math.max(0, Math.min(1, c)); }
            return { kind: 'learn', fact, actor, source, via, confidence };
        }
        case 'lie': {
            const id = ident(raw.id), actor = entity(raw.actor), target = entity(raw.target), text = txt(raw.text, 240);
            if (!id || !text || !actor || !target || actor === target) return null;
            const fact = optFact(raw, true);
            return { kind: 'lie', id, actor, target, text, ...(fact ? { fact } : {}) };
        }
        case 'relation': {
            const actor = entity(raw.actor), target = entity(raw.target), reason = txt(raw.reason, 160);
            if (!actor || !target || actor === target || !reason) return null;
            const deltas: Partial<Record<Axis, number>> = {};
            let any = false;
            for (const ax of AXES) {
                if (raw[ax] === undefined) continue;
                const n = fin(raw[ax]);
                if (n === null) return null;
                deltas[ax] = Math.max(-REL_CAP, Math.min(REL_CAP, n));
                any = true;
            }
            if (!any) return null;
            const fact = optFact(raw, false);
            return { kind: 'relation', actor, target, reason, ...deltas, ...(fact ? { fact } : {}) };
        }
        case 'agreement': {
            const a = entity(raw.a), b = entity(raw.b), terms = txt(raw.terms, 240);
            const mode = raw.mode === 'exclusive' || raw.mode === 'open' || raw.mode === 'conditional' ? raw.mode : null;
            if (!a || !b || !mode || !terms || a === b) return null;
            return { kind: 'agreement', a, b, mode, terms };
        }
        case 'agenda': {
            const actor = entity(raw.actor), id = ident(raw.id), goal = txt(raw.goal, 160);
            if (!actor || !id || !goal) return null;
            if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 8) return null;
            const steps: { text: string; minutes: number }[] = [];
            for (const s of raw.steps) {
                if (!isObj(s)) return null;
                const t = txt(s.text, 160), m = fin(s.minutes);
                if (!t || m === null || !Number.isInteger(m) || m < 1 || m > 1440) return null;
                steps.push({ text: t, minutes: m });
            }
            const status = raw.status === undefined || raw.status === 'active' || raw.status === 'planned' ? 'active' : raw.status === 'cancelled' ? 'cancelled' : raw.status === 'completed' ? 'completed' : null;
            if (!status) return null;
            return { kind: 'agenda', actor, id, goal, steps, status };
        }
        case 'thread': {
            const id = ident(raw.id), text = txt(raw.text, 200);
            const actors = entList(raw.actors, 6, 1);
            const status = raw.status === 'open' || raw.status === 'resolved' || raw.status === 'cancelled' ? raw.status : null;
            if (!id || !text || !actors || !status) return null;
            if (raw.due !== undefined) { const d = fin(raw.due); if (d === null || !Number.isInteger(d) || d < 0) return null; return { kind: 'thread', id, text, actors, status, due: d }; }
            return { kind: 'thread', id, text, actors, status };
        }
        case 'emotion': {
            const actor = entity(raw.actor);
            if (!actor) return null;
            const v = fin(raw.valence), a = fin(raw.arousal), d = fin(raw.dominance);
            if (v === null || a === null || d === null) return null;
            const reason = raw.reason === undefined ? null : txt(raw.reason, 160);
            if (raw.reason !== undefined && reason === null) return null;
            return { kind: 'emotion', actor, valence: clamp1(v), arousal: clamp1(a), dominance: clamp1(d), ...(reason ? { reason } : {}) };
        }
        case 'wardrobe': {
            const actor = entity(raw.actor);
            if (!actor) return null;
            if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 16) return null;
            const items: NItem[] = [];
            for (const it of raw.items) {
                if (!isObj(it)) return null;
                const id = ident(it.id), name = txt(it.name, 80), loc = txt(it.location, 80);
                const state = it.state === 'worn' || it.state === 'stored' ? it.state : null;
                if (!id || !name || !loc || !state) return null;
                let condition = '';
                if (it.condition !== undefined) { const c = txt(it.condition, 80); if (!c) return null; condition = c; }
                items.push({ id, name, state, location: loc, ...(condition ? { condition } : {}) });
            }
            return { kind: 'wardrobe', actor, items };
        }
    }
    return null;
}

const clamp1 = (n: number) => Math.max(-1, Math.min(1, Math.round(n * 1000) / 1000));

// The AI's raw answer → validated events. Tolerates prose and code fences around the JSON (the model likes them),
// reads only the first MAX_EVENTS of the array, and silently drops anything that does not validate. Never throws.
export function parseNarrativeEvents(raw: string, context: NarrativeContext): NarrativeEvent[] {
    if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_INPUT) return [];
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch {
        const s = raw.indexOf('['), e = raw.lastIndexOf(']');
        if (s < 0 || e <= s) return [];
        try { json = JSON.parse(raw.slice(s, e + 1)); } catch { return []; }
    }
    if (!Array.isArray(json)) return [];
    const out: NarrativeEvent[] = [];
    for (const item of json.slice(0, MAX_EVENTS)) {
        const ev = validEvent(item, context);
        if (ev) out.push(ev);
    }
    return out;
}

/* ---------- the replay: the entries are the only truth ---------- */

// Rebuilds the whole narrative subsystem from the entries (newest definitions of a duplicated key win, in order),
// leaving every other system of the save untouched. Agendas advance and moods cool with each entry's clock; an
// out-of-order entry simply contributes no elapsed time (the clock never goes back). At the end the game's own
// clock (day*1440+minutes) carries agendas and moods the rest of the way, without entries of their own.
export function reconcileNarrative(g: Save, entries: { key: string; events: NarrativeEvent[]; context: NarrativeContext }[]): void {
    const st = freshStore();
    (g as any).narrative = st;
    if (!Array.isArray(entries)) return;
    const keyOf = (en: any, i: number) => (typeof en?.key === 'string' && en.key ? en.key : `#${i}`);
    const last = new Map<string, number>();
    entries.forEach((en: any, i: number) => last.set(keyOf(en, i), i));
    entries.forEach((en: any, i: number) => {
        if (last.get(keyOf(en, i)) !== i) return;             // a re-generated source: its last version is the one that counts
        if (!isObj(en) || !isObj(en.context)) return;
        const ctx = en.context as unknown as NarrativeContext;
        const at = fin(ctx.at) ?? st.lastAt;
        advanceTime(st, Math.max(0, at - st.lastAt));
        st.lastAt = Math.max(st.lastAt, at);
        const events = Array.isArray(en.events) ? en.events : [];
        for (let k = 0; k < events.length && k < MAX_EVENTS; k++) {
            const ev = validEvent(events[k], ctx);
            if (ev) applyEvent(st, ev, ctx, at);
        }
    });
    const gameNow = Number(g?.day) * 1440 + Number(g?.minutes);
    if (Number.isFinite(gameNow) && gameNow > st.lastAt) { advanceTime(st, gameNow - st.lastAt); st.lastAt = gameNow; }
}

function advanceTime(st: NarrativeStore, dt: number): void {
    if (dt <= 0) return;
    for (const ag of Object.values(st.agendas)) {
        if (ag.status !== 'active') continue;
        ag.spent += dt;
        if (ag.spent >= ag.steps.reduce((s, x) => s + x.minutes, 0)) { ag.status = 'ready'; ag.consequence = 'pending'; }   // ready — but the engine never plays it out
    }
    const f = Math.pow(0.5, dt / DECAY_HALF);
    for (const [who, e] of Object.entries(st.emotions)) {
        for (const k of ['valence', 'arousal', 'dominance'] as const) {
            const v = e[k] * f;
            e[k] = Math.abs(v) < 0.02 ? 0 : Math.round(v * 1000) / 1000;
        }
        if (!e.valence && !e.arousal && !e.dominance) delete st.emotions[who];
    }
}

function applyEvent(st: NarrativeStore, ev: Valid, ctx: NarrativeContext, at: number): void {
    const present = presentOf(ctx);
    switch (ev.kind) {
        case 'fact': {
            if (st.facts[ev.id]) return;                       // the first version of a fact stands
            const place = txt(ctx?.place, 80) ?? '';
            st.facts[ev.id] = { id: ev.id, text: ev.text, subjects: ev.subjects, witnesses: ev.witnesses, secret: ev.secret, tags: ev.tags, at, place };
            for (const w of ev.witnesses) {                    // only the witnesses know it — and seeing it is knowing it
                const k = (st.knowledge[w] ??= Object.create(null));
                k[ev.id] = { via: 'witness', source: place, at };
                onLearned(st, w, st.facts[ev.id], at);
            }
            return;
        }
        case 'learn': {
            const f = st.facts[ev.fact];
            if (!f || !present.has(ev.actor)) return;
            if (ev.via === 'told' && (!present.has(ev.source) || !st.knowledge[ev.source]?.[ev.fact])) return;   // nobody tells what they do not know
            const k = (st.knowledge[ev.actor] ??= Object.create(null));
            k[ev.fact] = { via: ev.via, source: ev.source, at, ...(ev.confidence !== undefined ? { confidence: ev.confidence } : {}) };
            onLearned(st, ev.actor, f, at);
            return;
        }
        case 'lie': {
            if (!present.has(ev.actor) || !present.has(ev.target)) return;   // told face to face
            if (st.lies[ev.id]) return;
            st.lies[ev.id] = { id: ev.id, actor: ev.actor, target: ev.target, text: ev.text, ...(ev.fact ? { fact: ev.fact } : {}), at };
            return;
        }
        case 'relation': {
            if (!present.has(ev.actor)) return;                // feelings move where the person is
            if (ev.fact && !(st.facts[ev.fact] && st.knowledge[ev.actor]?.[ev.fact])) return;   // "because of that": they must know it
            for (const ax of AXES) { const d = ev[ax]; if (d) bump(st, ev.actor, ev.target, ax, d, at, ev.reason); }
            return;
        }
        case 'agreement': {
            if (!present.has(ev.a) || !present.has(ev.b)) return;   // struck between two people in the room
            st.agreements[[ev.a, ev.b].sort().join('|')] = { a: ev.a, b: ev.b, mode: ev.mode, terms: ev.terms, at };
            return;
        }
        case 'agenda': {
            if (!present.has(ev.actor)) return;                // their own intention, in their own person
            st.agendas[`${ev.actor}|${ev.id}`] = { actor: ev.actor, id: ev.id, goal: ev.goal, steps: ev.steps, createdAt: at, spent: 0, status: ev.status, updatedAt: at };
            return;
        }
        case 'thread': {
            if (!ev.actors.some(a => present.has(a))) return;  // a matter is moved by someone in it, not from afar
            const old = st.threads[ev.id];
            st.threads[ev.id] = { id: ev.id, text: ev.text, actors: ev.actors, status: ev.status, updatedAt: at, ...(ev.due !== undefined ? { due: ev.due } : old?.due !== undefined ? { due: old.due } : {}) };
            return;
        }
        case 'emotion': {
            if (!present.has(ev.actor)) return;
            st.emotions[ev.actor] = { valence: ev.valence, arousal: ev.arousal, dominance: ev.dominance, ...(ev.reason ? { reason: ev.reason } : {}), at };
            return;
        }
        case 'wardrobe': {
            if (!present.has(ev.actor)) return;
            const w = (st.wardrobe[ev.actor] ??= Object.create(null));
            for (const it of ev.items) w[it.id] = it;
            return;
        }
    }
}

function bump(st: NarrativeStore, actor: string, target: string, axis: Axis, delta: number, at: number, reason: string): void {
    const mine = (st.relations[actor] ??= Object.create(null));
    const rel = (mine[target] ??= { trust: 0, affection: 0, resentment: 0, fear: 0, log: [] });
    const before = rel[axis];
    rel[axis] = Math.max(-REL_CAP, Math.min(REL_CAP, before + delta));
    const moved = Math.round((rel[axis] - before) * 10) / 10;
    rel.log.push({ at, what: `${axis} ${moved >= 0 ? '+' : ''}${moved}`, reason });
    if (rel.log.length > 5) rel.log.splice(0, rel.log.length - 5);
}

// A fact tagged as a pact-breaker, once actually known — witnessed as it happened, or learned later — bites: a
// little, once, toward the other party of each closed pact the knower has with a subject of the fact. An open
// pact has nothing to break; a fact older than the pact never violated it; the tag alone (nobody knows) does
// nothing; already-resented knowledge is not resent again.
function onLearned(st: NarrativeStore, who: string, f: NFact, at: number): void {
    if (!f.tags.some(t => VIOLATION_TAGS.includes(t))) return;
    for (const ag of Object.values(st.agreements)) {
        if (ag.mode === 'open') continue;
        if (ag.a !== who && ag.b !== who) continue;
        if (f.at < ag.at) continue;
        const other = ag.a === who ? ag.b : ag.a;
        if (!f.subjects.includes(other)) continue;
        const key = `${who}|${f.id}|${other}`;
        if (st.violations[key]) continue;
        st.violations[key] = true;
        bump(st, who, other, 'resentment', VIOLATION_RESENTMENT, at, `learned: ${f.text}`.slice(0, 160));
    }
}

/* ---------- lines for the AI ---------- */

const sign = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`;
const vad = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
const dayOf = (at: number) => `day ${Math.floor(at / 1440)}`;
function agendaStep(ag: NAgenda): number {
    let left = ag.spent;
    for (let i = 0; i < ag.steps.length; i++) { if (left < ag.steps[i].minutes) return i + 1; left -= ag.steps[i].minutes; }
    return ag.steps.length;
}
const wornLine = (who: string, items: NItem[]) => `${who} is wearing: ${items.slice(0, 8).map(i => i.name + (i.condition ? ` (${i.condition})` : '')).join(', ')}`;

// The narrative block for the prompt. With a `speaker`: strictly what that one person knows and carries — their
// facts, feelings, pacts, lies (the words they were told, the truth only on the liar's side), agendas, threads
// they are in, and their whole wardrobe, stored pieces with where and how. Without a speaker the block is a
// shared, conservative room: the facts everyone present knows (the intersection, so a room never betrays a
// secret), what is observably worn, and a pact only when everyone present is party to it. Private states —
// relations, moods, agendas, threads — never appear without a speaker. Autonomous guidance, not a preset.
export function narrativeLines(g: Save, present: { avatar: string; name: string }[], speaker?: string): string[] {
    const st: NarrativeStore = narrativeState(g);
    const people = (Array.isArray(present) ? present : []).filter(p => p && typeof p.avatar === 'string' && p.avatar) as { avatar: string; name: string }[];
    const nameOf = new Map<string, string>(people.map(p => [p.avatar, String(p.name ?? p.avatar)]));
    const nm = (id: string) => nameOf.get(id) ?? g.cast?.[id]?.name ?? (id === '__you' ? '{{user}}' : id);
    const here = people.map(p => p.avatar);
    if (speaker && !here.includes(speaker)) speaker = undefined;
    const audience = speaker ? [speaker] : here;
    const lines: string[] = [];
    let used = 0;
    const push = (s: string) => {
        const line = s.length > 420 ? s.slice(0, 417) + '…' : s;
        if (lines.length && used + line.length > LINES_BUDGET) return;
        lines.push(line);
        used += line.length + 1;
    };
    push('[Narrative core — autonomous internal states, for the AI only. They shape how people act, speak and feel; they are a live background, not a script, and nobody has to mention or follow them aloud.]');
    // what the audience knows
    const knows = (fid: string) => audience.length > 0 && audience.every(a => !!st.knowledge[a]?.[fid]);
    const known = Object.values(st.facts).filter(f => knows(f.id)).sort((a, b) => a.at - b.at).slice(-6);
    if (known.length) push(`Information available to ${speaker ? nm(speaker) : 'everyone here'} (reports are not proof): ` + known.map(f => {
        const k = st.knowledge[audience[0]]?.[f.id];
        return `(${dayOf(f.at)}, ${k?.via ?? 'unknown source'}${k?.confidence !== undefined ? `, confidence ${k.confidence}` : ''}) ${f.text}${f.secret ? ' [secret]' : ''}`;
    }).join(' '));
    if (speaker) {
        // one voice: strictly the speaker's own inner world
        const who = speaker;
        const rels = st.relations[who];
        if (rels) {
            const parts: string[] = [];
            for (const [t, r] of Object.entries(rels)) {
                const ax = AXES.filter(a => r[a]).map(a => `${a} ${sign(r[a])}`);
                if (ax.length) parts.push(`→ ${nm(t)} (${ax.join(', ')}${r.log.length ? `: ${r.log.at(-1)!.reason}` : ''})`);
            }
            if (parts.length) push(`${nm(who)}'s private feelings: ${parts.join('; ')}`);
        }
        const e = st.emotions[who];
        if (e && Math.abs(e.valence) + Math.abs(e.arousal) + Math.abs(e.dominance) > 0.05)
            push(`${nm(who)}'s mood: valence ${vad(e.valence)}, arousal ${vad(e.arousal)}, dominance ${vad(e.dominance)}${e.reason ? ` (${e.reason})` : ''}`);
        for (const ag of Object.values(st.agendas)) {
            if (ag.actor !== who || ag.status === 'cancelled' || ag.status === 'completed') continue;
            push(ag.status === 'ready'
                ? `${nm(who)}'s agenda "${ag.goal}": the time for it is spent — its consequence is still waiting to happen`
                : `${nm(who)}'s agenda "${ag.goal}": step ${agendaStep(ag)}/${ag.steps.length} "${ag.steps[agendaStep(ag) - 1].text}" (${Math.round(ag.spent)} min in)`);
        }
        const mine = Object.values(st.wardrobe[who] ?? {});
        const worn = mine.filter(i => i.state === 'worn'), stored = mine.filter(i => i.state === 'stored');
        if (worn.length) push(wornLine(nm(who), worn));
        if (stored.length) push(`${nm(who)} has put away: ${stored.slice(0, 8).map(i => `${i.name} — ${i.location}${i.condition ? ` (${i.condition})` : ''}`).join(', ')}`);
        for (const l of Object.values(st.lies).filter(l => l.actor === who).slice(-2)) push(`Lie ${nm(who)} told ${nm(l.target)}: "${l.text}"${l.fact ? ` (the truth: ${l.fact})` : ''}`);
        for (const l of Object.values(st.lies).filter(l => l.target === who).slice(-2)) push(`${nm(l.actor)} told ${nm(who)}: "${l.text}"`);
        for (const ag of Object.values(st.agreements)) {
            if (ag.a !== who && ag.b !== who) continue;
            push(`Your ${ag.mode} agreement with ${nm(ag.a === who ? ag.b : ag.a)}: ${ag.terms}`);
        }
        for (const th of Object.values(st.threads)) {
            if (th.status !== 'open' || !th.actors.includes(who)) continue;
            push(`Open thread: ${th.text} (${th.actors.map(nm).join(', ')})${th.due !== undefined && th.due < st.lastAt ? ' — past due, still open' : ''}`);
        }
    } else {
        // a shared room: only what the room can observe
        for (const who of here) {
            const worn = Object.values(st.wardrobe[who] ?? {}).filter(i => i.state === 'worn');
            if (worn.length) push(wornLine(nm(who), worn));
        }
        for (const ag of Object.values(st.agreements)) {
            if (!here.length || !here.every(p => ag.a === p || ag.b === p)) continue;   // only when everyone present is party to it
            push(`${nm(ag.a)} and ${nm(ag.b)} have a ${ag.mode} agreement: ${ag.terms}`);
        }
    }
    return lines;
}
