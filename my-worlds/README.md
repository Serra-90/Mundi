# My worlds

I miei mondi Mundi personalizzati, nel formato runtime dell'estensione (file grezzi, non bundled).

## Shrinking

Mondo moderno (kind `Moderno`), id `w_shrinking_mvsh45difpr`. Falconara e dintorni.

- `world.json` — la definizione del mondo (copia di `user/files/mundi-world-w_shrinking_mvsh45difpr.json`)
- `images/` — le 169 immagini referenziate (mappe, piante, sfondi)
- `lore/` — i 5 lorebook usati dal mondo (campo `lorebooks` del world.json)

## Palatium Augusti

Il palazzo imperiale di Terra Aeterna, mondo medievale, id `w_palatium_augusti_mvqx6u7a5rz`.

- `world.json` — copia di `user/files/mundi-world-w_palatium_augusti_mvqx6u7a5rz.json`
- `images/` — le 42 immagini referenziate (stanze, piante dei piani)
- `lore/` — i 2 lorebook usati dal mondo

## Ripristino in SillyTavern

1. Copia `world.json` e tutto `images/` in `data/<tuo-profilo>/user/files/` (i nomi dei file devono restare quelli originali: sono i percorsi scritti dentro il world.json).
2. Copia i lorebook di `lore/` in `data/<tuo-profilo>/worlds/`.
3. In `data/<tuo-profilo>/settings.json`, sotto `extension_settings.mundi.customWorlds`, aggiungi la voce del mondo, es. per Shrinking:

   ```json
   { "id": "w_shrinking_mvsh45difpr", "name": "Shrinking", "kind": "Moderno",
     "file": "user/files/mundi-world-w_shrinking_mvsh45difpr.json", "updated": 0 }
   ```

In alternativa, dal creator di Mundi: «Importa un mondo» con un file esportato dall'estensione (immagini incluse nel JSON).

Nota: i lorebook `Mundi - <nome mondo>` in `worlds/` sono generati automaticamente dal world.json all'avvio di una partita e non vanno ripristinati a mano.
