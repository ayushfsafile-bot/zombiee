import * as THREE from 'three';
import type { GraphicsQuality } from './types';

export interface WeatherSceneRig {
  scene: THREE.Scene;
  fog: THREE.FogExp2;
  hemiLight: THREE.HemisphereLight;
  moonLight: THREE.DirectionalLight;
  moonRimLight: THREE.DirectionalLight;
  skyDomeMat?: THREE.MeshBasicMaterial;
}

export interface WeatherUpdateOptions {
  dt: number;
  cameraPos: THREE.Vector3;
  wave: number;
  quality: GraphicsQuality;
  isPlaying: boolean;
  mobilePreview?: boolean;
  hasEnvReflections?: boolean;
  onThunder?: (strength: number, delaySec: number) => void;
}

// Pre-allocated scratch colors & matrices (Zero GC in render loop)
// Bright overcast daytime baseline -> moody daytime rain squall (never night)
const _lightRainSky = new THREE.Color(0x9fb2c4);
const _heavyStormSky = new THREE.Color(0x7c8e9e);
const _lightningSky = new THREE.Color(0xe2eef8);

const _lightRainHemiSky = new THREE.Color(0xdeebf7);
const _heavyStormHemiSky = new THREE.Color(0xa6bacd);
const _lightningHemiSky = new THREE.Color(0xf8fbff);

const _lightRainHemiGround = new THREE.Color(0x5b5d61);
const _heavyStormHemiGround = new THREE.Color(0x42464d);

const _skyDomeLightTint = new THREE.Color(0xffffff);
const _skyDomeStormTint = new THREE.Color(0xd2dde8);

const _rainBaseColor = new THREE.Color(0xdbe6f0);
const _rainFlashColor = new THREE.Color(0xf8fafc);

const _rippleMatrixArr = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0.02, 0, 1,
]);
const _rippleColor = new THREE.Color();

const MAX_RAIN_DROPS = 960;
const SPLASH_RING_COUNT = 44;
const SPLASH_DURATION = 0.4;
const SPLASH_RADIUS = 15;
const BOX_W = 40;
const BOX_H = 22;
const BOX_HALF_W = BOX_W * 0.5;

export class DynamicWeatherSystem {
  private readonly rig: WeatherSceneRig;
  private readonly lightningLight: THREE.DirectionalLight;
  private readonly rainLines: THREE.LineSegments;
  private readonly rainGeometry: THREE.BufferGeometry;
  private readonly rainMaterial: THREE.LineBasicMaterial;
  private readonly rainPositions: Float32Array;
  private readonly dropOffsets: Float32Array; // x, y, z, speedVar per drop

  // GPU-instanced raindrop splash ripples (1 draw call, 50 rings)
  private readonly splashMesh: THREE.InstancedMesh;
  private readonly splashGeo: THREE.RingGeometry;
  private readonly splashMat: THREE.MeshBasicMaterial;
  private readonly splashX = new Float32Array(SPLASH_RING_COUNT);
  private readonly splashZ = new Float32Array(SPLASH_RING_COUNT);
  private readonly splashAge = new Float32Array(SPLASH_RING_COUNT);

  private elapsed = 0;
  private stormIntensity = 0.14; // 0.14 = Light Rain, 1.0 = Heavy Thunderstorm
  private groundWetness = 0.18; // 0.0 -> 1.0 accumulates as rain falls
  private nextLightningTimer = 7.5;
  private flashElapsed = -1;
  private flashDuration = 0.38;
  private flashStrength = 0;
  private flashSecondPulseTime = 0.16;

