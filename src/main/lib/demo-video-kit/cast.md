# Playbook: supporting cast

Read this when the saved character has a `cast`. It is for the demo-video-builder persona: short
rules for a video where the host shares the screen with cast members. Everything else in the
persona still holds.

## Who speaks each line

- Every line has one speaker. The speaker is the host, unless the script gives the line to a cast
  member by `name`.
- A member's lines fit its `note`: its role, manner and the kind of thing it says.

## Which voice speaks it

- A `command`-voice line is spoken with `node <kit>/character.cjs speak spec.json`. Each line in
  the spec carries that line's `speaker`, the member's `name`. Omit `speaker` for the host.
- A `kokoro`-voice line uses the persona's Kokoro recipe with that speaker's `id`.
- A line is never spoken in another speaker's voice, in Kokoro's default voices, or in any
  fallback voice. There is no fallback.
- A failing voice fails the run with its error. `character.cjs speak` stops at the first failure
  and refuses an unknown speaker, a member without a voice, and a `kokoro` speaker; report that
  error as it is. Never retry the line in another voice.

## A member without a voice

- A member without `voice` never speaks. Give it no lines.
- It is heard only through sound effects on its moments, never words: cue one of its `sfx` with
  sound.cjs, or a built-in effect that fits its `note` when it has no `sfx`.

## Sounds

- A member's `sfx` names its signature sounds: built-in effects or the persona's own.
- character.json `sounds` lists the project's own effects (`sfx`) and music beds (`beds`) by
  `name`, each with a `note` on what it is. Use them by name: a sound.cjs cue for an effect, the
  spec's `bed` for a music bed. They are mixed like the built-in ones.
- An unknown sound name fails the run with sound.cjs's error. Never swap in another sound.

## Captions

- Captions never show a speaker's name unless the script calls for it.

## Looks and lip-sync

- A member is drawn only as `character.js` draws it. Never invent a look.
- A member that `character.js` does not draw is heard, not seen.
- Each on-screen speaker's mouth moves only on its own lines. The others stay still while
  someone else speaks.

## Character: off

- 'Character: off' means no host and no cast: no one drawn, no character voice.
- meta.character stays the host's name, never a cast member's.
