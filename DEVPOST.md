# Devpost submission — final copy (2026-11-16)

**Track:** Productivity · **Division:** New Experience

**Tagline (pick one):**
- Rebuild what you know. A VR learning experience where you physically restore forgotten connections and watch your understanding take shape.
- Rebuild what you know. Hands-first VR that restores fading knowledge structures — and remembers exactly what to bring back tomorrow.

**Optional field — how Hand Interactions are implemented:**
> Every interaction is pinch-first: distance-grab carries cards at a readable offset along the hand's ray, validity-aware snapping means a drop lands on the nearest legal socket, and the HUD (hints, menus, summary) is reachable without controllers. Hands and controllers share one interaction pipeline, so feedback, audio, and difficulty behave identically in both.

**Team contribution:** Solo developer — interaction design, systems engineering, procedural audio, and testing.

**Housekeeping:** select Track + Division, add video link (<3 min, device/simulator footage), 3–5 screenshots (summary with Mastery trend + weak-link list, rebuild with hidden arrows, day briefing toast, contrast mode on).

---

## Inspiration

Knowing individual facts is not the same as understanding how they fit together.

You can memorize every term in a subject and still struggle to explain how one idea leads to another, what depends on what, or why a system works the way it does. Most learning tools test what you remember, but rarely make the structure of your understanding visible.

I wanted to explore a different approach: what if learning were something you could physically rebuild?

VR offered a natural way to experiment with that idea. Instead of presenting knowledge as another page or collection of flashcards, Recall turns it into a spatial structure. Connections become visible. Forgetting has a visual consequence. And remembering means restoring the relationships that hold the whole system together.

That became the central idea behind Recall: **make understanding something you can see, interact with, and rebuild.**

## What it does

Recall transforms a knowledge system, starting with the water cycle, into a floating structure of connected concepts.

Each learning session follows one central action: **rebuild**.

**1. See it**

The complete knowledge structure appears in front of you. Concepts are connected by glowing lines, making the relationships between them visible.

**2. Watch it break**

The concepts scatter onto a table below. Their connections fade into faint outlines, leaving the structure incomplete.

**3. Rebuild it**

Using hand tracking, you point, pinch, pick up concepts, and release them into their corresponding positions.

A correct placement presses the card into its socket, creates a ripple, and restores the relationship with a traveling light. An incorrect placement returns the card to the table with a short explanation.

Hands carry the entire experience end-to-end — grabbing, dropping, hints, menus, and the summary are all reachable by pinch alone. Controllers are optional; nothing ever requires pairing one.

The interaction is deliberately simple. The challenge is understanding where each concept belongs and how it connects to the others.

**4. Feel it complete**

When the structure is restored, the experience brings it to life.

A comet travels through the completed cycle, sounding each connection as a note. The cards animate in sequence, a bloom expands, and the experience resolves into a final chord.

Afterward, a session summary shows which relationships were successfully recalled and which still need reinforcement.

### Learning that adapts

The rebuilding interaction is only one part of Recall. Behind it is a spaced-repetition system that tracks memory at the relationship level.

Each relationship has its own strength. Successful recall reinforces it, while its strength gradually decays over time. Weaker relationships are brought back sooner, and the concepts associated with them become part of subsequent sessions.

Every session from the second day on opens by announcing what changed — *"2 arrows hidden — recall from memory"*, a named drill, or *"every arrow visible."* The summary shows mastery rising or falling between sessions and names the exact relationships that weakened. Progress persists locally, so tomorrow's session is already shaped by today's.

This means Recall does not simply track whether someone completed a session. It tracks which connections they can reconstruct and which ones need more practice — a loop designed to pull the learner back tomorrow, with growth between sessions that is visible, not implied.

## How we built it

Recall is built with the Immersive Web SDK (IWSDK), Three.js, and an Entity Component System architecture, using TypeScript and Vite.

The project is organized around several independent systems:

