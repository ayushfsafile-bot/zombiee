import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {
  computeMeshPartBounds,
  computeTorsoBounds,
  makeObbCollider,
  makeOrientedCapsuleCollider,
  type Collider,
  type MeshPartBounds,
  type TorsoBounds,
} from './colliders';
import {
  disposeObject3DResources,
  optimizeObjectTexturesAndMaterials,
  runProgressiveTasks,
  type RuntimePerfProfile,
} from './performance';
import type { GraphicsQuality } from './types';

export const MILITARY_AMBULANCE_URL =
  'https://file.garden/avaubS0ShqQb7IVS/retextured_m725_military_ambulance.glb';
export const WRECKED_M725_AMBULANCE_URL =
  'https://file.garden/avaubS0ShqQb7IVS/m725_military_ambulance.glb';
export const CIVILIAN_AMBULANCE_URL =
  'https://file.garden/avaubS0ShqQb7IVS/shvan_92_ambulance_-_low_poly_model.glb';
export const BURNED_POLICE_URL =
  'https://file.garden/avaubS0ShqQb7IVS/free_burned_police_cars.glb';

const SHARED_VEHICLE_PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });

export interface VehicleLoadOptions {
  profile?: RuntimePerfProfile;
  onProgress?: (loaded: number, total: number) => void;
  isAborted?: () => boolean;
}

export interface VehiclePackResult {
  vehicleMeshes: THREE.Object3D[];
  newObstacles: Collider[];
  milAmbRearMedkitPos: THREE.Vector3 | null;
  update: (
    dt: number,
    nowMs: number,
    stormIntensity?: number,
    cameraPos?: THREE.Vector3,
  ) => void;
  setQuality: (quality: GraphicsQuality, mobilePreview?: boolean) => void;
  dispose: () => void;
}

interface NormalizedVehicleMeta {
  size: THREE.Vector3;
  box: THREE.Box3;
  torso: TorsoBounds;
  parts: MeshPartBounds[];
  lengthAxis: 'x' | 'z';
  frontSign: 1 | -1;
  hasSkeleton: boolean;
}

interface EmergencyLightRig {
  kind: 'civilian' | 'military';
  worldX: number;
  worldZ: number;
  rearWorldX: number;
  rearWorldZ: number;
  strobeLight: THREE.PointLight;
  redMat: THREE.MeshStandardMaterial;
  blueOrAmberMat: THREE.MeshStandardMaterial;
  redSprite: THREE.Sprite;
  blueOrAmberSprite: THREE.Sprite;
  rearGlowLight?: THREE.PointLight;
  phaseOffset: number;
}

interface BurningEngineRig {
  worldX: number;
  worldZ: number;
  fireGroup: THREE.Group;
  fireLight: THREE.PointLight;
  outerDarkRedPlanes: THREE.Mesh[];
  orangeMidSprites: THREE.Sprite[];
  yellowCoreSprites: THREE.Sprite[];
  phaseOffset: number;
}

interface PooledParticleSystem {
  points: THREE.Points;
  maxCount: number;
  activeCount: number;
  positions: Float32Array;
  velocities: Float32Array;
  ages: Float32Array;
  lifetimes: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  seeds: Float32Array;
  emittersX: Float32Array;
  emittersY: Float32Array;
  emittersZ: Float32Array;
  emitterCount: number;
  posAttr: THREE.BufferAttribute;
  sizeAttr: THREE.BufferAttribute;
  alphaAttr: THREE.BufferAttribute;
  kind: 'smoke' | 'ember' | 'steam' | 'sizzle';
}

const _tmpBox = new THREE.Box3();
const _tmpSize = new THREE.Vector3();
const _tmpCenter = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _redColor = new THREE.Color(0xef4444);
const _blueColor = new THREE.Color(0x3b82f6);
const _amberColor = new THREE.Color(0xf59e0b);
const _fireColor = new THREE.Color(0xff5a14);

function createLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register((parser) => {
    const extName = 'KHR_materials_pbrSpecularGlossiness';
    return {
      name: extName,
      getMaterialType(materialIndex: number) {
        const matDef = parser.json.materials?.[materialIndex];
        if (matDef?.extensions?.[extName]) {
          return THREE.MeshStandardMaterial;
        }
        return null;
      },
      extendMaterialParams(materialIndex: number, materialParams: Record<string, unknown>) {
        const matDef = parser.json.materials?.[materialIndex];
        const sg = matDef?.extensions?.[extName];
        if (!sg) return null;

        if (Array.isArray(sg.diffuseFactor)) {
          const c = new THREE.Color().fromArray(sg.diffuseFactor);
          materialParams.color = c;
          if (sg.diffuseFactor.length >= 4 && sg.diffuseFactor[3] < 1) {
            materialParams.opacity = sg.diffuseFactor[3];
            materialParams.transparent = true;
          }
        }
        const glossiness = typeof sg.glossinessFactor === 'number' ? sg.glossinessFactor : 0.4;
        materialParams.roughness = sg.specularGlossinessTexture
          ? THREE.MathUtils.clamp(1.0 - glossiness * 0.6, 0.35, 0.92)
          : THREE.MathUtils.clamp(1.0 - glossiness, 0.25, 0.92);
        materialParams.metalness = 0.08;

        const pending: Promise<unknown>[] = [];
        if (sg.diffuseTexture) {
          pending.push(
            parser.assignTexture(materialParams, 'map', sg.diffuseTexture, THREE.SRGBColorSpace),
          );
        }
        return pending.length ? Promise.all(pending) : Promise.resolve();
      },
    };
  });
  return loader;
}

const vehicleGltfLoader = createLoader();

async function loadVehicleGLTF(
  url: string,
): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] } | null> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < 12) return null;
    const magic = new DataView(buffer).getUint32(0, true);
    if (magic !== 0x46546c67) return null;

    return await new Promise((resolve, reject) => {
      vehicleGltfLoader.parse(
        buffer,
        '',
        (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations || [] }),
        reject,
      );
    });
  } catch (err) {
    console.warn(`[Vehicles] Failed to load GLB ${url}:`, err);
    return null;
  }
}

function hasSkinnedMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
      found = true;
    }
  });
  return found;
}

function cloneVehicleScene(source: THREE.Group, needsSkeletonClone: boolean): THREE.Group {
  if (needsSkeletonClone) {
    return SkeletonUtils.clone(source) as THREE.Group;
  }
  return source.clone(true);
}

function inferFrontSign(
  root: THREE.Object3D,
  lengthAxis: 'x' | 'z',
  center: THREE.Vector3,
): 1 | -1 {
  let frontScore = 0;
  let rearScore = 0;
  let frontSampleCount = 0;
  let rearSampleCount = 0;

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const n = `${obj.name || ''} ${mesh.material && !Array.isArray(mesh.material) ? mesh.material.name || '' : ''}`.toLowerCase();
    const isFrontHint =
      n.includes('hood') ||
      n.includes('windshield') ||
      n.includes('headlight') ||
      n.includes('bumper_front') ||
      n.includes('grille') ||
      n.includes('cab');
    const isRearHint =
      n.includes('bumper_rear') ||
      n.includes('brakelight') ||
      n.includes('taillight') ||
      n.includes('reverse') ||
      n.includes('rear') ||
      n.includes('back_door');

    if (!isFrontHint && !isRearHint) return;
    _tmpBox.setFromObject(mesh);
    _tmpBox.getCenter(_tmpVec);
    const coord = lengthAxis === 'x' ? _tmpVec.x - center.x : _tmpVec.z - center.z;
    if (isFrontHint) {
      frontScore += coord;
      frontSampleCount++;
    }
    if (isRearHint) {
      rearScore += coord;
      rearSampleCount++;
    }
  });

  if (frontSampleCount > 0 || rearSampleCount > 0) {
    const avgFront = frontSampleCount > 0 ? frontScore / frontSampleCount : 0;
    const avgRear = rearSampleCount > 0 ? rearScore / rearSampleCount : 0;
    return avgFront >= avgRear ? 1 : -1;
  }

  return 1;
}

