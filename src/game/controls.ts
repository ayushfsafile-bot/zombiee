import * as THREE from 'three';
import type {
  GameState,
  TouchControlId,
  TouchHudLayout,
  WeaponKey,
} from './types';

export interface HybridControlsCallbacks {
  getGameState: () => GameState;
  onFireStart: () => void;
  onFireEnd: () => void;
  onJump: () => void;
  onAdsChange: (active: boolean) => void;
  onReload: () => void;
  onSwitchWeapon: (key: WeaponKey) => void;
  onCycleWeapon: (dir: 1 | -1) => void;
  onToggleBulletTime: () => void;
  onToggleFlashlight: () => void;
  onInspectWeapon: () => void;
  onReviveWolf: () => void;
  onToggleMute: () => void;
  onPauseRequest: () => void;
  onPointerLockChange: (locked: boolean) => void;
  onEnsureAudio: () => void;
}

export const TOUCH_CONTROL_IDS: TouchControlId[] = [
  'stick-move-zone',
  'btn-touch-fire',
  'btn-touch-jump',
  'btn-touch-reload',
  'btn-touch-swap',
  'btn-touch-ads',
  'btn-touch-light',
  'btn-touch-inspect',
];

export function createDefaultTouchHudLayout(): TouchHudLayout {
  return {
    touchSensitivity: 1.0,
    controls: {
      'stick-move-zone': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-fire': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-jump': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-reload': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-swap': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-ads': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-light': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
      'btn-touch-inspect': { xPct: -1, yPct: -1, scale: 1.0, opacity: 0.8 },
    },
  };
}

export class HybridControls {
  private readonly container: HTMLElement;
  private readonly callbacks: HybridControlsCallbacks;

  public readonly keys: Record<string, boolean> = {};
  public yaw = 0;
  public pitch = 0;
  public targetYaw = 0;
  public targetPitch = 0;

  public moveStickX = 0;
  public moveStickY = 0;
  public touchSprinting = false;
  public sprintLocked = false;
  public adsActive = false;
  public isPointerLocked = false;
  public readonly isTouchDevice: boolean;
  public forceShowTouch = false;
  public mouseSensitivityMult = 1.0;

  private hudLayout: TouchHudLayout = createDefaultTouchHudLayout();
  private selectedHudControl: TouchControlId = 'btn-touch-fire';
  private onHudControlSelect: ((id: TouchControlId, label: string) => void) | null = null;
  private dragState: {
    id: TouchControlId;
    el: HTMLElement;
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startLeftPx: number;
    startTopPx: number;
  } | null = null;

  private moveTouchId: number | null = null;
  private moveOriginX = 0;
  private moveOriginY = 0;
  private moveMaxR = 36;
  private sprintLockZoneArmed = false;

  private fireTouchId: number | null = null;
  private readonly lookTouches = new Map<number, { x: number; y: number }>();
  private lastTouchActionMs = 0;

  private readonly ac = new AbortController();

  constructor(container: HTMLElement, callbacks: HybridControlsCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isTouchDevice =
      'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;

    this.bindDesktopEvents();
    this.bindMobileEvents();
    this.bindHudEditorDragEvents();
    this.checkOrientation();
  }

  public clearTransientInputs(): void {
    for (const k of Object.keys(this.keys)) {
      this.keys[k] = false;
    }
    this.moveStickX = 0;
    this.moveStickY = 0;
    this.touchSprinting = false;
    this.sprintLocked = false;
    this.moveTouchId = null;
    this.fireTouchId = null;
    this.lookTouches.clear();
    if (this.adsActive) {
      this.adsActive = false;
      this.callbacks.onAdsChange(false);
    }
  }

  public dispose(): void {
    this.ac.abort();
  }

  public get isCrouching(): boolean {
    return Boolean(
      this.keys['KeyC'] || this.keys['ControlLeft'] || this.keys['ControlRight'],
    );
  }

