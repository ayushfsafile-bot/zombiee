import type { WeaponKey } from './types';

// ============================================================================
// CUSTOM AUDIO URL CONSTANTS — Paste direct URLs or local filenames here
// ============================================================================
export const GUNSHOT_AUDIO_URL = 'https://file.garden/avaubS0ShqQb7IVS/shoot.mp3';
export const RELOAD_AUDIO_URL = 'https://file.garden/avaubS0ShqQb7IVS/reload.mp3';
export const ZOMBIE_AUDIO_URL = 'https://file.garden/avaubS0ShqQb7IVS/zombie.mp3';
export const RUN_AUDIO_URL = 'https://file.garden/avaubS0ShqQb7IVS/run.mp3';
export const BREATH_AUDIO_URL =
  'https://file.garden/avaubS0ShqQb7IVS/Running-Heavy-Breathing-Sound.mp3';
export const WOLF_BITE_SOUND_URL =
  'https://file.garden/avaubS0ShqQb7IVS/YTDown.com_YouTube_Media_BHKsvEvgltE_Multiple-carnivores-eating-sound-effect_008_128k.mp3';

export type ZombieGroanKind = 'normal' | 'screamer' | 'boss';

interface DecodedAudioAsset {
  url: string;
  rawBytes: ArrayBuffer | null;
  buffer: AudioBuffer | null;
  activeStartSec: number;
  peakOffsetsSec: number[];
  gainBoost: number;
  failed: boolean;
  decoding: boolean;
}

interface AnalyzedBuffer {
  activeStartSec: number;
  peakOffsetsSec: number[];
  gainBoost: number;
}

function analyzeAudioBuffer(buffer: AudioBuffer): AnalyzedBuffer {
  const sr = Math.max(1, buffer.sampleRate);
  const channels = buffer.numberOfChannels;
  const len = buffer.length;
  if (len === 0 || channels === 0) {
    return { activeStartSec: 0, peakOffsetsSec: [0], gainBoost: 1 };
  }

  const ch0 = buffer.getChannelData(0);
  const ch1 = channels > 1 ? buffer.getChannelData(1) : null;

  // Scan in 20ms chunks to find peak amplitude, first audible onset, and energetic burst windows
  const stepSamples = Math.max(1, Math.floor(sr * 0.02));
  let globalPeak = 0;
  let firstStrongSample = -1;
  let firstSoftSample = -1;

  for (let i = 0; i < len; i += 2) {
    const s = Math.max(Math.abs(ch0[i]), ch1 ? Math.abs(ch1[i]) : 0);
    if (s > globalPeak) globalPeak = s;
    if (firstStrongSample < 0 && s > 0.06) firstStrongSample = i;
    if (firstSoftSample < 0 && s > 0.02) firstSoftSample = i;
  }

  const onsetSample = firstStrongSample >= 0 ? firstStrongSample : Math.max(0, firstSoftSample);
  const activeStartSec = Math.max(0, onsetSample / sr - 0.015);
  const gainBoost =
    globalPeak > 0.01 ? Math.max(1.0, Math.min(3.5, 0.88 / globalPeak)) : 1.0;

  // Compute 250ms window RMS to locate punchy sound bursts (critical for multi-second SFX packs)
  const winSamples = Math.max(stepSamples, Math.floor(sr * 0.25));
  const winRmsList: Array<{ timeSec: number; rms: number }> = [];
  let maxWinRms = 0;

  for (let start = 0; start < len; start += winSamples) {
    const end = Math.min(len, start + winSamples);
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i += 4) {
      const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      sumSq += s * s;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    if (rms > maxWinRms) maxWinRms = rms;
    winRmsList.push({ timeSec: start / sr, rms });
  }

  const peakOffsetsSec: number[] = [];
  const rmsThreshold = maxWinRms * 0.42;
  for (const w of winRmsList) {
    if (w.rms >= rmsThreshold && w.timeSec + 0.25 < buffer.duration) {
      const prev = peakOffsetsSec[peakOffsetsSec.length - 1];
      if (prev === undefined || w.timeSec - prev >= 0.9) {
        // Step back slightly so we catch the attack transient cleanly
        peakOffsetsSec.push(Math.max(0, w.timeSec - 0.04));
      }
    }
  }
  if (peakOffsetsSec.length === 0) {
    peakOffsetsSec.push(activeStartSec);
  }

  return { activeStartSec, peakOffsetsSec, gainBoost };
}

