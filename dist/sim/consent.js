// Doing something together (an action with "With whom"): a check of consent, between a social check and a proposal.
// 1. The AI judges the attempt (what is asked, of whom, and how) and sets how hard it is for them (the DC).
// 2. The engine adjusts it by the relationship, rolls the d20 and decides the outcome.
// 3. The AI then writes their answer in that light (agree and do it, or decline).
// 4. The consequences: the bond and approval move; on a no, the action does not happen and cannot be asked
//    again of them for a while.
import { cfg, nowAbs } from '../core/store.js';
import { quiet, personaName } from '../st/bridge.js';
import { bondOf, bump, isPartner, social } from './social.js';
import { approvalOf, approve } from './living.js';
import { romOf, friendTier, romanceTier } from './romance.js';
import { note } from './facts.js';
export const consentOn = (g) => cfg(g).consent !== false;
const DIFF = { trivial: 5, easy: 9, medium: 13, hard: 17, 'very hard': 21 };
const COOL = 120; // minutes before asking the same thing of the same person again, after a no
const cools = (g) => (social(g).consentCool ??= {});
const coolKey = (a, avatar) => `${a.id}|${avatar}`;
// Who said no to this lately (and until when).
export function refusedLately(g, a, who) {
    const now = nowAbs(g), c = cools(g);
    return who.filter(x => (c[coolKey(a, x)] ?? 0) > now);
}
// How {{user}} and this person stand, in words (for the judge).
function standing(g, r) {
    const b = bondOf(g, r.avatar), ap = approvalOf(g, r.avatar), rom = romOf(g, r.avatar);
    const parts = [`${friendTier(b).name.toLowerCase()} (bond ${b}/100)`, `romance: ${romanceTier(g, r.avatar).name.toLowerCase()}`];
    if (rom.status !== 'none')
        parts.push(`status: ${rom.status}`);
    else if (isPartner(g, r.avatar))
        parts.push('status: dating');
    if (ap <= -30)
        parts.push('disapproves of {{user}}');
    else if (ap >= 40)
        parts.push('thinks highly of {{user}}');
    if (!r.met)
        parts.push('they have never met');
    return `${r.name}: ${parts.join(', ')}`;
}
// 1 + 2: the AI judges, the engine rolls.
export async function consentCheck(g, w, a, people, how, mins, recent) {
    const me = personaName();
    let difficulty = 'medium', quality = 0, why = '', impossible = false;
    try {
        const out = await quiet(`[You are the rules judge of a role-play game. You do not write the story.]
${me} proposes to do this together with ${people.map(r => r.name).join(', ')}: ${a.name} (${a.label})${how ? `, like this: "${how}"` : ''}, for about ${mins} minutes.
How they stand with ${me}:
${people.map(r => standing(g, r).replace(/\{\{user\}\}/g, me)).join('\n')}
${recent ? `The scene so far:\n"""\n${recent}\n"""\n` : ''}
Judge how much this asks of them (the hardest to win over, if more than one), given who they are, their relationship with ${me}, the place and the moment, and how good ${me}'s approach is.
Reply in exactly this form:
DIFFICULTY: trivial, easy, medium, hard, very hard, or impossible (impossible: they would never agree, whatever the dice)
QUALITY: a number from -2 to 2 (how fitting the approach is: clumsy or out of place -2, ordinary 0, tender, clever and fitting 2)
WHY: one short sentence`, 80, 'You judge one thing in a role-play game and answer only in the form asked.');
        const get = (k) => (out.match(new RegExp(`${k}\\s*:\\s*([^\\n]+)`, 'i'))?.[1] ?? '').trim();
        const d = get('difficulty').toLowerCase();
        impossible = /impossible/.test(d);
        difficulty = ['very hard', 'trivial', 'easy', 'medium', 'hard'].find(x => d.includes(x)) ?? (impossible ? 'very hard' : 'medium');
        quality = Math.max(-2, Math.min(2, Math.round(Number((get('quality').match(/[+-]?\d+/) ?? ['0'])[0])) || 0));
        why = get('why').slice(0, 200);
    }
    catch { /* the judge is offline: a medium check */ }
    // the engine: the relationship moves the DC
    const base = DIFF[difficulty] ?? 13;
    let dc = base;
    const hardest = people.reduce((h, r) => (bondOf(g, r.avatar) < bondOf(g, h.avatar) ? r : h), people[0]);
    const b = bondOf(g, hardest.avatar), ap = approvalOf(g, hardest.avatar);
    if (b >= 80)
        dc -= 3;
    else if (b >= 55)
        dc -= 2;
    else if (b >= 30)
        dc -= 1;
    else if (b < 10)
        dc += 2;
    if (people.every(r => isPartner(g, r.avatar) || romOf(g, r.avatar).status !== 'none'))
        dc -= 3;
    if (ap <= -30)
        dc += 2;
    else if (ap >= 40)
        dc -= 1;
    dc = Math.max(3, Math.min(25, dc));
    const d20 = 1 + Math.floor(Math.random() * 20);
    const bonus = quality;
    const total = d20 + bonus;
    const grade = impossible ? (d20 === 20 ? 'fail' : 'critical-fail')
        : d20 === 20 ? 'critical-success' : d20 === 1 ? 'critical-fail' : total >= dc ? 'success' : 'fail';
    return { dc, base, d20, bonus, total, grade, difficulty: impossible ? 'impossible' : difficulty, quality, why, impossible };
}
export const agreed = (c) => c.grade === 'success' || c.grade === 'critical-success';
// 3: what the AI is told before it answers.
export function consentHint(c, a, names, how, dur) {
    const who = names.join(', ');
    const what = `${a.name} (${a.label})${how ? `, like this: ${how}` : ''}`;
    if (agreed(c))
        return `[{{user}} proposes to ${who}: ${what}. The engine rolled: ${who} ${names.length > 1 ? 'agree' : 'agrees'}${c.grade === 'critical-success' ? ', gladly and warmly' : ''}. Write ${who}'s answer in character and then narrate the action as it happens (about ${dur}), with ${who} taking part. Do not write {{user}}'s words or decisions beyond what is stated.]`;
    return `[{{user}} proposes to ${who}: ${what}. The engine rolled: ${who} ${names.length > 1 ? 'decline' : 'declines'}${c.grade === 'critical-fail' ? ' firmly, and is put off or hurt by being asked' : ', in their own way (kindly, awkwardly, or with a reason of their own)'}. The action does NOT happen. Write ${who}'s refusal in character; the scene goes on from there. Do not make them change their mind. Do not write {{user}}'s words or decisions.]`;
}
// 4: the consequences.
export function consentAfter(g, a, people, c) {
    const msgs = [];
    const names = people.map(r => r.name).join(', ');
    for (const r of people) {
        if (c.grade === 'critical-success') {
            bump(g, r.avatar, 4);
            approve(g, r.avatar, 3);
        }
        else if (c.grade === 'success') {
            bump(g, r.avatar, 2);
            approve(g, r.avatar, 1);
        }
        else if (c.grade === 'fail') {
            bump(g, r.avatar, -1);
            cools(g)[coolKey(a, r.avatar)] = nowAbs(g) + COOL;
        }
        else {
            bump(g, r.avatar, -4);
            approve(g, r.avatar, -6);
            cools(g)[coolKey(a, r.avatar)] = nowAbs(g) + COOL * 3;
        }
    }
    if (agreed(c))
        note(g, '{u} and {0} did this together: {1}.', [names, a.name.toLowerCase()], people.map(r => r.avatar));
    else
        note(g, '{u} asked {0} to do this together ({1}), and they said no.', [names, a.name.toLowerCase()], people.map(r => r.avatar));
    if (c.grade === 'critical-fail')
        msgs.push(`${names}: that did not go down well.`);
    return msgs;
}
