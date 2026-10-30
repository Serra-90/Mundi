// The narrative states runtime: the bridge between the live chat and the narrative subsystem (narrative.ts).
// When a reply completes it makes one quiet AI call (outside the conversation, no preset, no HTML) asking only
// for the narrative event deltas of that single message — facts, lies, promises, feelings, wardrobes… — and hands
// them to reconcileNarrative, oldest source first and with the state replayed before every call, so events that
// depend on earlier ones see them. What was processed is remembered in a ledger on the save, keyed by each
// message's content, its swipe variant AND a digest of everything said before it: a user edit, deletion or swipe
// upstream invalidates everything that depends on it. Nothing here writes the engine's own state (stats,
// positions, romance): the native systems stay native, and the diary never counts the same thing twice.
import { chat, quiet, currentChatId, speakerOf, personaName, nameOf, on, saveChat } from '../st/bridge.js';
import { game, cfg, saveGame, state, nowAbs, type Save } from '../core/store.js';
import { getWorld, type WorldDef } from '../core/world.js';
import { presentAt } from './people.js';
import { placeName } from './facts.js';
import { parseNarrativeEvents, reconcileNarrative, narrativeState, type NarrativeContext, type NarrativeEvent } from './narrative.js';

/* ---------- the ledger, on the save ---------- */

// One processed source message: its key (content + swipe + dependency prefix), where it sat in the chat, the
// events the AI returned for it, and the scene as it was when the message arrived (captured at receipt, never
// recomputed from where the player happens to be later).
export interface NarrativeRecord { key: string; index: number; events: NarrativeEvent[]; context: NarrativeContext }
interface CacheEntry { key: string; events: NarrativeEvent[]; context: NarrativeContext }
export interface NarrativeLedger {
    version: 1;
    /** chat length when the ledger was created (at install, before the first reply): history is never processed */
    baseline: number;
    /** fingerprint of the last message at that moment: the anchor that survives deletions above the baseline */
    anchor: string;
    /** the processed sources that are still in the chat, in chat order (rebuilt on every sync) */
    records: NarrativeRecord[];
    /** bounded most-recently-used event variants, keyed with their full dependency prefix, so a swipe that comes
     *  back restores its own events — and a descendant never reuses a cache entry built on another prefix */
    cache: CacheEntry[];
    /** keys the AI failed on (malformed JSON, unusable answers), to stop paying for a message it cannot parse */
    failed?: Record<string, number>;
    /** the last failure, for the diagnostics line */
    err?: { key: string; msg: string; at: number } | null;
}

const CACHE_MAX = 48;      // event variants kept (swipes and edits that may come back)
const FAIL_MAX = 3;        // tries per source before it is left alone (and shown in diagnostics)
const PER_RUN = 4;         // sources extracted in one pass (group replies arrive one by one; this catches up)
const DRAIN_RUNS = 6;      // extra passes one drain may chain for a burst, so a backlog cannot loop forever
const RESP_LEN = 1800;     // the quiet call's answer room (events only, no prose)
const TEXT_LIMIT = 10000;  // rough cap on the source text the prompt carries
const SNAP_LINES = 40;     // snapshot lines about the current narrative state (ids WITH their meaning)
const SNAP_CHARS = 3600;
// The per-message context stamp (MESSAGE_RECEIVED/SENT, at receipt). Context only: when and where, who was
// present. Never events, never a secret — a message carries nothing the story has not already shown.
const STAMP = 'mundiNarrativeContext';
export interface NarrativeStamp { at: number; place: string; present: string[] }

// Per-save switch: on unless the save says no.
export const narrativeOn = (g: Save) => (cfg(g) as any).narrativeStates !== false;
const ledgerOf = (g: Save): NarrativeLedger => ((g as any).narrativeLedger ??= { version: 1, baseline: chat().length, anchor: anchorOf(chat().at(-1)), records: [], cache: [] } as NarrativeLedger);
// The baseline is written when the runtime is installed (or a chat opens), BEFORE the first reply — not after
// it: the first reply of a fresh save is narrative, not history.
export function ensureNarrativeLedger() {
    const g = game();
    if (g && narrativeOn(g) && !(g as any).narrativeLedger) { ledgerOf(g); saveGame(); }
}

