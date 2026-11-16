# Recall

> **Rebuild what you know.** Recall turns forgetting into a structure you can see, and fix, with your hands.

A hands-first, seated WebXR experience for the **Meta VR Start Developer Competition 2026**.
**Track:** Productivity · **Division:** New Experience · **Built with:** Immersive Web SDK (IWSDK)

---

## 1. The idea in one sentence

Flashcards test whether you remember individual facts. **Recall tests whether you understand how those facts connect**, by making you rebuild their structure in 3D space with your hands.

## 2. The problem

Reviewing flashcards checks isolated answers. You can pass every card and still not know how the ideas relate: what causes what, what depends on what, what does not belong. Recall targets that gap. You do not review what you know. You show that you know it by rebuilding it.

## 3. How it works

One session takes a few minutes.

1. **See it.** The water cycle floats in front of you, every connection glowing. On the very first session, one short line — *"Watch how the cycle connects — then rebuild it"* — fades in and out during this phase (never shown again after day 1).
2. **Watch it break.** The concepts scatter onto the table below; faint ghost lines keep the shape of the structure visible.
3. **Rebuild it.** Point at a concept, squeeze the trigger to grab it, and release it near its socket. The card presses into place with a ripple, and the connection it satisfies **draws itself in** with a traveling light. A wrong placement glides back to the table with a short, friendly explanation.
4. **Feel it complete.** When the last connection locks in, the structure plays its own melody: a comet races the loop sounding each connection’s note, a bloom swells behind the cards, the cards breathe in sequence, and everything resolves on a chord. Then the summary fades in: what stuck, and what came back weaker.
5. **Come back tomorrow.** Memory fades a little each "day". Your weakest concepts return as the next session's challenge.

There is one verb: **rebuild**.

## 4. Core design principle

> **Rebuild the relationships, not the original arrangement.**

Memorizing a layout would teach the room, not the subject. So the app does not check coordinates. It checks relationships:

- A concept must sit at the correct **height** for what it is.
- For every link `A → B` where both ends are placed, A must come **before** B along the flow direction of the arc.

The full placement rules live in one pure function (`validator.ts`) and are unit-tested, including the guarantee that the app never lets you enter an unsolvable state.

## 5. Spatial grammar

| Axis | Meaning | Rule |
|---|---|---|
| **Height** | What kind of thing it is | Fixed and meaningful in every session. Never randomized. |
| **Arc direction** | Flow / cause → effect | Curved arc within arm's reach in front of the seated player. Sways a few degrees between days — never mirrored, never random. |
| **Fixed anchors** | The driver of the system | Placed by the app, not the player (e.g. the Sun in the water cycle). |

## 6. Built-in knowledge pack: the water cycle

The first pack is a connected system, not a four-step sequence.

**8 concepts:** Sun heat (fixed anchor), Evaporation, Water vapor, Cooling, Condensation, Clouds, Precipitation, Collection.

| From | Relationship | To |
|---|---|---|
| Sun heat | drives | Evaporation |
| Evaporation | produces | Water vapor |
| Water vapor | rises into | Cooling |
| Cooling | enables | Condensation |
| Condensation | forms | Clouds |
| Clouds | releases | Precipitation |
| Precipitation | feeds | Collection |
| Collection | supplies | Evaporation (closes the loop) |

Height bands (0 lowest → 5 highest): Collection 0, Evaporation 1, Water vapor 2, Precipitation 2, Cooling 3, Condensation 3, Clouds 4, Sun heat 5.

**Distractors** (wrong pieces mixed into the scramble, each rejecting with an explanation) are authored in the pack format and validated, but are not spawned in the current build.

## 7. Session progression

The difficulty rung responds to demonstrated mastery (evaluated from relationship strengths, weak counts, and the last completed session), not to the calendar:

| Rung | Challenge |
|---|---|
| 1 | Complete reference structure, all relationships visible |
| 2 | Ring sways ±8°; 2 relationships hidden |
| 3 | 3 relationships hidden |
| 4 | Weakest concepts start unplaced on the table |

- **Strong mastery → faster progression.** Clean, high-mastery sessions promote the rung.
- **Repeated struggles → more reinforcement.** Weak concepts return as drills and escalation pauses until the user recovers.
- **Overwhelmed → de-escalation.** If mastery collapses, the rung drops so the reconstruction gets easier while the drill targets the weak spots.
- Hidden relationships never disappear entirely: they stay as a dim skeleton so the structure is always readable.
- At most 3 concepts are ever removed, so sessions stay short.
- **Restart** wipes the whole run (day 1, rung 1, full strength). **Next Day** fades memory a little and re-evaluates the rung.

## 8. Forgetting and the reason to come back

Every link carries its own strength value (0–1), the day it was last rebuilt, and its hint history, on a local spaced-repetition schedule.

