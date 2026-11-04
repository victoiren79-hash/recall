# Recall

> **Rebuild what you know.** Recall turns forgetting into a structure you can see, and fix, with your hands.

A hands-first, seated WebXR app for the **Meta VR Start Developer Competition 2026**.
**Track:** Productivity · **Division:** New Experience · **Built with:** Immersive Web SDK (IWSDK)

---

## 1. The idea in one sentence

Flashcards test whether you remember individual facts. **Recall tests whether you understand how those facts connect**, by making you rebuild their structure in 3D space with your hands.

## 2. The problem

Reviewing flashcards checks isolated answers. You can pass every card and still not know how the ideas relate: what causes what, what depends on what, what does not belong. Recall targets that gap. You do not review what you know. You show that you know it by rebuilding it.

## 3. How it works

One session takes a few minutes.

1. **See it.** A structure of connected concepts floats in front of you, with every link glowing.
2. **Watch it break.** The concepts scramble. The links fade to faint ghosts, and empty sockets stay visible so you know where things can go.
3. **Rebuild it.** Pinch a concept, move it, release it near a socket. It snaps in. When a placement satisfies a relationship, that link lights up. A wrong placement bounces back with a short explanation.
4. **See what stuck.** A summary shows which links are strong (glowing) and which are weak (still ghosted). Weak links come back in your next session.

There is one verb: **rebuild**.

## 4. Core design principle

> **Rebuild the relationships, not the original arrangement.**

Memorizing a layout would teach the room, not the subject. So the app does not check coordinates. It checks relationships:

- A concept must sit at the correct **height** for what it is.
- For every link `A → B` where both ends are placed, A must come **before** B along the flow direction of the arc.

Any horizontal arrangement that satisfies both rules passes. Mirrored and rotated rebuilds are valid. This keeps Recall a learning tool and not a spatial jigsaw.

## 5. Spatial grammar

| Axis | Meaning | Rule |
|---|---|---|
| **Height** | What kind of thing it is | Fixed and meaningful in every session. Never randomized. |
| **Arc direction** | Flow / cause → effect | Curved arc within arm's reach in front of the seated player. May be rotated or mirrored between sessions. |
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

**Distractors** (wrong pieces mixed into the scramble) test understanding. Each one rejects with an explanation:

- *"Clouds are smoke"*: clouds are tiny water droplets or ice crystals.
- *"Evaporation makes oxygen"*: evaporation turns liquid water into water vapor.

## 7. Session progression

| Session | Challenge |
|---|---|
| 1 | Complete structure, all relationships visible |
| 2 | Rotated layout, 1 distractor, some links hidden |
| 3 | Mirrored layout, 2 distractors, more hidden links |
| 4+ | Weak links selectively removed, varied layouts |

At most about one third of links are hidden at once, so the player always has enough clues to reason through the structure.

## 8. Forgetting and the reason to come back

Every link has its own strength value and review date on a local spaced-repetition schedule.

- Correctly rebuilt links gain strength and their next review moves further out.
- Missed links drop back and come due sooner.
- Link brightness reflects strength. Weak or overdue links fade to **ghosts**, never to invisible. There is always something to rebuild toward.
- Later sessions challenge only weak links, so repeat sessions are short and never a full rebuild.

A **"next day" control** in the demo build fast-forwards the scheduler so progression can be seen without waiting real days.

## 9. Why this belongs in VR

- **Height carries meaning.** Surface water sits low, clouds sit high. In VR you rebuild the structure around you, and position and depth become memory cues.
- **Hands do the learning.** Placing each concept physically ties the action to the relationship.
- **Seated and compact.** Everything sits within arm's reach, so the airplane-seat test passes.

## 10. Hands-first and accessibility

- Entire experience completes **without a controller**. Pinch-and-place is the only required input.
- Large cards, large sockets, generous snap radius, no timing windows, no precision aiming. Designed to survive hand-tracking jitter.
- **Gaze + dwell** alternative for players who cannot pinch (IWSDK treats gaze as a pointer).
- High-contrast mode.
- No lengthy onboarding. The first scramble demonstrates the mechanic.