- **Interaction and presentation:** IWSDK handles the immersive experience and unified interaction pipeline. Three.js and ECS manage the spatial environment, concepts, cards, and connections.
- **Knowledge validation:** A dedicated validator checks the rules of the knowledge structure, including height bands and flow order.
- **Adaptive scheduling:** A separate scheduler tracks individual relationship strengths, daily decay, review scheduling, and performance-responsive difficulty.
- **Session generation:** The session generator uses the learning state to determine what should appear in the next session.
- **Procedural environment and audio:** The room, cards, and icons are generated in code. Audio is synthesized through the Web Audio API and spatially positioned so sounds originate from the interactions that produce them.
- **Persistence:** IndexedDB stores the day counter, relationship strengths, concept difficulty profile, and session history so learning progress survives restarts.

The whole loop is FoV-aware and seated: the cycle sits in the comfortable center of view, panels wrap to the edges, and every interaction works within a two-foot radius — the airplane-seat test passes.

The experience is designed to work offline without downloading external visual or audio assets.

We also built a headless verification suite using Playwright and the IWSDK emulator — nine end-to-end suites that drive actual grab, pinch, and mouse interactions and check the complete learning loop, allowing us to test behavior rather than relying only on visual inspection.

## Challenges we ran into

**Making adaptation honest**

Our first difficulty system advanced according to the calendar rather than demonstrated mastery, and it initially penalized every relationship connected to a misplaced card, even when the learner might have understood some of those relationships correctly.

We changed the attribution logic so that only the relationships actually blocked by a placement lose strength. Difficulty now responds to demonstrated mastery instead of elapsed time.

**Preventing unsolvable sessions**

An early version could allow a sequence of placements that left one card impossible to place. We addressed this in the validator, which now ensures that every accepted placement preserves a solvable puzzle.

**Sharing one space, and earning every effect**

Two smaller fights shaped the polish: the floating structure and the card tray initially competed for the same visual space (the tray now lives on the table below), and early builds leaned on decorative glow — stripped out so that light and motion only carry real feedback.

## Accomplishments that we're proud of

**A complete learning interaction**

Recall connects spatial interaction, knowledge validation, adaptive scheduling, and persistent progress into one working learning loop.

**A loop that pulls you back tomorrow**

Sessions are short, progress persists, and the summary makes growth between sessions visible — mastery trending up or down, weak relationships named, and the next session's challenge announced. Recall is built as a daily habit, not a one-time demo.

**Relationship-level adaptation**

Instead of treating a session as simply right or wrong, Recall tracks individual connections. This gives the learning system a more precise basis for deciding what needs to be reviewed.

**Accessibility as a toggle, not an afterthought**

A one-tap high-contrast mode swaps cards, sockets, and connections to a WCAG-AA palette — and every correction pairs its amber flash with a written explanation, so no feedback is ever color-only.

**A verified interaction loop**

We built 51 automated tests and nine emulator-driven end-to-end suites that exercise real grab-and-place input and verify the adaptive flow.

**One verb, one line of onboarding**

The experience is built around a single action: rebuild. The first session opens with one skippable line — no tutorial, no walls of text.

## What we learned

**Adaptation needs attribution.**

Knowing that a learner failed is easy. Knowing which connection they misunderstood is what makes reinforcement useful rather than punitive.

**Presence changes how information is experienced.**

Spatial positioning, hand interaction, and sound made the experience feel less like answering a quiz and more like working with a system. The knowledge structure became something to interact with, rather than something to look at.

**Automated interaction testing matters.**

The emulator-driven tests caught problems that manual testing repeatedly missed, including unreachable cards, stuck interaction states, and unsolvable boards. Testing the actual interaction loop was essential to making the experience reliable.

## What's next for Recall

The current water-cycle knowledge pack is a starting point. The underlying approach can support other subjects that depend on relationships, sequences, or constraints.

Our next steps include:

- **More knowledge packs:** History timelines, anatomy systems, state machines, and other subjects with interconnected concepts.
- **A pack-authoring format:** A lightweight way for educators and creators to define their own knowledge structures.
- **Mixed-reality mode:** Anchor knowledge structures to a real desk, bringing the rebuilding interaction into the user's physical environment.
- **Gaze-and-dwell input:** For people who cannot use pinch gestures.

The long-term direction is to make Recall a flexible way to learn systems, not just a single VR activity about the water cycle.