/* ---------- keys: content + swipe + the prefix it depends on ---------- */

const hash64 = (s: string) => {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a ^= c; a = Math.imul(a, 16777619);
        b = Math.imul(b ^ (c + i), 2246822519); b = (b ^ (b >>> 13)) >>> 0;
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
};
// The text as the story tells it: thoughts and HTML out, whitespace collapsed.
const canonical = (raw: unknown) => String(raw ?? '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// A message's fingerprint: who spoke (a reply hidden with /hide keeps its author — never "system"), which swipe
// of it, when it was sent, and what it says. send_date keeps two identical replies from colliding.
function fingerprintOf(m: any): string {
    if (!m) return '';
    const who = m.is_user ? '__you' : speakerOf(m) ?? String(m.name ?? '?');
    const swipe = Array.isArray(m.swipes) && typeof m.swipe_id === 'number' ? `s${m.swipe_id}` : 's';
    return hash64(`${who}|${swipe}|${String(m.send_date ?? '')}|${canonical(m.mes)}`);
}
// What a baseline is anchored to: the last message, whatever kind it is.
const anchorOf = (m: any) => (m ? fingerprintOf(m) : '');
// One message folded into the running prefix digest.
const fold = (chain: string, m: any) => hash64(`${chain}|${fingerprintOf(m)}|${m?.is_user ? 'u' : 'a'}`);

// A reply of the story: not the user's, not Mundi's canned lines (the engine already wrote their facts). Hiding
// a message (/hide) flips is_system on it, but a hidden reply is still a reply — its record survives; genuine
// system noise (no author, no swipes, no stamp of ours) is not a source.
const isReply = (m: any) => !!m && !m.is_user && !m.extra?.mundi &&
    (!!(m.original_avatar || stampOf(m) || m.gen_started) || (Array.isArray(m.swipes) && m.swipes.length > 0));

const stampOf = (m: any): NarrativeStamp | null => {
    const s = m?.extra?.[STAMP];
    return s && typeof s.at === 'number' && typeof s.place === 'string' && Array.isArray(s.present) ? s : null;
};
// The scene of a message, stamped the moment it lands: the ORIGINAL context for its extraction and for every
// later edit/swipe of it — not wherever the player happens to be now. The first line of a new game can arrive
// before the save was even set (CHAT_CHANGED ran early): the stamp ensures the ledger first, so the first reply
// is narrative, never history. The stamp is persisted with the chat — once per message, not per snapshot.
export function stampNarrative(id: number) {
    ensureNarrativeLedger();
    const g = game(); const m = chat()[id];
    if (!g || !m || stampOf(m)) return;
    const w = getWorld(g.world);
    if (!w) return;
    m.extra ??= {};
    m.extra[STAMP] = { at: nowAbs(g), place: g.player.loc, present: ['__you', ...presentAt(g, w, g.player.loc).map(r => r.avatar)] };
    saveChat();
}

interface Source { index: number; key: string; speaker: string | null; text: string; before: string; ctx: NarrativeContext | null }

// The player's id and every person of the save: the only entities events may name.
const actorsOf = (g: Save): string[] => ['__you', ...Object.keys(g.cast)];
const liveContext = (g: Save, w: WorldDef): NarrativeContext =>
    ({ at: nowAbs(g), place: g.player.loc, present: ['__you', ...presentAt(g, w, g.player.loc).map(r => r.avatar)], ids: actorsOf(g) });
const contextFromStamp = (g: Save, s: NarrativeStamp): NarrativeContext =>
    ({ at: s.at, place: s.place, present: [...new Set(['__you', ...s.present.filter((x: unknown): x is string => typeof x === 'string')])], ids: actorsOf(g) });

// Where history ends today. The anchor message is found by its fingerprint (it may have moved after deletions
// above the baseline); when it is gone, the saved count still skips the same leading messages.
function baselineNow(ledger: NarrativeLedger, list: any[]): number {
    if (ledger.anchor) for (let i = list.length - 1; i >= 0; i--) if (fingerprintOf(list[i]) === ledger.anchor) return i + 1;
    return Math.min(ledger.baseline, list.length);
}

// Walks the chat once: the candidate sources (with their dependency-chained keys and their original context) and
// the chat's whole digest. A source's key folds in its speaker, swipe, text, send_date, the last user line
// before it and the digest of EVERYTHING before it — so an edit, deletion or swipe upstream gives every
// descendant a new key (re-extracted, never mixed with a cache entry of the old prefix).
function scan(g: Save, w: WorldDef, ledger: NarrativeLedger): { sources: Source[]; sig: string } {
    const list = chat();
    const from = baselineNow(ledger, list);
    const out: Source[] = [];
    const seen = new Map<string, number>();
    let chain = '0';
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (i >= from && isReply(m)) {
            const text = canonical(m.mes);
            if (text) {
                const fp = fingerprintOf(m);
                const n = (seen.get(fp) ?? 0) + 1; seen.set(fp, n);
                // the user's last line before this reply — hidden ones included: /hide must not change what the
                // reply answered, so hiding a line never moves a key
                let before = '';
                for (let j = i - 1; j >= 0; j--) if (list[j]?.is_user) { before = canonical(list[j].mes); break; }
                const stamp = stampOf(m);
                // context: the message's own stamp; a source without one (the event was missed, or an old chat was
                // loaded) invents nothing — only the LATEST message may fall back to the live scene.
                const ctx = stamp ? contextFromStamp(g, stamp) : i === list.length - 1 ? liveContext(g, w) : null;
                out.push({ index: i, key: `${hash64(`${fp}|${before}|${chain}`)}#${n}`, speaker: speakerOf(m), text, before, ctx });
            }
        }
        chain = fold(chain, m);
    }
    return { sources: out, sig: chain };
}