function createAudioAsset(url: string): DecodedAudioAsset {
  return {
    url: url.trim(),
    rawBytes: null,
    buffer: null,
    activeStartSec: 0,
    peakOffsetsSec: [0],
    gainBoost: 1.0,
    failed: !url.trim(),
    decoding: false,
  };
}

export class TacticalAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private muted = false;
  private lowHealthInterval: number | null = null;
  private silentUnlocked = false;

  // Web Audio decoded assets (no brittle HTMLAudio clone autoplay failures)
  private readonly gunshotAsset: DecodedAudioAsset;
  private readonly reloadAsset: DecodedAudioAsset;
  private readonly zombieAsset: DecodedAudioAsset;
  private readonly runAsset: DecodedAudioAsset;
  private readonly breathAsset: DecodedAudioAsset;
  private readonly wolfBiteAsset: DecodedAudioAsset;
  private readonly allAssets: DecodedAudioAsset[];

  private exertionLevel = 0;
  private procBreathCooldown = 0;

  // Continuous Web Audio loop beds (running footsteps & heavy breathing)
  private runLoopSource: AudioBufferSourceNode | null = null;
  private runLoopGain: GainNode | null = null;
  private breathLoopSource: AudioBufferSourceNode | null = null;
  private breathLoopGain: GainNode | null = null;

  // Continuous procedural rain bed
  private rainSource: AudioBufferSourceNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private sharedNoiseBuffer: AudioBuffer | null = null;

  private readonly unlockHandler = (): void => {
    this.ensureContext();
  };

  constructor() {
    this.gunshotAsset = createAudioAsset(GUNSHOT_AUDIO_URL);
    this.reloadAsset = createAudioAsset(RELOAD_AUDIO_URL);
    this.zombieAsset = createAudioAsset(ZOMBIE_AUDIO_URL);
    this.runAsset = createAudioAsset(RUN_AUDIO_URL);
    this.breathAsset = createAudioAsset(BREATH_AUDIO_URL);
    this.wolfBiteAsset = createAudioAsset(WOLF_BITE_SOUND_URL);

    this.allAssets = [
      this.gunshotAsset,
      this.reloadAsset,
      this.zombieAsset,
      this.runAsset,
      this.breathAsset,
      this.wolfBiteAsset,
    ];

    for (const asset of this.allAssets) {
      if (!asset.failed) {
        void this.prefetchAsset(asset);
      }
    }

    // Ensure any user gesture anywhere unlocks & resumes Web Audio immediately
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.unlockHandler, { capture: true, passive: true });
      window.addEventListener('touchstart', this.unlockHandler, { capture: true, passive: true });
      window.addEventListener('keydown', this.unlockHandler, { capture: true, passive: true });
    }
  }

  private async prefetchAsset(asset: DecodedAudioAsset): Promise<void> {
    try {
      const res = await fetch(asset.url, { mode: 'cors' });
      if (!res.ok) {
        asset.failed = true;
        return;
      }
      asset.rawBytes = await res.arrayBuffer();
      if (this.ctx) {
        await this.decodeAssetIfReady(asset);
      }
    } catch {
      asset.failed = true;
    }
  }

  private async decodeAssetIfReady(asset: DecodedAudioAsset): Promise<void> {
    if (!this.ctx || !asset.rawBytes || asset.buffer || asset.failed || asset.decoding) return;
    asset.decoding = true;
    try {
      const copy = asset.rawBytes.slice(0);
      const decoded = await this.ctx.decodeAudioData(copy);
      const analysis = analyzeAudioBuffer(decoded);
      asset.buffer = decoded;
      asset.activeStartSec = analysis.activeStartSec;
      asset.peakOffsetsSec = analysis.peakOffsetsSec;
      asset.gainBoost = analysis.gainBoost;
      asset.rawBytes = null;
    } catch {
      asset.failed = true;
    } finally {
      asset.decoding = false;
    }
  }

  public ensureContext(): void {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.88;

      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-10, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(14, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(5, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.14, this.ctx.currentTime);

      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.buildSharedNoiseBuffer();
      this.initRainAmbience();

      for (const asset of this.allAssets) {
        if (asset.rawBytes && !asset.buffer && !asset.failed) {
          void this.decodeAssetIfReady(asset);
        }
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }

    // Play a 1-sample silent buffer once on user gesture to reliably unlock mobile/WebView Web Audio
    if (this.ctx && !this.silentUnlocked) {
      try {
        const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
        this.silentUnlocked = true;
      } catch {
        // Ignore unlock retry on next gesture
      }
    }
  }

  private playBufferSlice(
    asset: DecodedAudioAsset,
    opts: {
      volume: number;
      rate?: number;
      offsetSec?: number;
      maxDurationSec?: number;
      fadeInSec?: number;
      fadeOutSec?: number;
    },
  ): boolean {
    if (this.muted || !this.ctx || !this.masterGain || !asset.buffer) return false;
    try {
      const now = this.ctx.currentTime;
      const buf = asset.buffer;
      const startOffset = Math.max(0, Math.min(buf.duration - 0.05, opts.offsetSec ?? asset.activeStartSec));
      const available = Math.max(0.05, buf.duration - startOffset);
      const duration = Math.min(available, opts.maxDurationSec ?? available);

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.max(0.25, Math.min(3.0, opts.rate ?? 1.0));

      const gain = this.ctx.createGain();
      const targetGain = Math.max(0.01, Math.min(2.8, opts.volume * asset.gainBoost));
      const fadeIn = Math.min(opts.fadeInSec ?? 0.008, duration * 0.25);
      const fadeOut = Math.min(opts.fadeOutSec ?? 0.08, duration * 0.45);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(targetGain, now + fadeIn);
      if (duration > fadeIn + fadeOut) {
        gain.gain.setValueAtTime(targetGain, now + duration - fadeOut);
      }
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      src.connect(gain);
      gain.connect(this.masterGain);
      src.start(now, startOffset, duration + 0.02);
      return true;
    } catch {
      return false;
    }
  }

  private stopLoopNode(kind: 'run' | 'breath'): void {
    const src = kind === 'run' ? this.runLoopSource : this.breathLoopSource;
    const gain = kind === 'run' ? this.runLoopGain : this.breathLoopGain;

    if (gain && this.ctx) {
      try {
        gain.gain.cancelScheduledValues(this.ctx.currentTime);
        gain.gain.setValueAtTime(0, this.ctx.currentTime);
      } catch {
        // Ignore scheduling errors
      }
    }
    if (src) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes
      }
    }
    if (gain) {
      try {
        gain.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }

    if (kind === 'run') {
      this.runLoopSource = null;
      this.runLoopGain = null;
    } else {
      this.breathLoopSource = null;
      this.breathLoopGain = null;
    }
  }

  public stopMovementAudio(): void {
    this.exertionLevel = 0;
    this.procBreathCooldown = 0;
    this.stopLoopNode('run');
    this.stopLoopNode('breath');
  }

  public hasRunAudioLoopReady(): boolean {
    return Boolean(this.runAsset.buffer && !this.runAsset.failed && this.ctx);
  }

  public updateMovementLoops(opts: {
    dt: number;
    isPlaying: boolean;
    isMoving: boolean;
    horizontalSpeed: number;
    isGrounded: boolean;
    isSprinting: boolean;
    isCrouching: boolean;
    hp: number;
    bulletTime: boolean;
  }): void {
    const {
      dt,
      isPlaying,
      isMoving,
      horizontalSpeed,
      isGrounded,
      isSprinting,
      isCrouching,
      hp,
      bulletTime,
    } = opts;

    const activelyMovingOnGround =
      !this.muted && isPlaying && isMoving && horizontalSpeed > 0.35 && isGrounded;

    // When character velocity/input stops (or paused/airborne/muted), stop running & exhaust breathing immediately
    if (!activelyMovingOnGround || !this.ctx || !this.masterGain) {
      this.stopMovementAudio();
      return;
    }

    const now = this.ctx.currentTime;

    // 1. Optional continuous running loop buffer if a valid custom URL loaded (otherwise procedural footsteps trigger per stride)
    if (this.runAsset.buffer && !this.runAsset.failed) {
      const runTargetRate =
        (isSprinting ? 1.32 : isCrouching ? 0.68 : 0.96) / (bulletTime ? 1.35 : 1.0);
      const runTargetVol =
        (isSprinting ? 0.68 : isCrouching ? 0.3 : 0.48) * this.runAsset.gainBoost;

      if (!this.runLoopSource || !this.runLoopGain) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.runAsset.buffer;
        src.loop = true;
        src.loopStart = Math.min(this.runAsset.activeStartSec, Math.max(0, this.runAsset.buffer.duration - 0.3));
        src.playbackRate.value = runTargetRate;

        const g = this.ctx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(this.masterGain);
        src.start(now, src.loopStart);

        this.runLoopSource = src;
        this.runLoopGain = g;
      }

      this.runLoopGain.gain.setTargetAtTime(runTargetVol, now, 0.04);
      this.runLoopSource.playbackRate.setTargetAtTime(runTargetRate, now, 0.06);
    } else {
      this.stopLoopNode('run');
    }

    // 2. Dynamic Exhaust / Heavy Breathing while moving (sprinting exertion OR HP < 45)
    if (isSprinting) {
      this.exertionLevel = Math.min(1, this.exertionLevel + dt * 0.55);
    } else {
      this.exertionLevel = Math.max(0, this.exertionLevel - dt * 0.45);
    }

    const lowHpNeed = hp > 0 && hp < 45 ? (45 - hp) / 45 : 0;
    const criticalHp = hp > 0 && hp < 25;
    const sprintBreathNeed = this.exertionLevel > 0.32 ? (this.exertionLevel - 0.32) / 0.68 : 0;

    const breathTargetVol = Math.min(
      1.2,
      Math.max(sprintBreathNeed * 0.68, lowHpNeed * (criticalHp ? 0.92 : 0.68)),
    );
    const breathTargetRate = (criticalHp ? 1.24 : 1.0) / (bulletTime ? 1.3 : 1.0);

    if (breathTargetVol <= 0.02) {
      this.stopLoopNode('breath');
    } else if (this.breathAsset.buffer && !this.breathAsset.failed) {
      if (!this.breathLoopSource || !this.breathLoopGain) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.breathAsset.buffer;
        src.loop = true;
        src.loopStart = Math.min(
          this.breathAsset.activeStartSec,
          Math.max(0, this.breathAsset.buffer.duration - 0.5),
        );
        src.playbackRate.value = breathTargetRate;

        const g = this.ctx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(this.masterGain);
        src.start(now, src.loopStart);

        this.breathLoopSource = src;
        this.breathLoopGain = g;
      }

      this.breathLoopGain.gain.setTargetAtTime(
        Math.min(1.6, breathTargetVol * this.breathAsset.gainBoost * 0.65),
        now,
        0.08,
      );
      this.breathLoopSource.playbackRate.setTargetAtTime(breathTargetRate, now, 0.08);
    } else if (breathTargetVol > 0.18) {
      this.procBreathCooldown -= dt;
      if (this.procBreathCooldown <= 0) {
        this.playFastBreathing(bulletTime);
        this.procBreathCooldown = criticalHp ? 0.95 : 1.5;
      }
    }
  }

  private buildSharedNoiseBuffer(): void {
    if (!this.ctx || this.sharedNoiseBuffer) return;
    const length = Math.floor(this.ctx.sampleRate * 3.0);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      data[i] = Math.max(-1, Math.min(1, sample));
    }
    this.sharedNoiseBuffer = buffer;
  }

  private initRainAmbience(): void {
    if (!this.ctx || !this.masterGain || !this.sharedNoiseBuffer || this.rainSource) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.sharedNoiseBuffer;
    src.loop = true;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 340;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2100;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    src.connect(hp);
    hp.connect(lp);
    lp.connect(gain);
    gain.connect(this.masterGain);
    src.start(this.ctx.currentTime);

    this.rainSource = src;
    this.rainFilter = lp;
    this.rainGain = gain;
  }

  public setRainAmbience(intensity: number, activeMultiplier = 1.0): void {
    if (!this.ctx || !this.rainGain || !this.rainFilter) return;
    const now = this.ctx.currentTime;
    const clamped = Math.max(0, Math.min(1, intensity));
    const targetGain = this.muted
      ? 0
      : (0.04 + clamped * 0.12) * Math.max(0, Math.min(1, activeMultiplier));
    const targetCutoff = 1750 + clamped * 2150;

    this.rainGain.gain.setTargetAtTime(targetGain, now, 0.35);
    this.rainFilter.frequency.setTargetAtTime(targetCutoff, now, 0.35);
  }

  public playThunder(strength = 0.85, delaySec = 0.18): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain || !this.sharedNoiseBuffer) return;

    const start = this.ctx.currentTime + Math.max(0.02, delaySec);
    const clampedStrength = Math.max(0.35, Math.min(1.2, strength));
    const dur = 2.4 + clampedStrength * 1.4;

    const crack = this.ctx.createBufferSource();
    crack.buffer = this.sharedNoiseBuffer;
    crack.playbackRate.value = 1.25 + Math.random() * 0.25;

    const crackFilter = this.ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.setValueAtTime(680, start);
    crackFilter.frequency.exponentialRampToValueAtTime(160, start + 0.55);
    crackFilter.Q.value = 0.7;

    const crackGain = this.ctx.createGain();
    crackGain.gain.setValueAtTime(0.001, start);
    crackGain.gain.linearRampToValueAtTime(0.45 * clampedStrength, start + 0.03);
    crackGain.gain.exponentialRampToValueAtTime(0.001, start + 0.65);

    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(this.masterGain);
    crack.start(start);
    crack.stop(start + 0.7);

    const rumble = this.ctx.createBufferSource();
    rumble.buffer = this.sharedNoiseBuffer;
    rumble.loop = true;
    rumble.playbackRate.value = 0.45 + Math.random() * 0.15;

    const rumbleFilter = this.ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.setValueAtTime(240, start + 0.04);
    rumbleFilter.frequency.exponentialRampToValueAtTime(52, start + dur);

    const rumbleGain = this.ctx.createGain();
    rumbleGain.gain.setValueAtTime(0.001, start);
    rumbleGain.gain.linearRampToValueAtTime(0.58 * clampedStrength, start + 0.14);
    rumbleGain.gain.setValueAtTime(0.45 * clampedStrength, start + 0.48);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, start + dur);

    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(this.masterGain);
    rumble.start(start);
    rumble.stop(start + dur + 0.05);
  }

  public playFootstep(isSprint: boolean, isCrouch: boolean, bulletTime: boolean): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain || !this.sharedNoiseBuffer) return;

    const now = this.ctx.currentTime;
    const dilation = bulletTime ? 1.45 : 1.0;
    const pitchJitter = 0.92 + Math.random() * 0.16;
    const volumeScale = isCrouch ? 0.45 : isSprint ? 1.05 : 0.75;

    const thump = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    thump.type = 'triangle';
    const startFreq = ((isSprint ? 138 : 112) * pitchJitter) / dilation;
    thump.frequency.setValueAtTime(startFreq, now);
    thump.frequency.exponentialRampToValueAtTime(38 / dilation, now + 0.065 * dilation);

    thumpGain.gain.setValueAtTime(0.32 * volumeScale, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.075 * dilation);

    thump.connect(thumpGain);
    thumpGain.connect(this.masterGain);
    thump.start(now);
    thump.stop(now + 0.08 * dilation);

    const scuff = this.ctx.createBufferSource();
    scuff.buffer = this.sharedNoiseBuffer;
    scuff.playbackRate.value = (isSprint ? 1.2 : 0.96) * pitchJitter;

    const scuffFilter = this.ctx.createBiquadFilter();
    scuffFilter.type = 'bandpass';
    scuffFilter.frequency.setValueAtTime(((isSprint ? 1600 : 1180) * pitchJitter) / dilation, now);
    scuffFilter.Q.value = 0.9;

    const scuffGain = this.ctx.createGain();
    scuffGain.gain.setValueAtTime(0.001, now);
    scuffGain.gain.linearRampToValueAtTime(0.36 * volumeScale, now + 0.008);
    scuffGain.gain.exponentialRampToValueAtTime(0.001, now + (isSprint ? 0.09 : 0.07) * dilation);

    scuff.connect(scuffFilter);
    scuffFilter.connect(scuffGain);
    scuffGain.connect(this.masterGain);
    scuff.start(now, Math.random() * 1.5, 0.12 * dilation);
  }

  public playFastBreathing(bulletTime: boolean): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain || !this.sharedNoiseBuffer) return;

    const now = this.ctx.currentTime;
    const dilation = bulletTime ? 1.35 : 1.0;

    const phases: Array<{ offset: number; dur: number; freq: number; amp: number }> = [
      { offset: 0, dur: 0.17 * dilation, freq: 720 / dilation, amp: 0.24 },
      { offset: 0.21 * dilation, dur: 0.19 * dilation, freq: 940 / dilation, amp: 0.21 },
    ];

    for (const p of phases) {
      const t = now + p.offset;
      const src = this.ctx.createBufferSource();
      src.buffer = this.sharedNoiseBuffer;
      src.playbackRate.value = 0.9 + Math.random() * 0.18;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(p.freq, t);
      filter.frequency.linearRampToValueAtTime(p.freq * 0.78, t + p.dur);
      filter.Q.value = 1.6;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(p.amp, t + p.dur * 0.28);
      gain.gain.exponentialRampToValueAtTime(0.001, t + p.dur);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      src.start(t, Math.random() * 1.5, p.dur + 0.03);
    }
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.88, this.ctx.currentTime, 0.02);
    }
    if (this.muted) {
      this.setLowHealthAlarm(false);
      this.stopMovementAudio();
    }
    return !this.muted;
  }

  public playMechanicalClick(volume = 0.5, freq = 1400): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, now + 0.045);

    gain.gain.setValueAtTime(volume * 0.34, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.055);
  }

  public playUpgradePurchase(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const t = now + idx * 0.045;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.24, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.15);
    });
  }

  public playWeaponFire(weapon: WeaponKey, dilation = 1.0): void {
    if (this.muted) return;
    this.ensureContext();

    const weaponRate = weapon === 'mark23' ? 1.25 : weapon === 'kriss' ? 1.45 : 0.88;
    const playedCustom = this.playBufferSlice(this.gunshotAsset, {
      volume: weapon === 'm4fps' ? 0.78 : 0.7,
      rate: weaponRate / Math.max(1.0, dilation * 0.85),
      offsetSec: this.gunshotAsset.activeStartSec,
      maxDurationSec: 1.15,
      fadeInSec: 0.004,
      fadeOutSec: 0.08,
    });
    if (playedCustom) return;

    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const dur = (weapon === 'm4fps' ? 0.18 : weapon === 'kriss' ? 0.13 : 0.115) * dilation;

    const sampleCount = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buffer = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const env = Math.pow(
        1 - i / sampleCount,
        weapon === 'm4fps' ? 2.0 : weapon === 'kriss' ? 2.2 : 2.5,
      );
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(
      (weapon === 'm4fps' ? 960 : weapon === 'kriss' ? 1180 : 1480) / dilation,
      now,
    );
    filter.Q.value = weapon === 'm4fps' ? 0.78 : weapon === 'kriss' ? 0.85 : 1.0;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(weapon === 'm4fps' ? 0.65 : weapon === 'kriss' ? 0.58 : 0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now);

    const thump = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(
      (weapon === 'm4fps' ? 142 : weapon === 'kriss' ? 158 : 178) / dilation,
      now,
    );
    thump.frequency.exponentialRampToValueAtTime(36, now + Math.min(0.16, dur));
    thumpGain.gain.setValueAtTime(weapon === 'm4fps' ? 0.54 : weapon === 'kriss' ? 0.48 : 0.42, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + Math.min(0.18, dur));
    thump.connect(thumpGain);
    thumpGain.connect(this.masterGain);
    thump.start(now);
    thump.stop(now + Math.min(0.19, dur));
  }

  public playReload(weapon: WeaponKey = 'mark23', dilation = 1.0): void {
    if (this.muted) return;
    this.ensureContext();

    const weaponRate = weapon === 'mark23' ? 1.2 : weapon === 'kriss' ? 1.3 : 0.95;
    const playedCustom = this.playBufferSlice(this.reloadAsset, {
      volume: 0.72,
      rate: weaponRate / Math.max(1.0, dilation * 0.9),
      offsetSec: this.reloadAsset.activeStartSec,
      maxDurationSec: 1.55,
      fadeInSec: 0.01,
      fadeOutSec: 0.14,
    });
    if (playedCustom) return;

    if (!this.ctx || !this.masterGain) return;
    this.playMechanicalClick(0.65, 900 / dilation);
    window.setTimeout(() => this.playMechanicalClick(0.75, 1350 / dilation), 340 * dilation);
    window.setTimeout(() => this.playMechanicalClick(0.85, 1750 / dilation), 720 * dilation);
  }

  public playHeadshotCrit(bulletTime: boolean): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(bulletTime ? 1320 : 1080, now);
    osc.frequency.exponentialRampToValueAtTime(bulletTime ? 1960 : 1520, now + 0.08);
    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  public playBodyHit(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.06);
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  public playZombieGroan(
    distance: number,
    kind: ZombieGroanKind = 'normal',
    bulletTime = false,
  ): void {
    if (this.muted) return;
    this.ensureContext();

    const baseRate = kind === 'boss' ? 0.65 : kind === 'screamer' ? 1.35 : 1.0;
    const finalRate = bulletTime ? baseRate * 0.72 : baseRate;
    const attenVol = Math.max(0.18, Math.min(0.85, 1.0 - distance / 30));

    const playedCustom = this.playBufferSlice(this.zombieAsset, {
      volume: attenVol * 0.72,
      rate: finalRate,
      offsetSec: this.zombieAsset.activeStartSec,
      maxDurationSec: 1.4,
      fadeInSec: 0.02,
      fadeOutSec: 0.18,
    });
    if (playedCustom) return;

    if (!this.ctx || !this.masterGain) return;

    const atten = Math.max(0.08, Math.min(0.48, 1.0 - distance / 28));
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    const base = (88 + Math.random() * 28) * baseRate;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.linearRampToValueAtTime(base * 0.72, now + 0.45);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(360, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(atten * 0.35, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.52);
  }

  public playPlayerHurt(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.22);
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  public playPickup(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(580, now);
    osc.frequency.exponentialRampToValueAtTime(980, now + 0.12);
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  public enterBulletTime(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(65, now + 0.35);
    gain.gain.setValueAtTime(0.36, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.38);
  }

  public exitBulletTime(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.22);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  public playBrassClink(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    const baseFreq = 3200 + Math.random() * 900;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.72, now + 0.045);

    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.05);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.055);
  }

  private playHeartbeatPulse(): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const beats: Array<{ delay: number; startHz: number; endHz: number; amp: number; dur: number }> = [
      { delay: 0, startHz: 58, endHz: 30, amp: 0.34, dur: 0.14 },
      { delay: 0.18, startHz: 48, endHz: 26, amp: 0.26, dur: 0.16 },
    ];

    for (const b of beats) {
      const t = now + b.delay;
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(b.startHz, t);
      osc.frequency.exponentialRampToValueAtTime(b.endHz, t + b.dur);

      filter.type = 'lowpass';
      filter.frequency.value = 110;

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(b.amp, t + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, t + b.dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + b.dur + 0.02);
    }
  }

  public setLowHealthAlarm(active: boolean): void {
    if (!active || this.muted) {
      if (this.lowHealthInterval !== null) {
        window.clearInterval(this.lowHealthInterval);
        this.lowHealthInterval = null;
      }
      return;
    }
    if (this.lowHealthInterval !== null) return;
    this.playHeartbeatPulse();
    this.lowHealthInterval = window.setInterval(() => {
      this.playHeartbeatPulse();
    }, 860);
  }

  public playWolfAlert(distance = 5): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const atten = Math.max(0.18, Math.min(0.65, 1.0 - distance / 26));

    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(190, now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(125, now + 0.18);

    filter.type = 'bandpass';
    filter.frequency.value = 580;
    filter.Q.value = 1.4;

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(atten * 0.55, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.21);
  }

  public playWolfBite(distance = 5): void {
    if (this.muted) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const rate = 0.9 + Math.random() * 0.25;
    const attenVol = Math.max(0.35, Math.min(0.95, 1.0 - distance / 28));

    // 1. Play decoded custom carnivore bite burst directly from its high-energy transient offset
    let playedCustom = false;
    if (this.wolfBiteAsset.buffer && !this.wolfBiteAsset.failed) {
      const peaks = this.wolfBiteAsset.peakOffsetsSec;
      const pickedOffset = peaks[Math.floor(Math.random() * peaks.length)] ?? this.wolfBiteAsset.activeStartSec;
      playedCustom = this.playBufferSlice(this.wolfBiteAsset, {
        volume: attenVol * 0.95,
        rate,
        offsetSec: pickedOffset,
        maxDurationSec: 0.78,
        fadeInSec: 0.012,
        fadeOutSec: 0.14,
      });
    }

    // 2. Always trigger crisp jaw-snap low-frequency thud (+ full noise crunch when buffer isn't loaded)
    const now = this.ctx.currentTime;
    const thud = this.ctx.createOscillator();
    const thudGain = this.ctx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(140 * rate, now);
    thud.frequency.exponentialRampToValueAtTime(45, now + 0.12);

    const thudAmp = playedCustom ? attenVol * 0.48 : attenVol * 0.78;
    thudGain.gain.setValueAtTime(0.001, now);
    thudGain.gain.linearRampToValueAtTime(thudAmp, now + 0.008);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    thud.connect(thudGain);
    thudGain.connect(this.masterGain);
    thud.start(now);
    thud.stop(now + 0.13);

    if (playedCustom) return;

    // Band-pass filtered noise burst fallback (800Hz - 1600Hz over 0.18s)
    const sampleCount = Math.max(1, Math.floor(this.ctx.sampleRate * 0.18));
    const noiseBuf = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const env = Math.pow(1 - i / sampleCount, 1.45);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;

    const crunchFilter = this.ctx.createBiquadFilter();
    crunchFilter.type = 'bandpass';
    crunchFilter.frequency.setValueAtTime(1600 * rate, now);
    crunchFilter.frequency.exponentialRampToValueAtTime(800, now + 0.18);
    crunchFilter.Q.value = 1.4;

    const crunchGain = this.ctx.createGain();
    crunchGain.gain.setValueAtTime(0.001, now);
    crunchGain.gain.linearRampToValueAtTime(attenVol * 0.72, now + 0.01);
    crunchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    noise.connect(crunchFilter);
    crunchFilter.connect(crunchGain);
    crunchGain.connect(this.masterGain);
    noise.start(now);
  }

  public suspendContext(): void {
    this.stopAllLoops();
    if (this.ctx && this.ctx.state === 'running') {
      void this.ctx.suspend().catch(() => {});
    }
  }

  public resumeContext(): void {
    if (!this.muted && this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
  }

  public stopAllLoops(): void {
    this.setLowHealthAlarm(false);
    this.setRainAmbience(0, 0);
    this.stopMovementAudio();
  }

  public dispose(): void {
    this.stopAllLoops();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.unlockHandler, { capture: true });
      window.removeEventListener('touchstart', this.unlockHandler, { capture: true });
      window.removeEventListener('keydown', this.unlockHandler, { capture: true });
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
  }
}
