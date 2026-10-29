// The people of a place who have no card: the barman, the receptionist, the regular at the corner table, and the
// crowd around them. The AI plays them as minor characters while they are there (the place's own list, in the
// world), so a café is never empty. Anyone of them can become a real card in a game ("promoted"): from then on she
// is one of the cast, with a home and a routine that brings her to work at that place.
import type { Save, Resident } from '../core/store.js';
import type { WorldDef, Extra, Place } from '../core/world.js';
import { openNow, periodId } from './daynight.js';
import { isScenario } from '../core/world.js';

const dow = (day: number) => ((day - 1) % 7) + 1;   // 1 Monday … 7 Sunday
const inHours = (h: [number, number], minutes: number) => { const t = (minutes % 1440) / 60; const [a, b] = h; return a <= b ? t >= a && t < b : t >= a || t < b; };
const placeOf = (w: WorldDef, id: string): Place | undefined => w.places.find(p => p.id === id);

/** place|extra → the card she became in this game */
export const promoted = (g: Save): Record<string, string> => (((g as any).extras ??= {}) as Record<string, string>);
export const extraKey = (place: string, ex: Extra) => `${place}|${ex.id}`;

/** Is she at work there now? (her hours, her days; with no hours, whenever the place is open) */
export function onDuty(g: Save, w: WorldDef, place: string, ex: Extra) {
    if (ex.days?.length && !ex.days.includes(dow(g.day))) return false;
    return ex.hours ? inHours(ex.hours, g.minutes) : openNow(g, w, place);
}
/** The place's people there right now (not the ones who became a card). */
export function extrasHere(g: Save, w: WorldDef, place: string): Extra[] {
    const p = placeOf(w, place);
    if (!p?.people?.length) return [];
    const done = promoted(g);
    return p.people.filter(ex => !done[extraKey(place, ex)] && onDuty(g, w, place, ex));
}
/** The background crowd now (the line for this part of the day, or for any). Nothing when the place is closed. */
export function crowdHere(g: Save, w: WorldDef, place: string): string {
    const p = placeOf(w, place);
    if (!p?.crowdText || !openNow(g, w, place)) return '';
    return (p.crowdText[periodId(w, g.minutes)] ?? p.crowdText.any ?? '').trim();
}
export const hasExtras = (g: Save, w: WorldDef, place: string) => !!extrasHere(g, w, place).length || !!crowdHere(g, w, place);

/** What the AI is told about them (empty when the place has nobody of its own). */
export function extrasLines(g: Save, w: WorldDef, place: string): string[] {
    const ex = extrasHere(g, w, place), crowd = crowdHere(g, w, place);
    return [
        ex.length ? `Minor characters of this place, here now (they have no card: the AI plays them, briefly and true to their role, in the narration or when {{user}} speaks to them; they never take over the scene): ${ex.map(e => `${e.name}, ${e.role}${e.desc ? ` — ${e.desc}` : ''}`).join('; ')}.` : '',
        crowd ? `Around, in the background: ${crowd} (unnamed people: they can be seen and heard, and answer a passing word, but they are not part of the scene).` : '',
    ].filter(Boolean);
}

/** She becomes a real card: one of the cast, living somewhere, working at this place in her hours. */
export async function promoteExtra(g: Save, w: WorldDef, place: string, ex: Extra): Promise<string> {
    const key = extraKey(place, ex);
    if (promoted(g)[key]) return promoted(g)[key];
    const { createCharacter } = await import('../st/bridge.js');
    const { resident, initialsAvatar, takenHomes, syncScene } = await import('./game.js');
    const p = placeOf(w, place);
    const description = `${ex.name}: ${ex.role}${p ? ` (${p.name})` : ''}.${ex.desc ? ` ${ex.desc}` : ''}`;
    const avatar = await createCharacter({
        name: ex.name, description, scenario: w.setting, tags: ['Mundi', w.name],
        extensions: { mundi: { world: w.id, extra: key } },
    }, await initialsAvatar(ex.name, ['#64748b', '#1e293b']));
    const r: Resident = resident(w, avatar, takenHomes(g), g.player.home);
    r.occupation = null;
    if (!isScenario(w)) r.routine = routineAt(place, ex);
    r.met = g.player.loc === place;
    g.cast[avatar] = r;
    promoted(g)[key] = avatar;
    await syncScene();
    return avatar;
}
// her days: at the place in her hours (the days she works), home otherwise and out for a while on her days off
function routineAt(place: string, ex: Extra): Resident['routine'] {
    const [a, b] = ex.hours ?? [9, 18];
    const work: [number, string][] = a <= b ? (b <= 20 ? [[0, 'home'], [a, place], [b, 'leisure'], [b + 3, 'home']] : [[0, 'home'], [a, place], [b, 'home']]) : [[0, place], [b, 'home'], [a, place]];
    const free: [number, string][] = [[0, 'home'], [10, 'leisure'], [20, 'home']];
    const weekendWork = !ex.days?.length || ex.days.some(d => d >= 6);
    return { weekday: work, weekend: weekendWork ? work : free };
}