- Correctly rebuilt links gain strength (+0.08; +0.04 when a hint assisted the recall); links contradicted by a wrong-order placement lose it (−0.12). Wrong-height or occupied-socket bounces carry no relationship evidence, so they cost nothing — they are recorded on the concept instead, shifting tomorrow's emphasis.
- Each simulated day, memory decays a little (−0.06) — connection brightness reflects strength, so you can literally see what is fading.
- **Review scheduling:** hidden relationships are chosen by review priority — weak relationships return sooner, strong ones earn progressively longer intervals, and relationships you have repeatedly struggled with come back more often. Each link also tracks the last day it was *actually tested from memory* (hidden), so the hiding set rotates day to day instead of repeating the same two arrows. Assisted (hint-covered) recall is recorded separately from independent recall.
- **Day briefing:** every session from day 2 opens by announcing what changed — "2 arrows hidden — recall from memory", a named drill, or "every arrow visible" — so the adaptive work is visible, not silent.
- Concepts whose weakest link drops below 0.5 are selected as the next session's drill, capped at 3 per session.
- The last 12 completed sessions are kept as history, powering the mastery trend in the summary.
- Progress (day, rung, per-link strengths, concept profile, history) persists in IndexedDB and survives closing the app. Preferences (intro cue seen, high-contrast mode) persist in a separate small flags store.

A **"Next Day" control** fast-forwards the scheduler so progression can be seen without waiting real days. **"Restart"** resets the entire run. The summary offers **"Study again"** (same day, fresh rebuild) alongside Next Day.

## 9. Why this belongs in VR

- **Height carries meaning.** Surface water sits low, clouds sit high. In VR you rebuild the structure around you, and position and depth become memory cues.
- **Hands do the learning.** Placing each concept physically ties the action to the relationship.
- **Seated and compact.** Everything sits within arm's reach, so the airplane-seat test passes.

## 10. Input and comfort

- **Controllers and hand tracking** both work through the same grab pipeline (IWSDK `DistanceGrabbable`): aim, squeeze, release.
- The laser cursor is always visible with a tip dot in empty space, so aiming is never a guess.
- Cards float to a fixed, readable offset in front of the grabbing hand — sockets stay reachable beyond arm's length.
- Large cards, generous snap radius, no timing windows, no precision aiming, no forced rotation. Designed to survive hand-tracking jitter.
- Hover, grab, and placement all respond with spring-based micro-animations; placement ends with an iOS-style ripple blooming out of the card.
- The completed structure celebrates with a comet racing the loop, a shockwave, a card wave, and a light bloom — then the summary fades in. Never fireworks.
- **A Hint control during rebuilds**: escalating, contextual assistance — from a gentle “start here” socket highlight to an explicit relationship clue — requested by the user, never automatic, and recorded so hinted recalls count for less than independent ones.
- **Procedural sound design** — every interaction has a quiet, spatially-placed voice: a tick on grab, a warm thock on placement, the pentatonic melody climbing as connections light up, a gentle bump on mistakes, and the completion sequence resolving on a literal chord. Fully synthesized in the Web Audio API — zero audio assets, nothing to license.
- **High-contrast mode** — a toggle in the menu swaps card faces, socket outlines, and cycle links to a WCAG-AA palette (near-black cards, pure-white borders and labels, amber sockets) on demand. Off by default; the choice persists.
- **Mistakes always speak.** Every correction pairs its amber flash with a written explanation — no feedback is ever color-only.

Planned after the core loop: gaze-and-dwell fallback.

## 11. Competition fit

| Requirement | How Recall meets it |
|---|---|
| Hands-first | Playable with controllers or hand tracking; pinch-and-place is the only required input |
| Seated-optimized | Cycle and tray within a 2-foot radius, wrapped around the seated player |
| Easy in / easy out | Cold start straight into a pack; first complete moment in about 60 seconds; sessions of a few minutes; progress saved automatically |
| Original, not a wrapper | No third-party service. All logic and content are built in. |
| Offline | No cloud calls. Judges can run it on a constrained network. |
| New Experience | Conceived and built inside the competition window. No pre-existing code or prototypes. |
| Track | Productivity: a short daily recall habit |

## 12. Tech stack

- **Immersive Web SDK (IWSDK)** on top of Three.js and an ECS
- **TypeScript**, bundled with Vite (via the IWSDK scaffold)
- **IndexedDB** for progress and spaced-repetition state
- **Vitest** for the pure-logic test suite (layout, validator, scheduler)
- **Performance hygiene:** shared geometry/material pools across cards and props, bloom post-processing that steps aside entirely in XR, and XR supersampling capped at 1.5 for frame-budget safety
- **Hosting:** GitHub Pages or Vercel (static, no server)
- **Requires:** Node.js v20.19.0 or higher

## 13. Architecture

