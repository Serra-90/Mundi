/* ---------- bounds and pacing ---------- */
const DIR_BUDGET = 1200; // the whole director block stays under this many characters
const DIR_LINE = 600; // any one line of it
const REL_STRONG = 6; // |axis| at least this strong: a feeling that may color a choice (axes live in ±10)
const MAJOR_EVERY = 3; // a major call-back returns at most every N-th ledger turn — a cooldown, not a timer
const MINOR_EVERY = 2; // a minor one, at most every other turn
const REL_AXES = ['trust', 'affection', 'resentment', 'fear'];
/* ---------- deterministic derivation: no RNG, no wall clock, no stored state ---------- */
// FNV-1a over the string: the same inputs always hash the same, so the same save renders the same lines.
const hash32 = (s) => {
    let a = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        a ^= s.charCodeAt(i);
        a = Math.imul(a, 16777619);
    }
    return a >>> 0;
};
// The ledger as the director reads it: the records' KEYS only, never their events (the replay already applied
// those to the store). The length is the turn count; the keys' digest is the fingerprint a swipe or edit moves.
const keysOf = (g) => {
    const recs = g?.narrativeLedger?.records;
    if (!Array.isArray(recs))
        return [];
    const out = [];
    for (const r of recs) {
        const k = r?.key;
        if (typeof k === 'string' && k)
            out.push(k);
    }
    return out;
};
// The game's own clock decides due dates — the same clock the engine moves and reconcileNarrative catches up to.
const clockOf = (g, st) => {
    const now = Number(g?.day) * 1440 + Number(g?.minutes);
    return Number.isFinite(now) ? now : (Number(st?.lastAt) || 0);
};
/* ---------- the lines ---------- */
// The director's block for the scene's prompt. `present` is the room as the caller sees it ({ avatar, name }[]);
// `speaker`, when given AND held by this room, opens exactly that one mind. Returns 0 or 1 lines (the speakerless
// room gets its one generic guidance line instead), never writes anything, and never creates the narrative store:
// a save without one is a save the director has nothing to say about yet.
export function directorLines(g, present, speaker) {
    const raw = g?.narrative;
    const st = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.schemaVersion === 1 ? raw : null;
    if (!st)
        return [];
    const people = (Array.isArray(present) ? present : []).filter((p) => p && typeof p.avatar === 'string' && p.avatar);
    const names = new Map(people.map(p => [p.avatar, String(p.name ?? p.avatar)]));
    const nm = (id) => names.get(id) ?? id;
    const cap = (s) => (s.length > DIR_LINE ? s.slice(0, DIR_LINE - 1) + '…' : s);
    const out = (line) => (line.length <= DIR_BUDGET ? [line] : []); // one capped line is always within budget; the guard keeps the promise honest
    const who = speaker !== undefined && people.some(p => p.avatar === speaker) ? speaker : undefined;
    if (!who) {
        if (!people.length)
            return []; // an empty room is directed by no one
        // no mind is opened: generic guidance only, with nothing private in it — no texts, no names, no goals, no
        // feelings, not even how many matters are open
        return out(cap(`[Director] Let what the people here already carry — plans whose time is spent, matters left open, feelings held — surface through their own choices when the scene allows. Never resolve or reveal anything on the director's behalf: no forced question, no event every turn, no one moved or brought in from off-screen.`));
    }
    const keys = keysOf(g);
    const turn = keys.length; // a turn = one processed source of the ledger
    const fp = hash32(keys.join('\u0001')); // the fingerprint an edit or swipe moves
    const slot = (anchor, every) => (turn + hash32(anchor)) % every === 0; // the cooldown
    const rank = (anchor) => hash32(`${anchor}|${fp}`); // stable ordering of siblings; a swipe re-deals it
    const clock = clockOf(g, st);
    const threads = Object.values(st.threads ?? {}).filter((t) => !!t && typeof t.id === 'string' && Array.isArray(t.actors));
    const agendas = Object.values(st.agendas ?? {}).filter((a) => !!a && typeof a.actor === 'string' && typeof a.id === 'string');
    // 1 (major): the speaker's ready agendas — the time is spent, the consequence still pending. The engine never
    // played it out and neither does the director: it may surface through the speaker's own choices, never be
    // resolved, announced or skipped by fiat.
    const ready = agendas.filter(a => a.actor === who && a.status === 'ready')
        .sort((a, b) => rank(`${a.actor}|${a.id}`) - rank(`${b.actor}|${b.id}`));
    for (const a of ready) {
        if (!slot(`${a.actor}|${a.id}`, MAJOR_EVERY))
            continue;
        return out(cap(`[Director] ${nm(who)}'s plan "${String(a.goal).slice(0, 160)}" has spent its time and its consequence is still unwritten — it may surface through ${nm(who)}'s own choices if the scene allows. Never resolve, announce or skip it on the director's behalf.`));
    }
    // 2 (major): open threads the speaker is in that are PAST their due date — the game clock decides, and a past
    // due date is flagged, never resolved by age: the pressure may show, the matter stays open.
    const pastDue = threads.filter(t => t.status === 'open' && t.actors.includes(who) && typeof t.due === 'number' && t.due < clock)
        .sort((a, b) => rank(`th|${a.id}`) - rank(`th|${b.id}`));
    for (const t of pastDue) {
        if (!slot(`th|${t.id}`, MAJOR_EVERY))
            continue;
        return out(cap(`[Director] The open matter "${String(t.text).slice(0, 160)}" is past its time and still open — the pressure may show in how those involved act. Do not resolve it by age or fiat, and do not reveal what only some of them know.`));
    }
    // 3 (minor): a strong feeling of the speaker's OWN, with the reason they earned it — this mind alone; what
    // others feel, about the speaker or anyone, never appears here.
    const felt = [];
    for (const [target, rel] of Object.entries(st.relations?.[who] ?? {})) {
        if (!rel || typeof rel !== 'object')
            continue;
        for (const axis of REL_AXES) {
            const v = rel[axis];
            if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) < REL_STRONG)
                continue;
            const log = Array.isArray(rel.log) ? rel.log : [];
            const last = log.length ? log[log.length - 1] : null;
            felt.push({ target, axis, value: v, reason: last && typeof last.reason === 'string' ? last.reason : '' });
        }
    }
    felt.sort((a, b) => rank(`rel|${a.target}|${a.axis}`) - rank(`rel|${b.target}|${b.axis}`));
    for (const f of felt) {
        if (!slot(`rel|${who}|${f.target}|${f.axis}`, MINOR_EVERY))
            continue;
        const s = `${f.value > 0 ? '+' : ''}${Math.round(f.value * 10) / 10}`;
        return out(cap(`[Director] ${nm(who)} still carries ${f.axis} ${s} toward ${nm(f.target)}${f.reason ? ` (${f.reason.slice(0, 120)})` : ''} — let it color ${nm(who)}'s next choice, not dictate it; the feeling is ${nm(who)}'s alone and no one else's to state aloud.`));
    }
    // 4 (minor): an open thread of the speaker's that is NOT past due (those are the majors above, and a cooling
    // major does not sneak back through this weaker class) — the gentlest call-back of all.
    const open = threads.filter(t => t.status === 'open' && t.actors.includes(who) && !(typeof t.due === 'number' && t.due < clock))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || rank(`th|${a.id}`) - rank(`th|${b.id}`));
    for (const t of open) {
        if (!slot(`th|${t.id}`, MINOR_EVERY))
            continue;
        return out(cap(`[Director] An open matter remains: "${String(t.text).slice(0, 160)}" — it may resurface naturally through whoever shares it. Nobody has to mention it, and it does not resolve by itself.`));
    }
    return [];
}
