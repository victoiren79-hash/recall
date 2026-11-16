# Demo video production plan (target 2:45, hard limit 3:00)

Rules: real gameplay only (no AI-generated video carrying the pitch — judging criterion), lead with the best material, judges may stop at 3:00. Public YouTube/Vimeo upload, link in the submission form.

## Timeline structure

| Time | Beat | Footage | VO |
|---|---|---|---|
| 0:00–0:12 | Hook | Cold start → SEE phase, cue fades in | VO1 |
| 0:12–0:30 | Problem | Scramble — cards scatter to tray | VO2 |
| 0:30–1:05 | The verb | 3–4 grab/carry/drop placements + one wrong-order bounce (amber toast) | VO3–4 |
| 1:05–1:45 | The differentiator | Day briefing toast ("2 arrows hidden") → rebuild with dark arrows → summary with ▼ + weak list | VO5–7 |
| 1:45–2:00 | Completion | Comet, bloom, card wave — no VO, let the chord play | — |
| 2:00–2:30 | The habit | Day summary → Next Day briefing; hands-only grab | VO8–9 |
| 2:30–2:45 | Close | Contrast before/after (1 s each) → end card | VO10 |

## Voiceover — ElevenLabs

Voice: **Adam** (premade). Alternative: **Rachel** (lighter, clearer).
Settings: Stability 60%, Similarity 75%, Style 0–10%, default speed. Generate **one WAV per beat**.

- **VO1:** "What if understanding wasn't something you read — but something you could rebuild?"
- **VO2:** "You can memorize facts, and still miss how they connect. Recall turns a knowledge system — starting with the water cycle — into a structure you can see, hold, and restore."
- **VO3:** "Every session has one verb: rebuild. Study the complete structure. Watch it break. Then put every concept back where it belongs — with your hands."
- **VO4:** "Place it right, and the connection draws itself back in. Place it wrong, and Recall tells you exactly why."
- **VO5:** "Behind it, Recall tracks memory at the relationship level. Every connection has its own strength. It grows when you recall it — and fades when you don't."
- **VO6:** "And it shows. Today, two arrows are hidden. Tomorrow, it might be three."
- **VO7:** "When you finish, the summary tells the truth: what you got right, what faded, and what tomorrow watches."
- **(silence over the completion sequence — its own melody is the soundtrack)**
- **VO8:** "Mastery rises and falls between sessions. Weak relationships return sooner."
- **VO9:** "Every day, Recall already knows what to teach you. Seated. Two minutes. Fully playable with hands alone — and a one-tap high-contrast mode."
- **VO10:** "Recall. Rebuild what you know."

## Raw footage checklist (record all, pick winners in the edit)

1. Cold start → SEE + cue (2 takes)
2. Scramble (1–2 takes)
3. 4–5 correct placements, varied cards — slow, deliberate hand moves
4. Deliberate mistake: Evaporation into its own socket before Collection exists — amber toast (2 takes)
5. Day briefing toast ("2 arrows hidden") — first seconds after Next Day
6. Rebuild showing dark arrows between already-placed cards
7. The money summary (Mastery ▼ + weak list) — stage: 3 wrong-order bounces on Evaporation, then finish
8. Completion sequence — one full take, untouched
9. Hands-only grab — no controller in frame
10. Contrast toggle: 1 s off → click → 1 s on

Sources: Quest casting (`occulus.com/casting` in Chrome — hands visible) for most takes. Hard-to-time beats (briefing toast, summary reveal): run `verify-day-drill` / `verify-v13-summary` with **Playwright video recording** (context option `recordVideo`) for clean deterministic frames, then cut. Both sources mixed is fine.

## Music

- YouTube Audio Library → search "calm ambient piano" (no strong melody in the 1–4 kHz vocal band). Pixabay "ambient minimal" as alternative.
- Levels: alone ≈ −20 dB, duck to −26 dB under VO, +3 dB swell during the completion beat, fade under end card. Never louder than the app's own pentatonic notes and completion chord.

## DaVinci Resolve (free) workflow

1. Timeline: 1920×1080, 30 fps.
2. VO on A1, music on A2, footage V1, text overlays V2.
3. Radio-edit: lay all VO beats first, then cut video to the words.
4. Hard cuts only; the only dissolve allowed is the contrast before/after pair.
5. Text+ only on the end card: "Recall — rebuild what you know" / "recall-tau-sandy.vercel.app" / "Built with Immersive Web SDK · Meta VR Start 2026" — hold 4 s.
6. Fairlight: VO compressor + limiter to ≈ −14 LUFS; music ducked; completion beat music-only + app chord.
7. Deliver H.264 1080p, upload YouTube as **Public**.

## Don'ts

- No dev overlay / emulator toolbar in frame — deployed site or clean capture only.
- No AI-generated filler footage (explicit judging criterion).
- No text covering the cycle; no speed ramps; honest pacing.
- Freeze code before recording — the video must match what judges see at the link.
