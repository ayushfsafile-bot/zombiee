import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import type { GraphicsQuality, ZombieEntity } from './types';

export const BLOOD_SPLATTER_SHEET_URL =
  '/assets/aistudio/_Pngtree_blood_splatter_vector_material_5991034_936da168.png';
export const BLOOD_SPLASH_URL =
  '/assets/aistudio/_Pngtree_splashing_blood_vector_png_5448934_7537d92f.png';

const MAX_SURFACE_DECALS = 48;
const MAX_BODY_WOUNDS = 36;
const MAX_WOUNDS_PER_ZOMBIE = 5;
const MAX_IMPACT_SPRITES = 36;
const MAX_BLOOD_DROPLETS = 110;
const MAX_BLOOD_MIST = 52;
const MAX_DECAL_BUILDS_PER_FRAME = 3;

const SPLAT_TINTS = [
  0xffffff,
  0xfce7e7,
  0xead0d0,
  0xf5d6d6,
  0xdcc0c0,
  0xffebeb,
];

interface QualityBudget {
  maxDecals: number;
  maxDroplets: number;
  maxMist: number;
  maxImpactSprites: number;
  maxBodyWounds: number;
  dropletScale: number;
  decalLife: number;
  usePbrDecals: boolean;
  allowDropletFloorDecals: boolean;
}

const MOBILE_PREVIEW_BUDGET: QualityBudget = {
  maxDecals: 10,
  maxDroplets: 24,
  maxMist: 14,
  maxImpactSprites: 14,
  maxBodyWounds: 10,
  dropletScale: 0.45,
  decalLife: 6.5,
  usePbrDecals: false,
  allowDropletFloorDecals: false,
};

const QUALITY_BUDGETS: Record<GraphicsQuality, QualityBudget> = {
  LOW: {
    maxDecals: 12,
    maxDroplets: 28,
    maxMist: 14,
    maxImpactSprites: 16,
    maxBodyWounds: 14,
    dropletScale: 0.42,
    decalLife: 7.0,
    usePbrDecals: false,
    allowDropletFloorDecals: false,
  },
  MED: {
    maxDecals: 28,
    maxDroplets: 64,
    maxMist: 30,
    maxImpactSprites: 26,
    maxBodyWounds: 24,
    dropletScale: 0.72,
    decalLife: 11.5,
    usePbrDecals: true,
    allowDropletFloorDecals: false,
  },
  HIGH: {
    maxDecals: 48,
    maxDroplets: 110,
    maxMist: 52,
    maxImpactSprites: 36,
    maxBodyWounds: 36,
    dropletScale: 1.0,
    decalLife: 15.0,
    usePbrDecals: true,
    allowDropletFloorDecals: true,
  },
};

interface SurfaceDecalSlot {
  poolIndex: number;
  activeIndex: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  age: number;
  maxLife: number;
  fadeStart: number;
  baseOpacity: number;
  freshColor: THREE.Color;
  driedColor: THREE.Color;
  usesFallbackQuad: boolean;
}

interface BodyWoundSlot {
  poolIndex: number;
  activeIndex: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  zombie: ZombieEntity | null;
  age: number;
  maxLife: number;
  baseOpacity: number;
}

interface BloodSplatterSpriteSlot {
  poolIndex: number;
  activeIndex: number;
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  age: number;
  maxLife: number;
  startScale: number;
  endScale: number;
  startOpacity: number;
  vel: THREE.Vector3;
}

interface BloodDropletSlot {
  poolIndex: number;
  activeIndex: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  maxLife: number;
  vel: THREE.Vector3;
  gravity: number;
  baseWidth: number;
  baseLength: number;
  canSplashDecal: boolean;
}

interface BloodMistParticleSlot {
  poolIndex: number;
  activeIndex: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxLife: number;
  startScale: number;
  endScale: number;
  currentScale: number;
  startOpacity: number;
  currentOpacity: number;
  rollRad: number;
  tintR: number;
  tintGB: number;
}

export interface ZombieBloodHitParams {
  zombie: ZombieEntity;
  hitPoint: THREE.Vector3;
  shotDir: THREE.Vector3;
  isHead: boolean;
  isKill: boolean;
  isHeavyWeapon?: boolean;
  isWolfBite?: boolean;
  cameraPos: THREE.Vector3;
  envTargets: THREE.Object3D[];
}

// Reusable scratch objects (Zero per-frame GC allocations)
const _ray = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _localHit = new THREE.Vector3();
const _localNormal = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();
const _worldImpact = new THREE.Vector3();
const _decalPos = new THREE.Vector3();
const _decalLook = new THREE.Vector3();
const _decalSize = new THREE.Vector3();
const _decalDummy = new THREE.Object3D();
const _normalMat = new THREE.Matrix3();
const _invZombieMat = new THREE.Matrix4();
const _velDir = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _rightVec = new THREE.Vector3();
const _faceNormal = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();
const _tmpQuat = new THREE.Quaternion();
const _identityMat = new THREE.Matrix4();
const _visibleProxies: THREE.Object3D[] = [];

function seededRandom(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function makeFallbackSplatterCanvas(variant: number, size = 256): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRandom(1337 + variant * 919);
  const cx = size * 0.5;
  const cy = size * 0.5;

  ctx.clearRect(0, 0, size, size);

  // Irregular central blotch built from jagged quadratic lobes (never a clean circle)
  const lobes = 14 + (variant % 4) * 3;
  ctx.beginPath();
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const nextA = ((i + 0.5) / lobes) * Math.PI * 2;
    const spike = size * (0.14 + rand() * 0.16);
    const valley = size * (0.08 + rand() * 0.11);
    const px = cx + Math.cos(a) * spike;
    const py = cy + Math.sin(a) * spike;
    const mx = cx + Math.cos(nextA) * valley;
    const my = cy + Math.sin(nextA) * valley;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.quadraticCurveTo(mx, my, px, py);
  }
  ctx.closePath();
  const grad = ctx.createRadialGradient(cx, cy, size * 0.04, cx, cy, size * 0.38);
  grad.addColorStop(0, 'rgba(135, 14, 18, 0.96)');
  grad.addColorStop(0.65, 'rgba(168, 18, 22, 0.9)');
  grad.addColorStop(1, 'rgba(95, 8, 12, 0.72)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Jagged radial streaks and micro satellite droplets
  const streaks = 16 + (variant % 3) * 5;
  for (let i = 0; i < streaks; i++) {
    const a = rand() * Math.PI * 2;
    const startR = size * (0.12 + rand() * 0.1);
    const len = size * (0.1 + rand() * 0.24);
    const w = 1.5 + rand() * 5.0;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * startR, cy + Math.sin(a) * startR);
    ctx.rotate(a);
    ctx.fillStyle = `rgba(${115 + Math.floor(rand() * 55)}, 12, 16, ${0.7 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.moveTo(0, -w * 0.5);
    ctx.quadraticCurveTo(len * 0.55, -w * 0.22, len, 0);
    ctx.quadraticCurveTo(len * 0.55, w * 0.22, 0, w * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (let i = 0; i < 24; i++) {
    const a = rand() * Math.PI * 2;
    const r = size * (0.18 + rand() * 0.27);
    const rx = 2 + rand() * 7;
    const ry = 1.5 + rand() * 5;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.rotate(a + (rand() - 0.5) * 0.6);
    ctx.fillStyle = `rgba(128, 14, 18, ${0.68 + rand() * 0.28})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return canvas;
}

function makeBloodMistTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRandom(8842);
  ctx.clearRect(0, 0, size, size);

  for (let i = 0; i < 9; i++) {
    const ox = size * (0.34 + rand() * 0.32);
    const oy = size * (0.34 + rand() * 0.32);
    const r = size * (0.18 + rand() * 0.22);
    const g = ctx.createRadialGradient(ox, oy, 1, ox, oy, r);
    g.addColorStop(0, 'rgba(155, 18, 22, 0.34)');
    g.addColorStop(0.5, 'rgba(110, 12, 16, 0.16)');
    g.addColorStop(1, 'rgba(70, 6, 10, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeBloodDropletTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Tapered directional arterial droplet / streak
  const grad = ctx.createLinearGradient(0, 4, 0, h - 4);
  grad.addColorStop(0, 'rgba(90, 8, 12, 0)');
  grad.addColorStop(0.32, 'rgba(145, 16, 20, 0.78)');
  grad.addColorStop(0.74, 'rgba(185, 22, 26, 0.96)');
  grad.addColorStop(0.92, 'rgba(120, 10, 14, 0.92)');
  grad.addColorStop(1, 'rgba(80, 6, 10, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 4);
  ctx.bezierCurveTo(w * 0.64, h * 0.35, w * 0.86, h * 0.72, w * 0.74, h * 0.88);
  ctx.quadraticCurveTo(w * 0.5, h - 2, w * 0.26, h * 0.88);
  ctx.bezierCurveTo(w * 0.14, h * 0.72, w * 0.36, h * 0.35, w * 0.5, 4);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Normalizes PNG splatter regions into clean, fringe-free transparent alpha textures.
 * Automatically keys out white/near-white opaque backgrounds if the source PNG uses an opaque backdrop,
 * while preserving true transparent alpha channels and boosting rich crimson edges.
 */
function renderNormalizedCropToCanvas(
  img: HTMLImageElement,
  srcXNorm: number,
  srcYNorm: number,
  srcWNorm: number,
  srcHNorm: number,
  targetCanvas: HTMLCanvasElement,
  rotationRad: number,
  flipX: boolean,
  outSize = 512,
): void {
  targetCanvas.width = outSize;
  targetCanvas.height = outSize;
  const ctx = targetCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, outSize, outSize);

  const sx = Math.floor(img.naturalWidth * srcXNorm);
  const sy = Math.floor(img.naturalHeight * srcYNorm);
  const sw = Math.max(16, Math.floor(img.naturalWidth * srcWNorm));
  const sh = Math.max(16, Math.floor(img.naturalHeight * srcHNorm));

  const pad = outSize * 0.08;
  const drawSpan = outSize - pad * 2;
  const aspect = sw / sh;
  const drawW = aspect >= 1 ? drawSpan : drawSpan * aspect;
  const drawH = aspect >= 1 ? drawSpan / aspect : drawSpan;

  ctx.save();
  ctx.translate(outSize * 0.5, outSize * 0.5);
  ctx.rotate(rotationRad);
  ctx.scale(flipX ? -1 : 1, 1);
  ctx.drawImage(img, sx, sy, sw, sh, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, outSize, outSize);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a < 8) {
      d[i] = 110;
      d[i + 1] = 10;
      d[i + 2] = 14;
      d[i + 3] = 0;
      continue;
    }

    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const minC = Math.min(r, g, b);
    const maxC = Math.max(r, g, b);

    // Strip any white/near-white background or anti-aliased white fringe
    if (minC > 210 && maxC - minC < 36) {
      d[i] = 110;
      d[i + 1] = 10;
      d[i + 2] = 14;
      d[i + 3] = 0;
      continue;
    }
    if (minC > 130 && r - minC < 75) {
      const fade = THREE.MathUtils.clamp(1 - (minC - 130) / 80, 0, 1);
      d[i + 3] = Math.round(a * fade);
    }

    // Recolor pale edge pixels toward deep wet crimson so mipmaps never produce white halos
    d[i] = Math.min(220, Math.max(45, Math.round(r * 0.94)));
    d[i + 1] = Math.min(48, Math.round(g * 0.42));
    d[i + 2] = Math.min(48, Math.round(b * 0.42));
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Dedicated O(1) object pool for blood splatter burst sprites.
 * Eliminates linear inactive-slot scanning, idle update loops, and per-shot Sprite instantiation.
 */
export class BloodSplatterSpritePool {
  private readonly scene: THREE.Scene;
  private readonly pool: BloodSplatterSpriteSlot[] = [];
  private readonly freeIndices: number[] = [];
  private readonly activeSlots: BloodSplatterSpriteSlot[] = [];
  private maxActiveBudget: number;

  constructor(
    scene: THREE.Scene,
    splatTextures: readonly THREE.Texture[],
    capacity = MAX_IMPACT_SPRITES,
  ) {
    this.scene = scene;
    this.maxActiveBudget = capacity;

    for (let i = 0; i < capacity; i++) {
      const tex = splatTextures[i % splatTextures.length];
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: SPLAT_TINTS[i % SPLAT_TINTS.length],
        transparent: true,
        opacity: 0.94,
        alphaTest: 0.03,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 4;
      sprite.userData.noBulletRaycast = true;
      this.scene.add(sprite);

      this.pool.push({
        poolIndex: i,
        activeIndex: -1,
        sprite,
        mat,
        age: 0,
        maxLife: 0.22,
        startScale: 0.24,
        endScale: 0.65,
        startOpacity: 0.94,
        vel: new THREE.Vector3(),
      });
    }

    for (let i = capacity - 1; i >= 0; i--) {
      this.freeIndices.push(i);
    }
  }

  public setBudget(maxActive: number): void {
    this.maxActiveBudget = Math.max(1, Math.min(this.pool.length, maxActive));
    while (this.activeSlots.length > this.maxActiveBudget) {
      this.releaseOldest();
    }
  }

  private acquireSlot(): BloodSplatterSpriteSlot {
    if (this.activeSlots.length >= this.maxActiveBudget || this.freeIndices.length === 0) {
      return this.evictAndReuseOldest();
    }
    const poolIdx = this.freeIndices.pop()!;
    const slot = this.pool[poolIdx];
    slot.activeIndex = this.activeSlots.length;
    this.activeSlots.push(slot);
    return slot;
  }

  private evictAndReuseOldest(): BloodSplatterSpriteSlot {
    let oldest = this.activeSlots[0];
    for (let i = 1; i < this.activeSlots.length; i++) {
      if (this.activeSlots[i].age > oldest.age) {
        oldest = this.activeSlots[i];
      }
    }
    return oldest;
  }

  private releaseOldest(): void {
    if (this.activeSlots.length === 0) return;
    let oldestIdx = 0;
    for (let i = 1; i < this.activeSlots.length; i++) {
      if (this.activeSlots[i].age > this.activeSlots[oldestIdx].age) {
        oldestIdx = i;
      }
    }
    this.releaseAt(oldestIdx);
  }

  private releaseAt(activeIdx: number): void {
    const slot = this.activeSlots[activeIdx];
    const lastIdx = this.activeSlots.length - 1;
    if (activeIdx !== lastIdx) {
      const moved = this.activeSlots[lastIdx];
      this.activeSlots[activeIdx] = moved;
      moved.activeIndex = activeIdx;
    }
    this.activeSlots.pop();
    slot.activeIndex = -1;
    slot.sprite.visible = false;
    this.freeIndices.push(slot.poolIndex);
  }

  public spawn(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    scaleMult: number,
    isHead: boolean,
    splatTextures: readonly THREE.Texture[],
  ): void {
    const slot = this.acquireSlot();
    const texIdx = Math.floor(Math.random() * splatTextures.length);
    slot.mat.map = splatTextures[texIdx];
    slot.mat.color.setHex(isHead ? 0xffffff : SPLAT_TINTS[texIdx % SPLAT_TINTS.length]);
    slot.mat.rotation = Math.random() * Math.PI * 2;
    slot.startOpacity = isHead ? 0.96 : 0.86;
    slot.mat.opacity = slot.startOpacity;

    slot.startScale = 0.22 * scaleMult;
    slot.endScale = (0.58 + Math.random() * 0.28) * scaleMult;
    slot.maxLife = (isHead ? 0.22 : 0.16) + Math.random() * 0.06;
    slot.age = 0;

    slot.sprite.position.copy(origin);
    slot.sprite.scale.set(slot.startScale, slot.startScale, 1);
    slot.sprite.visible = true;
    slot.vel.set(
      dir.x * (0.9 + Math.random() * 1.1) + (Math.random() - 0.5) * 0.6,
      0.35 + Math.random() * 0.7,
      dir.z * (0.9 + Math.random() * 1.1) + (Math.random() - 0.5) * 0.6,
    );
  }

  public update(dt: number): void {
    for (let i = this.activeSlots.length - 1; i >= 0; i--) {
      const sp = this.activeSlots[i];
      sp.age += dt;
      if (sp.age >= sp.maxLife) {
        this.releaseAt(i);
        continue;
      }
      const p = sp.age / sp.maxLife;
      const eased = 1 - Math.pow(1 - p, 2);
      const s = THREE.MathUtils.lerp(sp.startScale, sp.endScale, eased);
      sp.sprite.position.addScaledVector(sp.vel, dt);
      sp.vel.y -= 3.2 * dt;
      sp.sprite.scale.set(s, s, 1);
      sp.mat.opacity = sp.startOpacity * Math.pow(1 - p, 1.35);
    }
  }

  public clearAll(): void {
    for (let i = this.activeSlots.length - 1; i >= 0; i--) {
      this.releaseAt(i);
    }
  }

  public dispose(): void {
    this.clearAll();
    for (let i = 0; i < this.pool.length; i++) {
      this.scene.remove(this.pool[i].sprite);
      this.pool[i].mat.dispose();
    }
  }
}

/**
 * Dedicated O(1) InstancedMesh object pool for volumetric blood mist puffs.
 * Collapses up to 52 mist sprites into a single camera-facing GPU instanced draw call (0 calls when idle).
 */
export class BloodMistParticlePool {
  private readonly scene: THREE.Scene;
  private readonly instancedMesh: THREE.InstancedMesh;
  private readonly geo: THREE.PlaneGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly posScaleArray: Float32Array;
  private readonly visualArray: Float32Array;
  private readonly posScaleAttr: THREE.InstancedBufferAttribute;
  private readonly visualAttr: THREE.InstancedBufferAttribute;
  private readonly pool: BloodMistParticleSlot[] = [];
  private readonly freeIndices: number[] = [];
  private readonly activeSlots: BloodMistParticleSlot[] = [];
  private maxActiveBudget: number;
  private gpuDirty = false;

  constructor(scene: THREE.Scene, mistTexture: THREE.Texture, capacity = MAX_BLOOD_MIST) {
    this.scene = scene;
    this.maxActiveBudget = capacity;

    this.geo = new THREE.PlaneGeometry(1, 1);
    this.posScaleArray = new Float32Array(capacity * 4);
    this.visualArray = new Float32Array(capacity * 4);
    this.posScaleAttr = new THREE.InstancedBufferAttribute(this.posScaleArray, 4);
    this.posScaleAttr.setUsage(THREE.DynamicDrawUsage);
    this.visualAttr = new THREE.InstancedBufferAttribute(this.visualArray, 4);
    this.visualAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aMistPosScale', this.posScaleAttr);
    this.geo.setAttribute('aMistVisual', this.visualAttr);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMistMap: { value: mistTexture },
      },
      vertexShader: `
        attribute vec4 aMistPosScale;
        attribute vec4 aMistVisual;
        varying vec2 vUv;
        varying vec4 vMistVisual;
        void main() {
          vec4 mvCenter = viewMatrix * vec4(aMistPosScale.xyz, 1.0);
          float c = cos(aMistVisual.x);
          float s = sin(aMistVisual.x);
          vec2 rotated = vec2(
            position.x * c - position.y * s,
            position.x * s + position.y * c
          ) * aMistPosScale.w;
          mvCenter.xy += rotated;
          gl_Position = projectionMatrix * mvCenter;
          vUv = uv;
          vMistVisual = aMistVisual;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMistMap;
        varying vec2 vUv;
        varying vec4 vMistVisual;
        void main() {
          vec4 tex = texture2D(uMistMap, vUv);
          float alpha = tex.a * vMistVisual.y;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(tex.rgb * vec3(vMistVisual.z, vMistVisual.w, vMistVisual.w), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.instancedMesh = new THREE.InstancedMesh(this.geo, this.mat, capacity);
    for (let i = 0; i < capacity; i++) {
      this.instancedMesh.setMatrixAt(i, _identityMat);
      this.pool.push({
        poolIndex: i,
        activeIndex: -1,
        px: 0,
        py: 0,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        maxLife: 0.4,
        startScale: 0.25,
        endScale: 0.7,
        currentScale: 0.25,
        startOpacity: 0.32,
        currentOpacity: 0.32,
        rollRad: 0,
        tintR: 1,
        tintGB: 1,
      });
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this.instancedMesh.count = 0;
    this.instancedMesh.visible = false;
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.renderOrder = 3;
    this.instancedMesh.userData.noBulletRaycast = true;
    this.scene.add(this.instancedMesh);

    for (let i = capacity - 1; i >= 0; i--) {
      this.freeIndices.push(i);
    }
  }

  public setBudget(maxActive: number): void {
    this.maxActiveBudget = Math.max(1, Math.min(this.pool.length, maxActive));
    while (this.activeSlots.length > this.maxActiveBudget) {
      this.releaseOldest();
    }
    this.syncInstanceCount();
  }

  private acquireSlot(): BloodMistParticleSlot {
    if (this.activeSlots.length >= this.maxActiveBudget || this.freeIndices.length === 0) {
      let oldest = this.activeSlots[0];
      for (let i = 1; i < this.activeSlots.length; i++) {
        if (this.activeSlots[i].age > oldest.age) {
          oldest = this.activeSlots[i];
        }
      }
      return oldest;
    }
    const poolIdx = this.freeIndices.pop()!;
    const slot = this.pool[poolIdx];
    slot.activeIndex = this.activeSlots.length;
    this.activeSlots.push(slot);
    return slot;
  }

  private releaseOldest(): void {
    if (this.activeSlots.length === 0) return;
    let oldestIdx = 0;
    for (let i = 1; i < this.activeSlots.length; i++) {
      if (this.activeSlots[i].age > this.activeSlots[oldestIdx].age) {
        oldestIdx = i;
      }
    }
    this.releaseAt(oldestIdx);
  }

  private releaseAt(activeIdx: number): void {
    const slot = this.activeSlots[activeIdx];
    const lastIdx = this.activeSlots.length - 1;
    if (activeIdx !== lastIdx) {
      const moved = this.activeSlots[lastIdx];
      this.activeSlots[activeIdx] = moved;
      moved.activeIndex = activeIdx;
    }
    this.activeSlots.pop();
    slot.activeIndex = -1;
    this.freeIndices.push(slot.poolIndex);
    this.gpuDirty = true;
  }

  private writeSlotToGpu(slot: BloodMistParticleSlot, instanceIdx: number): void {
    const o = instanceIdx * 4;
    this.posScaleArray[o] = slot.px;
    this.posScaleArray[o + 1] = slot.py;
    this.posScaleArray[o + 2] = slot.pz;
    this.posScaleArray[o + 3] = slot.currentScale;

    this.visualArray[o] = slot.rollRad;
    this.visualArray[o + 1] = slot.currentOpacity;
    this.visualArray[o + 2] = slot.tintR;
    this.visualArray[o + 3] = slot.tintGB;
  }

  private syncInstanceCount(): void {
    const n = this.activeSlots.length;
    this.instancedMesh.count = n;
    this.instancedMesh.visible = n > 0;
    if (n > 0 && this.gpuDirty) {
      for (let i = 0; i < n; i++) {
        this.writeSlotToGpu(this.activeSlots[i], i);
      }
      this.posScaleAttr.needsUpdate = true;
      this.visualAttr.needsUpdate = true;
      this.gpuDirty = false;
    }
  }

  public spawnBurst(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    isHead: boolean,
    isKill: boolean,
  ): void {
    for (let n = 0; n < count; n++) {
      const slot = this.acquireSlot();
      slot.px = origin.x + (Math.random() - 0.5) * 0.18;
      slot.py = origin.y + (Math.random() - 0.5) * 0.14;
      slot.pz = origin.z + (Math.random() - 0.5) * 0.18;

      slot.vx = dir.x * (0.9 + Math.random() * 1.4) + (Math.random() - 0.5) * 0.9;
      slot.vy = 0.2 + Math.random() * 0.75;
      slot.vz = dir.z * (0.9 + Math.random() * 1.4) + (Math.random() - 0.5) * 0.9;

      slot.startScale = (isHead ? 0.34 : isKill ? 0.28 : 0.22) * (0.85 + Math.random() * 0.35);
      slot.endScale = slot.startScale * (isHead ? 2.65 : 2.15);
      slot.currentScale = slot.startScale;
      slot.startOpacity = isHead ? 0.44 : isKill ? 0.36 : 0.26;
      slot.currentOpacity = slot.startOpacity;
      slot.maxLife = (isHead ? 0.48 : 0.36) + Math.random() * 0.14;
      slot.age = 0;
      slot.rollRad = Math.random() * Math.PI * 2;

      const brightTint = isHead && n % 2 === 0;
      slot.tintR = brightTint ? 1.0 : 0.9;
      slot.tintGB = brightTint ? 1.0 : 0.72;
      this.writeSlotToGpu(slot, slot.activeIndex);
      this.gpuDirty = true;
    }

    if (this.activeSlots.length > 0) {
      this.instancedMesh.count = this.activeSlots.length;
      this.instancedMesh.visible = true;
      this.posScaleAttr.needsUpdate = true;
      this.visualAttr.needsUpdate = true;
      this.gpuDirty = false;
    }
  }

  public update(dt: number): void {
    const activeCount = this.activeSlots.length;
    if (activeCount === 0) {
      if (this.instancedMesh.visible) {
        this.instancedMesh.count = 0;
        this.instancedMesh.visible = false;
      }
      return;
    }

    const drag = Math.exp(-4.8 * dt);
    for (let i = this.activeSlots.length - 1; i >= 0; i--) {
      const ms = this.activeSlots[i];
      ms.age += dt;
      if (ms.age >= ms.maxLife) {
        this.releaseAt(i);
        continue;
      }
      const p = ms.age / ms.maxLife;
      ms.vx *= drag;
      ms.vy *= drag;
      ms.vz *= drag;
      ms.px += ms.vx * dt;
      ms.py += ms.vy * dt;
      ms.pz += ms.vz * dt;
      ms.currentScale = THREE.MathUtils.lerp(ms.startScale, ms.endScale, 1 - Math.pow(1 - p, 1.8));
      ms.currentOpacity = ms.startOpacity * Math.pow(1 - p, 1.5);
    }

    const remaining = this.activeSlots.length;
    this.instancedMesh.count = remaining;
    this.instancedMesh.visible = remaining > 0;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) {
        this.writeSlotToGpu(this.activeSlots[i], i);
      }
      this.posScaleAttr.needsUpdate = true;
      this.visualAttr.needsUpdate = true;
    }
    this.gpuDirty = false;
  }

  public clearAll(): void {
    while (this.activeSlots.length > 0) {
      this.releaseAt(this.activeSlots.length - 1);
    }
    this.instancedMesh.count = 0;
    this.instancedMesh.visible = false;
    this.gpuDirty = false;
  }

  public dispose(): void {
    this.clearAll();
    this.scene.remove(this.instancedMesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class BloodEffectsSystem {
  private readonly scene: THREE.Scene;
  private readonly isSoftwareGl: boolean;
  private isMobilePreview: boolean;
  private budget: QualityBudget;

  private readonly splatCanvases: HTMLCanvasElement[] = [];
  private readonly splatTextures: THREE.CanvasTexture[] = [];
  private readonly mistTexture: THREE.CanvasTexture;
  private readonly dropletTexture: THREE.CanvasTexture;

  private readonly surfaceDecals: SurfaceDecalSlot[] = [];
  private readonly freeSurfaceDecalIndices: number[] = [];
  private readonly activeSurfaceDecals: SurfaceDecalSlot[] = [];

  private readonly bodyWounds: BodyWoundSlot[] = [];
  private readonly freeBodyWoundIndices: number[] = [];
  private readonly activeBodyWounds: BodyWoundSlot[] = [];
  private readonly bodyWoundGeo: THREE.PlaneGeometry;

  private readonly droplets: BloodDropletSlot[] = [];
  private readonly freeDropletIndices: number[] = [];
  private readonly activeDroplets: BloodDropletSlot[] = [];

  private readonly splatterSpritePool: BloodSplatterSpritePool;
  private readonly mistParticlePool: BloodMistParticlePool;

  private readonly dropletGeo: THREE.PlaneGeometry;
  private readonly fallbackDecalGeo: THREE.PlaneGeometry;

  private readonly decalPoolCap: number;
  private readonly bodyWoundPoolCap: number;
  private readonly dropletPoolCap: number;

  private decalBuildsThisFrame = 0;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    isSoftwareGl: boolean,
    initialQuality: GraphicsQuality,
    maxAnisotropy = 4,
    mobilePreview = false,
  ) {
    this.scene = scene;
    this.isSoftwareGl = isSoftwareGl;
    this.isMobilePreview = mobilePreview;
    this.budget = mobilePreview ? MOBILE_PREVIEW_BUDGET : QUALITY_BUDGETS[initialQuality];

    // Mobile preview uses tighter pre-allocated pools so GPU material/mesh overhead stays minimal
    this.decalPoolCap = mobilePreview ? 12 : MAX_SURFACE_DECALS;
    this.bodyWoundPoolCap = mobilePreview ? 12 : MAX_BODY_WOUNDS;
    this.dropletPoolCap = mobilePreview ? 32 : MAX_BLOOD_DROPLETS;
    const spriteCap = mobilePreview ? 16 : MAX_IMPACT_SPRITES;
    const mistCap = mobilePreview ? 16 : MAX_BLOOD_MIST;

    // 1. Initialize 6 splatter CanvasTextures synchronously with organic irregular shapes,
    //    then upgrade them seamlessly when the 2 transparent PNG assets finish loading.
    const aniso = mobilePreview ? 1 : Math.max(1, Math.min(4, maxAnisotropy));
    for (let i = 0; i < 6; i++) {
      const canvas = makeFallbackSplatterCanvas(i, mobilePreview ? 128 : 256);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = aniso;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this.splatCanvases.push(canvas);
      this.splatTextures.push(tex);
    }

    this.mistTexture = makeBloodMistTexture();
    this.dropletTexture = makeBloodDropletTexture();

    this.dropletGeo = new THREE.PlaneGeometry(1, 1);
    this.bodyWoundGeo = new THREE.PlaneGeometry(1, 1);
    this.fallbackDecalGeo = new THREE.PlaneGeometry(1, 1);

    this.splatterSpritePool = new BloodSplatterSpritePool(
      this.scene,
      this.splatTextures,
      spriteCap,
    );
    this.splatterSpritePool.setBudget(this.budget.maxImpactSprites);

    this.mistParticlePool = new BloodMistParticlePool(
      this.scene,
      this.mistTexture,
      mistCap,
    );
    this.mistParticlePool.setBudget(this.budget.maxMist);

    this.prewarmPools();
    this.loadPngSplatterAssets(aniso, mobilePreview ? 256 : 512);
  }

  private loadPngSplatterAssets(aniso: number, targetOutSize: number): void {
    const loadImg = (url: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${url}`));
        img.src = url;
      });

    void loadImg(BLOOD_SPLATTER_SHEET_URL)
      .then((sheetImg) => {
        if (this.disposed) return;
        const regions: Array<[number, number, number, number, number, boolean]> = [
          // [xNorm, yNorm, wNorm, hNorm, rotRad, flipX]
          [0.03, 0.35, 0.45, 0.54, 0.0, false], // Large jagged main splash
          [0.57, 0.07, 0.28, 0.27, 0.15, false], // Dense top-right splash w/ micro spray
          [0.67, 0.34, 0.31, 0.30, -0.25, false], // Spiky radial burst
          [0.48, 0.49, 0.25, 0.26, 0.45, true], // Elongated directional drip cluster
          [0.05, 0.38, 0.43, 0.50, 1.35, true], // Rotated/flipped heavy cluster variant
        ];
        for (let i = 0; i < regions.length; i++) {
          const [rx, ry, rw, rh, rot, flip] = regions[i];
          renderNormalizedCropToCanvas(
            sheetImg,
            rx,
            ry,
            rw,
            rh,
            this.splatCanvases[i],
            rot,
            flip,
            targetOutSize,
          );
          this.splatTextures[i].anisotropy = aniso;
          this.splatTextures[i].needsUpdate = true;
        }
      })
      .catch(() => {
        // Procedural irregular splatters remain active as fallback
      });

    void loadImg(BLOOD_SPLASH_URL)
      .then((splashImg) => {
        if (this.disposed) return;
        renderNormalizedCropToCanvas(
          splashImg,
          0.25,
          0.23,
          0.60,
          0.64,
          this.splatCanvases[5],
          0.0,
          false,
          targetOutSize,
        );
        this.splatTextures[5].anisotropy = aniso;
        this.splatTextures[5].needsUpdate = true;
      })
      .catch(() => {
        // Procedural irregular splatter remains active as fallback
      });
  }

  private prewarmPools(): void {
    for (let i = 0; i < this.decalPoolCap; i++) {
      const tex = this.splatTextures[i % this.splatTextures.length];
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: SPLAT_TINTS[i % SPLAT_TINTS.length],
        roughness: 0.2,
        metalness: 0.06,
        transparent: true,
        opacity: 0.92,
        alphaTest: 0.03,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(this.fallbackDecalGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.noBulletRaycast = true;
      this.scene.add(mesh);
      this.surfaceDecals.push({
        poolIndex: i,
        activeIndex: -1,
        mesh,
        mat,
        age: 0,
        maxLife: 12,
        fadeStart: 8.5,
        baseOpacity: 0.92,
        freshColor: new THREE.Color(0xffffff),
        driedColor: new THREE.Color(0x6b3232),
        usesFallbackQuad: true,
      });
    }
    for (let i = this.decalPoolCap - 1; i >= 0; i--) {
      this.freeSurfaceDecalIndices.push(i);
    }

    for (let i = 0; i < this.bodyWoundPoolCap; i++) {
      const tex = this.splatTextures[i % this.splatTextures.length];
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: 0xffffff,
        roughness: 0.22,
        metalness: 0.05,
        transparent: true,
        opacity: 0.92,
        alphaTest: 0.05,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(this.bodyWoundGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.noBulletRaycast = true;
      this.bodyWounds.push({
        poolIndex: i,
        activeIndex: -1,
        mesh,
        mat,
        zombie: null,
        age: 0,
        maxLife: 10,
        baseOpacity: 0.92,
      });
    }
    for (let i = this.bodyWoundPoolCap - 1; i >= 0; i--) {
      this.freeBodyWoundIndices.push(i);
    }

    for (let i = 0; i < this.dropletPoolCap; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.dropletTexture,
        color: SPLAT_TINTS[i % SPLAT_TINTS.length],
        transparent: true,
        opacity: 0.96,
        alphaTest: 0.04,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.dropletGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      mesh.userData.noBulletRaycast = true;
      this.scene.add(mesh);
      this.droplets.push({
        poolIndex: i,
        activeIndex: -1,
        mesh,
        mat,
        age: 0,
        maxLife: 0.65,
        vel: new THREE.Vector3(),
        gravity: 13.5,
        baseWidth: 0.06,
        baseLength: 0.22,
        canSplashDecal: false,
      });
    }
    for (let i = this.dropletPoolCap - 1; i >= 0; i--) {
      this.freeDropletIndices.push(i);
    }
  }

  public setQuality(quality: GraphicsQuality, mobilePreview = this.isMobilePreview): void {
    this.isMobilePreview = mobilePreview;
    const base = mobilePreview ? MOBILE_PREVIEW_BUDGET : QUALITY_BUDGETS[quality];
    this.budget = this.isSoftwareGl || mobilePreview
      ? {
          ...base,
          maxDecals: Math.min(base.maxDecals, this.decalPoolCap),
          maxDroplets: Math.min(base.maxDroplets, this.dropletPoolCap),
          maxMist: Math.min(base.maxMist, mobilePreview ? 14 : 24),
          maxImpactSprites: Math.min(base.maxImpactSprites, mobilePreview ? 14 : 20),
          maxBodyWounds: Math.min(base.maxBodyWounds, this.bodyWoundPoolCap),
          usePbrDecals: false,
          allowDropletFloorDecals: false,
        }
      : {
          ...base,
          maxDecals: Math.min(base.maxDecals, this.decalPoolCap),
          maxDroplets: Math.min(base.maxDroplets, this.dropletPoolCap),
          maxBodyWounds: Math.min(base.maxBodyWounds, this.bodyWoundPoolCap),
        };

    const aniso = mobilePreview || quality === 'LOW' ? 1 : quality === 'MED' ? 2 : 4;
    for (const tex of this.splatTextures) {
      tex.anisotropy = aniso;
      tex.needsUpdate = true;
    }

    this.splatterSpritePool.setBudget(this.budget.maxImpactSprites);
    this.mistParticlePool.setBudget(this.budget.maxMist);

    while (this.activeSurfaceDecals.length > this.budget.maxDecals) {
      let oldestIdx = 0;
      for (let i = 1; i < this.activeSurfaceDecals.length; i++) {
        if (this.activeSurfaceDecals[i].age > this.activeSurfaceDecals[oldestIdx].age) {
          oldestIdx = i;
        }
      }
      this.releaseSurfaceDecal(this.activeSurfaceDecals[oldestIdx]);
    }

    while (this.activeDroplets.length > this.budget.maxDroplets) {
      let oldestIdx = 0;
      for (let i = 1; i < this.activeDroplets.length; i++) {
        if (this.activeDroplets[i].age > this.activeDroplets[oldestIdx].age) {
          oldestIdx = i;
        }
      }
      this.releaseDropletAt(oldestIdx);
    }
  }

  public clearWoundsForZombie(zombie: ZombieEntity): void {
    for (let i = this.activeBodyWounds.length - 1; i >= 0; i--) {
      const w = this.activeBodyWounds[i];
      if (w.zombie === zombie) {
        this.releaseBodyWound(w);
      }
    }
  }

  public clearAll(): void {
    while (this.activeSurfaceDecals.length > 0) {
      this.releaseSurfaceDecal(this.activeSurfaceDecals[this.activeSurfaceDecals.length - 1]);
    }
    while (this.activeBodyWounds.length > 0) {
      this.releaseBodyWound(this.activeBodyWounds[this.activeBodyWounds.length - 1]);
    }
    while (this.activeDroplets.length > 0) {
      this.releaseDropletAt(this.activeDroplets.length - 1);
    }
    this.splatterSpritePool.clearAll();
    this.mistParticlePool.clearAll();
    this.decalBuildsThisFrame = 0;
  }

  /**
   * Computes an anatomically grounded surface hit point & outward surface normal on the zombie's body/head,
   * preventing splatter decals or sprites from floating at the outer corners of oversized hitboxes.
   */
  private computeAnatomicalHit(
    zombie: ZombieEntity,
    rawHitWorld: THREE.Vector3,
    shotDir: THREE.Vector3,
    isHead: boolean,
  ): void {
    zombie.root.updateMatrixWorld(true);
    _invZombieMat.copy(zombie.root.matrixWorld).invert();
    _localHit.copy(rawHitWorld).applyMatrix4(_invZombieMat);

    const scale = zombie.isBoss ? 1.65 : 1.0;
    const isCrawler = zombie.archetype === 'crawler' && !zombie.isBoss;

    if (isCrawler) {
      _localHit.x = THREE.MathUtils.clamp(_localHit.x, -0.22, 0.22);
      _localHit.y = THREE.MathUtils.clamp(_localHit.y, 0.18, 0.56);
      _localHit.z = THREE.MathUtils.clamp(_localHit.z, -0.52, 0.52);
    } else if (isHead) {
      const rHead = 0.145 * scale;
      const horizLen = Math.hypot(_localHit.x, _localHit.z);
      if (horizLen > rHead) {
        const k = rHead / horizLen;
        _localHit.x *= k;
        _localHit.z *= k;
      }
      _localHit.y = THREE.MathUtils.clamp(_localHit.y, 1.46 * scale, 1.76 * scale);
    } else {
      const rTorsoX = (_localHit.y > 1.05 * scale ? 0.25 : 0.20) * scale;
      const rTorsoZ = 0.17 * scale;
      const nx = _localHit.x / rTorsoX;
      const nz = _localHit.z / rTorsoZ;
      const ellLen = Math.hypot(nx, nz);
      if (ellLen > 1.0) {
        _localHit.x /= ellLen;
        _localHit.z /= ellLen;
      }
      _localHit.y = THREE.MathUtils.clamp(_localHit.y, 0.34 * scale, 1.42 * scale);
    }

    // Transform incoming direction into zombie local space to orient wound outward toward shooter
    _localNormal.copy(shotDir).negate().transformDirection(_invZombieMat);
    _localNormal.y *= 0.45;
    if (_localNormal.lengthSq() < 0.001) {
      _localNormal.set(_localHit.x, 0.1, _localHit.z);
    }
    _localNormal.normalize();

    _worldImpact.copy(_localHit).applyMatrix4(zombie.root.matrixWorld);
    _worldNormal.copy(_localNormal).transformDirection(zombie.root.matrixWorld).normalize();
  }

  public spawnZombieBloodHit(params: ZombieBloodHitParams): void {
    const {
      zombie,
      hitPoint,
      shotDir,
      isHead,
      isKill,
      isHeavyWeapon = false,
      isWolfBite = false,
      cameraPos,
      envTargets,
    } = params;

    this.computeAnatomicalHit(zombie, hitPoint, shotDir, isHead);

    // 1. Attach irregular blood wound splatter directly onto the zombie's body/head surface
    if (!zombie.isDead || isKill) {
      this.spawnBodyWoundDecal(zombie, isHead);
    }

    // 2. Pooled entry + exit splatter sprite burst (layered irregular PNG splatters)
    const burstScale = isHead ? 1.48 : isKill ? 1.25 : isHeavyWeapon ? 1.15 : 0.92;
    this.splatterSpritePool.spawn(
      _worldImpact,
      _worldNormal,
      burstScale,
      isHead,
      this.splatTextures,
    );
    if (isHead || isKill || isHeavyWeapon) {
      // Exit-wound spray slightly behind the zombie along the bullet vector
      _decalPos.copy(_worldImpact).addScaledVector(shotDir, 0.24);
      this.splatterSpritePool.spawn(
        _decalPos,
        shotDir,
        burstScale * 1.18,
        isHead,
        this.splatTextures,
      );
    }

    // 3. Pooled directional flying blood droplets with gravity and varied velocities
    const baseDrops = isHead
      ? 18
      : isKill
        ? 13
        : isWolfBite
          ? 8
          : isHeavyWeapon
            ? 9
            : 7;
    const dropCount = Math.max(2, Math.round(baseDrops * this.budget.dropletScale));
    this.spawnDirectionalDroplets(
      _worldImpact,
      shotDir,
      dropCount,
      isHead,
      isKill,
      cameraPos,
    );

    // 4. Pooled instanced blood mist burst (1 GPU draw call across all active mist particles)
    const baseMist = isHead ? 5 : isKill ? 4 : isHeavyWeapon ? 3 : 2;
    const mistCount = Math.max(1, Math.round(baseMist * this.budget.dropletScale));
    this.mistParticlePool.spawnBurst(_worldImpact, shotDir, mistCount, isHead, isKill);

    // 5. Project surface-aligned DecalGeometry onto nearby walls, vehicles, barriers & floor
    this.projectEnvironmentBloodDecals(
      _worldImpact,
      shotDir,
      isHead,
      isKill,
      isWolfBite,
      envTargets,
    );
  }

  private spawnBodyWoundDecal(zombie: ZombieEntity, isHead: boolean): void {
    // Cap active wound splatters on any individual zombie to prevent overdraw stacking
    let countOnZombie = 0;
    let oldestOnZombie: BodyWoundSlot | null = null;
    for (let i = 0; i < this.activeBodyWounds.length; i++) {
      const w = this.activeBodyWounds[i];
      if (w.zombie === zombie) {
        countOnZombie++;
        if (!oldestOnZombie || w.age > oldestOnZombie.age) {
          oldestOnZombie = w;
        }
      }
    }

    let slot: BodyWoundSlot;
    if (countOnZombie >= MAX_WOUNDS_PER_ZOMBIE && oldestOnZombie) {
      slot = oldestOnZombie;
      if (slot.mesh.parent) {
        slot.mesh.parent.remove(slot.mesh);
      }
    } else {
      slot = this.acquireBodyWoundSlot();
    }

    const scale = zombie.isBoss ? 1.55 : 1.0;
    const woundW = (isHead ? 0.24 : 0.34) * scale * (0.85 + Math.random() * 0.35);
    const woundH = woundW * (0.85 + Math.random() * 0.38);

    const texIdx = Math.floor(Math.random() * this.splatTextures.length);
    slot.mat.map = this.splatTextures[texIdx];
    slot.mat.color.setHex(isHead ? 0xffffff : SPLAT_TINTS[texIdx % SPLAT_TINTS.length]);
    slot.mat.roughness = this.budget.usePbrDecals ? 0.22 : 0.75;
    slot.mat.opacity = 0.92;

    slot.mesh.position.copy(_localHit).addScaledVector(_localNormal, 0.016 * scale);
    _decalLook.copy(slot.mesh.position).add(_localNormal);
    slot.mesh.lookAt(_decalLook);
    slot.mesh.rotateZ(Math.random() * Math.PI * 2);
    slot.mesh.scale.set(woundW, woundH, 1);
    slot.mesh.visible = true;

    zombie.root.add(slot.mesh);
    slot.zombie = zombie;
    slot.age = 0;
    slot.maxLife = 12;
    slot.baseOpacity = 0.92;
  }

  private acquireBodyWoundSlot(): BodyWoundSlot {
    if (
      this.activeBodyWounds.length >= this.budget.maxBodyWounds ||
      this.freeBodyWoundIndices.length === 0
    ) {
      let oldest = this.activeBodyWounds[0];
      for (let i = 1; i < this.activeBodyWounds.length; i++) {
        if (this.activeBodyWounds[i].age > oldest.age) {
          oldest = this.activeBodyWounds[i];
        }
      }
      if (oldest.mesh.parent) {
        oldest.mesh.parent.remove(oldest.mesh);
      }
      return oldest;
    }

    const poolIdx = this.freeBodyWoundIndices.pop()!;
    const slot = this.bodyWounds[poolIdx];
    slot.activeIndex = this.activeBodyWounds.length;
    this.activeBodyWounds.push(slot);
    return slot;
  }

  private releaseBodyWound(slot: BodyWoundSlot): void {
    const activeIdx = slot.activeIndex;
    if (activeIdx < 0) return;
    if (slot.mesh.parent) {
      slot.mesh.parent.remove(slot.mesh);
    }
    slot.mesh.visible = false;
    slot.zombie = null;

    const lastIdx = this.activeBodyWounds.length - 1;
    if (activeIdx !== lastIdx) {
      const moved = this.activeBodyWounds[lastIdx];
      this.activeBodyWounds[activeIdx] = moved;
      moved.activeIndex = activeIdx;
    }
    this.activeBodyWounds.pop();
    slot.activeIndex = -1;
    this.freeBodyWoundIndices.push(slot.poolIndex);
  }

  private acquireDropletSlot(): BloodDropletSlot {
    if (
      this.activeDroplets.length >= this.budget.maxDroplets ||
      this.freeDropletIndices.length === 0
    ) {
      let oldest = this.activeDroplets[0];
      for (let i = 1; i < this.activeDroplets.length; i++) {
        if (this.activeDroplets[i].age > oldest.age) {
          oldest = this.activeDroplets[i];
        }
      }
      return oldest;
    }

    const poolIdx = this.freeDropletIndices.pop()!;
    const slot = this.droplets[poolIdx];
    slot.activeIndex = this.activeDroplets.length;
    this.activeDroplets.push(slot);
    return slot;
  }

  private releaseDropletAt(activeIdx: number): void {
    const slot = this.activeDroplets[activeIdx];
    const lastIdx = this.activeDroplets.length - 1;
    if (activeIdx !== lastIdx) {
      const moved = this.activeDroplets[lastIdx];
      this.activeDroplets[activeIdx] = moved;
      moved.activeIndex = activeIdx;
    }
    this.activeDroplets.pop();
    slot.activeIndex = -1;
    slot.mesh.visible = false;
    this.freeDropletIndices.push(slot.poolIndex);
  }

  private spawnDirectionalDroplets(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    isHead: boolean,
    isKill: boolean,
    cameraPos: THREE.Vector3,
  ): void {
    for (let n = 0; n < count; n++) {
      const slot = this.acquireDropletSlot();

      const isExitJet = n < Math.ceil(count * 0.7);
      const speed = isHead
        ? 4.4 + Math.random() * 6.4
        : isKill
          ? 3.2 + Math.random() * 4.8
          : 2.4 + Math.random() * 3.8;
      const spread = isHead ? 0.68 : 0.55;
      const dirSign = isExitJet ? 1 : -0.45;

      slot.vel.set(
        dir.x * dirSign * speed + (Math.random() - 0.5) * speed * spread,
        (isHead ? 1.4 + Math.random() * 3.4 : 0.4 + Math.random() * 2.2) +
          dir.y * dirSign * speed * 0.55,
        dir.z * dirSign * speed + (Math.random() - 0.5) * speed * spread,
      );

      slot.gravity = 11.5 + Math.random() * 4.5;
      slot.baseWidth = (isHead ? 0.055 : 0.042) + Math.random() * 0.045;
      slot.baseLength = (isHead ? 0.19 : 0.14) + Math.random() * 0.14;
      slot.maxLife = 0.42 + Math.random() * 0.36;
      slot.age = 0;
      slot.canSplashDecal =
        this.budget.allowDropletFloorDecals && (isHead || isKill) && n < 2;

      slot.mat.color.setHex(
        isHead && n % 3 === 0 ? 0xffffff : SPLAT_TINTS[n % SPLAT_TINTS.length],
      );
      slot.mat.opacity = 0.96;

      slot.mesh.position.copy(origin);
      this.orientDropletMesh(slot, cameraPos);
      slot.mesh.visible = true;
    }
  }

  private orientDropletMesh(slot: BloodDropletSlot, cameraPos: THREE.Vector3): void {
    const speed = slot.vel.length();
    if (speed > 0.05) {
      _velDir.copy(slot.vel).divideScalar(speed);
    } else {
      _velDir.set(0, -1, 0);
    }

    _toCam.subVectors(cameraPos, slot.mesh.position);
    if (_toCam.lengthSq() < 0.0001) {
      _toCam.set(0, 0, 1);
    } else {
      _toCam.normalize();
    }

    _rightVec.crossVectors(_velDir, _toCam);
    if (_rightVec.lengthSq() < 0.0001) {
      _rightVec.set(1, 0, 0);
    } else {
      _rightVec.normalize();
    }
    _faceNormal.crossVectors(_rightVec, _velDir).normalize();

    _basisMat.makeBasis(_rightVec, _velDir, _faceNormal);
    _tmpQuat.setFromRotationMatrix(_basisMat);
    slot.mesh.quaternion.copy(_tmpQuat);

    const stretch = THREE.MathUtils.clamp(0.75 + speed * 0.16, 0.75, 2.2);
    slot.mesh.scale.set(slot.baseWidth, slot.baseLength * stretch, 1);
  }

  private projectEnvironmentBloodDecals(
    impactWorld: THREE.Vector3,
    shotDir: THREE.Vector3,
    isHead: boolean,
    isKill: boolean,
    isWolfBite: boolean,
    envTargets: THREE.Object3D[],
  ): void {
    // A. Exit-wound spray onto nearby wall, concrete barrier, shipping container, or vehicle behind zombie
    if (!isWolfBite && (isHead || isKill || Math.random() < 0.78)) {
      _rayDir
        .set(
          shotDir.x + (Math.random() - 0.5) * 0.16,
          shotDir.y - 0.08 + (Math.random() - 0.5) * 0.12,
          shotDir.z + (Math.random() - 0.5) * 0.16,
        )
        .normalize();
      _rayOrigin.copy(impactWorld).addScaledVector(_rayDir, 0.12);
      const wallSize = (isHead ? 0.88 : isKill ? 0.72 : 0.54) * (0.85 + Math.random() * 0.35);
      this.castAndPlaceDecal(
        _rayOrigin,
        _rayDir,
        isHead ? 4.8 : 3.8,
        wallSize,
        envTargets,
        isHead,
      );
    }

    // B. Downward arterial floor splatter / pool directly under & behind the zombie
    const floorCount = isHead || isKill ? 2 : isWolfBite ? 1 : Math.random() < 0.7 ? 1 : 0;
    for (let f = 0; f < floorCount; f++) {
      const fwdDist = f === 0 ? 0.35 + Math.random() * 0.55 : 0.85 + Math.random() * 0.9;
      _rayOrigin.set(
        impactWorld.x + shotDir.x * fwdDist + (Math.random() - 0.5) * 0.45,
        Math.max(0.65, impactWorld.y),
        impactWorld.z + shotDir.z * fwdDist + (Math.random() - 0.5) * 0.45,
      );
      _rayDir.set(0, -1, 0);
      const floorSize =
        (isHead ? 0.98 : isKill ? 0.86 : isWolfBite ? 0.72 : 0.56) *
        (f === 0 ? 1.0 : 0.68) *
        (0.82 + Math.random() * 0.38);
      this.castAndPlaceDecal(_rayOrigin, _rayDir, 3.8, floorSize, envTargets, isHead);
    }
  }

  private castAndPlaceDecal(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    sizeSpan: number,
    envTargets: THREE.Object3D[],
    isHead: boolean,
  ): void {
    _ray.set(origin, dir);
    _ray.near = 0.02;
    _ray.far = maxDist;
    const hits = _ray.intersectObjects(envTargets, false);
    if (hits.length === 0) return;

    let hit = hits[0];
    let targetMesh = hit.object as THREE.Mesh;

    // If hit landed on an invisible collision proxy, resolve onto the parent's visible mesh
    // so the decal adheres tightly to the actual rendered geometry rather than floating.
    if (targetMesh.userData.isRaycastProxy && targetMesh.parent) {
      _visibleProxies.length = 0;
      targetMesh.parent.traverse((child) => {
        const cm = child as THREE.Mesh;
        if (cm.isMesh && cm.visible && !cm.userData.isRaycastProxy) {
          const m = Array.isArray(cm.material) ? cm.material[0] : cm.material;
          if (!m || !m.transparent) _visibleProxies.push(cm);
        }
      });
      if (_visibleProxies.length > 0) {
        const visHits = _ray.intersectObjects(_visibleProxies, false);
        _visibleProxies.length = 0;
        if (visHits.length === 0) return;
        hit = visHits[0];
        targetMesh = hit.object as THREE.Mesh;
      } else {
        return;
      }
    }

    if (!targetMesh.isMesh || !targetMesh.geometry) return;

    if (hit.face) {
      _normalMat.getNormalMatrix(targetMesh.matrixWorld);
      _worldNormal.copy(hit.face.normal).applyMatrix3(_normalMat).normalize();
      if (_worldNormal.dot(dir) > 0) {
        _worldNormal.negate();
      }
    } else {
      _worldNormal.copy(dir).negate();
    }

    this.placeSurfaceDecal(targetMesh, hit.point, _worldNormal, sizeSpan, isHead);
  }

  private placeSurfaceDecal(
    targetMesh: THREE.Mesh,
    hitPoint: THREE.Vector3,
    surfaceNormal: THREE.Vector3,
    sizeSpan: number,
    isHead: boolean,
  ): void {
    const posAttr = targetMesh.geometry.getAttribute('position');
    if (!posAttr) return;
    const slot = this.acquireSurfaceDecalSlot();

    const triCount = targetMesh.geometry.index
      ? Math.floor(targetMesh.geometry.index.count / 3)
      : Math.floor(posAttr.count / 3);

    const aspect = 0.8 + Math.random() * 0.45;
    const width = sizeSpan;
    const height = sizeSpan * aspect;

    _decalPos.copy(hitPoint).addScaledVector(surfaceNormal, 0.004);
    _decalLook.copy(_decalPos).add(surfaceNormal);
    _decalDummy.position.copy(_decalPos);
    _decalDummy.up.set(0, 1, 0);
    if (Math.abs(surfaceNormal.y) > 0.96) {
      _decalDummy.up.set(0, 0, 1);
    }
    _decalDummy.lookAt(_decalLook);
    _decalDummy.rotateZ(Math.random() * Math.PI * 2);

    let builtDecalGeo: THREE.BufferGeometry | null = null;
    if (
      !this.isMobilePreview &&
      triCount <= 2600 &&
      this.decalBuildsThisFrame < MAX_DECAL_BUILDS_PER_FRAME
    ) {
      this.decalBuildsThisFrame++;
      _decalSize.set(width, height, 0.28);
      try {
        targetMesh.updateMatrixWorld(true);
        const geo = new DecalGeometry(targetMesh, _decalPos, _decalDummy.rotation, _decalSize);
        const decalPosAttr = geo.getAttribute('position');
        if (decalPosAttr && decalPosAttr.count >= 3) {
          builtDecalGeo = geo;
        } else {
          geo.dispose();
        }
      } catch {
        builtDecalGeo = null;
      }
    }

    if (builtDecalGeo) {
      if (!slot.usesFallbackQuad && slot.mesh.geometry !== this.fallbackDecalGeo) {
        slot.mesh.geometry.dispose();
      }
      slot.mesh.geometry = builtDecalGeo;
      slot.mesh.position.set(0, 0, 0);
      slot.mesh.rotation.set(0, 0, 0);
      slot.mesh.scale.set(1, 1, 1);
      slot.usesFallbackQuad = false;
    } else {
      // Compact surface-normal-aligned fallback for high-poly GLBs or per-frame DecalGeometry cap
      if (!slot.usesFallbackQuad && slot.mesh.geometry !== this.fallbackDecalGeo) {
        slot.mesh.geometry.dispose();
      }
      const clampedW = Math.min(0.54, width);
      const clampedH = Math.min(0.54, height);
      slot.mesh.geometry = this.fallbackDecalGeo;
      slot.mesh.position.copy(hitPoint).addScaledVector(surfaceNormal, 0.009);
      slot.mesh.quaternion.copy(_decalDummy.quaternion);
      slot.mesh.scale.set(clampedW, clampedH, 1);
      slot.usesFallbackQuad = true;
    }

    const texIdx = Math.floor(Math.random() * this.splatTextures.length);
    slot.mat.map = this.splatTextures[texIdx];
    slot.freshColor.setHex(isHead ? 0xffffff : SPLAT_TINTS[texIdx % SPLAT_TINTS.length]);
    slot.driedColor.setHex(0x6b3232);
    slot.mat.color.copy(slot.freshColor);
    slot.mat.roughness = this.budget.usePbrDecals ? 0.16 : 0.78;
    slot.mat.metalness = this.budget.usePbrDecals ? 0.08 : 0.0;
    slot.baseOpacity = isHead ? 0.94 : 0.86;
    slot.mat.opacity = slot.baseOpacity;

    slot.maxLife = this.budget.decalLife * (0.85 + Math.random() * 0.3);
    slot.fadeStart = Math.max(2.5, slot.maxLife - 3.5);
    slot.age = 0;
    slot.mesh.visible = true;
  }

  private acquireSurfaceDecalSlot(): SurfaceDecalSlot {
    if (
      this.activeSurfaceDecals.length >= this.budget.maxDecals ||
      this.freeSurfaceDecalIndices.length === 0
    ) {
      let oldest = this.activeSurfaceDecals[0];
      for (let i = 1; i < this.activeSurfaceDecals.length; i++) {
        if (this.activeSurfaceDecals[i].age > oldest.age) {
          oldest = this.activeSurfaceDecals[i];
        }
      }
      if (!oldest.usesFallbackQuad && oldest.mesh.geometry !== this.fallbackDecalGeo) {
        oldest.mesh.geometry.dispose();
        oldest.mesh.geometry = this.fallbackDecalGeo;
        oldest.usesFallbackQuad = true;
      }
      return oldest;
    }

    const poolIdx = this.freeSurfaceDecalIndices.pop()!;
    const slot = this.surfaceDecals[poolIdx];
    slot.activeIndex = this.activeSurfaceDecals.length;
    this.activeSurfaceDecals.push(slot);
    return slot;
  }

  private releaseSurfaceDecal(slot: SurfaceDecalSlot): void {
    const activeIdx = slot.activeIndex;
    if (activeIdx < 0) return;

    slot.mesh.visible = false;
    if (!slot.usesFallbackQuad && slot.mesh.geometry !== this.fallbackDecalGeo) {
      slot.mesh.geometry.dispose();
      slot.mesh.geometry = this.fallbackDecalGeo;
      slot.usesFallbackQuad = true;
    }

    const lastIdx = this.activeSurfaceDecals.length - 1;
    if (activeIdx !== lastIdx) {
      const moved = this.activeSurfaceDecals[lastIdx];
      this.activeSurfaceDecals[activeIdx] = moved;
      moved.activeIndex = activeIdx;
    }
    this.activeSurfaceDecals.pop();
    slot.activeIndex = -1;
    this.freeSurfaceDecalIndices.push(slot.poolIndex);
  }

  public update(dt: number, cameraPos: THREE.Vector3, envTargets: THREE.Object3D[]): void {
    this.decalBuildsThisFrame = 0;

    // 1. Update active surface blood decals (gradual darkening/drying + natural fadeout)
    for (let i = this.activeSurfaceDecals.length - 1; i >= 0; i--) {
      const d = this.activeSurfaceDecals[i];
      d.age += dt;
      if (d.age >= d.maxLife) {
        this.releaseSurfaceDecal(d);
        continue;
      }

      const dryT = Math.min(1, d.age / Math.max(1, d.fadeStart * 0.65));
      d.mat.color.copy(d.freshColor).lerp(d.driedColor, dryT);
      if (this.budget.usePbrDecals) {
        d.mat.roughness = THREE.MathUtils.lerp(0.16, 0.56, dryT);
      }

      if (d.age > d.fadeStart) {
        const fadeT = (d.age - d.fadeStart) / Math.max(0.1, d.maxLife - d.fadeStart);
        d.mat.opacity = d.baseOpacity * Math.pow(Math.max(0, 1 - fadeT), 1.4);
      }
    }

    // 2. Update active zombie-attached body wound splatters (reclaim immediately if zombie recycled)
    for (let i = this.activeBodyWounds.length - 1; i >= 0; i--) {
      const w = this.activeBodyWounds[i];
      if (!w.zombie || !w.zombie.root.visible || !w.zombie.root.parent) {
        this.releaseBodyWound(w);
        continue;
      }
      w.age += dt;
      if (w.age >= w.maxLife) {
        this.releaseBodyWound(w);
        continue;
      }
      if (w.age > w.maxLife - 2.5) {
        const t = (w.age - (w.maxLife - 2.5)) / 2.5;
        w.mat.opacity = w.baseOpacity * Math.max(0, 1 - t);
      }
    }

    // 3. Update pooled blood splatter burst sprites
    this.splatterSpritePool.update(dt);

    // 4. Update active directional flying blood droplets with gravity & velocity-stretched orientation
    for (let i = this.activeDroplets.length - 1; i >= 0; i--) {
      const dr = this.activeDroplets[i];
      dr.age += dt;
      if (dr.age >= dr.maxLife) {
        this.releaseDropletAt(i);
        continue;
      }

      dr.vel.y -= dr.gravity * dt;
      dr.mesh.position.addScaledVector(dr.vel, dt);

      if (dr.mesh.position.y <= 0.018) {
        if (dr.canSplashDecal) {
          dr.canSplashDecal = false;
          _rayOrigin.set(dr.mesh.position.x, 0.35, dr.mesh.position.z);
          _rayDir.set(0, -1, 0);
          this.castAndPlaceDecal(
            _rayOrigin,
            _rayDir,
            0.8,
            0.34 + Math.random() * 0.22,
            envTargets,
            false,
          );
        }
        this.releaseDropletAt(i);
        continue;
      }

      this.orientDropletMesh(dr, cameraPos);
      const p = dr.age / dr.maxLife;
      dr.mat.opacity = 0.94 * (1 - p * p);
    }

    // 5. Update pooled GPU-instanced crimson blood mist puffs
    this.mistParticlePool.update(dt);
  }

  public dispose(): void {
    this.disposed = true;
    this.clearAll();

    for (const d of this.surfaceDecals) {
      this.scene.remove(d.mesh);
      d.mat.dispose();
    }
    for (const w of this.bodyWounds) {
      w.mat.dispose();
    }
    for (const dr of this.droplets) {
      this.scene.remove(dr.mesh);
      dr.mat.dispose();
    }
    this.splatterSpritePool.dispose();
    this.mistParticlePool.dispose();

    this.dropletGeo.dispose();
    this.bodyWoundGeo.dispose();
    this.fallbackDecalGeo.dispose();

    for (const tex of this.splatTextures) {
      tex.dispose();
    }
    this.mistTexture.dispose();
    this.dropletTexture.dispose();
  }
}
