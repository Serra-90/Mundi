// Getting to your plans: from an hour before, at the meeting place, "Things to do" offers to wait for them; half an
// hour before, a calendar reminder asks whether to go now. Both take you straight to the meet-up.
import { esc, game, notify, saveGame, toast, nowAbs, state } from '../core/store.js';
import { getWorld } from '../core/world.js';
import { thumb } from '../st/bridge.js';
import { social } from '../sim/social.js';
import { placeOf, playerHomeId, travelMinutes } from '../sim/places.js';
import { advance } from '../sim/time.js';
import { fmtClock as hm } from '../core/fmt.js';
import { syncScene } from '../sim/game.js';
import { runPlans } from './plans.js';
import { showTransition } from './lifeui.js';
import { icon } from './icons.js';
import { ACT } from './reg.js';
const GRACE = 60;
const live = (g) => social(g).appts.filter(a => a.state === 'set' && !a.come && g.cast[a.avatar]);
const what = (a) => (a.kind === 'date' ? 'Date' : a.kind === 'party' ? 'Party' : 'Hang out');
const where = (g, w, id) => (id === playerHomeId ? 'your home' : placeOf(g, w, id)?.name ?? '');
// One event with several people (a party: one plan per guest) is shown once.
const group = (g, a) => live(g).filter(x => x.from === a.from && x.place === a.place && x.kind === a.kind);
const remindAll = (g, a) => { for (const x of [a, ...group(g, a)])
    x.reminded = true; };