/* ---------- the quiet call ---------- */

// What the extractor needs to keep ids stable: the relevant facts WITH their texts and who knows them HOW (an id
// alone says nothing, and a truth nobody present knows is never offered as one), plus the open matters. Bounded,
// and shown to this technical extractor only — the scene's own prompt is narrativeLines', which keeps secrets
// private. Facts surface only as someone's knowledge, with their provenance.
function snapshot(g: Save, present: string[]): string {
    const st: any = narrativeState(g);
    const lines: string[] = [];
    const nm = (id: string) => id === '__you' ? personaName() : g.cast[id]?.name ?? id;
    const known = new Set<string>();
    const knows: string[] = [];
    for (const a of present) for (const [fid, k] of Object.entries(st?.knowledge?.[a] ?? {}) as [string, any][]) {
        known.add(fid);
        knows.push(`${nm(a)} knows ${fid} (${k.via}${k.via !== 'witness' ? `, from: ${String(k.source ?? '').slice(0, 48)}` : ''})`);
    }
    for (const f of (Object.values(st?.facts ?? {}) as any[]).filter(f => f && known.has(f.id)).slice(-24))
        lines.push(`fact ${f.id}: "${String(f.text).slice(0, 140)}"${f.secret ? ' (secret)' : ''}`);
    lines.push(...knows.slice(-12));
    for (const t of (Object.values(st?.threads ?? {}) as any[]).filter(t => t?.status === 'open' && (t.actors ?? []).some((a: string) => present.includes(a))).slice(-8))
        lines.push(`thread ${t.id} "${String(t.text).slice(0, 100)}" (${t.status})`);
    for (const a of (Object.values(st?.agendas ?? {}) as any[]).filter(a => a && a.status !== 'cancelled' && a.status !== 'completed' && present.includes(a.actor)).slice(-8))
        lines.push(`agenda ${a.id} of ${nm(a.actor)}: ${String(a.goal).slice(0, 100)}`);
    for (const p of (Object.values(st?.agreements ?? {}) as any[]).filter(p => p && (present.includes(p.a) || present.includes(p.b))).slice(-6))
        lines.push(`agreement ${p.a} + ${p.b} (${p.mode}): ${String(p.terms).slice(0, 100)}`);
    for (const l of (Object.values(st?.lies ?? {}) as any[]).filter(l => l && (present.includes(l.actor) || present.includes(l.target))).slice(-6))
        lines.push(`lie ${l.id}: ${nm(l.actor)} told ${nm(l.target)} "${String(l.text).slice(0, 100)}"`);
    for (const a of present) for (const it of (Object.values(st?.wardrobe?.[a] ?? {}) as any[]).slice(-8))
        lines.push(`wardrobe ${it.id} of ${nm(a)}: ${it.state} "${String(it.name).slice(0, 60)}" (${String(it.location).slice(0, 40)})`);
    return lines.slice(0, SNAP_LINES).join('\n').slice(0, SNAP_CHARS);
}

