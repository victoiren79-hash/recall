// src/index.ts
// App conductor: boots the world, loads persisted progress, and runs the
// session machine — SEE (study the structure) → scramble → REBUILD → complete
// → SUMMARY → Replay / Next Day.

import {
  World,
  Vector3,
  Euler,
  FogExp2,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  SRGBColorSpace,
} from '@iwsdk/core';
import { ensureAudio, updateListener, sfx } from './systems/audio';
import { Vector2 } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import projectOptions from 'virtual:iwsdk-project';

// __RECALL_UI_VERSION__: v8
import { PanelSystem } from './panel.js';
import { loadBundledPack } from './packs/loadPack';
import { buildLayout } from './systems/layout';
import { spawnStructure, disposeSpawn, type HeadPose, type SpawnHandles } from './systems/spawn';
import { createHud, type HudHandles, type HudPhase } from './systems/hud';
import { InteractionSystemImpl } from './systems/interaction';
import {
  initSchedulerState,
  applySessionResult,
  advanceDay,
  weakNodeIds,
  linkStrengthMap,
  linkId,
  type SchedulerState,
} from './systems/scheduler';
import { buildSessionConfig, hiddenCountForSession, type SessionConfig } from './systems/session';
import { MASTERED_THRESHOLD, normalizeState, recordSession, reviewLinkIds, type SessionRejection } from './systems/scheduler';
import { loadProgress, saveProgress } from './systems/store';

/** How long the solved structure stays up before it scrambles (ms). The
 * first-ever session gets the long study window; every later session is a
 * refresher and moves on quickly. */