const label = (a) => (a.title ? a.title : what(a));
// "Things to do" at the meeting place, from an hour before
export function apptActions(g, w) {
    const now = nowAbs(g);
    const seen = new Set();
    return live(g).filter(a => a.place === g.player.loc && a.from > now && a.from - now <= 60).flatMap(a => {
        const key = `${a.from}|${a.place}|${a.kind}`;
        if (seen.has(key))
            return [];
        seen.add(key);
        const all = group(g, a);
        const r = g.cast[a.avatar];
        if (all.length > 1 || a.kind === 'party')
            return [`<button class="mh-act is-plan mh-glass" data-act="ap-wait" data-id="${esc(a.id)}"><i>${icon('calendar')}</i><b data-notr>${esc(label(a))} at ${hm(a.from % 1440)}</b><small>Wait for your guests (${all.length}) · ${a.from - now} min</small></button>`];
        return [`<button class="mh-act is-plan mh-glass" data-act="ap-wait" data-id="${esc(a.id)}"><i>${icon(a.kind === 'date' ? 'heart' : 'calendar')}</i><b>${a.title ? `<span data-notr>${esc(a.title)}</span>` : what(a)} with ${esc(r.name)} at ${hm(a.from % 1440)}</b><small>Wait for ${esc(r.name)} · ${a.from - now} min</small></button>`];
    });
}
// the calendar reminder, half an hour before (or a little late), when you are somewhere else
const due = (g) => { const now = nowAbs(g); return live(g).find(a => !a.reminded && a.place !== g.player.loc && a.from - now <= 30 && now < a.from + GRACE) ?? null; };
export function apptReminderHtml(g, w) {
    const a = due(g);
    if (!a)
        return '';
    const r = g.cast[a.avatar];
    const late = nowAbs(g) >= a.from;
    return `<div class="mh-invite mh-remind mh-glass" role="dialog"><img src="${esc(thumb(r.avatar))}" alt="">
        <div><b>${icon('calendar')} ${late ? 'You are late!' : 'Coming up'}</b><p>${group(g, a).length > 1 || a.kind === 'party'
        ? `<span data-notr>${esc(label(a))}</span> at ${esc(where(g, w, a.place))}, ${hm(a.from % 1440)} · ${group(g, a).length} guests.${late ? ' Your guests are waiting.' : ' Go now?'}`
        : `${what(a)} with <b data-notr>${esc(r.name)}</b> at ${esc(where(g, w, a.place))}, ${hm(a.from % 1440)}.${late ? ` ${esc(r.name)} is waiting.` : ' Go now?'}`}</p></div>
        <div class="mh-invite-btns"><button class="mu-primary" data-act="ap-go" data-id="${esc(a.id)}">Go now</button><button data-act="ap-later" data-id="${esc(a.id)}">Later</button></div></div>`;
}
// Something long (a shift, a night's sleep) would run over a plan: ask first.
const CF = { id: '', then: '' };
export function conflictWith(g, mins) {
    const now = nowAbs(g);
    return live(g).find(a => a.from + GRACE > now && a.from < now + mins && a.place !== g.player.loc) ?? null;
}
// returns true when a question was opened (the caller stops; the answer continues it)
export function askAboutPlans(g, mins, then) {
    const a = conflictWith(g, mins);
    if (!a || a.okToSkip)
        return false;
    Object.assign(CF, { id: a.id, then });
    notify();
    return true;
}
export function conflictHtml(g, w) {
    const a = CF.id ? social(g).appts.find(x => x.id === CF.id) : null;
    if (!a)
        return '';
    const r = g.cast[a.avatar];
    return `<div class="mu-recap-veil"><section class="mu-recap mu-conflict mh-glass" role="dialog"><img src="${esc(thumb(r.avatar))}" alt="">
        <h3>You have plans with ${esc(r.name)}</h3>
        <p>${what(a)} at ${esc(where(g, w, a.place))}, ${hm(a.from % 1440)}. ${CF.then === 'work' ? 'The shift would run over it.' : 'You would sleep through it.'} Do you want to go?</p>
        <div class="mu-row"><button class="mu-primary" data-act="cf-go">Go meet ${esc(r.name)}</button>${CF.then === 'work' && partHours(g, w, a) >= 1 ? `<button data-act="cf-part">Work ${partHours(g, w, a)} h, then go</button>` : ''}<button data-act="cf-skip">${CF.then === 'work' ? 'Work anyway' : 'Sleep anyway'}</button></div>
        <small class="mu-muted">If you don't go, ${esc(r.name)} will wait an hour and won't be happy about it.</small></section></div>`;
}
// Whole hours you can work and still get to the plan on time.
function partHours(g, w, a) {
    const o = g.player.job && w.occupations.find(x => x.id === g.player.job.id);
    if (!o)
        return 0;
    const free = a.from - nowAbs(g) - travelMinutes(g, w, g.player.loc, a.place);
    return Math.max(0, Math.min(o.shift - 1, Math.floor(free / 60)));
}
const find = (g, id) => social(g).appts.find(a => a.id === id);
// time passes until they arrive, and the meet-up starts
async function waitFor(g, w, a) {
    const mins = a.from - nowAbs(g);
    if (mins > 0)
        advance(g, w, mins).forEach(m => toast(m, 'warn'));
    runPlans();
    saveGame();
    await syncScene();
    const r = g.cast[a.avatar];
    showTransition(group(g, a).length > 1 || a.kind === 'party' ? label(a) : `${what(a)} with ${r?.name ?? ''}`, `${where(g, w, a.place)} · ${hm(a.from % 1440)}`, 'time');
    state.view = 'scene';
    notify();
}
Object.assign(ACT, {
    'ap-wait': async (el) => {
        const g = game();
        const w = g && getWorld(g.world);
        const a = g && find(g, el.dataset.id);
        if (!g || !w || !a)
            return;
        await waitFor(g, w, a);
    },
    'ap-go': async (el) => {
        const g = game();
        const w = g && getWorld(g.world);
        const a = g && find(g, el.dataset.id);
        if (!g || !w || !a)
            return;
        remindAll(g, a);
        const { travelTo } = await import('./map.js');
        await travelTo(a.place, undefined, false);
        if (a.state === 'set' && g.player.loc === a.place)
            await waitFor(g, w, a);
    },
    'cf-go': async () => {
        const g = game();
        const w = g && getWorld(g.world);
        const a = g && find(g, CF.id);
        CF.id = '';
        if (!g || !w || !a) {
            notify();
            return;
        }
        remindAll(g, a);
        const { travelTo } = await import('./map.js');
        await travelTo(a.place, undefined, false);
        if (a.state === 'set' && g.player.loc === a.place)
            await waitFor(g, w, a);
    },
    'cf-part': async () => {
        const g = game();
        const w = g && getWorld(g.world);
        const a = g && find(g, CF.id);
        CF.id = '';
        if (!g || !w || !a) {
            notify();
            return;
        }
        const o = g.player.job && w.occupations.find(x => x.id === g.player.job.id);
        if (!o)
            return;
        const h = partHours(g, w, a);
        remindAll(g, a);
        const { workShift } = await import('../sim/work.js');
        const { finishWork, travelTo } = await import('./map.js');
        await finishWork(workShift(g, w, 'normal', h), o.name);
        await new Promise(r => setTimeout(r, 2900)); // the shift's transition, then off to the plan
        await travelTo(a.place, undefined, false);
        if (a.state === 'set' && g.player.loc === a.place)
            await waitFor(g, w, a);
    },
    'cf-skip': () => {
        const g = game();
        const a = g && find(g, CF.id);
        const then = CF.then;
        CF.id = '';
        if (a)
            a.okToSkip = true;
        notify();
        ACT[then]?.(document.body, new Event('click')); // carry on with the shift or the sleep
    },
    'ap-later': (el) => { const g = game(); const a = g && find(g, el.dataset.id); if (!g || !a)
        return; remindAll(g, a); saveGame(); notify(); },
});