const YOU = '__you';
// Only structured event deltas. No HTML, no role-play instructions, no preset: the system prompt is empty and the
// answer is nothing but a JSON array (empty when nothing happened). The schema is exactly narrative.ts's events.
function buildPrompt(g: Save, w: WorldDef, s: Source, context: NarrativeContext, snap: string): string {
    const meName = personaName();
    const who = (id: string) => id === YOU ? `${YOU} (${meName}, the player)` : `${id} (${g.cast[id]?.name ?? nameOf(id)})`;
    const clock = `${String(Math.floor((context.at % 1440) / 60)).padStart(2, '0')}:${String(context.at % 60).padStart(2, '0')}`;
    const reply = s.text.slice(0, 7000);
    const before = s.before.slice(0, Math.max(500, TEXT_LIMIT - reply.length - 1600));
    const author = s.speaker ? (g.cast[s.speaker]?.name ?? nameOf(s.speaker)) : 'the storyteller';
    return `You keep the narrative memory of a role-play. Read ONE reply of the story and output the events that the reply clearly ESTABLISHES. Output ONLY a JSON array of event objects — no prose, no markdown, no HTML, no code fence. When nothing of consequence happened, output [] .

Event kinds (exactly these shapes; people are named by their exact id below):
- {"kind":"fact","id":"a-stable-id","text":"what is now true","subjects":["id"],"witnesses":["id"],"secret":false,"tags":["word"]}  — every witness was present and saw it; secret true only when others present did NOT hear/see it; tags: up to 4 words, "agreement-break" or "betrayal" when a pact was broken
- {"kind":"learn","fact":"an-id-from-below","actor":"id","source":"id or the evidence itself","via":"told","confidence":0.9}  — via is "told" (source must be a person present who knows the fact) or "evidence"
- {"kind":"lie","id":"a-stable-id","actor":"id","target":"id","text":"the lie told","fact":"the truth, if the story showed it"}
- {"kind":"relation","actor":"id","target":"id","trust":2,"affection":-1,"resentment":0,"fear":0,"reason":"why","fact":"an-id-from-below"}  — each axis −10…10, only where the story moved it; "fact" only if the actor knows it
- {"kind":"agreement","a":"id","b":"id","mode":"exclusive","terms":"what was agreed"}  — mode is "exclusive", "open" or "conditional"
- {"kind":"agenda","actor":"id","id":"a-stable-id","goal":"what they now intend to do","steps":[{"text":"first step","minutes":30}],"status":"active"}  — whole minutes; reuse id and set status "completed" only when the story actually completes it, or "cancelled" when abandoned
- {"kind":"thread","id":"a-stable-id","text":"the open matter","actors":["id"],"status":"open","due":650}  — status is "open", "resolved" or "cancelled"; due is absolute minutes
- {"kind":"emotion","actor":"id","valence":0,"arousal":0,"dominance":0,"reason":"why"}  — each from -1 to 1
- {"kind":"wardrobe","actor":"id","items":[{"id":"a-stable-id","name":"red dress","state":"worn","location":"${YOU}","condition":"clean"}]}  — state is "worn" or "stored"

Rules:
- Only events this text clearly establishes as said, done, seen or agreed. An intention is not a completed action.
- ${meName}'s private thoughts are not observable: only what ${meName} visibly said or did.
- Knowledge changes only through clear communication ("told", by someone present who knows it) or evidence; do not scan anyone's mind or card.
- Reuse the ids below when an event updates that fact, thread, agenda or wardrobe piece; new ids short, lowercase, stable.
- Ordinary small talk is [] .

Scene when this happened: day ${Math.floor(context.at / 1440)}, ${clock}, at ${placeName(g, w, context.place)}. Present: ${context.present.map(who).join(', ')}.
People (use these exact ids): ${context.ids.map(who).join(', ')}.
Narrative state so far (ids with their meaning):
${snap || '(nothing yet)'}
${before ? `The user's line before it:\n${before}\n\n` : ''}The reply, by ${author}:\n${reply}

Events:`;
}

/* ---------- the answer: envelope first, then the parser ---------- */

// narrative.ts answers [] to anything it cannot read, so [] as "nothing happened" and [] as "the answer was
// garbage" must be told apart HERE, before the parser: the envelope is checked first, and a non-empty array that
// validates to zero events is a failure, not a no-op.
function envelope(raw: string): 'empty' | 'malformed' | 'events' {
    const s = raw.indexOf('['), e = raw.lastIndexOf(']');
    if (s < 0 || e <= s) return 'malformed';
    try { const json: unknown = JSON.parse(raw.slice(s, e + 1)); if (!Array.isArray(json)) return 'malformed'; return json.length ? 'events' : 'empty'; }
    catch { return 'malformed'; }
}

/* ---------- sync: serialized, coalesced, race-checked ---------- */

let inFlight: Promise<void> | null = null;
let again = false, againExtract = false;
// One drain (the chain of runs a single trigger starts): the keys already TRIED, so a failure is never retried
// inside the same drain, and how many extra passes it may chain for a burst of arrivals.
let drainAttempted: Set<string> | null = null;
let drainRuns = 0;
export const narrativeBusy = () => inFlight !== null;

// The one entry point. `extract` (default true) lets the AI be asked about new replies; false only rebuilds the
// ledger against the chat as it is now (a deletion, a chat switch, an interrupted generation). Calls while one
// runs are coalesced into it — a reply that lands mid-extraction is never dropped, it runs right after.
export function syncNarrative(options: { extract?: boolean } = {}): Promise<void> {
    if (inFlight) { again = true; if (options.extract !== false) againExtract = true; return inFlight; }
    let extract = options.extract !== false;
    drainAttempted = new Set(); drainRuns = 0;
    inFlight = (async () => {
        for (;;) {
            await once(extract);
            if (!again) break;
            again = false; extract = againExtract; againExtract = false;
        }
    })().finally(() => { inFlight = null; again = false; againExtract = false; drainAttempted = null; drainRuns = 0; });
    return inFlight;
}

// The scene's prompt follows the new state. prompt.ts is imported dynamically (it pulls half the simulation in,
// and the simulation will call back here): no static cycle, and a failure to refresh is only a stale prompt.
const refreshAfter = () => { void import('./prompt.js').then(m => { m.refreshPrompt(); }).catch(() => { }); };

async function once(extract: boolean) {
    const g = game();
    if (!g || !narrativeOn(g)) return;
    const w = getWorld(g.world);
    if (!w) return;
    const cid = currentChatId();                     // captured before anything is awaited
    const ledger = ledgerOf(g);
    const { sources } = scan(g, w, ledger);

    // Rebuild: only records whose message is still in the chat (as selected now) stay active — hidden ones too.
    const at = new Map(sources.map(s => [s.key, s.index]));
    let records = ledger.records.filter(r => at.has(r.key));
    for (const r of records) r.index = at.get(r.key)!;
    let changed = records.length !== ledger.records.length;
    // A variant comes back (a swipe switched back, an edit undone): its events return from the cache — the cache
    // is keyed by the full dependency prefix, so a descendant never picks up another prefix's events.
    for (const s of sources) {
        if (records.some(r => r.key === s.key)) continue;
        const c = ledger.cache.find(x => x.key === s.key);
        if (c) { records.push({ key: s.key, index: s.index, events: c.events, context: c.context }); changed = true; }
    }

    const reconcileNow = () => {
        records.sort((a, b) => a.index - b.index);
        ledger.records = records;
        reconcileNarrative(g, ledger.records.map(r => ({ key: r.key, events: r.events, context: r.context })));
    };
    // A failure is remembered only while the same save is still open in the same chat, under the same ledger
    // (a reset mid-flight kills it): nothing is ever written onto whatever the user switched to while we asked.
    const dead = () => game() !== g || currentChatId() !== cid || (g as any).narrativeLedger !== ledger;
    const fail = (key: string, e: unknown) => {
        if (dead()) return;
        const msg = String((e as any)?.message ?? e ?? 'no answer').slice(0, 160);
        ledger.err = { key, msg, at: Date.now() };
        (ledger.failed ??= {})[key] = ((ledger.failed ?? {})[key] ?? 0) + 1;
        const keys = Object.keys(ledger.failed);
        if (keys.length > 32) delete ledger.failed[keys[0]];
        console.warn('[Mundi] narrative states:', msg);
        saveGame();
    };

    // Extraction: OLDEST first (events depend on the ones before them), a few per pass, one quiet call each, with
    // the state replayed before every call. Never while the story itself is generating, and a key already tried in
    // this drain is not paid for again in it (its retries belong to a later event).
    if (extract && !state.generating) {
        const done = new Set(records.map(r => r.key));
        const pending = sources
            .filter(s => s.ctx && !done.has(s.key) && !ledger.cache.some(x => x.key === s.key) && ((ledger.failed ?? {})[s.key] ?? 0) < FAIL_MAX && !drainAttempted?.has(s.key))
            .sort((a, b) => a.index - b.index).slice(0, PER_RUN);
        for (const s of pending) {
            // A story generation waiting for this drain has priority over the next technical call.
            if (state.generating) break;
            drainAttempted?.add(s.key);             // tried in this drain, whatever the outcome
            const context = s.ctx!;                 // the ORIGINAL scene of the message, from its stamp (pending is ctx-filtered)
            reconcileNow();                         // dependencies land before the call that may cite them
            saveGame();
            let raw = '';
            try { raw = await quiet(buildPrompt(g, w, s, context, snapshot(g, context.present)), RESP_LEN, '', { exact: true }); }
            catch (e) { fail(s.key, e); continue; }
            // The world may have moved while we asked: same save, same chat, same ledger — or nothing is written.
            if (dead()) return;
            const now2 = scan(g, w, ledger);
            const cur = now2.sources.find(x => x.key === s.key);
            // ...and the message, with its whole prefix, still selected. A message ADDED after ours changes
            // nothing for us; anything changed before us invalidates the answer, which is then dropped.
            const prefix = (list: Source[], upto: number) => list.filter(x => x.index < upto).map(x => x.key).join('|');
            if (!cur || prefix(now2.sources, cur.index) !== prefix(sources, s.index)) return;
            const kind = envelope(String(raw ?? ''));
            if (kind === 'malformed') { fail(s.key, 'the answer was not a JSON array'); continue; }
            const events = parseNarrativeEvents(String(raw ?? ''), context);
            if (kind === 'events' && !events.length) { fail(s.key, 'no usable event in the answer'); continue; }
            records = records.filter(r => r.key !== s.key);
            records.push({ key: s.key, index: cur.index, events, context });
            ledger.cache = [{ key: s.key, events, context }, ...ledger.cache.filter(x => x.key !== s.key)].slice(0, CACHE_MAX);
            if (ledger.err?.key === s.key) ledger.err = null;
            changed = true;
        }
    }

    // Nothing stale commits: after awaits (and only then) the records are refiltered against the chat once more.
    if (extract && !dead()) {
        const last = scan(g, w, ledger);
        const keys = new Set(last.sources.map(x => x.key));
        const kept = records.filter(r => keys.has(r.key));
        if (kept.length !== records.length) { records = kept; changed = true; }
    }
    if (dead()) return;                               // a reset (or a chat switch) won while we worked: no commit
    if (changed) {
        reconcileNow();
        saveGame();
        refreshAfter();
    } else if (ledger.records.length) {
        // The clock moved, or the state was never rebuilt for this chat: moods cool and agendas advance even
        // when no record changed (rebuild-only syncs included).
        const st = (g as any).narrative;
        if (!st || Number(st.lastAt) !== nowAbs(g)) { reconcileNow(); saveGame(); }
    }
    // Auto-drain: a burst (a group turn) can be longer than one pass; while sources that were NEVER TRIED in this
    // drain remain, another extract pass is chained — bounded, and a failure never retriggers it (only fresh
    // keys do), so the drain always ends idle. Not while the story itself is generating: its own end re-triggers.
    if (extract && !state.generating && drainAttempted && drainRuns < DRAIN_RUNS && !dead()) {
        const tried = drainAttempted;
        const more = sources.some(s => s.ctx && !records.some(r => r.key === s.key) && !ledger.cache.some(x => x.key === s.key) && ((ledger.failed ?? {})[s.key] ?? 0) < FAIL_MAX && !tried.has(s.key));
        if (more) { again = true; againExtract = true; drainRuns++; }
    }
}

/* ---------- diagnostics and reset ---------- */

// One line for settings screens and the console: what ran, what waits, what failed.
export function narrativeDiagnostics(g: Save): string {
    if (!narrativeOn(g)) return 'Narrative states: off for this save (cfg.narrativeStates === false).';
    const ledger = (g as any).narrativeLedger as NarrativeLedger | undefined;
    if (!ledger) return `Narrative states: on (from message ${chat().length + 1}; the old messages are history).`;
    const w = getWorld(g.world);
    const { sources } = w ? scan(g, w, ledger) : { sources: [] as Source[] };
    const known = new Set([...ledger.records.map(r => r.key), ...ledger.cache.map(c => c.key)]);
    const pending = sources.filter(s => !known.has(s.key));
    const noCtx = pending.filter(s => !s.ctx).length;
    const failed = Object.keys(ledger.failed ?? {}).length;
    const err = ledger.err ? `; last error (…${ledger.err.key.slice(0, 8)}): ${ledger.err.msg}, ${new Date(ledger.err.at).toLocaleString()}` : '';
    return `Narrative states: on. History before message ${baselineNow(ledger, chat()) + 1}; processed ${ledger.records.length}; pending ${pending.length}${noCtx ? ` (${noCtx} without a captured context)` : ''}; failed ${failed}; cache ${ledger.cache.length}/${CACHE_MAX}${err}.`;
}

// Forgets the ledger AND the narrative state it produced (the save's other systems are untouched); the next sync
// baselines at the chat as it is then, and the scene's prompt is refreshed to the emptied state.
export function resetNarrative(g: Save) {
    delete (g as any).narrativeLedger;
    delete (g as any).narrative;
    saveGame();
    refreshAfter();
}

/* ---------- wiring (one call from the entry point) ---------- */

let installed = false;
// Follows SillyTavern's own events. A message is stamped the moment it lands (its original scene, before any
// deferred work). Finished generations and new variants (swipes, edits) extract — an interrupted generation never
// does, it only rebuilds. Generation events may also be our own quiet call's: those find the busy flag up, so
// they never loop; everything else coalesces into a running sync instead of being dropped.
export function installNarrativeRuntime() {
    if (installed) return;
    installed = true;
    ensureNarrativeLedger();
    const later = (extract: boolean) => () => setTimeout(() => { if (!narrativeBusy() && !(extract && state.generating)) void syncNarrative({ extract }); }, 250);
    const coalesce = (extract: boolean) => () => void syncNarrative({ extract });
    on('MESSAGE_RECEIVED', (id: number) => { stampNarrative(id); coalesce(true)(); });
    on('MESSAGE_SENT', (id: number) => stampNarrative(id));
    on('GENERATION_ENDED', later(true));
    on('GENERATION_STOPPED', later(false));          // incomplete: rebuild only
    on('MESSAGE_SWIPED', coalesce(true));            // the new variant is pending work, not just a rebuild
    on('MESSAGE_EDITED', coalesce(true));
    on('MESSAGE_DELETED', coalesce(false));
    on('CHAT_CHANGED', () => { ensureNarrativeLedger(); coalesce(false)(); });
}
