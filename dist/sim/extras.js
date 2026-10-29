import { openNow, periodId } from './daynight.js';
import { isScenario } from '../core/world.js';
const dow = (day) => ((day - 1) % 7) + 1; // 1 Monday … 7 Sunday
const inHours = (h, minutes) => { const t = (minutes % 1440) / 60; const [a, b] = h; return a <= b ? t >= a && t < b : t >= a || t < b; };
const placeOf = (w, id) => w.places.find(p => p.id === id);
/** place|extra → the card she became in this game */
export const promoted = (g) => (g.extras ??= {});
export const extraKey = (place, ex) => `${place}|${ex.id}`;
/** Is she at work there now? (her hours, her days; with no hours, whenever the place is open) */
export function onDuty(g, w, place, ex) {
    if (ex.days?.length && !ex.days.includes(dow(g.day)))
        return false;
    return ex.hours ? inHours(ex.hours, g.minutes) : openNow(g, w, place);
}
/** The place's people there right now (not the ones who became a card). */
export function extrasHere(g, w, place) {
    const p = placeOf(w, place);
    if (!p?.people?.length)
        return [];
    const done = promoted(g);
    return p.people.filter(ex => !done[extraKey(place, ex)] && onDuty(g, w, place, ex));
}
/** The background crowd now (the line for this part of the day, or for any). Nothing when the place is closed. */
export function crowdHere(g, w, place) {
    const p = placeOf(w, place);
    if (!p?.crowdText || !openNow(g, w, place))
        return '';
    return (p.crowdText[periodId(w, g.minutes)] ?? p.crowdText.any ?? '').trim();
}
export const hasExtras = (g, w, place) => !!extrasHere(g, w, place).length || !!crowdHere(g, w, place);
/** What the AI is told about them (empty when the place has nobody of its own). */
export function extrasLines(g, w, place) {
    const ex = extrasHere(g, w, place), crowd = crowdHere(g, w, place);
    return [
        ex.length ? `Minor characters of this place, here now (they have no card: the AI plays them, briefly and true to their role, in the narration or when {{user}} speaks to them; they never take over the scene): ${ex.map(e => `${e.name}, ${e.role}${e.desc ? ` — ${e.desc}` : ''}`).join('; ')}.` : '',
        crowd ? `Around, in the background: ${crowd} (unnamed people: they can be seen and heard, and answer a passing word, but they are not part of the scene).` : '',
    ].filter(Boolean);
}
/** She becomes a real card: one of the cast, living somewhere, working at this place in her hours. */
export async function promoteExtra(g, w, place, ex) {
    const key = extraKey(place, ex);
    if (promoted(g)[key])
        return promoted(g)[key];
    const { createCharacter } = await import('../st/bridge.js');
    const { resident, initialsAvatar, takenHomes, syncScene } = await import('./game.js');
    const p = placeOf(w, place);
    const description = `${ex.name}: ${ex.role}${p ? ` (${p.name})` : ''}.${ex.desc ? ` ${ex.desc}` : ''}`;
    const avatar = await createCharacter({
        name: ex.name, description, scenario: w.setting, tags: ['Mundi', w.name],
        extensions: { mundi: { world: w.id, extra: key } },
    }, await initialsAvatar(ex.name, ['#64748b', '#1e293b']));
    const r = resident(w, avatar, takenHomes(g), g.player.home);
    r.occupation = null;
    if (!isScenario(w))
        r.routine = routineAt(place, ex);
    r.met = g.player.loc === place;
    g.cast[avatar] = r;
    promoted(g)[key] = avatar;
    await syncScene();
    return avatar;
}
// her days: at the place in her hours (the days she works), home otherwise and out for a while on her days off
function routineAt(place, ex) {
    const [a, b] = ex.hours ?? [9, 18];
    const work = a <= b ? (b <= 20 ? [[0, 'home'], [a, place], [b, 'leisure'], [b + 3, 'home']] : [[0, 'home'], [a, place], [b, 'home']]) : [[0, place], [b, 'home'], [a, place]];
    const free = [[0, 'home'], [10, 'leisure'], [20, 'home']];
    const weekendWork = !ex.days?.length || ex.days.some(d => d >= 6);
    return { weekday: work, weekend: weekendWork ? work : free };
}