## 11. Competition fit

| Requirement | How Recall meets it |
|---|---|
| Hands-first | Fully playable with pinch only, no controller pairing |
| Seated-optimized | Arc and sockets within a 2-foot radius |
| Easy in / easy out | Cold start straight into a pack; first complete moment in about 60 seconds; sessions of a few minutes; progress saved automatically |
| Original, not a wrapper | No third-party service. All logic and content are built in. |
| Offline | No cloud calls. Judges can run it on a constrained network. |
| New Experience | Conceived and built inside the competition window. No pre-existing code or prototypes. |
| Track | Productivity: a short daily recall habit |

## 12. Tech stack

- **Immersive Web SDK (IWSDK)** on top of Three.js and an ECS
- **TypeScript**, bundled with Vite (via the IWSDK scaffold)
- **IndexedDB** for progress and spaced-repetition state
- **Hosting:** GitHub Pages or Vercel (static, no server)
- **Requires:** Node.js v20.19.0 or higher

### Architecture (planned)

| Module | Responsibility |
|---|---|
| `pack` loader | Reads a pack JSON and validates its shape |
| `layout` | Builds the arc and sockets from height bands; applies rotation / mirroring |
| `interaction` | Pinch-grab, move, release, snap, and gaze-dwell fallback |
| `validator` | The single rule function: correct height band and correct flow order |
| `feedback` | Link lighting, bounce-back, distractor explanations |
| `scheduler` | Per-link strength and next-review dates; "next day" fast-forward |
| `store` | IndexedDB persistence |
| `summary` | End-of-session strong / weak link report |

## 13. Pack format

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

A plain 2D page for authoring custom packs from simple text lines is planned after the core loop works.

## 14. Project structure (planned)

```
recall/
├── src/
│   ├── packs/
│   │   └── water-cycle.json
│   ├── systems/          # interaction, layout, validator, scheduler
│   ├── store/            # IndexedDB
│   └── index.ts
├── README.md
└── package.json
```

## 15. Run locally

```bash
npm install        # install dependencies
npm run dev        # start the dev session; prints the local URL
```

On a desktop browser, IWSDK provides mouse-and-keyboard emulation of a headset, so no VR hardware is needed to develop or try it. Use the URL printed by `npm run dev`, since the port can change.

## 16. Scope

**In scope**

- One polished built-in pack (water cycle)
- Pinch-and-place with forgiving snap zones
- Relationship validation and visual feedback
- Distractors with explanations
- Local spaced-repetition scheduling and ghosted weak links
- Gaze-dwell fallback and high-contrast mode
- Simple 2D format for custom packs (after the core loop)

**Out of scope**

- AI-generated content or any cloud inference
- Multiplayer
- Room customization
- A large content library
- Passthrough / mixed reality in this version

## 17. Known limitations

- **Never tested on real hands.** Hand-tracking jitter, comfort over a full session, and spatial audio are only validated in the emulator. Interactions are designed with large targets for this reason.
- A fixed cycle can be memorized by order. Rotation, mirroring, hidden links, and distractors from session 2 onward are the mitigation.
- Knowledge packs are authored by hand. There is no automatic extraction from text.

## 18. Roadmap

- More built-in packs (other systems with clear cause / dependency structure)
- Custom-pack authoring page with sharing
- Additional relationship types
- Mixed reality mode where the room's real surfaces become anchors

## 19. Submission checklist

- [ ] Playable build live at a public URL (WebXR) and still live through judging
- [ ] Demo video under 3 minutes, public on YouTube or Vimeo, leading with the first-minute rebuild
- [ ] Submission form: name, tagline (140 chars or less), track, division, description (about 500 words), team details
- [ ] Description covers inspiration, how it was built, and future plans
- [ ] Hand-interaction description (optional field)
- [ ] No third-party logos, brand names, or identifiable people in the app or video

## 20. Credits and license

Built solo by Victoire. All code, content, and assets are original or used under their own licenses. [TODO: add the list of third-party assets and their licenses before submission.]
