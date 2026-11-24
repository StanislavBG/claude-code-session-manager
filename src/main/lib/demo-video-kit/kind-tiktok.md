# Playbook: TikTok kind

Read this when the `Video kind:` line is TikTok. It is for the demo-video-builder persona: short
imperative rules for one vertical short built to go viral with this project's own audience.

This playbook overrides three persona rules: the stage size, the keystone holds, and the scene
structure. Everything else in the persona still holds: plain language, the claims list, the
voice-first rule, the character, the kit-tool failure rule, and the single save call.

## Format

- Stage: vertical 9:16, 1080x1920 logical pixels, scaled to fit with letterboxing.
- Put `<meta name="sm-demo-aspect" content="9:16">` in the document head. frames.cjs and export.cjs
  read it to size the viewport and the MP4.
- Length: 30 s by default; any whole number of seconds from 15 to 60 when the goal asks for it.
  The duration meta and `smDemo.duration` both say it.
- Frame 0 is the live scene: the subject already on screen, no title card, no fade from black.
- The hook is visible by 3 s: one on-screen line that names the problem or the surprise.
- Captions read with the sound muted. Each caption is at most 12 words. Captions carry every
  point the narration makes, so the short works on mute.
- A cut or a camera move (push in, pan, pull out) at least every 3 s. No hold longer than 3 s;
  the persona's 5 s keystone hold does not apply here.
- The payoff lands in the last 5 s: what the viewer gets, shown, not told.
- A loop ending: the last frame matches frame 0's framing and light, so the clip loops cleanly.
  A small "next" tag over the live scene is fine; never a full-screen end card.
- Safe zone: no text in the bottom 20% or the right 15% of the frame (the app's own buttons and
  caption sit there). Keep text clear of the top bar too.

## Structure

Replace the persona's title-problem-reveal order with these beats, in order:

1. Live open with the hook (0-3 s).
2. The problem or the mistake, shown.
3. The turn: the project does the one thing, captured whenever a capture exists.
4. The payoff (last 5 s).
5. The loop back to frame 0's framing.

One idea per short. If the target has three features, pick the one this audience cares about most.

## Episode contract

- `seek(t)` is pure: the frame for `t` depends only on `t`, never on history or on the previous
  frame. Re-render from scratch each call.
- Seeded randomness only: no `Math.random`, no `Date`, in render code. Use a small seeded PRNG
  (mulberry32 or similar) created at module level.
- One clock: `play()` drives `seek()` from one `requestAnimationFrame` loop. No per-scene timers.
- Expose on `window.smDemo`, besides the persona's `duration`, `seek`, `play`, `pause`:
  - `smDemo.beats = { hook, payoff, loop }`: the second each beat lands.
  - `smDemo.cuts = [ ... ]`: the second of every cut or camera move, ascending.

## Kit checks

Run the kit from `~/.claude/session-manager/demo-video-kit/` exactly as the persona says, plus:

- Stills check: run frames.cjs `sampleFrames({ htmlPath, lengthS })`, open its contact sheet PNG,
  and look at every still. Each one must read on a phone: subject large, captions legible and inside
  the safe zone, no frame cut off or empty. Fix and re-run until all pass.
- checks.cjs: pass `tiktok` in the input JSON as
  `{ beats: smDemo.beats, cuts: smDemo.cuts, postCaption: meta.post.caption }`, together with the
  frames from sampleFrames and `lengthS`. The hook, cadence, payoff, loop, safe-zone and
  post-caption checks must all pass before you save.
- sound.cjs: mix the narration over the music bed; the bed is ducked under speech and the mix is
  normalised to -14 LUFS. When the project has a saved character with a command voice, speak its
  lines with `node character.cjs speak spec.json` first. Pass `projectRoot` (`$SM_PROJECT_ROOT`) in
  its spec: a cue or the spec's `bed` may name one of the persona's own `sounds`, and an unknown name
  fails the run; never swap in another sound.
- export.cjs: `node export.cjs spec.json` with `{ htmlPath, lengthS, audioPath, outDir }` writes
  `video.mp4` (1080x1920, H.264/AAC) and `poster.png` in `outDir`. It must exit 0.

## Audience rule

Decide who the short is for from what the project is and who it is for: read its README, its
landing copy and its docs, not your guess. Write every hook, caption and line for that audience's
words and that audience's problem. Save it as `meta.post.audience`, one short sentence.

## Post caption rule

- At most 150 characters.
- At most 2 hashtags, at the end.
- No link, no URL, no domain.
- The text before the hashtags ends in a short question that invites a comment.

Save it as `meta.post.caption`. A style file that forbids questions does not apply here: the
caption always ends in a short question.

## Series rule

When the `Video target:` line names a series brief file:

1. Read the brief, then every season, canon and ledger file it names.
2. Make the next episode exactly as they say: its premise, cast, topic and beats. Follow the
   brief's topic; never invent a premise, never pick an episode the files do not schedule.
   Keep its sound too: every sound cue at its time and its music as the sound.cjs `bed`,
   by the names the files use.
3. Use the project persona for the host and voice; never borrow another project's characters.
4. When the files have no next episode left, in the review stage or the final stage alike,
   call `project_video_outcome_write` once with `{ videoId: <the Entry id>, outcome:
   'season-complete', text: 'Season complete: <brief path> has no next episode' }`. Save no
   video and no review material, end the report with that same `Season complete` line, and
   end PASS: a finished season is a passing run, not a failure.

Never update the series files yourself unless the brief says to.
