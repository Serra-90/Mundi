// Lorebooks a world uses besides its own (Globe → Lorebooks). They are switched on in SillyTavern's World Info
// while that game is open, and switched back off when you leave it.
// Switched off too: the lorebooks of any other game that are still on (another world's lorebooks, or another world's
// own "Mundi - <world>" lorebook), even when they were turned on before the page was reloaded. Lorebooks that belong
// to no Mundi world are left as the user set them.
import { game, cfg, settings, saveSettings } from '../core/store.js';
import { worlds } from '../core/world.js';
import { globalLore, setGlobalLore, chatLoreExtra } from '../st/bridge.js';
// turned on by Mundi, so Mundi turns them off again (kept in the settings, so a reload does not forget them)
const ours = () => { const s = settings(); return (s.loreOn = Array.isArray(s.loreOn) ? s.loreOn : []); };
// every lorebook that belongs to a Mundi game: the worlds' own ("Mundi - <name>") and the ones they use
function gameBooks() {
    const out = new Set(ours());
    for (const w of worlds()) {
        out.add(`Mundi - ${w.name}`);
        for (const n of w.lorebooks ?? [])
            out.add(n);
    }
    return out;
}
export async function applyGameLore() {
    const g = game();
    const want = [...new Set([...(g ? cfg(g).lore ?? [] : []), ...chatLoreExtra()])]; // the world's lorebooks, and the chat's extra ones
    const mine = gameBooks();
    let changed = false;
    // off: what belongs to another game (or to this game's earlier settings) and is not wanted now
    for (const n of globalLore())
        if (mine.has(n) && !want.includes(n)) {
            await setGlobalLore(n, false);
            changed = true;
        }
    const keep = ours().filter(x => want.includes(x));
    // on: what this game wants
    const on = globalLore();
    for (const n of want)
        if (!on.includes(n)) {
            await setGlobalLore(n, true);
            if (!keep.includes(n))
                keep.push(n);
            changed = true;
        }
    if (changed || keep.length !== ours().length) {
        settings().loreOn = keep;
        saveSettings();
    }
}