const SEE_DURATION_MS = 3000;
const SEE_FIRST_MS = 5000;

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then(async (world) => {
  // Dark seated-room mood: fade distant geometry into the wall's base colour.
  const scene = (world as any).scene;
  if (scene && typeof scene === 'object' && 'fog' in scene) {
    scene.fog = new FogExp2(0x10141d, 0.08);
  } else {
    console.warn('[Recall] world.scene not available; fog skipped');
  }

  // Crisp rendering: match the display's pixel ratio (user feedback: blurry).
  try {
    const renderer = (world as any).renderer;
    if (renderer && typeof renderer.setPixelRatio === 'function') {
      // Floor the pixel ratio at 1.5 even when devicePixelRatio is 1: the flat
      // canvas otherwise renders at CSS resolution and is upscaled by the
      // compositor on scaled displays (Windows 125-150% is common) — visibly
      // soft. XR is unaffected by this value on real headsets (WebXR sizes its
      // own framebuffer via setFramebufferScaleFactor below), and the IWER
      // emulator hard-resets the canvas to the window size at session start
      // regardless, so this only ever sharpens the flat view.
      renderer.setPixelRatio(Math.max(Math.min(window.devicePixelRatio || 1, 2), 1.5));
    }
    // Supersample the XR framebuffer on real headsets (the Quest browser
    // honours this; the IWER emulator ignores it).
    renderer.xr?.setFramebufferScaleFactor?.(1.5);
    // Foveation 1.0 (the default) blurs everything outside the centre —
    // disable it so the whole view stays sharp.
    renderer.xr?.setFoveation?.(0);
    // IWER (the browser emulator) hard-resets the canvas to the window's CSS
    // size when a session starts, throwing away the supersampled buffer —
    // which is why XR looked far blurrier than the flat page. three fires
    // 'sessionstart' after that reset, so re-apply the supersampled size
    // here. Detection: IWER's XRWebGLLayer reports framebuffer === null
    // (native layers always expose a real framebuffer).
    const XR_SUPERSAMPLE = Math.max(Math.min(window.devicePixelRatio || 1, 2), 1.5);
    renderer.xr?.addEventListener?.('sessionstart', () => {
      try {
        const layer = renderer.xr?.getBaseLayer?.();
        if (!layer || layer.framebuffer !== null) return; // native headset — leave it alone
        // renderer.setSize() refuses to run while presenting, and setPixelRatio
        // funnels through it — so resize the drawing buffer directly.
        const canvas = renderer.domElement as HTMLCanvasElement;
        canvas.width = Math.floor(window.innerWidth * XR_SUPERSAMPLE);
        canvas.height = Math.floor(window.innerHeight * XR_SUPERSAMPLE);
      } catch (err) {
        console.warn('[Recall] XR supersample failed', err);
      }
    });
    // IWER applies its render state at frame boundaries — its canvas reset
    // lands AFTER the sessionstart hook (on the first frame). Re-assert the
    // supersampled buffer every XR frame; it's a cheap size comparison, and
    // IWER's viewports read the canvas size dynamically so the change takes
    // effect in the same frame.
    (world as any).onXRFrame?.(() => {
      try {
        const layer = renderer.xr?.getBaseLayer?.();
        if (!layer || layer.framebuffer !== null) return;
        const canvas = renderer.domElement as HTMLCanvasElement;
        const w = Math.floor(window.innerWidth * XR_SUPERSAMPLE);
        const h = Math.floor(window.innerHeight * XR_SUPERSAMPLE);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      } catch {
        // Frame-guard only; never break the XR loop.
      }
    });
  } catch {
    // Renderer manages its own ratio.
  }

  // Neon bloom post-processing (reference look): every emissive element —
  // card borders, arrows, sun, HUD borders — bleeds light like the mockup.
  // XR frames bypass the composer (standard composers are not XR-safe).
  try {
    const renderer = (world as any).renderer;
    const scene3d = (world as any).scene;
    if (renderer && scene3d && (world as any).camera) {
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene3d, (world as any).camera));
      const bloom = new UnrealBloomPass(
        new Vector2(window.innerWidth, window.innerHeight),
        0.2,  // strength
        0.4,  // radius
        0.78, // threshold (linear) — only the sun/arrow cores bloom
      );
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      composer.setPixelRatio(renderer.getPixelRatio?.() ?? 1);
      composer.setSize(window.innerWidth, window.innerHeight);
      window.addEventListener('resize', () => {
        composer.setSize(window.innerWidth, window.innerHeight);
      });

      const originalRender = renderer.render.bind(renderer);
      const originalToneMapping = renderer.toneMapping;
      let composing = false;
      renderer.render = (sceneArg: any, cameraArg: any) => {
        // Inside the composer's own passes, or while presenting in XR, render
        // directly — composers cannot drive WebXR stereo rendering.
        if (composing || renderer.xr?.isPresenting) {
          // XR path keeps the engine's own tone mapping.
          renderer.toneMapping = originalToneMapping;
          return originalRender(sceneArg, cameraArg);
        }
        // Flat path: RenderPass must stay linear — OutputPass applies the
        // engine's tone mapping exactly once at the end.
        renderer.toneMapping = 0; // NoToneMapping
        composing = true;
        try {
          return composer.render();
        } finally {
          composing = false;
        }
      };
    } else {
      console.warn('[Recall] bloom composer skipped — renderer/scene/camera unavailable');
    }
  } catch (err) {
    console.warn('[Recall] bloom composer setup failed; rendering without bloom', err);
  }

  // Standard VR cursor affordance (user spec): a straight laser, always
  // visible, with a small dot at its extremity so aiming reads even when the
  // ray hits nothing. The SDK laser defaults to VisibleOnIntersection and its
  // surface dot only exists on hover — so we flip the laser to always-on
  // (no scaling hacks; stock 2 mm beam) and add our own tip dot for empty
  // space. On hover the SDK's surface cursor takes over and ours hides.
  const cursorTipDots: Array<{ sprite: Sprite; pointer: { getIntersection?: () => unknown } }> = [];
  try {
    const dotCanvas = document.createElement('canvas');
    dotCanvas.width = 64;
    dotCanvas.height = 64;
    const dctx = dotCanvas.getContext('2d');
    if (dctx) {
      const g = dctx.createRadialGradient(32, 32, 0, 32, 32, 30);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(0.45, 'rgba(230, 242, 255, 0.95)');
      g.addColorStop(1, 'rgba(200, 225, 255, 0)');
      dctx.fillStyle = g;
      dctx.fillRect(0, 0, 64, 64);
      const dotTexture = new CanvasTexture(dotCanvas);
      dotTexture.colorSpace = SRGBColorSpace;
      const multiPointers = (world as any).input?.xr?.multiPointers;
      for (const hand of ['left', 'right'] as const) {
        const rayPointer = multiPointers?.[hand]?.ray?.visual;
        if (!rayPointer?.ray) continue;
        rayPointer.rayDisplayMode = 1; // RayDisplayMode.Visible — always-on laser
        const dotMat = new SpriteMaterial({
          map: dotTexture,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          depthTest: false,
        });
        const dot = new Sprite(dotMat);
        dot.renderOrder = 999;
        dot.scale.setScalar(0.014);
        dot.position.set(0, 0, -0.75); // the laser's idle length (SDK endValue)
        rayPointer.ray.add(dot);
        cursorTipDots.push({ sprite: dot, pointer: rayPointer.pointer });
      }
    }
  } catch (err) {
    console.warn('[Recall] cursor setup unavailable', err);
  }

  // Emulator input-mode safeguard. The IWER dev UI persists an input preset
  // (controller / hand) in browser prefs — a stray click on the hand preset
  // makes EVERY later session hand-only: controllers lose their lasers and
  // triggers entirely (that is the "left laser only, hands work" symptom).
  // The injection applies prefs patches posted on this channel, so exposing
  // a one-call switch lets us (and the user, from the console) snap back to
  // controllers without hunting through the emulator UI. The emulator's RPC
  // listener dispatches `setInputMode` with `{ mode }` (see its message
  // handler: `executeSetInputMode({ mode })`).
  (window as any).__recallSetEmulatorInput = (mode: 'controller' | 'hand'): void => {
    if (mode !== 'controller' && mode !== 'hand') return;
    window.postMessage(
      { id: `recall-${Date.now()}`, method: 'setInputMode', params: { mode } },
      window.location.origin === 'null' ? '*' : window.location.origin,
    );
  };

  // Autoplay policy: create/resume the audio context on the first gesture.
  window.addEventListener('pointerdown', () => ensureAudio(), { once: true });
  window.addEventListener('keydown', () => ensureAudio(), { once: true });

  // Enter XR overlay (production has no dev-plugin UI): a fixed glass button
  // that requests the immersive session — works from desktop Chrome and the
  // Quest browser. Hidden while presenting; the flat page stays playable
  // with the mouse (IWSDK's canvas pointer drives a cursor + grab).
  const enterXR = document.createElement('button');
  enterXR.type = 'button';
  enterXR.className = 'recall-enter-xr';
  enterXR.textContent = 'Enter XR';
  const setXRLabel = (text: string, ms = 0): void => {
    enterXR.textContent = text;
    if (ms > 0) window.setTimeout(() => (enterXR.textContent = 'Enter XR'), ms);
  };
  // Support pre-flight: on a desktop without an XR runtime, say so instead of
  // failing silently — the flat page stays mouse-playable either way.
  const xrCheck = (navigator as any).xr?.isSessionSupported?.('immersive-vr');
  if (xrCheck?.then) {
    xrCheck
      .then((ok: boolean) => {
        if (!ok) setXRLabel('Desktop mode — mouse-playable (XR needs a headset or emulator)');
      })
      .catch(() => {});
  }
  enterXR.addEventListener('click', () => {
    ensureAudio();
    if (!(navigator as any).xr) {
      setXRLabel('XR not available in this browser — desktop mode uses the mouse', 3000);
      return;
    }
    try {
      const result = (world as any).launchXR?.();
      if (result?.catch) {
        result.catch((err: unknown) => {
          console.warn('[Recall] launchXR failed', err);
          setXRLabel('XR failed to start — the page stays mouse-playable', 3000);
        });
      }
    } catch (err) {
      console.warn('[Recall] launchXR failed', err);
      setXRLabel('XR failed to start — the page stays mouse-playable', 3000);
    }
  });
  const xrStyle = document.createElement('style');
  xrStyle.textContent = [
    '.recall-enter-xr {',
    '  position: fixed; top: 16px; right: 16px; z-index: 1000;',
    '  padding: 10px 24px; border-radius: 14px;',
    '  border: 1px solid rgba(96, 165, 250, 0.6);',
    '  background: rgba(20, 26, 43, 0.85); color: #ffffff;',
    "  font: 600 15px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;",
    '  cursor: pointer; letter-spacing: 0.04em;',
    '  box-shadow: 0 4px 18px rgba(59, 130, 246, 0.25);',
    '}',
    '.recall-enter-xr:hover {',
    '  background: rgba(34, 44, 70, 0.92);',
    '  border-color: rgba(140, 190, 250, 0.9);',
    '}',
    // Desktop affordances hint: small, dim, bottom-left — discoverable
    // without competing with the scene.
    '.recall-desktop-hint {',
    '  position: fixed; bottom: 14px; left: 16px; z-index: 1000;',
    '  padding: 7px 14px; border-radius: 10px;',
    '  border: 1px solid rgba(96, 165, 250, 0.28);',
    '  background: rgba(16, 21, 36, 0.72); color: rgba(214, 230, 250, 0.85);',
    "  font: 500 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;",
    '  letter-spacing: 0.03em; pointer-events: none; user-select: none;',
    '}',
    '.recall-desktop-hint b { color: #ffffff; font-weight: 700; }',
  ].join('\n');
  document.head.appendChild(xrStyle);
  document.body.appendChild(enterXR);
  // The desktop hint: WASD turns the (seated) view, mouse drags cards.
  const desktopHint = document.createElement('div');
  desktopHint.className = 'recall-desktop-hint';
  desktopHint.innerHTML = '<b>WASD</b> — turn around &nbsp;·&nbsp; <b>Mouse</b> — grab &amp; drop cards';
  document.body.appendChild(desktopHint);
  const xrRenderer = (world as any).renderer;
  const syncXRButton = (): void => {
    const presenting = Boolean(xrRenderer?.xr?.isPresenting);
    enterXR.style.display = presenting ? 'none' : 'block';
    desktopHint.style.display = presenting ? 'none' : 'block';
  };
  xrRenderer?.xr?.addEventListener?.('sessionstart', syncXRButton);
  xrRenderer?.xr?.addEventListener?.('sessionend', syncXRButton);
  syncXRButton();

  // Register the core systems we need. GrabSystem is already registered by
  // World.create (iwsdk.config.json sets world.features.grabbing: true).
  world.registerSystem(PanelSystem);

  // Visible UI version (shown next to the logo) — bump it whenever the visual
  // build changes so a stale tab is instantly recognisable.
  const UI_VERSION = 'v8';

  // Self-healing dev reload: a long-lived tab keeps running old code across
  // dev-server restarts (the HMR socket dies with the old process). Poll the
  // served module for its version and hard-reload when it drifts.
  if (import.meta.env.DEV) {
    try {
      sessionStorage.setItem('recall-ui-version', UI_VERSION);
    } catch {
      // Storage unavailable — the poller still runs, just without the guard.
    }
    setInterval(async () => {
      try {
        const res = await fetch('/src/index.ts?recall-probe=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        const text = await res.text();
        // Only well-formed version captures count — the regex literal itself
        // appears in the served source and must never match (that bug trapped
        // npm run dev in an endless reload loop).
        const matches = [...text.matchAll(/__RECALL_UI_VERSION__:\s*(v\d+)/g)];
        const served = matches.map((m) => m[1]).find((v) => /^v\d+$/.test(v));
        if (!served || served === UI_VERSION) return;
        // Reload at most once per version change (sessionStorage guard) so a
        // flaky server can never trap the tab in a reload loop.
        try {
          if (sessionStorage.getItem('recall-ui-version') === served) return;
          sessionStorage.setItem('recall-ui-version', served);
        } catch {
          // ignore
        }
        location.reload();
      } catch {
        // Server briefly unavailable — try again next tick.
      }
    }, 5000);
  }

  const pack = loadBundledPack();
  const allLinkIds = pack.links.map((l) => linkId(l.from, l.to));
  const labelOf = (id: string): string =>
    pack.nodes.find((n) => n.id === id)?.label ?? id;

  const saved = await loadProgress();
  let progress: SchedulerState = saved ? normalizeState(saved, pack) : initSchedulerState(pack);

  let config: SessionConfig;
  let spawnHandles: SpawnHandles | null = null;
  let hud: HudHandles | null = null;
  let interaction: InteractionSystemImpl | null = null;
  let phase: HudPhase = 'see';
  let seeTimer: number | null = null;
  let currentHead: HeadPose | null = null;

  const clearSeeTimer = (): void => {
    if (seeTimer !== null) {
      clearTimeout(seeTimer);
      seeTimer = null;
    }
  };

  const beginRebuild = (): void => {
    clearSeeTimer();
    if (phase !== 'see' || !interaction || !hud) return;
    phase = 'rebuild';
    interaction.setPhase('rebuild');
    hud.setPhase('rebuild', progress.sessionNum);
    // Session 4+: only the weak links (spawned unplaced) are the challenge —
    // strong cards stay placed so repeat sessions stay short (README §8).
    const weakOnly = config.number >= 4 && config.removedNodeIds.length > 0;
    interaction.scrambleToTray(weakOnly ? config.removedNodeIds : undefined);
    hud.showToast('Scrambled!', 'Drag the concepts back into position.', 'success');
  };

  const onSessionComplete = (): void => {
    if (phase !== 'rebuild' || !interaction || !hud) return;
    phase = 'summary';
    interaction.setPhase('summary');
    hud.setPhase('summary', progress.sessionNum);

    // Completion sequence (user: "the whole point of the program"): the
    // satisfied connections pulse through in flow order with traveling
    // lights, a bloom swells behind the structure, the cards breathe once in
    // sequence, and the room's light gently lifts. The summary fades in
    // AFTER the wave — the structure is the star first.
    spawnHandles?.playCompletionWave();
    spawnHandles?.setCompletionGlow(true);
    interaction.playCompletionCardWave();

    const rejections: SessionRejection[] = interaction.getSessionRejections();
    const hintedConcepts = interaction.getHintedConcepts();
    // Mastery + session history: record before building the summary so the
    // progress comparison uses the just-finished state.
    const strengths = pack.links.map((l) => progress.links[linkId(l.from, l.to)]?.strength ?? 1);
    const mastery = strengths.length > 0
      ? strengths.reduce((a, b) => a + b, 0) / strengths.length
      : 1;
    const prevMastery = progress.lastResult?.mastery ?? null;
    const weakCount = strengths.filter((v) => v < MASTERED_THRESHOLD).length;
    // Strength updates: precise attribution (rejections) + assisted-recall gains.
    // The hidden links were this session's actual recall tests — stamp them so
    // the review rotation moves on to fresh ones tomorrow.
    progress = applySessionResult(progress, pack, rejections, hintedConcepts, config?.hiddenLinkIds ?? []);
    progress = recordSession(progress, {
      day: progress.day,
      rung: progress.sessionNum,
      recalled: pack.links.length - new Set(rejections.flatMap((r) => r.linkIds)).size,
      weak: weakCount,
      rejected: rejections.length,
      drill: config.removedNodeIds.length > 0,
      mastery: +mastery.toFixed(3),
      at: Date.now(),
    });
    void saveProgress(progress);

    const weakLinks = pack.links
      .map((l) => ({
        id: linkId(l.from, l.to),
        label: `${labelOf(l.from)} → ${labelOf(l.to)}`,
        strength: progress.links[linkId(l.from, l.to)]?.strength ?? 1,
      }))
      .filter((l) => l.strength < 0.75)
      .sort((a, b) => a.strength - b.strength)
      .map((l) => l.label);

    const strong = pack.links.length - weakLinks.length;
    const masteryPct = Math.round(mastery * 100);
    const masteryDelta = prevMastery === null
      ? null
      : Math.round((mastery - prevMastery) * 100);
    const summaryInfo = {
      sessionNum: progress.sessionNum,
      strong,
      total: pack.links.length,
      weakLinks,
      masteryPct,
      masteryDelta,
      nextDrill: config.removedNodeIds.length > 0,
    };
    // The summary appears AFTER the sequence finishes — the comet, bloom,
    // shockwave and card wave are the star of the completion moment, not a
    // panel dropped on top of them.
    const summaryHud = hud;
    window.setTimeout(() => {
      // Guard: the user may have restarted mid-sequence — only show the
      // summary if we are still in the summary phase of this session.
      if (phase === 'summary' && summaryHud) summaryHud.showSummary(summaryInfo);
    }, 3400);
    // No completion toast — the summary modal IS the completion message, and
    // two overlapping notifications read as noise (spec §6).
  };

  const startSession = (): void => {
    clearSeeTimer();
    if (!currentHead) return;

    // Tear down the previous session's scene and HUD.
    if (spawnHandles) {
      disposeSpawn(spawnHandles);
      hud?.dispose();
      spawnHandles = null;
      hud = null;
      interaction = null;
    }

    const weak = weakNodeIds(pack, progress);
    const seed = progress.day * 1013 + progress.sessionNum * 77;
    // Real review scheduling: the scheduler picks which connections to
    // recall (hide) this session — weak and stale ones return sooner.
    const hiddenLinkIds = reviewLinkIds(pack, progress, hiddenCountForSession(progress.sessionNum));
    config = buildSessionConfig(progress.sessionNum, weak, hiddenLinkIds, seed);
    const distractors = pack.distractors.slice(0, config.distractorCount);

    const layout = buildLayout(pack, { mirror: config.mirror, rotDeg: config.rotDeg });
    spawnHandles = spawnStructure(world, pack, layout, currentHead, {
      rotDeg: config.rotDeg,
      distractors,
      hiddenLinkIds,
      linkStrengths: linkStrengthMap(progress),
      removedNodeIds: config.removedNodeIds,
    });
    hud = createHud(world, spawnHandles.root);
    hud.onRestart = () => {
      // Restart means RESTART (user): wipe the whole run — day 1, session 1,
      // every link back to full strength — then rebuild the scene.
      progress = initSchedulerState(pack);
      void saveProgress(progress);
      startSession();
    };
    hud.onNextDay = () => {
      progress = advanceDay(progress, pack);
      void saveProgress(progress);
      startSession();
    };

    // Day briefing (day 2+): SAY what the adaptive schedule changed, or the
    // player never feels it — hidden arrows appear silently and mastery
    // drifts a point at a time.
    if (progress.day > 1) {
      const parts: string[] = [];
      const n = hiddenLinkIds.length;
      if (n > 0) parts.push(`${n} arrow${n === 1 ? '' : 's'} hidden — recall from memory`);
      if (config.removedNodeIds.length > 0) {
        const labels = config.removedNodeIds
          .map((id) => pack.nodes.find((nd) => nd.id === id)?.label ?? id)
          .slice(0, 2);
        parts.push(`drill: ${labels.join(' + ')}`);
      }
      const focusLabel = weak[0]
        ? pack.nodes.find((nd) => nd.id === weak[0])?.label
        : undefined;
      if (n === 0 && focusLabel) parts.push(`watch: ${focusLabel}`);
      hud.showToast(
        `Day ${progress.day}`,
        parts.length > 0 ? parts.join(' · ') : 'Every arrow visible — build it clean',
        'info',
      );
    }

    if (!world.getSystem(InteractionSystemImpl)) {
      world.registerSystem(InteractionSystemImpl); // IWSDK warns on duplicates
    }
    interaction = world.getSystem(InteractionSystemImpl) as unknown as InteractionSystemImpl;
    if (interaction) {
      interaction.onComplete = onSessionComplete;
      interaction.configure({ pack, layout, spawn: spawnHandles, hud });
      interaction.setPhase('see');
    }

    phase = 'see';
    hud.setPhase('see', progress.sessionNum);
    hud.hideSummary();
    seeTimer = window.setTimeout(beginRebuild, progress.day === 1 && progress.sessionNum === 1 ? SEE_FIRST_MS : SEE_DURATION_MS);

    // A restart inside a live XR session must re-apply the XR framing to the
    // FRESH handles: setXRMode/applyXRLayout fire on the session-start EDGE
    // only, so the new panels would otherwise sit at their flat spread (the
    // "menu jumps across the room on Restart" bug) and the new cycle would
    // ignore the XR pull. The arrangement also re-anchors to the current
    // head direction instead of the stale page-load pose.
    if (isPresenting()) {
      const xrPose = getViewerPose();
      if (xrPose && Number.isFinite(xrPose.x) && Number.isFinite(xrPose.yaw)) {
        spawnHandles.baseHead = {
          position: { x: xrPose.x, y: xrPose.y, z: xrPose.z },
          yaw: xrPose.yaw,
        };
      }
      spawnHandles.applyXRLayout(true);
      hud.setXRMode(true);
      interaction?.setXRMode(true);
    }
  };

  // ---- Wait for a usable head pose, then run the session loop ----
  const posTmp = new Vector3();
  const dirTmp = new Vector3();

  // Yaw around +Y so that object.rotation.y = yaw maps local -z onto the direction.
  const yawOf = (dir: Vector3): number => Math.atan2(-dir.x, -dir.z);

  const isPresenting = (): boolean => {
    const r = (world as any).renderer;
    if (r && r.xr && typeof r.xr.isPresenting === 'boolean') return r.xr.isPresenting;
    const s = (world as any).session;
    return s !== undefined && s !== null;
  };

  /**
   * The viewer pose. `world.camera` only ever holds the flat-page pose — it
   * is never synced to the headset, in or out of XR — so using it while
   * presenting glues the whole scene to wherever that flat camera happened
   * to sit, which is how it ends up behind the player. In XR, pull the pose
   * from three.js's own XR camera (renderer.xr.getCamera()), which three.js
   * keeps synced to the real headset every frame.
   */
  const getViewerPose = (): { x: number; y: number; z: number; yaw: number } | null => {
    if (isPresenting()) {
      const renderer = (world as any).renderer;
      const xrCam = renderer?.xr?.getCamera?.();
      if (xrCam) {
        xrCam.getWorldPosition(posTmp);
        if (Number.isFinite(posTmp.x)) {
          xrCam.getWorldDirection(dirTmp);
          return { x: posTmp.x, y: posTmp.y, z: posTmp.z, yaw: yawOf(dirTmp) };
        }
      }
    }
    const cam = world.camera;
    cam.getWorldPosition(posTmp);
    cam.getWorldDirection(dirTmp);
    return { x: posTmp.x, y: posTmp.y, z: posTmp.z, yaw: yawOf(dirTmp) };
  };

  let spawned = false;
  const startMs = performance.now();
  const MAX_WAIT_MS = 2000;

  const tick = () => {
    if (spawned) return;

    if (performance.now() - startMs < MAX_WAIT_MS) {
      const pose = getViewerPose();
      // Give the XR/head pose a moment to report something real; accept
      // anything finite (reference spaces differ on what Y means).
      if (!pose || !Number.isFinite(pose.y) || (pose.x === 0 && pose.y === 0 && pose.z === 0)) {
        requestAnimationFrame(tick);
        return;
      }
      currentHead = { position: { x: pose.x, y: pose.y, z: pose.z }, yaw: pose.yaw };
    } else {
      const pose = getViewerPose();
      currentHead = {
        position: { x: pose?.x ?? 0, y: pose?.y ?? 1.6, z: pose?.z ?? 0 },
        yaw: pose?.yaw ?? 0,
      };
    }

    spawned = true;
    startSession();
  };

  requestAnimationFrame(tick);

  // A grab during the SEE phase starts the scramble early ("I've got it").
  const grabPoll = window.setInterval(() => {
    if (phase === 'see' && interaction?.hasHeldCards()) beginRebuild();
  }, 250);

  // ---- XR re-anchor ----
  // Anchors the structure to the XR HEAD RIG (not the flat camera — that one
  // keeps the flat-page pose and left the scene behind an XR user).
  const XR_SETTLE_MS = 1500;

  let xrSince = -1;
  let xrOrientationCaptured = false;

  const anchorToHead = (now: number) => {
    if (!spawnHandles) return;
    const pose = getViewerPose();
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return;
    // Position follows the player; rotation does NOT — the arrangement stays
    // world-anchored around them, so turning your head reveals what's beside
    // you (that is what makes it feel surrounding). Following the yaw locked
    // the view and made looking around impossible.
    spawnHandles.root.object3D.position.set(pose.x, pose.y, pose.z);
    spawnHandles.root.object3D.rotation.set(0, spawnHandles.baseHead.yaw, 0);
  };

  const restoreDesktopPose = () => {
    if (!spawnHandles) return;
    spawnHandles.root.object3D.position.set(
      spawnHandles.baseHead.position.x,
      spawnHandles.baseHead.position.y,
      spawnHandles.baseHead.position.z,
    );
    spawnHandles.root.object3D.rotation.set(0, spawnHandles.baseHead.yaw, 0);
  };

  const stepXr = () => {
    const now = performance.now();
    if (isPresenting()) {
      if (xrSince < 0) {
        xrSince = now;
        xrOrientationCaptured = false;
        // XR framing: pull the cycle in, wrap the panels and tray around the
        // player (the wide XR field of view makes flat distances feel far).
        try {
          spawnHandles?.applyXRLayout(true);
          hud?.setXRMode(true);
          interaction?.setXRMode(true);
          // Visible build proof the moment XR starts (transient toast).
          hud?.showToast(`Build ${UI_VERSION} live`, 'XR grab + buttons fixed', 'success');
        } catch (err) {
          console.error('[Recall] XR layout failed', err);
        }
      }
      // The first XR frame(s) can report a stale/default head pose before
      // real headset tracking kicks in. Capturing baseHead immediately on
      // session start can freeze the structure's orientation onto that bad
      // pose forever (appears rotated away from the player). Wait for
      // tracking to settle, then capture the real orientation exactly once.
      if (!xrOrientationCaptured && now - xrSince >= XR_SETTLE_MS) {
        const xrPose = getViewerPose();
        if (spawnHandles && xrPose && Number.isFinite(xrPose.yaw) && Number.isFinite(xrPose.x)) {
          spawnHandles.baseHead = {
            position: { x: xrPose.x, y: xrPose.y, z: xrPose.z },
            yaw: xrPose.yaw,
          };
          xrOrientationCaptured = true;
        }
      }
      // Continuous head-follow: the cycle, tray and panels stay anchored to
      // the player every frame — turn your head and they remain around you.
      anchorToHead(now);
    } else if (xrSince >= 0) {
      xrSince = -1;
      xrOrientationCaptured = false;
      restoreDesktopPose();
      try {
        spawnHandles?.applyXRLayout(false);
        hud?.setXRMode(false);
        interaction?.setXRMode(false);
      } catch (err) {
        console.error('[Recall] flat layout restore failed', err);
      }
    }
  };

  const onXRFrame = (world as any).onXRFrame;
  if (typeof onXRFrame === 'function') {
    onXRFrame.call(world, stepXr);
  } else {
    console.warn('[Recall] world.onXRFrame not available; relying on the page loop only');
  }

  // ---- Desktop look-around (WASD) ----
  // Seated by design: the flat camera pivots in place (A/D turn) and tilts
  // (W/S look up/down) — it never walks. XR headsets drive their own camera,
  // so this is flat-page only.
  const LOOK_YAW_SPEED = 1.4; // rad/s
  const LOOK_PITCH_SPEED = 0.9; // rad/s
  const LOOK_PITCH_LIMIT = 0.7; // rad (~40°)
  const lookKeys = new Set<string>();
  let lookBase: { yaw: number; pitch: number } | null = null;
  let lookYaw = 0;
  let lookPitch = 0;
  let lookLastMs = -1;
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
      lookKeys.add(e.code);
    }
  });
  window.addEventListener('keyup', (e) => {
    lookKeys.delete(e.code);
  });
  window.addEventListener('blur', () => lookKeys.clear());
  const stepLook = (): void => {
    if (isPresenting()) {
      lookBase = null; // re-capture the flat pose after an XR session ends
      lookKeys.clear();
      return;
    }
    const cam = (world as any).camera;
    if (!cam) return;
    const now = performance.now();
    if (lookLastMs < 0) {
      lookLastMs = now;
      return;
    }
    const dt = Math.min(0.1, (now - lookLastMs) / 1000);
    lookLastMs = now;
    if (lookKeys.size === 0) return;
    const yawIn = (lookKeys.has('KeyA') ? 1 : 0) - (lookKeys.has('KeyD') ? 1 : 0);
    const pitchIn = (lookKeys.has('KeyW') ? 1 : 0) - (lookKeys.has('KeyS') ? 1 : 0);
    if (yawIn === 0 && pitchIn === 0) return;
    if (!lookBase) {
      const base = new Euler().setFromQuaternion(cam.quaternion, 'YXZ');
      lookBase = { yaw: base.y, pitch: base.x };
    }
    lookYaw = Math.max(-Math.PI, Math.min(Math.PI, lookYaw + yawIn * LOOK_YAW_SPEED * dt));
    lookPitch = Math.max(-LOOK_PITCH_LIMIT, Math.min(LOOK_PITCH_LIMIT, lookPitch + pitchIn * LOOK_PITCH_SPEED * dt));
    cam.rotation.set(lookBase.pitch + lookPitch, lookBase.yaw + lookYaw, 0, 'YXZ');
  };

  const pageLoop = () => {
    stepXr();
    stepLook();
    // The audio listener rides the head pose so spatial sounds stay put.
    try {
      const lp = getViewerPose();
      if (lp) updateListener(lp.x, lp.y, lp.z, lp.yaw);
    } catch {
      // never break the loop
    }
    // Tip dot: visible in empty space, hidden when the SDK's surface cursor
    // takes over on hover.
    for (const t of cursorTipDots) {
      try {
        t.sprite.visible = !t.pointer.getIntersection?.();
      } catch {
        // Never break the loop on SDK shape changes.
      }
    }
    requestAnimationFrame(pageLoop);
  };
  requestAnimationFrame(pageLoop);

  // Stop the grab poll when the page goes away.
  window.addEventListener('beforeunload', () => {
    window.clearInterval(grabPoll);
    clearSeeTimer();
  });

  // Automation hooks: always on in dev, and on local production-style
  // previews (localhost) so the bundled build can be verified end-to-end.
  // Never active on deployed sites.
  if (import.meta.env.DEV || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    (window as any).__recall = {
      placeAll: () => interaction?.debugPlaceAll(),
      nextDay: () => hud?.onNextDay(),
      restart: () => hud?.onRestart(),
      launch: () => (world as any).launchXR(),
      state: () => {
        const cam = world.camera;
        const camPos = new Vector3();
        cam.getWorldPosition(camPos);
        const rootPos = spawnHandles
          ? new Vector3(
              spawnHandles.root.object3D.position.x,
              spawnHandles.root.object3D.position.y,
              spawnHandles.root.object3D.position.z,
            )
          : null;
        return {
          phase,
          sessionNum: progress.sessionNum,
          day: progress.day,
          camera: { x: +camPos.x.toFixed(2), y: +camPos.y.toFixed(2), z: +camPos.z.toFixed(2) },
          root: rootPos,
          spawned,
        };
      },
      scene: () => (world as any).scene,
      renderer: () => (world as any).renderer,
      interaction: () => interaction,
      structureScale: () => spawnHandles?.structure.object3D.scale.x ?? null,
      setXRTest: (v: boolean) => spawnHandles?.applyXRLayout(v),
    };
  }
}).catch((err) => {
  console.error('[Recall] World.create failed:', err);
});