| Module | Responsibility |
|---|---|
| `src/index.ts` | Conductor: boots the world, runs the session machine (SEE → REBUILD → SUMMARY), XR anchoring, cursor visuals |
| `src/packs/loadPack.ts` | Reads a pack JSON and validates its shape |
| `src/systems/layout.ts` | Builds sockets, anchors, and the tray from the pack; sways between sessions |
| `src/systems/spawn.ts` | Builds the SEE-state scene: cards, sockets, links, tray, room, HUD anchors; owns the completion sequence |
| `src/systems/interaction.ts` | Grab, move, release, snap-or-return, hover/grab/placement feedback, link lighting, progress |
| `src/systems/validator.ts` | The single rule function: correct height band and correct flow order |
| `src/systems/scheduler.ts` | Per-link strength, daily decay, weak-node selection, day ladder |
| `src/systems/session.ts` | Deterministic per-day session variety (hidden links, sway, weak drill) |
| `src/systems/store.ts` | IndexedDB persistence |
| `src/systems/hud.ts` | Canvas-textured panels: title, instructions, progress, menu, summary, toasts |
| `src/systems/motion.ts` | Shared motion language: damping, springs, easings |
| `src/systems/audio.ts` | Procedural Web Audio sound design: spatial voices, pentatonic link notes, completion chord |
| `src/systems/audio.ts` | Procedural Web Audio sound design: spatial voices, pentatonic link notes, completion chord |

## 14. Pack format

Packs are plain JSON, kept separate from code.

```json
{
  "id": "water-cycle",
  "nodes": [
    { "id": "sun", "label": "Sun heat", "band": 5, "fixed": true },
    { "id": "evap", "label": "Evaporation", "band": 1 }
  ],
  "links": [
    { "from": "sun", "to": "evap", "type": "drives" }
  ],
  "distractors": [
    { "label": "Clouds are smoke", "why": "Clouds are tiny water droplets or ice crystals, not smoke." }
  ]
}
```

- `band`: fixed height level (0 lowest, higher is higher up)
- `fixed`: placed by the app, not the player
- `links`: relationships the validator checks
- `distractors`: wrong pieces and the reason shown when rejected

## 15. Project structure

```
recall/
├── public/                  # static files served as-is
├── scripts/                 # headless verification suite (Playwright + IWSDK emulator)
├── src/
│   ├── index.ts             # conductor: boot, session machine, XR anchoring, cursors
│   ├── packs/               # knowledge packs + loader/validator
│   ├── systems/             # layout, spawn, interaction, validator, scheduler,
│   │                        #   session, store, hud, motion (+ unit tests)
│   └── components.ts        # ECS component definitions
├── index.html
├── iwsdk.config.json        # project authority: scene, assets, components, world
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
├── package.json
├── LICENSE.txt
└── README.md
```

## 16. Run locally

```bash
npm install        # install dependencies
npm run dev        # start the dev session; opens https://localhost:8081
npx vitest run     # run the pure-logic test suite
```

On a desktop browser, IWSDK provides an emulator for the headset, so no VR hardware is needed to develop or try it. **Enter XR** from the in-app button (or `__recall.launch()` from the console) to test the immersive layout.

### Headless verification

With the dev server running on `https://localhost:8081`:

```bash
node scripts/verify-v9-fixes.mjs    # placement rules + full rebuild via real emulator grabs
node scripts/verify-v13-summary.mjs # XR layout stability, summary placement, completion glow
node scripts/verify-v14-loop.mjs    # day ladder, weak-card drill, missing-link rebuild, restart reset
node scripts/verify-v15-completion.mjs # the completion sequence arms, runs, and settles fully lit
node scripts/grab-e2e.mjs           # real trigger-press grab → carry → snap, plus HUD reachability
```

Each script loads the app in a headless Chromium session with the IWSDK emulator, drives real input, and exits non-zero on failure. Screenshots land in `.verify/`.

## 17. Scope

**In scope**

- One polished built-in pack (water cycle)
- Point-and-place with forgiving snap zones (controllers and hand tracking)
- Relationship validation and visual feedback
- Local spaced-repetition scheduling and ghosted weak links
- Completion celebration, hover/grab micro-interactions, ambient detail, procedural sound

**Out of scope**

- Distractor cards in the current build (pack format supports them; visuals disabled)
- AI-generated content or any cloud inference
- Multiplayer
- Room customization
- A large content library
- Passthrough / mixed reality in this version
- Gaze-dwell fallback (planned)

## 18. Known limitations

- **Emulator-validated.** Interaction comfort, hand-tracking jitter, and comfort over a full session are validated in the IWSDK emulator and desktop browser, not yet on a physical headset. Interactions use large targets and generous snap radii for this reason.
- A fixed cycle can be memorized by order. Sway, hidden links, and weak-card drills from day 2 onward are the mitigation.
- Knowledge packs are authored by hand. There is no automatic extraction from text.

## 19. Roadmap

- More built-in packs (other systems with clear cause / dependency structure)
- Custom-pack authoring page with sharing
- Additional relationship types
- Re-enable distractor cards with polished visuals
- Mixed reality mode where the room's real surfaces become anchors

## 20. Credits and license

**Author:** Built solo by Victoire.

**License:** The source code in this repository is released under the [MIT License](LICENSE.txt).

**Third-party software:** Recall is built on the Immersive Web SDK, Three.js, and other open-source packages. They are installed from npm and not copied into this repository, and each stays under its own license.

**Assets:** The pack content, explanations, and visuals are original.

**Competition:** Entered in the Meta VR Start Developer Competition 2026. Under the Official Rules, the author keeps ownership of the entry and grants the sponsor the rights described there for evaluation and promotion.