  public resetLook(yaw = 0, pitch = 0): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.targetYaw = yaw;
    this.targetPitch = pitch;
  }

  public addRecoilPitch(amount: number): void {
    const limit = Math.PI * 0.44;
    this.targetPitch = Math.max(-limit, Math.min(limit, this.targetPitch + amount));
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch + amount));
  }

  public updateAimSmoothing(dt: number): void {
    if (this.isTouchDevice) {
      this.yaw = THREE.MathUtils.damp(this.yaw, this.targetYaw, 34, dt);
      this.pitch = THREE.MathUtils.damp(this.pitch, this.targetPitch, 34, dt);
    } else {
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
    }
  }

  public setAdsActive(active: boolean): void {
    if (this.adsActive === active) return;
    this.adsActive = active;
    const adsBtn = document.getElementById('btn-touch-ads');
    adsBtn?.classList.toggle('ads-active', active);
    this.callbacks.onAdsChange(active);
  }

  public requestPointerLock(): void {
    if (this.isTouchDevice || document.pointerLockElement === this.container) return;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    const nav = navigator as Navigator & { userActivation?: { isActive: boolean } };
    if (nav.userActivation && !nav.userActivation.isActive) return;
    try {
      const result = this.container.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this.isPointerLocked = false;
          this.callbacks.onPointerLockChange(false);
        });
      }
    } catch {
      // Ignore pointer lock rejection in automated/sandbox browsers
    }
  }

  public exitPointerLock(): void {
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock?.();
      } catch {
        // Ignore safely
      }
    }
  }

  public clearInputs(): void {
    for (const k of Object.keys(this.keys)) {
      this.keys[k] = false;
    }
    this.moveTouchId = null;
    this.fireTouchId = null;
    this.lookTouches.clear();
    this.moveStickX = 0;
    this.moveStickY = 0;
    this.touchSprinting = false;
    this.sprintLocked = false;
    this.sprintLockZoneArmed = false;
    this.setAdsActive(false);
    this.resetFloatingStickUI();
    this.callbacks.onFireEnd();
  }

  public updateMobileControlsVisibility(): void {
    const mobilePanel = document.getElementById('mobile-controls');
    if (!mobilePanel) return;
    const state = this.callbacks.getGameState();
    const show =
      state === 'HUD_EDIT' ||
      (state === 'PLAYING' && (this.isTouchDevice || this.forceShowTouch));
    mobilePanel.classList.toggle('hidden', !show);
    mobilePanel.classList.toggle('hud-edit-mode', state === 'HUD_EDIT');
  }

  public applyHudLayout(layout: TouchHudLayout): void {
    this.hudLayout = {
      touchSensitivity: layout.touchSensitivity,
      controls: { ...layout.controls },
    };

    for (const id of TOUCH_CONTROL_IDS) {
      const el = document.getElementById(id);
      const item = this.hudLayout.controls[id];
      if (!el || !item) continue;

      if (item.xPct >= 0 && item.yPct >= 0) {
        el.style.left = `${item.xPct}%`;
        el.style.top = `${item.yPct}%`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      } else {
        el.style.left = '';
        el.style.top = '';
        el.style.right = '';
        el.style.bottom = '';
      }
      el.style.transform = `scale(${item.scale})`;
      el.style.opacity = String(item.opacity);
    }
  }

  public setHudEditSelectionCallback(
    cb: ((id: TouchControlId, label: string) => void) | null,
  ): void {
    this.onHudControlSelect = cb;
  }

  public selectHudControl(id: TouchControlId): void {
    this.selectedHudControl = id;
    for (const cid of TOUCH_CONTROL_IDS) {
      const el = document.getElementById(cid);
      el?.classList.toggle('hud-edit-selected', cid === id);
    }
    const targetEl = document.getElementById(id);
    const label = targetEl?.dataset.hudLabel || id.toUpperCase();
    this.onHudControlSelect?.(id, label);
  }

  public getSelectedHudControl(): TouchControlId {
    return this.selectedHudControl;
  }

  private checkOrientation = (): void => {
    const warning = document.getElementById('portrait-warning');
    if (!warning) return;
    const isPortrait = this.isTouchDevice && window.innerHeight > window.innerWidth;
    warning.classList.toggle('hidden', !isPortrait);
    warning.classList.toggle('flex', isPortrait);
  };

  private resetFloatingStickUI(): void {
    const moveZone = document.getElementById('stick-move-zone');
    const moveKnob = document.getElementById('stick-move-knob');
    const sprintBadge = document.getElementById('sprint-lock-badge');

    if (moveZone) {
      const saved = this.hudLayout.controls['stick-move-zone'];
      if (saved && saved.xPct >= 0 && saved.yPct >= 0) {
        moveZone.style.left = `${saved.xPct}%`;
        moveZone.style.top = `${saved.yPct}%`;
        moveZone.style.right = 'auto';
        moveZone.style.bottom = 'auto';
      } else {
        moveZone.style.left = '';
        moveZone.style.top = '';
        moveZone.style.right = '';
        moveZone.style.bottom = '';
      }
      moveZone.classList.remove('border-amber-400/80', 'border-cyan-400/80');
      if (this.sprintLocked) {
        moveZone.classList.add('border-cyan-400/80');
      }
    }
    if (moveKnob) {
      moveKnob.style.transform = this.sprintLocked
        ? `translate(0px, ${-this.moveMaxR}px)`
        : 'translate(0px, 0px)';
    }
    if (sprintBadge) {
      sprintBadge.classList.toggle('hidden', !this.sprintLocked);
      sprintBadge.innerText = this.sprintLocked ? '⚡ SPRINT LOCKED' : '▲ SPRINT LOCK';
    }
  }

  private bindDesktopEvents(): void {
    const { signal } = this.ac;
    window.addEventListener('resize', this.checkOrientation, { signal });

    window.addEventListener(
      'keydown',
      (e) => {
        this.keys[e.code] = true;
        this.callbacks.onEnsureAudio();
        const state = this.callbacks.getGameState();
        if (state !== 'PLAYING') {
          if ((e.code === 'Escape' || e.code === 'KeyP') && state === 'PAUSED') {
            this.callbacks.onPauseRequest();
          }
          return;
        }

        if (e.code === 'KeyR') {
          this.callbacks.onReload();
        } else if (e.code === 'Digit1') {
          this.callbacks.onSwitchWeapon('mark23');
        } else if (e.code === 'Digit2') {
          this.callbacks.onSwitchWeapon('kriss');
        } else if (e.code === 'Digit3') {
          this.callbacks.onSwitchWeapon('m4fps');
        } else if (e.code === 'KeyQ') {
          this.callbacks.onCycleWeapon(1);
        } else if (e.code === 'Space') {
          e.preventDefault();
          this.callbacks.onJump();
        } else if (e.code === 'KeyF' || e.code === 'KeyB') {
          this.callbacks.onToggleBulletTime();
        } else if (e.code === 'KeyY') {
          this.callbacks.onInspectWeapon();
        } else if (e.code === 'KeyE') {
          this.callbacks.onReviveWolf();
        } else if (e.code === 'KeyT') {
          this.callbacks.onToggleFlashlight();
        } else if (e.code === 'KeyM') {
          this.callbacks.onToggleMute();
        } else if (e.code === 'Escape' || e.code === 'KeyP') {
          this.callbacks.onPauseRequest();
        }
      },
      { signal },
    );

    window.addEventListener(
      'keyup',
      (e) => {
        this.keys[e.code] = false;
      },
      { signal },
    );

    window.addEventListener(
      'blur',
      () => {
        this.clearInputs();
      },
      { signal },
    );

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) {
          this.clearInputs();
        }
      },
      { signal },
    );

    document.addEventListener(
      'pointerlockchange',
      () => {
        this.isPointerLocked = document.pointerLockElement === this.container;
        this.callbacks.onPointerLockChange(this.isPointerLocked);
      },
      { signal },
    );

    document.addEventListener(
      'pointerlockerror',
      () => {
        this.isPointerLocked = document.pointerLockElement === this.container;
        this.callbacks.onPointerLockChange(this.isPointerLocked);
      },
      { signal },
    );

    window.addEventListener(
      'mousemove',
      (e) => {
        if (this.callbacks.getGameState() !== 'PLAYING') return;
        if (!this.isPointerLocked && (e.buttons & 1) === 0 && (e.buttons & 2) === 0) return;
        const adsFactor = this.adsActive ? 0.62 : 1.0;
        const sensitivity = 0.0022 * this.mouseSensitivityMult * adsFactor;
        this.targetYaw -= e.movementX * sensitivity;
        this.targetPitch -= e.movementY * sensitivity;
        this.targetPitch = Math.max(
          -Math.PI * 0.44,
          Math.min(Math.PI * 0.44, this.targetPitch),
        );
      },
      { signal },
    );

    this.container.addEventListener(
      'mousedown',
      (e) => {
        if (this.callbacks.getGameState() !== 'PLAYING') return;
        this.callbacks.onEnsureAudio();
        if (!this.isPointerLocked && !this.isTouchDevice) {
          this.requestPointerLock();
        }
        if (e.button === 0) {
          this.callbacks.onFireStart();
        } else if (e.button === 2) {
          e.preventDefault();
          this.setAdsActive(true);
        }
      },
      { signal },
    );

    window.addEventListener(
      'mouseup',
      (e) => {
        if (e.button === 0) {
          this.callbacks.onFireEnd();
        } else if (e.button === 2) {
          this.setAdsActive(false);
        }
      },
      { signal },
    );

    window.addEventListener(
      'contextmenu',
      (e) => {
        if (this.callbacks.getGameState() === 'PLAYING') {
          e.preventDefault();
        }
      },
      { signal },
    );

    window.addEventListener(
      'wheel',
      (e) => {
        if (this.callbacks.getGameState() !== 'PLAYING') return;
        if (Math.abs(e.deltaY) < 4) return;
        this.callbacks.onCycleWeapon(e.deltaY > 0 ? 1 : -1);
      },
      { passive: true, signal },
    );
  }

  private bindMobileEvents(): void {
    const { signal } = this.ac;
    const touchLookLayer = document.getElementById('touchLookLayer');
    const moveZone = document.getElementById('stick-move-zone');
    const moveKnob = document.getElementById('stick-move-knob');
    const sprintBadge = document.getElementById('sprint-lock-badge');

    const fireBtn = document.getElementById('btn-touch-fire');
    const jumpBtn = document.getElementById('btn-touch-jump');
    const reloadBtn = document.getElementById('btn-touch-reload');
    const swapBtn = document.getElementById('btn-touch-swap');
    const adsBtn = document.getElementById('btn-touch-ads');
    const lightBtn = document.getElementById('btn-touch-light');
    const inspectBtn = document.getElementById('btn-touch-inspect');

    const pitchLimit = Math.PI * 0.44;

    const applyLookDelta = (touch: Touch) => {
      const prev = this.lookTouches.get(touch.identifier);
      if (!prev) return;
      const dx = touch.clientX - prev.x;
      const dy = touch.clientY - prev.y;
      prev.x = touch.clientX;
      prev.y = touch.clientY;

      const adsFactor = this.adsActive ? 0.62 : 1.0;
      const touchSens = 0.0046 * this.hudLayout.touchSensitivity * adsFactor;
      this.targetYaw -= dx * touchSens;
      this.targetPitch -= dy * touchSens;
      this.targetPitch = Math.max(-pitchLimit, Math.min(pitchLimit, this.targetPitch));
    };

    const startFloatingMoveStick = (touch: Touch) => {
      this.moveTouchId = touch.identifier;
      this.sprintLocked = false;
      this.sprintLockZoneArmed = false;

      const zoneWidth = moveZone ? moveZone.getBoundingClientRect().width || 92 : 92;
      const half = zoneWidth * 0.5;
      this.moveMaxR = zoneWidth * 0.42;

      const clampedX = Math.max(half + 8, Math.min(window.innerWidth * 0.45 - 8, touch.clientX));
      const clampedY = Math.max(half + 48, Math.min(window.innerHeight - half - 14, touch.clientY));
      this.moveOriginX = clampedX;
      this.moveOriginY = clampedY;

      if (moveZone) {
        moveZone.style.left = `${clampedX - half}px`;
        moveZone.style.top = `${clampedY - half}px`;
        moveZone.style.bottom = 'auto';
        moveZone.style.right = 'auto';
        moveZone.classList.remove('border-cyan-400/80');
      }
      updateFloatingMoveStick(touch);
    };

    const updateFloatingMoveStick = (touch: Touch) => {
      const rawDx = touch.clientX - this.moveOriginX;
      const rawDy = touch.clientY - this.moveOriginY;
      const maxR = this.moveMaxR;
      const rawDist = Math.hypot(rawDx, rawDy);

      let knobX = rawDx;
      let knobY = rawDy;
      if (rawDist > maxR && rawDist > 0) {
        knobX = (rawDx / rawDist) * maxR;
        knobY = (rawDy / rawDist) * maxR;
      }

      if (moveKnob) {
        moveKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;
      }

      const nx = knobX / maxR;
      const ny = knobY / maxR;
      this.moveStickX = Math.abs(nx) < 0.08 ? 0 : nx;
      this.moveStickY = Math.abs(ny) < 0.08 ? 0 : ny;

      this.touchSprinting = this.moveStickY <= -0.8;
      this.sprintLockZoneArmed = rawDy <= -maxR * 1.32 && Math.abs(rawDx) <= maxR * 0.72;

      if (sprintBadge) {
        const showHint = ny <= -0.68;
        sprintBadge.classList.toggle('hidden', !showHint);
        sprintBadge.innerText = this.sprintLockZoneArmed ? 'RELEASE TO LOCK' : '▲ SPRINT LOCK';
        sprintBadge.classList.toggle('border-cyan-400', this.sprintLockZoneArmed);
        sprintBadge.classList.toggle('text-cyan-300', this.sprintLockZoneArmed);
      }
      if (moveZone) {
        moveZone.classList.toggle('border-amber-400/80', this.touchSprinting);
      }
    };

    const endFloatingMoveStick = () => {
      this.moveTouchId = null;
      if (this.sprintLockZoneArmed) {
        this.sprintLocked = true;
        this.touchSprinting = true;
        this.moveStickX = 0;
        this.moveStickY = -1;
      } else {
        this.sprintLocked = false;
        this.touchSprinting = false;
        this.moveStickX = 0;
        this.moveStickY = 0;
      }
      this.sprintLockZoneArmed = false;
      this.resetFloatingStickUI();
    };

    if (touchLookLayer) {
      touchLookLayer.addEventListener(
        'touchstart',
        (e) => {
          if (this.callbacks.getGameState() !== 'PLAYING') return;
          const targetEl = e.target as HTMLElement | null;
          if (
            targetEl?.closest(
              'button, #hud-top-actions, #weapon-status-badge, #adrenaline-hud-panel, #wolf-revive-prompt',
            )
          ) {
            return;
          }

          const topActionsRect = document.getElementById('hud-top-actions')?.getBoundingClientRect();
          const leftBoundary = window.innerWidth * 0.45;
          let handledLookOrMove = false;

          for (const t of Array.from(e.changedTouches)) {
            const inTopActionsZone = Boolean(
              topActionsRect &&
                t.clientX <= topActionsRect.right + 10 &&
                t.clientY <= topActionsRect.bottom + 10,
            );
            if (inTopActionsZone) {
              continue;
            }
            handledLookOrMove = true;
            if (this.moveTouchId === null && t.clientX < leftBoundary) {
              startFloatingMoveStick(t);
            } else {
              this.lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
            }
          }

          if (!handledLookOrMove) return;
          e.preventDefault();
          this.callbacks.onEnsureAudio();
        },
        { passive: false, signal },
      );

      touchLookLayer.addEventListener(
        'touchmove',
        (e) => {
          if (this.callbacks.getGameState() !== 'PLAYING') return;
          e.preventDefault();
          for (const t of Array.from(e.changedTouches)) {
            if (t.identifier === this.moveTouchId) {
              updateFloatingMoveStick(t);
            } else if (this.lookTouches.has(t.identifier)) {
              applyLookDelta(t);
            }
          }
        },
        { passive: false, signal },
      );

      const handleLookLayerEnd = (e: TouchEvent) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier === this.moveTouchId) {
            endFloatingMoveStick();
          } else {
            this.lookTouches.delete(t.identifier);
          }
        }
      };

      touchLookLayer.addEventListener('touchend', handleLookLayerEnd, { passive: false, signal });
      touchLookLayer.addEventListener('touchcancel', handleLookLayerEnd, { passive: false, signal });
    }

    if (fireBtn) {
      fireBtn.addEventListener(
        'touchstart',
        (e) => {
          if (this.callbacks.getGameState() !== 'PLAYING') return;
          e.preventDefault();
          e.stopPropagation();
          this.callbacks.onEnsureAudio();

          const t = e.changedTouches[0];
          if (t && this.fireTouchId === null) {
            this.fireTouchId = t.identifier;
            this.lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
            this.callbacks.onFireStart();
          }
        },
        { passive: false, signal },
      );

      fireBtn.addEventListener(
        'touchmove',
        (e) => {
          if (this.callbacks.getGameState() !== 'PLAYING') return;
          e.preventDefault();
          e.stopPropagation();
          for (const t of Array.from(e.changedTouches)) {
            if (t.identifier === this.fireTouchId) {
              applyLookDelta(t);
            }
          }
        },
        { passive: false, signal },
      );

      const handleFireEnd = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier === this.fireTouchId) {
            this.fireTouchId = null;
            this.lookTouches.delete(t.identifier);
            this.callbacks.onFireEnd();
          }
        }
      };

      fireBtn.addEventListener('touchend', handleFireEnd, { passive: false, signal });
      fireBtn.addEventListener('touchcancel', handleFireEnd, { passive: false, signal });
    }

    const bindInstantButton = (btn: HTMLElement | null, action: () => void) => {
      if (!btn) return;
      btn.addEventListener(
        'touchstart',
        (e) => {
          if (this.callbacks.getGameState() !== 'PLAYING') return;
          e.preventDefault();
          e.stopPropagation();
          this.lastTouchActionMs = performance.now();
          this.callbacks.onEnsureAudio();
          action();
        },
        { passive: false, signal },
      );
      btn.addEventListener(
        'click',
        (e) => {
          if (this.callbacks.getGameState() !== 'PLAYING') return;
          e.stopPropagation();
          if (performance.now() - this.lastTouchActionMs < 400) return;
          this.callbacks.onEnsureAudio();
          action();
        },
        { signal },
      );
    };

    bindInstantButton(jumpBtn, () => this.callbacks.onJump());
    bindInstantButton(reloadBtn, () => this.callbacks.onReload());
    bindInstantButton(swapBtn, () => this.callbacks.onCycleWeapon(1));
    bindInstantButton(adsBtn, () => this.setAdsActive(!this.adsActive));
    bindInstantButton(lightBtn, () => this.callbacks.onToggleFlashlight());
    bindInstantButton(inspectBtn, () => this.callbacks.onInspectWeapon());
  }

  private bindHudEditorDragEvents(): void {
    const { signal } = this.ac;

    for (const id of TOUCH_CONTROL_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;

      el.addEventListener(
        'pointerdown',
        (e) => {
          if (this.callbacks.getGameState() !== 'HUD_EDIT') return;
          e.preventDefault();
          e.stopPropagation();
          this.selectHudControl(id);

          const rect = el.getBoundingClientRect();
          this.dragState = {
            id,
            el,
            pointerId: e.pointerId,
            startPointerX: e.clientX,
            startPointerY: e.clientY,
            startLeftPx: rect.left,
            startTopPx: rect.top,
          };
          el.setPointerCapture?.(e.pointerId);
        },
        { signal },
      );
    }

    window.addEventListener(
      'pointermove',
      (e) => {
        if (!this.dragState || e.pointerId !== this.dragState.pointerId) return;
        if (this.callbacks.getGameState() !== 'HUD_EDIT') return;

        const { id, el, startPointerX, startPointerY, startLeftPx, startTopPx } = this.dragState;
        const dx = e.clientX - startPointerX;
        const dy = e.clientY - startPointerY;

        const w = el.offsetWidth || 64;
        const h = el.offsetHeight || 64;
        const clampedLeft = Math.max(8, Math.min(window.innerWidth - w - 8, startLeftPx + dx));
        const clampedTop = Math.max(56, Math.min(window.innerHeight - h - 8, startTopPx + dy));

        const xPct = Number(((clampedLeft / Math.max(1, window.innerWidth)) * 100).toFixed(2));
        const yPct = Number(((clampedTop / Math.max(1, window.innerHeight)) * 100).toFixed(2));

        el.style.left = `${xPct}%`;
        el.style.top = `${yPct}%`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';

        this.hudLayout.controls[id] = {
          ...this.hudLayout.controls[id],
          xPct,
          yPct,
        };
      },
      { signal },
    );

    const endDrag = (e: PointerEvent) => {
      if (this.dragState && e.pointerId === this.dragState.pointerId) {
        this.dragState = null;
      }
    };

    window.addEventListener('pointerup', endDrag, { signal });
    window.addEventListener('pointercancel', endDrag, { signal });
  }

  public getHudLayoutSnapshot(): TouchHudLayout {
    return {
      touchSensitivity: this.hudLayout.touchSensitivity,
      controls: {
        'stick-move-zone': { ...this.hudLayout.controls['stick-move-zone'] },
        'btn-touch-fire': { ...this.hudLayout.controls['btn-touch-fire'] },
        'btn-touch-jump': { ...this.hudLayout.controls['btn-touch-jump'] },
        'btn-touch-reload': { ...this.hudLayout.controls['btn-touch-reload'] },
        'btn-touch-swap': { ...this.hudLayout.controls['btn-touch-swap'] },
        'btn-touch-ads': { ...this.hudLayout.controls['btn-touch-ads'] },
        'btn-touch-light': { ...this.hudLayout.controls['btn-touch-light'] },
        'btn-touch-inspect': { ...this.hudLayout.controls['btn-touch-inspect'] },
      },
    };
  }
}