  constructor(rig: WeatherSceneRig) {
    this.rig = rig;

    // Non-shadow-casting storm key light for dramatic arena-wide lightning illumination
    this.lightningLight = new THREE.DirectionalLight(0xdbeafe, 0);
    this.lightningLight.position.set(-18, 42, -14);
    this.lightningLight.castShadow = false;
    this.rig.scene.add(this.lightningLight);

    // Procedural 3D rain streaks (single LineSegments draw call)
    this.rainPositions = new Float32Array(MAX_RAIN_DROPS * 6);
    this.dropOffsets = new Float32Array(MAX_RAIN_DROPS * 4);

    for (let i = 0; i < MAX_RAIN_DROPS; i++) {
      const rx = (Math.random() - 0.5) * BOX_W;
      const ry = Math.random() * BOX_H;
      const rz = (Math.random() - 0.5) * BOX_W;
      const speedVar = 0.82 + Math.random() * 0.36;

      this.dropOffsets[i * 4] = rx;
      this.dropOffsets[i * 4 + 1] = ry;
      this.dropOffsets[i * 4 + 2] = rz;
      this.dropOffsets[i * 4 + 3] = speedVar;

      const idx = i * 6;
      this.rainPositions[idx] = rx;
      this.rainPositions[idx + 1] = ry;
      this.rainPositions[idx + 2] = rz;
      this.rainPositions[idx + 3] = rx;
      this.rainPositions[idx + 4] = ry - 0.45;
      this.rainPositions[idx + 5] = rz;
    }

    this.rainGeometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.rainPositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    this.rainGeometry.setAttribute('position', posAttr);
    this.rainGeometry.setDrawRange(0, 320 * 2);

    this.rainMaterial = new THREE.LineBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });

    this.rainLines = new THREE.LineSegments(this.rainGeometry, this.rainMaterial);
    this.rainLines.frustumCulled = false;
    this.rainLines.renderOrder = 2;
    this.rig.scene.add(this.rainLines);

    // Single InstancedMesh of 50 flat translucent rings lying on the wet street (y = 0.02)
    this.splashGeo = new THREE.RingGeometry(0.04, 0.07, 12);
    this.splashGeo.rotateX(-Math.PI * 0.5);
    this.splashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.splashMesh = new THREE.InstancedMesh(this.splashGeo, this.splashMat, SPLASH_RING_COUNT);
    this.splashMesh.frustumCulled = false;
    this.splashMesh.renderOrder = 1;

    for (let i = 0; i < SPLASH_RING_COUNT; i++) {
      this.splashX[i] = (Math.random() - 0.5) * SPLASH_RADIUS * 2;
      this.splashZ[i] = (Math.random() - 0.5) * SPLASH_RADIUS * 2;
      this.splashAge[i] = Math.random() * SPLASH_DURATION;
      const offset = i * 16;
      const matArray = this.splashMesh.instanceMatrix.array as Float32Array;
      matArray.set(_rippleMatrixArr, offset);
      matArray[offset] = 0.2;
      matArray[offset + 5] = 0.2;
      matArray[offset + 10] = 0.2;
      matArray[offset + 12] = this.splashX[i];
      matArray[offset + 13] = 0.02;
      matArray[offset + 14] = this.splashZ[i];
      _rippleColor.setRGB(0.5, 0.72, 0.9);
      this.splashMesh.setColorAt(i, _rippleColor);
    }
    this.splashMesh.instanceMatrix.needsUpdate = true;
    if (this.splashMesh.instanceColor) {
      this.splashMesh.instanceColor.needsUpdate = true;
    }
    this.rig.scene.add(this.splashMesh);
  }

  public setSkyDomeMaterial(mat: THREE.MeshBasicMaterial): void {
    this.rig.skyDomeMat = mat;
  }

  public getStormIntensity(): number {
    return this.stormIntensity;
  }

  public getGroundWetness(): number {
    return this.groundWetness;
  }

  public reset(): void {
    this.elapsed = 0;
    this.stormIntensity = 0.14;
    this.groundWetness = 0.18;
    this.nextLightningTimer = 8.5 + Math.random() * 4.0;
    this.flashElapsed = -1;
    this.flashStrength = 0;
    this.lightningLight.intensity = 0;
  }

  public update(opts: WeatherUpdateOptions): void {
    const { dt, cameraPos, wave, quality, isPlaying, onThunder } = opts;
    this.elapsed += dt;

    // 1. Procedural progression: Light Rain (0.14) -> Heavy Thunderstorm (~1.0) over ~75s
    const buildProgress = THREE.MathUtils.clamp(this.elapsed / 78, 0, 1);
    const smoothRamp = buildProgress * buildProgress * (3 - 2 * buildProgress);
    const waveFloor = Math.min(0.45, Math.max(0, wave - 1) * 0.12);
    const squallWave = buildProgress > 0.72 ? Math.sin((this.elapsed - 56) * 0.11) * 0.16 : 0;

    const targetIntensity = THREE.MathUtils.clamp(
      0.14 + smoothRamp * 0.82 + waveFloor * 0.35 + squallWave,
      0.14,
      1.0,
    );
    this.stormIntensity = THREE.MathUtils.damp(this.stormIntensity, targetIntensity, 1.4, dt);

    // Standing water & puddle wetness rises gradually as rain falls
    this.groundWetness = THREE.MathUtils.clamp(
      this.groundWetness + dt * (0.014 + this.stormIntensity * 0.032),
      0,
      1,
    );

    // 2. Random lightning strikes once storm reaches moderate-to-heavy intensity
    const s = this.stormIntensity;
    if (s > 0.26) {
      this.nextLightningTimer -= dt;
      if (this.nextLightningTimer <= 0) {
        this.triggerLightningFlash(s, onThunder);
        const baseCooldown = THREE.MathUtils.lerp(11.5, 3.6, THREE.MathUtils.clamp((s - 0.26) / 0.74, 0, 1));
        this.nextLightningTimer = baseCooldown + Math.random() * 4.8;
      }
    }

    // 3. Evaluate active jagged double-pulse lightning flash envelope
    let flash = 0;
    if (this.flashElapsed >= 0) {
      this.flashElapsed += dt;
      if (this.flashElapsed >= this.flashDuration) {
        this.flashElapsed = -1;
      } else {
        const t = this.flashElapsed;
        const primary = Math.exp(-t * 22) * Math.sin(Math.min(1, t / 0.045) * Math.PI * 0.5);
        const dt2 = t - this.flashSecondPulseTime;
        const secondary = dt2 > 0 ? Math.exp(-dt2 * 18) * 0.78 : 0;
        flash = Math.min(1.25, (primary + secondary) * this.flashStrength);
      }
    }

    // 4. Update scene ambient/hemi fill, overcast daylight key/rim, fog density & sky tint
    const envHemiCompensation = opts.hasEnvReflections === false ? 0.42 : 0;
    const baseHemiIntensity = THREE.MathUtils.lerp(1.12, 0.82, s) + envHemiCompensation;
    this.rig.hemiLight.intensity = baseHemiIntensity + flash * 1.1;
    this.rig.hemiLight.color.copy(_lightRainHemiSky).lerp(_heavyStormHemiSky, s);
    if (flash > 0.01) {
      this.rig.hemiLight.color.lerp(_lightningHemiSky, Math.min(0.85, flash * 0.75));
    }
    this.rig.hemiLight.groundColor.copy(_lightRainHemiGround).lerp(_heavyStormHemiGround, s);

    this.rig.moonLight.intensity = THREE.MathUtils.lerp(2.25, 1.55, s) + flash * 0.65;
    this.rig.moonRimLight.intensity = THREE.MathUtils.lerp(1.05, 0.72, s) + flash * 0.55;
    this.lightningLight.intensity = flash * 4.2;
    this.rig.fog.density = THREE.MathUtils.lerp(0.0115, 0.020, s);

    const bg = this.rig.scene.background;
    if (bg instanceof THREE.Color) {
      bg.copy(_lightRainSky).lerp(_heavyStormSky, s);
      if (flash > 0.01) {
        bg.lerp(_lightningSky, Math.min(0.75, flash * 0.62));
      }
      this.rig.fog.color.copy(bg);
    }

    if (this.rig.skyDomeMat) {
      this.rig.skyDomeMat.color.copy(_skyDomeLightTint).lerp(_skyDomeStormTint, s);
      if (flash > 0.01) {
        this.rig.skyDomeMat.color.lerp(_skyDomeLightTint, Math.min(0.8, flash * 0.65));
      }
    }

    // 5. Update 3D procedural rain streaks wrapped around the player/camera
    const mobileCap = opts.mobilePreview ? (quality === 'HIGH' ? 140 : 100) : MAX_RAIN_DROPS;
    const maxForQuality = Math.min(
      mobileCap,
      quality === 'HIGH' ? MAX_RAIN_DROPS : quality === 'MED' ? 520 : 180,
    );
    const minDrops = opts.mobilePreview ? 60 : 100;
    const activeDrops = Math.max(
      minDrops,
      Math.round(THREE.MathUtils.lerp(maxForQuality * 0.26, maxForQuality, s)),
    );
    this.rainGeometry.setDrawRange(0, activeDrops * 2);

    this.rainMaterial.opacity = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(0.18, 0.46, s) + flash * 0.28,
      0.16,
      0.78,
    );
    this.rainMaterial.color.copy(_rainBaseColor).lerp(_rainFlashColor, Math.min(1, flash));

    const fallSpeed = THREE.MathUtils.lerp(13.5, 25.5, s);
    const windX = THREE.MathUtils.lerp(0.9, 5.2, s) + Math.sin(this.elapsed * 0.7) * 1.1 * s;
    const windZ = THREE.MathUtils.lerp(0.4, 2.6, s);
    const streakLenY = THREE.MathUtils.lerp(0.42, 0.92, s);
    const streakLenX = (windX / fallSpeed) * streakLenY;
    const streakLenZ = (windZ / fallSpeed) * streakLenY;

    const minY = Math.max(-0.5, cameraPos.y - 4.0);
    const wrapBaseX = cameraPos.x;
    const wrapBaseZ = cameraPos.z;
    const rainTimeScale = isPlaying ? 1.0 : 0.75;

    for (let i = 0; i < activeDrops; i++) {
      const oIdx = i * 4;
      const speedVar = this.dropOffsets[oIdx + 3];
      let x = this.dropOffsets[oIdx] + windX * speedVar * dt * rainTimeScale;
      let y = this.dropOffsets[oIdx + 1] - fallSpeed * speedVar * dt * rainTimeScale;
      let z = this.dropOffsets[oIdx + 2] + windZ * speedVar * dt * rainTimeScale;

      const dx = x - wrapBaseX;
      if (dx > BOX_HALF_W) x -= BOX_W;
      else if (dx < -BOX_HALF_W) x += BOX_W;

      const dz = z - wrapBaseZ;
      if (dz > BOX_HALF_W) z -= BOX_W;
      else if (dz < -BOX_HALF_W) z += BOX_W;

      if (y < minY) {
        y += BOX_H;
        x = wrapBaseX + (Math.random() - 0.5) * BOX_W;
        z = wrapBaseZ + (Math.random() - 0.5) * BOX_W;
      }

      this.dropOffsets[oIdx] = x;
      this.dropOffsets[oIdx + 1] = y;
      this.dropOffsets[oIdx + 2] = z;

      const pIdx = i * 6;
      this.rainPositions[pIdx] = x;
      this.rainPositions[pIdx + 1] = y;
      this.rainPositions[pIdx + 2] = z;
      this.rainPositions[pIdx + 3] = x + streakLenX;
      this.rainPositions[pIdx + 4] = y - streakLenY;
      this.rainPositions[pIdx + 5] = z + streakLenZ;
    }
    (this.rainGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // 6. Animate GPU-Instanced Raindrop Splash Ripples (1 draw call) around player
    const baseMaxRipples = quality === 'LOW' ? 12 : quality === 'MED' ? 28 : SPLASH_RING_COUNT;
    const maxRipples = opts.mobilePreview ? Math.min(baseMaxRipples, quality === 'HIGH' ? 12 : 8) : baseMaxRipples;
    const maxSplashDist = opts.mobilePreview ? 8.5 : quality === 'LOW' ? 9.5 : quality === 'MED' ? 12.5 : SPLASH_RADIUS;
    const activeRipples =
      quality === 'LOW' || opts.mobilePreview
        ? maxRipples
        : Math.round(THREE.MathUtils.lerp(maxRipples * 0.55, maxRipples, s));
    this.splashMesh.count = activeRipples;

    const rippleBrightness = 0.42 + s * 0.45 + flash * 0.35;
    const matArray = this.splashMesh.instanceMatrix.array as Float32Array;
    const colorArray = this.splashMesh.instanceColor?.array as Float32Array | undefined;
    const ageStep = dt * (0.85 + s * 0.35);

    for (let i = 0; i < activeRipples; i++) {
      let age = this.splashAge[i] + ageStep;
      if (age >= SPLASH_DURATION) {
        age = 0;
        const angle = Math.random() * Math.PI * 2;
        const dist = 1.0 + Math.random() * maxSplashDist;
        let rx = wrapBaseX + Math.cos(angle) * dist;
        let rz = wrapBaseZ + Math.sin(angle) * dist;
        if (rx > 27.5) rx = 27.5;
        else if (rx < -27.5) rx = -27.5;
        if (rz > 27.5) rz = 27.5;
        else if (rz < -27.5) rz = -27.5;
        this.splashX[i] = rx;
        this.splashZ[i] = rz;
      }
      this.splashAge[i] = age;

      const t = age / SPLASH_DURATION;
      const scale = 0.2 + t * 1.6;
      const fade = (1 - t) * (1 - t) * rippleBrightness;

      const offset = i * 16;
      matArray[offset] = scale;
      matArray[offset + 5] = scale;
      matArray[offset + 10] = scale;
      matArray[offset + 12] = this.splashX[i];
      matArray[offset + 13] = 0.02;
      matArray[offset + 14] = this.splashZ[i];

      if (colorArray) {
        const cOff = i * 3;
        colorArray[cOff] = 0.55 * fade;
        colorArray[cOff + 1] = 0.82 * fade;
        colorArray[cOff + 2] = 1.0 * fade;
      }
    }
    this.splashMesh.instanceMatrix.needsUpdate = true;
    if (this.splashMesh.instanceColor) {
      this.splashMesh.instanceColor.needsUpdate = true;
    }
  }

  private triggerLightningFlash(
    stormIntensity: number,
    onThunder?: (strength: number, delaySec: number) => void,
  ): void {
    this.flashElapsed = 0;
    this.flashDuration = 0.34 + Math.random() * 0.14;
    this.flashSecondPulseTime = 0.12 + Math.random() * 0.08;
    this.flashStrength = THREE.MathUtils.lerp(0.65, 1.15, stormIntensity) * (0.85 + Math.random() * 0.3);

    const angle = Math.random() * Math.PI * 2;
    this.lightningLight.position.set(Math.cos(angle) * 28, 38 + Math.random() * 14, Math.sin(angle) * 28);

    if (onThunder) {
      const thunderDelay = 0.07 + Math.random() * 0.34;
      onThunder(this.flashStrength, thunderDelay);
    }
  }

  public dispose(): void {
    this.rig.scene.remove(this.rainLines);
    this.rig.scene.remove(this.lightningLight);
    this.rig.scene.remove(this.splashMesh);
    this.rainGeometry.dispose();
    this.rainMaterial.dispose();
    this.splashGeo.dispose();
    this.splashMat.dispose();
  }
}
