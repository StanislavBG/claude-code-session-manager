# Playbook: Marketing kind

Read this when the `Video kind:` line is Marketing. It is for the demo-video-builder persona: short
imperative rules for one open-web video, the kind that plays on the product's landing page.

This playbook overrides four persona rules: the scene order, the drawn-scene fallback for the
product, the title card, and the close. Everything else in the persona still holds: plain language,
the claims list, the voice-first rule, the character, the keystone holds after the opening 3 s, the
kit-tool failure rule, and the single save call.

## Format

- Stage: 16:9, 1280x720 logical pixels, scaled to fit with letterboxing. export.cjs writes it as
  1920x1080. Do not add an `sm-demo-aspect` meta of 9:16.
- Length: 30 s or 60 s, nothing else. The duration meta and `smDemo.duration` both say it.
- The first 3 s show what the product does for the visitor: the real product on screen doing the
  one thing, with one line that names the gain. No logo sting, no title card, no fade from black.
- It works autoplay-muted: captions carry every point the narration makes, at most 12 words each,
  large and high-contrast. A visitor who never turns the sound on still gets the whole story.
- The project persona hosts it: the project's own saved character, voice and look. Never borrow
  another project's host or mascot.

## Story

The story runs value, then proof, then a call to action. Nothing else.

- Value: what the visitor gets, in their words.
- Proof: the product doing it, in real captures, one thing per moment.
- Call to action: one plain line that sends the visitor to the landing URL.

### The 30 s story spine

| Beat | Time | What is on screen |
| --- | --- | --- |
| Value hook | 0-3 s | The product doing the one thing; one line naming the gain |
| Reveal | 3-8 s | The product in full, first clear look |
| Proof moments | 8-22 s | Two or three moments, 5-7 s each, one thing the visitor can do per moment |
| Payoff | 22-26 s | What the visitor ends up with, shown |
| Call to action | 26-30 s | The landing URL as plain text, and the line that sends them there |

For 60 s keep the same five beats in the same order: stretch the reveal to 8 s and use up to five
proof moments. Never pad with invented claims; use longer holds instead.

## Product shots

- Show the product only through real captures of the live product, made with capture.cjs. Never
  a drawn fake screen, a mock-up, or a hand-built imitation of the interface.
- Use the short clips when capture.cjs returns them (`kind: 'clip'` items). Otherwise use its
  screenshots with camera moves: a slow push in, a pan across, a pull out to the focus rect it
  returned.
- View every capture before you use it. Drop any that shows an error, a blank page, a loading
  state or a sign-in screen.
- When capture.cjs returns nothing usable, say so in the report and keep the product off screen:
  words and simple props only, never a drawn screen.

## Landing URL

- Take the landing URL from the `Video target:` line when it names one. Otherwise use the
  manifest's `homepage`, or a live URL in the README. Never invent one, never guess a domain.
- Show it on the call-to-action card as plain text, never an `<a>` tag (the write tool rejects
  outbound links). Say its short form aloud.
- Never close on a shell command, an install line or a code host page when a landing URL exists.
- With no landing URL at all, close on the project's name and one plain line on what it does.

## Grounding

- Every claim comes from what you read: the README, the landing copy, the docs.
- Save every claim in `meta.sources` as `{claim, source, ref}`, where `source` is a verbatim span
  copied from what was read and `ref` names the file or page. A claim with no verbatim span is cut.
- No invented numbers, features, customers, quotes or prices.
- Never claim the host is a human and never give a location.

## Language

- Say "you". Say what the visitor can do, never how it was built.
- Short sentences in plain words. Run checks.cjs `lintLanguage` over the narration and the
  captions (pass them as `narration` in the input JSON); it must pass: no sentence over 14 words,
  reading grade 8 or under, and none of its `BANNED_WORDS`.
- Also never use these words and phrases, which `BANNED_WORDS` does not catch: "honestly",
  "actually", "genuinely", "kind of", "sort of", "a bit", "underrated", "nuance", "resonate",
  "load-bearing", "hot take", "unpopular opinion", "the real reason", "nobody tells you",
  "most people don't realize". Check for them yourself before you save.
- At most one exclamation mark in the whole script.

## Kit checks

Run the kit from `~/.claude/session-manager/demo-video-kit/` exactly as the persona says, plus:

- capture.cjs: `capture({ url, outDir, shots })` against the live product, at most 6 shots.
- checks.cjs: the language lint above, plus the persona's caption, closing and voice-fit checks.
  All must pass before you save.
- sound.cjs: `mix({ narrationWav, cues, style, lengthS, out })` lays the narration over the music
  bed. The bed is ducked under speech, stays audible between lines, and the mix is normalised to
  -14 LUFS. When the project has a saved character with a command voice, speak its lines with
  `node character.cjs speak spec.json` first.
- export.cjs: `node export.cjs spec.json` with `{ htmlPath, lengthS, audioPath, outDir }` writes
  `video.mp4` (1920x1080, H.264/AAC) and `poster.png` in `outDir`. It must exit 0. The poster is
  the frame a visitor sees before play, so pick `posterAtS` on the value hook or the payoff.