function normalizeVehicleInstance(
  rawSource: THREE.Group,
  targetLength: number,
  isSoftwareGl: boolean,
  quality: GraphicsQuality,
  needsSkeletonClone: boolean,
  polishedMaterials: Set<THREE.Material>,
  transmissionMats: Array<{ mat: THREE.MeshPhysicalMaterial; origTransmission: number }>,
  outRayTargets: THREE.Object3D[],
  preRotationY = 0,
  weatherForRain = false,
): { wrapper: THREE.Group; meta: NormalizedVehicleMeta } {
  const model = cloneVehicleScene(rawSource, needsSkeletonClone);
  if (preRotationY !== 0) {
    model.rotation.y = preRotationY;
  }
  const wrapper = new THREE.Group();
  wrapper.add(model);

  model.updateMatrixWorld(true);
  _tmpBox.setFromObject(model);
  _tmpBox.getSize(_tmpSize);

  const currentLength = Math.max(0.001, _tmpSize.x, _tmpSize.z);
  const scale = targetLength / currentLength;
  model.scale.multiplyScalar(scale);
  model.updateMatrixWorld(true);

  _tmpBox.setFromObject(model);
  _tmpBox.getCenter(_tmpCenter);
  model.position.x -= _tmpCenter.x;
  model.position.z -= _tmpCenter.z;
  model.position.y -= _tmpBox.min.y;
  model.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(wrapper);
  const finalSize = finalBox.getSize(new THREE.Vector3());
  const parts = computeMeshPartBounds(wrapper, 0.18, 1.82);
  const torso = computeTorsoBounds(wrapper, 0.18, 1.82);
  const lengthAxis: 'x' | 'z' = finalSize.x > finalSize.z ? 'x' : 'z';
  const frontSign = inferFrontSign(model, lengthAxis, _tmpVec.set(0, 0, 0));

  const targetEnv = quality === 'HIGH' ? 1.0 : quality === 'LOW' ? 0.72 : 0.88;
  const targetAniso = quality === 'LOW' ? 1 : quality === 'MED' ? 2 : 4;

  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    mesh.userData.isVehicleMesh = true;
    mesh.castShadow = !isSoftwareGl && quality === 'HIGH';
    mesh.receiveShadow = !isSoftwareGl;

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || polishedMaterials.has(m)) continue;
      polishedMaterials.add(m);

      const std = m as THREE.MeshStandardMaterial;
      if (typeof std.envMapIntensity === 'number') {
        std.envMapIntensity = targetEnv;
      }

      if (weatherForRain && (std as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        // Weathering & wet-surface specular tuning to blend seamlessly into rainy night lighting
        std.color.setRGB(std.color.r * 0.74, std.color.g * 0.77, std.color.b * 0.71);
        if (std.roughnessMap) {
          std.roughness = THREE.MathUtils.clamp((std.roughness || 1.0) * 0.56, 0.36, 0.68);
        } else {
          std.roughness = 0.48;
        }
        std.metalness = THREE.MathUtils.clamp(Math.max(std.metalness ?? 0.22, 0.3), 0.25, 0.48);
        if (typeof std.aoMapIntensity === 'number') {
          std.aoMapIntensity = Math.max(std.aoMapIntensity, 1.15);
        }
        for (const tex of [std.map, std.normalMap, std.roughnessMap, std.metalnessMap, std.aoMap]) {
          if (tex) {
            tex.anisotropy = targetAniso;
            tex.needsUpdate = true;
          }
        }
      }

      const phys = m as THREE.MeshPhysicalMaterial;
      if (typeof phys.transmission === 'number' && phys.transmission > 0) {
        transmissionMats.push({ mat: phys, origTransmission: phys.transmission });
        if (isSoftwareGl || quality === 'LOW') {
          phys.transmission = 0;
          phys.transparent = true;
          phys.opacity = Math.min(phys.opacity || 1, 0.42);
        }
      }
      m.needsUpdate = true;
    }
  });

  // Fit invisible ballistic raycast proxies strictly to solid mesh parts using tailored CapsuleGeometry primitives
  for (const part of parts) {
    let proxyMesh: THREE.Mesh;
    if (part.width >= part.depth) {
      const r = Math.max(0.14, part.depth * 0.5);
      const midLen = Math.max(0.02, part.width - r * 2);
      const proxyGeo = new THREE.CapsuleGeometry(r, midLen, 4, 8);
      proxyMesh = new THREE.Mesh(proxyGeo, SHARED_VEHICLE_PROXY_MAT);
      proxyMesh.rotation.z = Math.PI * 0.5;
      proxyMesh.scale.set(Math.max(0.25, part.height / (r * 2)), 1, 1);
    } else {
      const r = Math.max(0.14, part.width * 0.5);
      const midLen = Math.max(0.02, part.depth - r * 2);
      const proxyGeo = new THREE.CapsuleGeometry(r, midLen, 4, 8);
      proxyMesh = new THREE.Mesh(proxyGeo, SHARED_VEHICLE_PROXY_MAT);
      proxyMesh.rotation.x = Math.PI * 0.5;
      proxyMesh.scale.set(1, 1, Math.max(0.25, part.height / (r * 2)));
    }
    proxyMesh.position.set(part.centerX, part.minY + part.height * 0.5, part.centerZ);
    proxyMesh.userData.isVehicleMetal = true;
    proxyMesh.userData.isRaycastProxy = true;
    proxyMesh.matrixAutoUpdate = false;
    proxyMesh.updateMatrix();
    wrapper.add(proxyMesh);
    outRayTargets.push(proxyMesh);
  }

  return {
    wrapper,
    meta: {
      size: finalSize,
      box: finalBox,
      torso,
      parts,
      lengthAxis,
      frontSign,
      hasSkeleton: needsSkeletonClone,
    },
  };
}

function createRadialFlareTexture(colorHex: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.95)');
  grad.addColorStop(0.24, colorHex);
  grad.addColorStop(0.58, `${colorHex}55`);
  grad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Multi-tongue organic flame wisp texture with dark-red/orange base and warm gold tips
 * (no blown-out white center so bloom adds subtle warmth instead of harsh white glare).
 */
