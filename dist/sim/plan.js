import { isScenario } from '../core/world.js';
import { pins, playerHomeId } from './places.js';
export const spotId = (zone, k) => `spot:${zone}:${k}`;
// The building a map is (null: not a building).
export const buildingOf = (w, mapId) => {
    if (!w || isScenario(w))
        return null;
    const m = w.maps.find(x => x.id === mapId);
    return m?.building ? m : null;
};
// The plan of a Home, or of a building of a world.
export function scopeOf(w, mapId) {
    if (!w)
        return null;
    if (isScenario(w))
        return w.plan ? { plan: w.plan, map: '' } : null;
    const b = buildingOf(w, mapId);
    return b?.plan ? { plan: b.plan, map: b.id } : null;
}
// The plan is drawn only with a picture of it (a blueprint) on a floor; floors without one still sort the rooms
// (the room pictures, floor by floor). Off: the room pictures, as always.
const hasRooms = (p) => !!p.floors?.length && !!p.rooms?.some(r => p.floors.some(f => f.id === r.floor));
export function floorsOn(w, mapId) {
    const s = scopeOf(w, mapId);
    return s && s.plan.on && hasRooms(s.plan) ? s : null;
}
export function planOn(w, mapId) {
    const s = floorsOn(w, mapId);
    return s && s.plan.floors.some(f => !!f.image) ? s : null;
}
// The spot a home stands on ('' when it is not one of the area's spots).
export function spotOf(w, h) {
    if (!h)
        return '';
    const z = w.homes.zones.find(x => x.id === h.zone);
    const k = z ? z.spots.findIndex(s => s[0] === h.x && s[1] === h.y) : -1;
    return z && k >= 0 ? spotId(z.id, k) : '';
}
// Every room the plan can hold: the rooms (of the building, in a world), then each bedroom spot (with its area's name).
export function planSlots(w, mapId = '') {
    const rooms = w.places.filter(p => !p.link && (!mapId || p.map === mapId)).map(p => ({ id: p.id, name: p.name, bedroom: false }));
    const beds = w.homes.zones.filter(z => !mapId || z.map === mapId).flatMap(z => z.spots.map((_, k) => ({ id: spotId(z.id, k), name: z.spots.length > 1 ? `${z.name} ${k + 1}` : z.name, bedroom: true })));
    return [...rooms, ...beds];
}
// What a plan room is in this game: the place to go to, or the bedroom of whoever lives at that spot (you first).
// null: the room is not in this house (turned off for this game), or nobody lives in that bedroom.
export function planTarget(g, w, r) {
    if (!r.id.startsWith('spot:'))
        return pins(g, w).some(p => p.id === r.id) ? { loc: r.id, known: true } : null;
    if (spotOf(w, g.player.home) === r.id)
        return { loc: playerHomeId, known: true };
    const there = Object.values(g.cast).filter(c => spotOf(w, c.home) === r.id && !c.homeWith);
    const who = there.find(c => c.met) ?? there[0];
    return who ? { loc: `home:${who.avatar}`, owner: who.avatar, known: !!who.met } : null;
}
// The places of a plan's scope (a building's rooms; the whole Home).
export const scopePins = (g, w, s) => pins(g, w).filter(p => !p.link && (!s?.map || p.map === s.map));
// The rooms of this game that are on no floor of the plan (they show with a red "!").
export function unplaced(g, w, s = scopeOf(w)) {
    const plan = s?.plan;
    if (!plan)
        return [];
    const placed = new Set(plan.rooms.filter(r => plan.floors.some(f => f.id === r.floor)).map(r => planTarget(g, w, r)?.loc).filter(Boolean));
    return scopePins(g, w, s).filter(p => !placed.has(p.id));
}
// The floor a room of the game is on ('' when it is not on the plan).
export function floorOf(g, w, loc, s = scopeOf(w)) {
    const plan = s?.plan;
    if (!plan)
        return '';
    return plan.rooms.find(r => plan.floors.some(f => f.id === r.floor) && planTarget(g, w, r)?.loc === loc)?.floor ?? '';
}
