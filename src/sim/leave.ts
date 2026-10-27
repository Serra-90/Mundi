// "Stay until goodbye" (This Home / This world → rules, one game at a time): while a conversation or an event is
// going on you cannot leave the room, go out, go to a plan elsewhere, sleep or let time pass. A conversation starts
// when you speak to the people in the room; it ends when you take your leave and they say goodbye back (their reply),
// or when they have all left the room on their own. An event (a date, a meet-up, a party) ends with its own button.
import { cfg, state, type Save } from '../core/store.js';
import type { WorldDef } from '../core/world.js';
import { presentAt } from './people.js';
import { social } from './social.js';
import { chat } from '../st/bridge.js';

interface Talk { loc: string; who: string[]; leaving?: number }
const talkOf = (g: Save): Talk | null => ((social(g) as any).talk ?? null);
const setTalk = (g: Save, t: Talk | null) => { (social(g) as any).talk = t; };

export const stayRule = (g: Save) => !!cfg(g).stayInScene;

// You spoke in this room: the people here (the ones you know) are in a conversation with you.
export function startTalk(g: Save, w: WorldDef) {
    if (!stayRule(g)) return;
    const here = presentAt(g, w, g.player.loc).filter(r => r.met).map(r => r.avatar);
    if (!here.length) return;
    const t = talkOf(g);
    const who = t && t.loc === g.player.loc && !t.leaving ? [...new Set([...t.who, ...here])] : here;
    setTalk(g, { loc: g.player.loc, who });
}

// Who you are still talking with here (the goodbye said and answered, or everyone gone: nobody).
export function talkingWith(g: Save, w: WorldDef): string[] {
    const t = talkOf(g);
    if (!t) return [];
    if (t.loc !== g.player.loc) { setTalk(g, null); return []; }   // something moved you (a crisis…): it is over
    if (t.leaving !== undefined && !state.generating && chat().length > t.leaving) { setTalk(g, null); return []; }   // they said goodbye back
    const here = new Set(presentAt(g, w, g.player.loc).map(r => r.avatar));
    const left = t.who.filter(a => here.has(a));
    if (!left.length) { setTalk(g, null); return []; }
    return left;
}
export const takingLeave = (g: Save) => talkOf(g)?.leaving !== undefined;

// You take your leave: the goodbye is done once their reply comes.
export function beginGoodbye(g: Save) { const t = talkOf(g); if (t) t.leaving = chat().length + 1; }

// Why you cannot leave now ('' when you can).
export function leaveBlock(g: Save, w: WorldDef): string {
    if (!stayRule(g)) return '';
    const e = (social(g) as any).event as { avatar: string; ending?: boolean } | null;
    if (e && !e.ending && g.cast[e.avatar]) return `End the event with ${g.cast[e.avatar].name} first.`;
    const who = talkingWith(g, w).map(a => g.cast[a]?.name).filter(Boolean);
    if (who.length) return takingLeave(g) ? 'Wait for them to say goodbye.' : `Say goodbye to ${who.join(', ')} first.`;
    return '';
}