function createLayeredFlameTexture(variant: 'dark_body' | 'hot_tongue'): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);

  const tongues: Array<{ x: number; y: number; rx: number; ry: number; rot: number }> = [
    { x: 64, y: 74, rx: 32, ry: 48, rot: 0 },
    { x: 46, y: 80, rx: 20, ry: 36, rot: -0.18 },
    { x: 82, y: 80, rx: 20, ry: 36, rot: 0.18 },
    { x: 64, y: 54, rx: 16, ry: 38, rot: 0.06 },
  ];

  for (const t of tongues) {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.rot);

    const grad = ctx.createRadialGradient(0, 10, 3, 0, 0, t.ry);
    if (variant === 'dark_body') {
      grad.addColorStop(0.0, 'rgba(255, 118, 22, 0.94)');
      grad.addColorStop(0.4, 'rgba(205, 48, 12, 0.85)');
      grad.addColorStop(0.76, 'rgba(115, 22, 10, 0.55)');
      grad.addColorStop(1.0, 'rgba(40, 12, 8, 0)');
    } else {
      grad.addColorStop(0.0, 'rgba(255, 212, 82, 0.95)');
      grad.addColorStop(0.32, 'rgba(255, 142, 24, 0.88)');
      grad.addColorStop(0.7, 'rgba(220, 62, 10, 0.48)');
      grad.addColorStop(1.0, 'rgba(150, 25, 4, 0)');
    }

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, t.rx, t.ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSoftParticleTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.42, 'rgba(255, 255, 255, 0.52)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createPooledParticleSystem(
  kind: 'smoke' | 'ember' | 'steam' | 'sizzle',
  maxCount: number,
  emitters: THREE.Vector3[],
  softTex: THREE.Texture,
  track: <T extends { dispose: () => void }>(res: T) => T,
): PooledParticleSystem {
  const positions = new Float32Array(maxCount * 3);
  const velocities = new Float32Array(maxCount * 3);
  const ages = new Float32Array(maxCount);
  const lifetimes = new Float32Array(maxCount);
  const sizes = new Float32Array(maxCount);
  const alphas = new Float32Array(maxCount);
  const seeds = new Float32Array(maxCount);
  const colors = new Float32Array(maxCount * 3);

  const emitterCount = emitters.length;
  const emittersX = new Float32Array(Math.max(1, emitterCount));
  const emittersY = new Float32Array(Math.max(1, emitterCount));
  const emittersZ = new Float32Array(Math.max(1, emitterCount));
  for (let e = 0; e < emitterCount; e++) {
    emittersX[e] = emitters[e].x;
    emittersY[e] = emitters[e].y;
    emittersZ[e] = emitters[e].z;
  }

  for (let i = 0; i < maxCount; i++) {
    const eIdx = emitterCount > 0 ? i % emitterCount : 0;
    const ex = emittersX[eIdx];
    const ey = emittersY[eIdx];
    const ez = emittersZ[eIdx];

    const spreadXZ = kind === 'steam' ? 1.1 : kind === 'sizzle' ? 0.9 : kind === 'smoke' ? 0.52 : 0.56;
    positions[i * 3] = ex + (Math.random() - 0.5) * spreadXZ;
    positions[i * 3 + 1] = ey + Math.random() * 0.22;
    positions[i * 3 + 2] = ez + (Math.random() - 0.5) * spreadXZ;

    if (kind === 'smoke') {
      velocities[i * 3] = 0.22 + (Math.random() - 0.35) * 0.34;
      velocities[i * 3 + 1] = 1.1 + Math.random() * 0.9;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.32;
      lifetimes[i] = 2.5 + Math.random() * 2.1;
      colors[i * 3] = 0.09;
      colors[i * 3 + 1] = 0.09;
      colors[i * 3 + 2] = 0.1;
      sizes[i] = 0.65;
    } else if (kind === 'steam') {
      velocities[i * 3] = (Math.random() - 0.5) * 0.36;
      velocities[i * 3 + 1] = 0.72 + Math.random() * 0.65;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.36;
      lifetimes[i] = 1.45 + Math.random() * 1.15;
      const tint = 0.76 + Math.random() * 0.16; // Distinct light-gray / soft white
      colors[i * 3] = tint;
      colors[i * 3 + 1] = tint * 1.02;
      colors[i * 3 + 2] = Math.min(1, tint * 1.06);
      sizes[i] = 0.42;
    } else if (kind === 'sizzle') {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.9 + Math.random() * 1.8;
      velocities[i * 3] = Math.cos(ang) * spd;
      velocities[i * 3 + 1] = 1.3 + Math.random() * 1.4;
      velocities[i * 3 + 2] = Math.sin(ang) * spd;
      lifetimes[i] = 0.22 + Math.random() * 0.22;
      colors[i * 3] = 1.0;
      colors[i * 3 + 1] = 0.52 + Math.random() * 0.28;
      colors[i * 3 + 2] = 0.12;
      sizes[i] = 0.075;
    } else {
      velocities[i * 3] = (Math.random() - 0.5) * 0.78;
      velocities[i * 3 + 1] = 1.45 + Math.random() * 1.65;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.78;
      lifetimes[i] = 1.05 + Math.random() * 1.35;
      const hot = Math.random();
      colors[i * 3] = 1.0;
      colors[i * 3 + 1] = 0.2 + hot * 0.42;
      colors[i * 3 + 2] = 0.02 + hot * 0.05;
      sizes[i] = 0.095;
    }

    seeds[i] = Math.random() * 6.283;
    ages[i] = Math.random() * lifetimes[i];
    positions[i * 3] += velocities[i * 3] * ages[i];
    positions[i * 3 + 1] += velocities[i * 3 + 1] * ages[i];
    positions[i * 3 + 2] += velocities[i * 3 + 2] * ages[i];
    alphas[i] = 0;
  }

  const geo = track(new THREE.BufferGeometry());
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(sizes, 1);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aSize', sizeAttr);
  geo.setAttribute('aAlpha', alphaAttr);
  geo.setAttribute('aColor', colorAttr);

  // Smoke transitions smoothly from dark charcoal near base -> medium gray as it rises in the vertex shader
  const isSmoke = kind === 'smoke';
  const mat = track(
    new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: softTex },
        uScale: { value: window.innerHeight * 0.56 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          ${
            isSmoke
              ? `
          float heightMix = clamp((position.y - 0.8) / 4.2, 0.0, 1.0);
          vColor = mix(vec3(0.08, 0.08, 0.09), vec3(0.36, 0.38, 0.42), heightMix);
          `
              : `
          vColor = aColor;
          `
          }
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * (uScale / max(1.0, -mvPos.z)), 1.5, 118.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float alpha = tex.a * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(vColor * tex.rgb, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending:
        kind === 'ember' || kind === 'sizzle'
          ? THREE.AdditiveBlending
          : THREE.NormalBlending,
    }),
  );

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  return {
    points,
    maxCount,
    activeCount: maxCount,
    positions,
    velocities,
    ages,
    lifetimes,
    sizes,
    alphas,
    seeds,
    emittersX,
    emittersY,
    emittersZ,
    emitterCount,
    posAttr,
    sizeAttr,
    alphaAttr,
    kind,
  };
}

function updatePooledParticles(
  sys: PooledParticleSystem,
  dt: number,
  nowSec: number,
  stormIntensity: number,
  uScaleVal: number,
): void {
  if (sys.emitterCount === 0 || sys.activeCount <= 0) {
    sys.points.visible = false;
    return;
  }

  // Sizzling sparks only happen when rain hits hot hood metal meaningfully
  if (sys.kind === 'sizzle' && stormIntensity < 0.22) {
    sys.points.visible = false;
    return;
  }

  sys.points.visible = true;
  sys.points.geometry.setDrawRange(0, sys.activeCount);

  const mat = sys.points.material as THREE.ShaderMaterial;
  mat.uniforms.uScale.value = uScaleVal;

  const isSmoke = sys.kind === 'smoke';
  const isSteam = sys.kind === 'steam';
  const isSizzle = sys.kind === 'sizzle';
  const windPushX = 0.24 + stormIntensity * 0.72;
  const windPushZ = 0.08 + stormIntensity * 0.28;
  const emberLifeScale = 1.0 - stormIntensity * 0.6; // Shorter ember life during heavy rain
  const steamAlphaScale = 0.16 + stormIntensity * 0.34; // Stronger steam in heavier rain
  const sizzleAlphaScale = THREE.MathUtils.clamp((stormIntensity - 0.18) * 1.15, 0.15, 0.95);

  for (let i = 0; i < sys.activeCount; i++) {
    const baseLife = sys.lifetimes[i];
    const effLife = sys.kind === 'ember' ? Math.max(0.32, baseLife * emberLifeScale) : baseLife;

    sys.ages[i] += dt;
    if (sys.ages[i] >= effLife) {
      const eIdx = i % sys.emitterCount;
      const spreadXZ = isSteam ? 1.15 : isSizzle ? 0.92 : isSmoke ? 0.52 : 0.56;
      sys.positions[i * 3] = sys.emittersX[eIdx] + (Math.random() - 0.5) * spreadXZ;
      sys.positions[i * 3 + 1] =
        sys.emittersY[eIdx] + (isSteam ? -0.15 + Math.random() * 0.25 : Math.random() * 0.2);
      sys.positions[i * 3 + 2] = sys.emittersZ[eIdx] + (Math.random() - 0.5) * spreadXZ;
      sys.ages[i] = 0;
    }

    const lifeT = sys.ages[i] / Math.max(0.01, effLife);
    const invLife = 1.0 - lifeT;
    const idx = i * 3;
    const seed = sys.seeds[i];

    if (isSmoke) {
      const turbX = Math.sin(nowSec * 0.72 + seed + lifeT * 2.2) * 0.18;
      const turbZ = Math.cos(nowSec * 0.85 + seed + lifeT * 2.0) * 0.16;
      sys.positions[idx] += (sys.velocities[idx] * 0.4 + windPushX + turbX) * dt;
      sys.positions[idx + 1] += sys.velocities[idx + 1] * (1.0 - lifeT * 0.3) * dt;
      sys.positions[idx + 2] += (sys.velocities[idx + 2] * 0.4 + windPushZ + turbZ) * dt;

      sys.sizes[i] = 0.65 + lifeT * 3.15;
      const fadeIn = lifeT < 0.18 ? lifeT * 5.55 : 1.0;
      sys.alphas[i] = fadeIn * invLife * invLife * 0.54;
    } else if (isSteam) {
      const curlX = Math.sin(nowSec * 1.4 + seed) * 0.16;
      const curlZ = Math.cos(nowSec * 1.2 + seed) * 0.16;
      sys.positions[idx] += (sys.velocities[idx] + windPushX * 0.85 + curlX) * dt;
      sys.positions[idx + 1] += sys.velocities[idx + 1] * (1.0 - lifeT * 0.35) * dt;
      sys.positions[idx + 2] += (sys.velocities[idx + 2] + windPushZ * 0.85 + curlZ) * dt;

      sys.sizes[i] = 0.36 + lifeT * 1.65;
      const fadeIn = lifeT < 0.2 ? lifeT * 5.0 : 1.0;
      sys.alphas[i] = fadeIn * invLife * invLife * steamAlphaScale;
    } else if (isSizzle) {
      sys.positions[idx] += (sys.velocities[idx] + windPushX * 0.4) * dt;
      sys.positions[idx + 1] += (sys.velocities[idx + 1] - 5.2 * sys.ages[i]) * dt;
      sys.positions[idx + 2] += sys.velocities[idx + 2] * dt;
      sys.sizes[i] = 0.068 * (0.4 + 0.6 * invLife);
      // Only a fraction bursts visibly at any moment for organic sizzling feel
      const burstWindow = Math.sin(seed * 5.0 + nowSec * 4.5) > 0.15 ? 1.0 : 0.0;
      sys.alphas[i] = invLife * sizzleAlphaScale * burstWindow * 0.85;
    } else {
      const swirlX = Math.sin(nowSec * 3.2 + seed + lifeT * 4.6) * 0.52;
      const swirlZ = Math.cos(nowSec * 2.9 + seed + lifeT * 4.2) * 0.52;
      sys.positions[idx] += (sys.velocities[idx] * 0.38 + windPushX * 0.55 + swirlX) * dt;
      sys.positions[idx + 1] += sys.velocities[idx + 1] * (1.0 - stormIntensity * 0.25) * dt;
      sys.positions[idx + 2] += (sys.velocities[idx + 2] * 0.38 + windPushZ * 0.55 + swirlZ) * dt;

      const flicker = 0.65 + 0.35 * Math.sin(nowSec * 15.0 + seed * 3.0);
      sys.sizes[i] = 0.105 * (1.0 - lifeT * 0.65);
      const fadeIn = lifeT < 0.12 ? lifeT * 8.33 : 1.0;
      sys.alphas[i] = fadeIn * invLife * flicker * 0.82;
    }
  }

  sys.posAttr.needsUpdate = true;
  sys.sizeAttr.needsUpdate = true;
  sys.alphaAttr.needsUpdate = true;
}

export async function loadAndIntegrateVehicles(
  scene: THREE.Scene,
  isSoftwareGl: boolean,
  initialQuality: GraphicsQuality,
  options: VehicleLoadOptions = {},
): Promise<VehiclePackResult> {
  const { profile, onProgress, isAborted } = options;
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(res: T): T => {
    disposables.push(res);
    return res;
  };

  const vehicleMeshes: THREE.Object3D[] = [];
  const newObstacles: Collider[] = [];
  const polishedMaterials = new Set<THREE.Material>();
  const transmissionMats: Array<{ mat: THREE.MeshPhysicalMaterial; origTransmission: number }> = [];
  const lightRigs: EmergencyLightRig[] = [];
  const burningRigs: BurningEngineRig[] = [];
  const vehicleRoots: THREE.Group[] = [];
  let milAmbRearMedkitPos: THREE.Vector3 | null = null;
  let currentQuality: GraphicsQuality = initialQuality;
  let mobilePreviewMode = Boolean(profile?.isMobilePreview);

  const vehicleUrls = [
    MILITARY_AMBULANCE_URL,
    CIVILIAN_AMBULANCE_URL,
    BURNED_POLICE_URL,
    WRECKED_M725_AMBULANCE_URL,
  ];
  let vehLoaded = 0;
  const loadedVehicleGltfs = await runProgressiveTasks(
    vehicleUrls.map((url) => async () => {
      const parsed = await loadVehicleGLTF(url);
      if (parsed && profile) {
        optimizeObjectTexturesAndMaterials(parsed.scene, profile);
      }
      vehLoaded += 1;
      onProgress?.(vehLoaded, vehicleUrls.length);
      return parsed;
    }),
    profile?.loaderConcurrency ?? 2,
    Boolean(profile?.progressiveLoadYield),
    isAborted,
  );

  if (isAborted?.()) {
    for (const item of loadedVehicleGltfs) {
      disposeObject3DResources(item?.scene);
    }
    return {
      vehicleMeshes,
      newObstacles,
      milAmbRearMedkitPos,
      update: () => {},
      setQuality: () => {},
      dispose: () => {},
    };
  }

  const [milAmbGLTF, civAmbGLTF, policeGLTF, wreckedM725GLTF] = loadedVehicleGltfs;

  const redFlareTex = track(createRadialFlareTexture('#ef4444'));
  const blueFlareTex = track(createRadialFlareTexture('#3b82f6'));
  const amberFlareTex = track(createRadialFlareTexture('#f59e0b'));
  const darkFlameTex = track(createLayeredFlameTexture('dark_body'));
  const hotFlameTex = track(createLayeredFlameTexture('hot_tongue'));
  const softParticleTex = track(createSoftParticleTexture());

  const barHousingMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4, metalness: 0.75 }),
  );
  const barHousingGeo = track(new THREE.BoxGeometry(0.95, 0.1, 0.24));
  const podGeo = track(new THREE.BoxGeometry(0.36, 0.12, 0.22));
  const beaconCylinderGeo = track(new THREE.CylinderGeometry(0.14, 0.17, 0.16, 10));
  const outerFlameGeo = track(new THREE.PlaneGeometry(1.18, 1.38));

  const registerVehicleCapsuleCollision = (
    cx: number,
    cz: number,
    rotY: number,
    parts: readonly MeshPartBounds[],
    maxHeightFallback: number,
  ) => {
    for (const part of parts) {
      const w = Math.max(0.35, part.width - 0.04);
      const d = Math.max(0.45, part.depth - 0.04);
      newObstacles.push(
        makeOrientedCapsuleCollider(
          cx,
          cz,
          w,
          d,
          rotY,
          Math.max(maxHeightFallback, part.height),
          part.centerX,
          part.centerZ,
        ),
      );
    }
  };

  // 1. MILITARY AMBULANCE (milAmbGLTF)
  if (milAmbGLTF) {
    const milSkeleton = hasSkinnedMesh(milAmbGLTF.scene);
    const { wrapper: milAmb, meta } = normalizeVehicleInstance(
      milAmbGLTF.scene,
      5.4,
      isSoftwareGl,
      currentQuality,
      milSkeleton,
      polishedMaterials,
      transmissionMats,
      vehicleMeshes,
    );
    milAmb.position.set(-6.5, 0, -14);
    milAmb.rotation.y = 0.55;
    scene.add(milAmb);
    vehicleRoots.push(milAmb);
    registerVehicleCapsuleCollision(-6.5, -14, 0.55, meta.parts, 2.5);

    const halfLen = (meta.lengthAxis === 'x' ? meta.size.x : meta.size.z) * 0.5;
    const roofY = meta.box.max.y + 0.07;
    const frontOffset = meta.frontSign * (halfLen * 0.12);
    const rearLocal = new THREE.Vector3(
      meta.lengthAxis === 'x' ? -meta.frontSign * (halfLen + 1.15) : 0,
      0,
      meta.lengthAxis === 'z' ? -meta.frontSign * (halfLen + 1.15) : 0,
    );
    milAmb.updateMatrixWorld(true);
    milAmbRearMedkitPos = milAmb.localToWorld(rearLocal.clone());
    milAmbRearMedkitPos.y = 0;

    // Animated red/amber erratic hazard beacon (1 shared roof PointLight instead of 2)
    const beaconGroup = new THREE.Group();
    beaconGroup.position.set(
      meta.lengthAxis === 'x' ? frontOffset : 0,
      roofY,
      meta.lengthAxis === 'z' ? frontOffset : 0,
    );
    milAmb.add(beaconGroup);

    const redMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        emissive: 0xef4444,
        emissiveIntensity: 2.8,
        roughness: 0.2,
      }),
    );
    const amberMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xf59e0b,
        emissiveIntensity: 2.8,
        roughness: 0.2,
      }),
    );

    const redBeacon = new THREE.Mesh(beaconCylinderGeo, redMat);
    redBeacon.position.set(meta.lengthAxis === 'x' ? 0 : -0.22, 0, meta.lengthAxis === 'x' ? -0.22 : 0);
    beaconGroup.add(redBeacon);

    const amberBeacon = new THREE.Mesh(beaconCylinderGeo, amberMat);
    amberBeacon.position.set(meta.lengthAxis === 'x' ? 0 : 0.22, 0, meta.lengthAxis === 'x' ? 0.22 : 0);
    beaconGroup.add(amberBeacon);

    const redSprite = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: redFlareTex,
          color: 0xff6b6b,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    redSprite.scale.set(1.2, 1.2, 1);
    redSprite.position.copy(redBeacon.position);
    beaconGroup.add(redSprite);

    const amberSprite = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: amberFlareTex,
          color: 0xfbbf24,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    amberSprite.scale.set(1.2, 1.2, 1);
    amberSprite.position.copy(amberBeacon.position);
    beaconGroup.add(amberSprite);

    const sharedStrobeLight = new THREE.PointLight(0xf59e0b, 15, 19, 1.7);
    sharedStrobeLight.position.set(0, 0.45, 0);
    sharedStrobeLight.castShadow = false;
    beaconGroup.add(sharedStrobeLight);

    // Subtle localized light illuminating rear Health Box spawn point when nearby
    const rearGlow = new THREE.PointLight(0x10b981, 6.5, 8.5, 1.8);
    rearGlow.position.set(
      meta.lengthAxis === 'x' ? -meta.frontSign * (halfLen + 0.6) : 0,
      1.35,
      meta.lengthAxis === 'z' ? -meta.frontSign * (halfLen + 0.6) : 0,
    );
    rearGlow.castShadow = false;
    milAmb.add(rearGlow);

    lightRigs.push({
      kind: 'military',
      worldX: -6.5,
      worldZ: -14,
      rearWorldX: milAmbRearMedkitPos.x,
      rearWorldZ: milAmbRearMedkitPos.z,
      strobeLight: sharedStrobeLight,
      redMat,
      blueOrAmberMat: amberMat,
      redSprite,
      blueOrAmberSprite: amberSprite,
      rearGlowLight: rearGlow,
      phaseOffset: 0.4,
    });
  }

  // 2. CIVILIAN SHVAN '92 AMBULANCES (2 Cloned Instances, 1 alternating PointLight per ambulance)
  if (civAmbGLTF) {
    const civSkeleton = hasSkinnedMesh(civAmbGLTF.scene);
    const civPlacements: Array<{ x: number; y: number; z: number; rotY: number; phase: number }> = [
      { x: 11, y: 0, z: -4, rotY: -0.4, phase: 0.0 },
      { x: -12, y: 0, z: 12, rotY: 2.3, phase: 1.8 },
    ];

    for (const cfg of civPlacements) {
      const { wrapper: civAmb, meta } = normalizeVehicleInstance(
        civAmbGLTF.scene,
        5.0,
        isSoftwareGl,
        currentQuality,
        civSkeleton,
        polishedMaterials,
        transmissionMats,
        vehicleMeshes,
      );
      civAmb.position.set(cfg.x, cfg.y, cfg.z);
      civAmb.rotation.y = cfg.rotY;
      scene.add(civAmb);
      vehicleRoots.push(civAmb);
      registerVehicleCapsuleCollision(cfg.x, cfg.z, cfg.rotY, meta.parts, 2.4);

      const halfLen = (meta.lengthAxis === 'x' ? meta.size.x : meta.size.z) * 0.5;
      const cabRoofOffset = meta.frontSign * (halfLen * 0.24);
      const roofY = meta.box.max.y + 0.04;

      const lightbar = new THREE.Group();
      lightbar.position.set(
        meta.lengthAxis === 'x' ? cabRoofOffset : 0,
        roofY,
        meta.lengthAxis === 'z' ? cabRoofOffset : 0,
      );
      if (meta.lengthAxis === 'x') {
        lightbar.rotation.y = Math.PI * 0.5;
      }
      civAmb.add(lightbar);

      const barMount = new THREE.Mesh(barHousingGeo, barHousingMat);
      lightbar.add(barMount);

      const redMat = track(
        new THREE.MeshStandardMaterial({
          color: 0xef4444,
          emissive: 0xef4444,
          emissiveIntensity: 3.0,
          roughness: 0.18,
        }),
      );
      const blueMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x3b82f6,
          emissive: 0x3b82f6,
          emissiveIntensity: 3.0,
          roughness: 0.18,
        }),
      );

      const redPod = new THREE.Mesh(podGeo, redMat);
      redPod.position.set(-0.34, 0.02, 0);
      lightbar.add(redPod);

      const bluePod = new THREE.Mesh(podGeo, blueMat);
      bluePod.position.set(0.34, 0.02, 0);
      lightbar.add(bluePod);

      const redSprite = new THREE.Sprite(
        track(
          new THREE.SpriteMaterial({
            map: redFlareTex,
            color: 0xef4444,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      );
      redSprite.scale.set(1.4, 1.4, 1);
      redSprite.position.copy(redPod.position);
      lightbar.add(redSprite);

      const blueSprite = new THREE.Sprite(
        track(
          new THREE.SpriteMaterial({
            map: blueFlareTex,
            color: 0x3b82f6,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      );
      blueSprite.scale.set(1.4, 1.4, 1);
      blueSprite.position.copy(bluePod.position);
      lightbar.add(blueSprite);

      // Single PointLight alternating between Red and Blue strobe colors
      const alternatingStrobeLight = new THREE.PointLight(0xef4444, 19, 22, 1.65);
      alternatingStrobeLight.position.set(0, 0.45, 0);
      alternatingStrobeLight.castShadow = false;
      lightbar.add(alternatingStrobeLight);

      lightRigs.push({
        kind: 'civilian',
        worldX: cfg.x,
        worldZ: cfg.z,
        rearWorldX: cfg.x,
        rearWorldZ: cfg.z,
        strobeLight: alternatingStrobeLight,
        redMat,
        blueOrAmberMat: blueMat,
        redSprite,
        blueOrAmberSprite: blueSprite,
        phaseOffset: cfg.phase,
      });
    }
  }

  // 3. BURNED POLICE CARS (3 wrecks, 2 with Rain-Reactive Layered Engine Fire, Smoke, Steam & Embers)
  const smokeEmitters: THREE.Vector3[] = [];
  const emberEmitters: THREE.Vector3[] = [];
  const steamEmitters: THREE.Vector3[] = [];
  const sizzleEmitters: THREE.Vector3[] = [];

  if (policeGLTF) {
    const policeSkeleton = hasSkinnedMesh(policeGLTF.scene);
    const policePlacements: Array<{
      x: number;
      z: number;
      rotY: number;
      tiltZ: number;
      isBurning: boolean;
      phase: number;
    }> = [
      { x: -1.6, z: 1.4, rotY: 0.62, tiltZ: -0.025, isBurning: true, phase: 0.0 },
      { x: 5.4, z: -6.2, rotY: -0.78, tiltZ: 0.02, isBurning: true, phase: 1.9 },
      { x: 2.8, z: 11.4, rotY: 2.25, tiltZ: -0.015, isBurning: false, phase: 0.0 },
    ];

    for (const cfg of policePlacements) {
      const { wrapper: car, meta } = normalizeVehicleInstance(
        policeGLTF.scene,
        4.6,
        isSoftwareGl,
        currentQuality,
        policeSkeleton,
        polishedMaterials,
        transmissionMats,
        vehicleMeshes,
      );
      car.position.set(cfg.x, 0, cfg.z);
      car.rotation.y = cfg.rotY;
      car.rotation.z = cfg.tiltZ;
      car.updateMatrixWorld(true);

      _tmpBox.setFromObject(car);
      if (Math.abs(_tmpBox.min.y) > 0.01) {
        car.position.y -= _tmpBox.min.y;
      }
      scene.add(car);
      vehicleRoots.push(car);
      registerVehicleCapsuleCollision(cfg.x, cfg.z, cfg.rotY, meta.parts, 1.5);

      if (cfg.isBurning) {
        const halfLen = (meta.lengthAxis === 'x' ? meta.size.x : meta.size.z) * 0.5;
        const engineLocal = new THREE.Vector3(
          meta.lengthAxis === 'x' ? meta.frontSign * halfLen * 0.56 : 0,
          meta.size.y * 0.5,
          meta.lengthAxis === 'z' ? meta.frontSign * halfLen * 0.56 : 0,
        );
        car.updateMatrixWorld(true);
        const engineWorld = car.localToWorld(engineLocal.clone());

        smokeEmitters.push(engineWorld.clone().add(new THREE.Vector3(0, 0.34, 0)));
        emberEmitters.push(engineWorld.clone().add(new THREE.Vector3(0, 0.22, 0)));
        steamEmitters.push(engineWorld.clone().add(new THREE.Vector3(0, 0.14, 0)));
        sizzleEmitters.push(engineWorld.clone().add(new THREE.Vector3(0, 0.12, 0)));

        const fireGroup = new THREE.Group();
        fireGroup.position.copy(engineWorld);
        scene.add(fireGroup);
        vehicleRoots.push(fireGroup);

        const outerDarkRedPlanes: THREE.Mesh[] = [];
        const orangeMidSprites: THREE.Sprite[] = [];
        const yellowCoreSprites: THREE.Sprite[] = [];

        // Layer 1: Dark-red/charred outer crossed flame planes (NormalBlending -> zero white bloom wash)
        for (let p = 0; p < 2; p++) {
          const pMat = track(
            new THREE.MeshBasicMaterial({
              map: darkFlameTex,
              color: 0xffffff,
              transparent: true,
              opacity: 0.78,
              blending: THREE.NormalBlending,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
          );
          const mesh = new THREE.Mesh(outerFlameGeo, pMat);
          mesh.position.y = 0.34;
          mesh.rotation.y = cfg.rotY + p * Math.PI * 0.5 + 0.25;
          fireGroup.add(mesh);
          outerDarkRedPlanes.push(mesh);
        }

        // Layer 2: Mid-height vivid orange flame tongues (suppressed moderately by heavy rain)
        for (let k = 0; k < 2; k++) {
          const midMat = track(
            new THREE.SpriteMaterial({
              map: hotFlameTex,
              color: 0xd9480f, // Controlled luminance avoids white bloom blowout
              transparent: true,
              opacity: 0.7,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          const sp = new THREE.Sprite(midMat);
          sp.position.set((k - 0.5) * 0.34, 0.34 + k * 0.06, ((k * 3) % 2 - 0.5) * 0.18);
          sp.scale.set(0.95, 1.15, 1);
          fireGroup.add(sp);
          orangeMidSprites.push(sp);
        }

        // Layer 3: Sheltered interior amber-yellow core inside engine bay (persists under heavy rain)
        for (let k = 0; k < 2; k++) {
          const coreMat = track(
            new THREE.SpriteMaterial({
              map: hotFlameTex,
              color: 0xd97706,
              transparent: true,
              opacity: 0.65,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          const sp = new THREE.Sprite(coreMat);
          sp.position.set((k - 0.5) * 0.24, 0.16, (k - 0.5) * 0.14);
          sp.scale.set(0.7, 0.82, 1);
          fireGroup.add(sp);
          yellowCoreSprites.push(sp);
        }

        const fireLight = new THREE.PointLight(0xff5a14, 17, 20, 1.6);
        fireLight.position.set(0, 1.0, 0);
        fireLight.castShadow = false;
        fireGroup.add(fireLight);

        burningRigs.push({
          worldX: engineWorld.x,
          worldZ: engineWorld.z,
          fireGroup,
          fireLight,
          outerDarkRedPlanes,
          orangeMidSprites,
          yellowCoreSprites,
          phaseOffset: cfg.phase,
        });
      }
    }
  }

  // 4. WRECKED M725 MILITARY AMBULANCES (Replaces basic block-built trucks at exact checkpoint spots)
  // Raw GLB length spans X (front hood at -X, tall ambulance bay at +X), so preRotationY = +PI/2 maps front to +Z.
  const wreckedM725Placements: Array<{ x: number; z: number; rotY: number; phase: number }> = [
    { x: -18.5, z: -16.8, rotY: 0.42, phase: 0.9 },
    { x: 13.5, z: 13.5, rotY: -2.55, phase: 2.3 },
  ];

  const attachM725HazardBeacon = (
    hostGroup: THREE.Group,
    worldX: number,
    worldZ: number,
    roofY: number,
    zOffset: number,
    phase: number,
  ) => {
    const beaconGroup = new THREE.Group();
    beaconGroup.position.set(0, roofY, zOffset);
    hostGroup.add(beaconGroup);

    const redMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        emissive: 0xef4444,
        emissiveIntensity: 2.4,
        roughness: 0.22,
      }),
    );
    const amberMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xf59e0b,
        emissiveIntensity: 2.4,
        roughness: 0.22,
      }),
    );

    const redBeacon = new THREE.Mesh(beaconCylinderGeo, redMat);
    redBeacon.position.set(-0.22, 0, 0);
    beaconGroup.add(redBeacon);

    const amberBeacon = new THREE.Mesh(beaconCylinderGeo, amberMat);
    amberBeacon.position.set(0.22, 0, 0);
    beaconGroup.add(amberBeacon);

    const redSprite = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: redFlareTex,
          color: 0xff6b6b,
          transparent: true,
          opacity: 0.78,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    redSprite.scale.set(1.05, 1.05, 1);
    redSprite.position.copy(redBeacon.position);
    beaconGroup.add(redSprite);

    const amberSprite = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: amberFlareTex,
          color: 0xfbbf24,
          transparent: true,
          opacity: 0.78,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    amberSprite.scale.set(1.05, 1.05, 1);
    amberSprite.position.copy(amberBeacon.position);
    beaconGroup.add(amberSprite);

    const strobeLight = new THREE.PointLight(0xf59e0b, 11, 16, 1.75);
    strobeLight.position.set(0, 0.42, 0);
    strobeLight.castShadow = false;
    beaconGroup.add(strobeLight);

    lightRigs.push({
      kind: 'military',
      worldX,
      worldZ,
      rearWorldX: worldX,
      rearWorldZ: worldZ,
      strobeLight,
      redMat,
      blueOrAmberMat: amberMat,
      redSprite,
      blueOrAmberSprite: amberSprite,
      phaseOffset: phase,
    });
  };

  if (wreckedM725GLTF) {
    const m725Skeleton = hasSkinnedMesh(wreckedM725GLTF.scene);
    for (const cfg of wreckedM725Placements) {
      const { wrapper: m725Amb, meta } = normalizeVehicleInstance(
        wreckedM725GLTF.scene,
        5.65,
        isSoftwareGl,
        currentQuality,
        m725Skeleton,
        polishedMaterials,
        transmissionMats,
        vehicleMeshes,
        Math.PI * 0.5,
        true,
      );
      m725Amb.position.set(cfg.x, 0, cfg.z);
      m725Amb.rotation.y = cfg.rotY;
      scene.add(m725Amb);
      vehicleRoots.push(m725Amb);

      if (meta.parts.length > 0) {
        for (const part of meta.parts) {
          const w = Math.max(0.4, part.width - 0.04);
          const d = Math.max(0.45, part.depth - 0.04);
          const h = Math.max(2.1, part.height);
          // Use crisp OBB for the boxy rear medical bay and capsule for front hood/fenders
          if (part.centerZ <= 0.15 && part.width >= 1.7) {
            newObstacles.push(
              makeObbCollider(cfg.x, cfg.z, w, d, cfg.rotY, h, part.centerX, part.centerZ),
            );
          } else {
            newObstacles.push(
              makeOrientedCapsuleCollider(
                cfg.x,
                cfg.z,
                w,
                d,
                cfg.rotY,
                h,
                part.centerX,
                part.centerZ,
              ),
            );
          }
        }
      } else {
        newObstacles.push(
          makeObbCollider(cfg.x, cfg.z, 2.26, 3.25, cfg.rotY, 2.5, 0, -1.15),
          makeOrientedCapsuleCollider(cfg.x, cfg.z, 2.08, 2.35, cfg.rotY, 2.0, 0, 1.65),
        );
      }

      attachM725HazardBeacon(
        m725Amb,
        cfg.x,
        cfg.z,
        meta.box.max.y + 0.04,
        meta.size.z * 0.06,
        cfg.phase,
      );
    }
  } else {
    // Graceful composite fallback only when external M725 GLB fails to download
    const fbArmorMat = track(
      new THREE.MeshStandardMaterial({ color: 0x2c3627, roughness: 0.56, metalness: 0.35 }),
    );
    const fbShelterMat = track(
      new THREE.MeshStandardMaterial({ color: 0x354030, roughness: 0.52, metalness: 0.32 }),
    );
    const fbTrimMat = track(
      new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: 0.42, metalness: 0.72 }),
    );
    const fbCrossMat = track(
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.55, metalness: 0.15 }),
    );
    const fbTireMat = track(
      new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.88, metalness: 0.08 }),
    );
    const fbTireGeo = track(new THREE.CylinderGeometry(0.41, 0.41, 0.28, 12));
    fbTireGeo.rotateZ(Math.PI * 0.5);

    for (const cfg of wreckedM725Placements) {
      const fbGroup = new THREE.Group();
      fbGroup.position.set(cfg.x, 0, cfg.z);
      fbGroup.rotation.y = cfg.rotY;

      const chassis = new THREE.Mesh(track(new THREE.BoxGeometry(2.14, 0.34, 5.5)), fbTrimMat);
      chassis.position.set(0, 0.52, 0);
      fbGroup.add(chassis);

      const hood = new THREE.Mesh(track(new THREE.BoxGeometry(1.94, 0.86, 1.45)), fbArmorMat);
      hood.position.set(0, 1.08, 2.02);
      fbGroup.add(hood);

      const cab = new THREE.Mesh(track(new THREE.BoxGeometry(2.04, 1.38, 1.28)), fbArmorMat);
      cab.position.set(0, 1.38, 0.74);
      fbGroup.add(cab);

      const shelter = new THREE.Mesh(track(new THREE.BoxGeometry(2.26, 1.82, 3.15)), fbShelterMat);
      shelter.position.set(0, 1.62, -1.24);
      fbGroup.add(shelter);

      const crossStripe = new THREE.Mesh(track(new THREE.BoxGeometry(2.29, 0.32, 0.76)), fbCrossMat);
      crossStripe.position.set(0, 1.68, -1.24);
      fbGroup.add(crossStripe);

      for (const wx of [-1.02, 1.02]) {
        for (const wz of [-1.85, 1.88]) {
          const wheel = new THREE.Mesh(fbTireGeo, fbTireMat);
          wheel.position.set(wx, 0.41, wz);
          fbGroup.add(wheel);
        }
      }

      fbGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.userData.isVehicleMesh = true;
          mesh.userData.isVehicleMetal = true;
          mesh.castShadow = !isSoftwareGl && currentQuality === 'HIGH';
          mesh.receiveShadow = !isSoftwareGl;
          vehicleMeshes.push(mesh);
        }
      });

      scene.add(fbGroup);
      vehicleRoots.push(fbGroup);
      newObstacles.push(
        makeObbCollider(cfg.x, cfg.z, 2.26, 3.18, cfg.rotY, 2.5, 0, -1.24),
        makeOrientedCapsuleCollider(cfg.x, cfg.z, 2.04, 2.55, cfg.rotY, 2.0, 0, 1.52),
      );
      attachM725HazardBeacon(fbGroup, cfg.x, cfg.z, 2.56, 0.12, cfg.phase);
    }
  }

  // 4. Pooled Smoke, Steam, Embers & Rain-Sizzle Sparks (THREE.Points + BufferGeometry)
  const smokePool = createPooledParticleSystem(
    'smoke',
    96,
    smokeEmitters,
    softParticleTex,
    track,
  );
  const steamPool = createPooledParticleSystem(
    'steam',
    76,
    steamEmitters,
    softParticleTex,
    track,
  );
  const emberPool = createPooledParticleSystem(
    'ember',
    58,
    emberEmitters,
    softParticleTex,
    track,
  );
  const sizzlePool = createPooledParticleSystem(
    'sizzle',
    36,
    sizzleEmitters,
    softParticleTex,
    track,
  );

  if (smokeEmitters.length > 0) {
    scene.add(smokePool.points);
    scene.add(steamPool.points);
    scene.add(emberPool.points);
    scene.add(sizzlePool.points);
  }

  let cachedUScale = window.innerHeight * 0.56;

  const applyQuality = (quality: GraphicsQuality, mobilePreview = mobilePreviewMode) => {
    currentQuality = quality;
    mobilePreviewMode = mobilePreview;
    cachedUScale = window.innerHeight * 0.56;
    const targetEnv = mobilePreview ? 0 : quality === 'HIGH' ? 1.0 : quality === 'LOW' ? 0.72 : 0.88;

    for (const mat of polishedMaterials) {
      const std = mat as THREE.MeshStandardMaterial;
      if (typeof std.envMapIntensity === 'number') {
        std.envMapIntensity = targetEnv;
      }
    }

    for (const entry of transmissionMats) {
      if (isSoftwareGl || mobilePreview || quality === 'LOW') {
        entry.mat.transmission = 0;
        entry.mat.transparent = true;
        entry.mat.opacity = 0.42;
      } else {
        entry.mat.transmission = entry.origTransmission;
      }
    }

    for (const root of vehicleRoots) {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.userData.isVehicleMesh && !mesh.userData.isRaycastProxy) {
          mesh.castShadow = !isSoftwareGl && !mobilePreview && quality === 'HIGH';
          mesh.receiveShadow = !isSoftwareGl && !mobilePreview;
        }
      });
    }

    if (mobilePreview) {
      smokePool.activeCount = quality === 'HIGH' ? 24 : 18;
      steamPool.activeCount = quality === 'HIGH' ? 16 : 10;
      emberPool.activeCount = 10;
      sizzlePool.activeCount = 0;
    } else if (quality === 'LOW') {
      smokePool.activeCount = 26;
      steamPool.activeCount = 16;
      emberPool.activeCount = 14;
      sizzlePool.activeCount = 0;
    } else if (quality === 'MED') {
      smokePool.activeCount = 58;
      steamPool.activeCount = 44;
      emberPool.activeCount = 34;
      sizzlePool.activeCount = 18;
    } else {
      smokePool.activeCount = smokePool.maxCount;
      steamPool.activeCount = steamPool.maxCount;
      emberPool.activeCount = emberPool.maxCount;
      sizzlePool.activeCount = sizzlePool.maxCount;
    }

    const pointLightsOn = !isSoftwareGl && !mobilePreview && quality !== 'LOW';
    for (const rig of lightRigs) {
      rig.strobeLight.visible = pointLightsOn;
      if (!pointLightsOn) rig.strobeLight.intensity = 0;
      if (rig.rearGlowLight) {
        rig.rearGlowLight.visible = pointLightsOn;
        if (!pointLightsOn) rig.rearGlowLight.intensity = 0;
      }
    }

    for (const bRig of burningRigs) {
      bRig.fireLight.visible = pointLightsOn;
      if (!pointLightsOn) bRig.fireLight.intensity = 0;
      for (let i = 0; i < bRig.outerDarkRedPlanes.length; i++) {
        bRig.outerDarkRedPlanes[i].visible = (!mobilePreview && quality !== 'LOW') || i === 0;
      }
      for (let i = 0; i < bRig.orangeMidSprites.length; i++) {
        bRig.orangeMidSprites[i].visible = (!mobilePreview && quality !== 'LOW') || i === 0;
      }
      for (let i = 0; i < bRig.yellowCoreSprites.length; i++) {
        bRig.yellowCoreSprites[i].visible = (!mobilePreview && quality === 'HIGH') || i === 0;
      }
    }
  };

  applyQuality(initialQuality, mobilePreviewMode);

  const update = (
    dt: number,
    nowMs: number,
    stormIntensity = 0.35,
    cameraPos?: THREE.Vector3,
  ) => {
    const t = nowMs * 0.001;
    const camX = cameraPos ? cameraPos.x : 0;
    const camZ = cameraPos ? cameraPos.z : 6;
    const maxLightDistSq =
      mobilePreviewMode || currentQuality === 'LOW' ? 0 : currentQuality === 'HIGH' ? 38 * 38 : 27 * 27;

    // 1. Animate Ambulance Lightbars (1 alternating PointLight per vehicle + distance activation)
    for (const rig of lightRigs) {
      const lt = t + rig.phaseOffset;
      const dx = rig.worldX - camX;
      const dz = rig.worldZ - camZ;
      const distSq = dx * dx + dz * dz;
      const lightAllowed =
        !isSoftwareGl && !mobilePreviewMode && currentQuality !== 'LOW' && distSq <= maxLightDistSq;

      if (rig.kind === 'civilian') {
        const cycle = (lt * 2.4) % 2.0;
        const redSideActive = cycle < 1.0;
        const redStrobe = redSideActive
          ? Math.sin(cycle * Math.PI * 3.5) > 0
            ? 1.0
            : 0.16
          : 0.06;
        const blueStrobe = !redSideActive
          ? Math.sin((cycle - 1.0) * Math.PI * 3.5) > 0
            ? 1.0
            : 0.16
          : 0.06;
        const sweep = 0.72 + 0.28 * Math.sin(lt * 5.2);
        const rPow = redStrobe * sweep;
        const bPow = blueStrobe * sweep;

        rig.redMat.emissiveIntensity = 0.25 + rPow * 3.8;
        rig.blueOrAmberMat.emissiveIntensity = 0.25 + bPow * 3.8;
        (rig.redSprite.material as THREE.SpriteMaterial).opacity = 0.12 + rPow * 0.85;
        (rig.blueOrAmberSprite.material as THREE.SpriteMaterial).opacity = 0.12 + bPow * 0.85;
        rig.redSprite.scale.setScalar(0.72 + rPow * 0.9);
        rig.blueOrAmberSprite.scale.setScalar(0.72 + bPow * 0.9);

        if (lightAllowed) {
          const distFade = Math.max(0, 1 - distSq / maxLightDistSq);
          if (rPow >= bPow) {
            rig.strobeLight.color.copy(_redColor);
            rig.strobeLight.position.x = -0.35;
            rig.strobeLight.intensity = rPow * 20 * (0.45 + 0.55 * distFade);
          } else {
            rig.strobeLight.color.copy(_blueColor);
            rig.strobeLight.position.x = 0.35;
            rig.strobeLight.intensity = bPow * 20 * (0.45 + 0.55 * distFade);
          }
        } else {
          rig.strobeLight.intensity = 0;
        }
      } else {
        const powerDip =
          Math.sin(lt * 1.7) * Math.sin(lt * 4.9) * Math.cos(lt * 11.3) > 0.64 ? 0.08 : 1.0;
        const flicker = 0.68 + 0.32 * Math.sin(lt * 29.0) * Math.cos(lt * 17.0);
        const alt = (lt * 3.1) % 2.0;
        const redOn = alt < 1.0 ? 1.0 : 0.14;
        const amberOn = alt >= 0.85 ? 1.0 : 0.18;
        const rPow = redOn * flicker * powerDip;
        const aPow = amberOn * flicker * powerDip;

        rig.redMat.emissiveIntensity = 0.15 + rPow * 3.4;
        rig.blueOrAmberMat.emissiveIntensity = 0.15 + aPow * 3.4;
        (rig.redSprite.material as THREE.SpriteMaterial).opacity = 0.08 + rPow * 0.8;
        (rig.blueOrAmberSprite.material as THREE.SpriteMaterial).opacity = 0.08 + aPow * 0.8;
        rig.redSprite.scale.setScalar(0.65 + rPow * 0.74);
        rig.blueOrAmberSprite.scale.setScalar(0.65 + aPow * 0.74);

        if (lightAllowed) {
          rig.strobeLight.color.copy(rPow >= aPow ? _redColor : _amberColor);
          rig.strobeLight.intensity = Math.max(rPow, aPow) * 16;
        } else {
          rig.strobeLight.intensity = 0;
        }

        if (rig.rearGlowLight) {
          const rdx = rig.rearWorldX - camX;
          const rdz = rig.rearWorldZ - camZ;
          const nearRear =
            !isSoftwareGl &&
            !mobilePreviewMode &&
            currentQuality !== 'LOW' &&
            rdx * rdx + rdz * rdz <= 16 * 16;
          rig.rearGlowLight.intensity = nearRear ? (4.5 + aPow * 3.5) * powerDip : 0;
        }
      }
    }

    // 2. Rain-Reactive Engine Fire Animation (flickering, fuel surges, rain suppression, wind lean)
    const rainSuppression = THREE.MathUtils.clamp(stormIntensity * 0.36, 0, 0.36);
    const windLeanX = 0.06 + stormIntensity * 0.22;

    for (const bRig of burningRigs) {
      const bt = t + bRig.phaseOffset;

      // Occasional fuel weaken & recover oscillation + irregular chaotic flicker
      const fuelSurge = 0.8 + 0.24 * Math.sin(bt * 0.67) * Math.cos(bt * 1.23);
      const fireFlicker =
        0.72 +
        0.16 * Math.sin(bt * 13.7) +
        0.11 * Math.cos(bt * 27.3) +
        0.07 * Math.sin(bt * 41.1);
      const energy = THREE.MathUtils.clamp(fuelSurge * fireFlicker, 0.42, 1.15);

      const dx = bRig.worldX - camX;
      const dz = bRig.worldZ - camZ;
      const distSq = dx * dx + dz * dz;
      const fireLightOn =
        !isSoftwareGl &&
        !mobilePreviewMode &&
        currentQuality !== 'LOW' &&
        distSq <= maxLightDistSq;

      if (fireLightOn) {
        const distFade = Math.max(0.35, 1 - distSq / maxLightDistSq);
        bRig.fireLight.color.copy(_fireColor);
        bRig.fireLight.intensity = 15.5 * energy * (1.0 - rainSuppression * 0.32) * distFade;
      } else {
        bRig.fireLight.intensity = 0;
      }

      // Layer 1: Dark-red outer flames lean with rain squall and dip during gusts
      for (let i = 0; i < bRig.outerDarkRedPlanes.length; i++) {
        const mesh = bRig.outerDarkRedPlanes[i];
        if (!mesh.visible) continue;
        const phase = bt * (8.4 + i * 2.7);
        const hScale = (0.86 + Math.cos(phase * 1.2) * 0.22) * energy * (1.0 - rainSuppression * 0.45);
        mesh.scale.set(0.95 + Math.sin(phase) * 0.14, Math.max(0.48, hScale), 1);
        mesh.rotation.z = -windLeanX + Math.sin(phase * 0.9) * 0.08;
        (mesh.material as THREE.MeshBasicMaterial).opacity =
          THREE.MathUtils.clamp(0.68 * energy * (1.0 - rainSuppression * 0.28), 0.3, 0.82);
      }

      // Layer 2: Mid orange exposed tongues compress noticeably in heavy rain
      for (let i = 0; i < bRig.orangeMidSprites.length; i++) {
        const sp = bRig.orangeMidSprites[i];
        if (!sp.visible) continue;
        const phase = bt * (10.2 + i * 2.5) + i * 1.4;
        const sX = 0.82 + Math.sin(phase) * 0.14;
        const sY =
          (0.98 + Math.cos(phase * 1.3) * 0.24) * energy * (1.0 - rainSuppression * 0.52);
        sp.scale.set(sX, Math.max(0.45, sY), 1);
        const mat = sp.material as THREE.SpriteMaterial;
        mat.rotation = -windLeanX * 0.65 + Math.sin(phase * 0.7) * 0.2;
        mat.opacity = THREE.MathUtils.clamp(0.62 * energy * (1.0 - rainSuppression * 0.35), 0.24, 0.75);
      }

      // Layer 3: Deep sheltered yellow-amber core stays alive inside hood despite rainfall
      for (let i = 0; i < bRig.yellowCoreSprites.length; i++) {
        const sp = bRig.yellowCoreSprites[i];
        if (!sp.visible) continue;
        const phase = bt * (11.8 + i * 2.1) + i * 1.9;
        const sX = 0.66 + Math.cos(phase) * 0.12;
        const sY = (0.78 + Math.sin(phase * 1.4) * 0.18) * (0.85 + 0.15 * energy);
        sp.scale.set(sX, Math.max(0.42, sY), 1);
        const mat = sp.material as THREE.SpriteMaterial;
        mat.rotation = Math.cos(phase * 0.6) * 0.18;
        mat.opacity = 0.55 + Math.sin(phase * 1.5) * 0.12;
      }
    }

    // 3. Update Pooled Smoke, Hood Steam, Embers & Rain-Sizzle Sparks
    updatePooledParticles(smokePool, dt, t, stormIntensity, cachedUScale);
    updatePooledParticles(steamPool, dt, t, stormIntensity, cachedUScale);
    updatePooledParticles(emberPool, dt, t, stormIntensity, cachedUScale);
    updatePooledParticles(sizzlePool, dt, t, stormIntensity, cachedUScale);
  };

  const dispose = () => {
    for (const root of vehicleRoots) {
      scene.remove(root);
    }
    scene.remove(smokePool.points);
    scene.remove(steamPool.points);
    scene.remove(emberPool.points);
    scene.remove(sizzlePool.points);

    const geoSet = new Set<THREE.BufferGeometry>();
    const texSet = new Set<THREE.Texture>();
    const matSet = new Set<THREE.Material>();

    for (const root of vehicleRoots) {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          if (mesh.geometry) geoSet.add(mesh.geometry);
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (!m || m === SHARED_VEHICLE_PROXY_MAT) continue;
            matSet.add(m);
            const rec = m as unknown as Record<string, unknown>;
            for (const key of [
              'map',
              'normalMap',
              'roughnessMap',
              'metalnessMap',
              'emissiveMap',
              'aoMap',
              'bumpMap',
            ]) {
              const maybeTex = rec[key] as THREE.Texture | undefined;
              if (maybeTex && maybeTex.isTexture) {
                texSet.add(maybeTex);
              }
            }
          }
        }
      });
    }

    for (const g of geoSet) g.dispose();
    for (const t of texSet) t.dispose();
    for (const m of matSet) m.dispose();
    for (const d of disposables) d.dispose();
  };

  return {
    vehicleMeshes,
    newObstacles,
    milAmbRearMedkitPos,
    update,
    setQuality: applyQuality,
    dispose,
  };
}
