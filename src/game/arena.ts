import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  makeCircleCollider,
  makeObbCollider,
  type Collider,
} from './colliders';
import type { GraphicsQuality } from './types';

export interface ArenaResult {
  arenaHalfSize: number;
  obstacles: Collider[];
  beacons: THREE.Mesh[];
  spawnPoints: THREE.Vector3[];
  skyDomeMat: THREE.MeshBasicMaterial;
  updateAtmosphere: (
    dt: number,
    nowMs: number,
    cameraPos?: THREE.Vector3,
    quality?: GraphicsQuality,
  ) => void;
  setGroundWetness: (wetness: number) => void;
  setCheckpointPower: (enabled: boolean) => void;
  setQuality: (quality: GraphicsQuality, mobilePreview?: boolean) => void;
  dispose: () => void;
}

interface TextureSet {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  renderer: THREE.WebGLRenderer,
  isColor: boolean,
  repeatX: number,
  repeatY: number,
  isMobilePreview = false,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (isColor) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = isMobilePreview ? 1 : renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function createAsphaltTextures(renderer: THREE.WebGLRenderer, isMobilePreview = false): TextureSet {
  const size = isMobilePreview ? 256 : 512;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rCtx = roughCanvas.getContext('2d')!;

  cCtx.fillStyle = '#1e2530';
  cCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#e6e6e6'; // ~0.90 damp rough asphalt baseline
  rCtx.fillRect(0, 0, size, size);

  // Asphalt aggregate & coarse grit
  for (let i = 0; i < 9500; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const s = 1 + (Math.random() > 0.8 ? 2 : 1);
    const v = 14 + Math.floor(Math.random() * 26);
    cCtx.fillStyle = `rgb(${v}, ${v + 4}, ${v + 9})`;
    cCtx.fillRect(x, y, s, s);

    const bv = 96 + Math.floor(Math.random() * 68);
    bCtx.fillStyle = `rgb(${bv}, ${bv}, ${bv})`;
    bCtx.fillRect(x, y, s, s);
  }

  // Organic multi-lobe rain puddles (glossy dark albedo + mirror-low roughness)
  for (let i = 0; i < 18; i++) {
    const px = Math.random() * size;
    const py = Math.random() * size;
    const lobes = 2 + Math.floor(Math.random() * 3);
    for (let l = 0; l < lobes; l++) {
      const lx = px + (Math.random() - 0.5) * 42;
      const ly = py + (Math.random() - 0.5) * 34;
      const r = 22 + Math.random() * 48;

      const cGrad = cCtx.createRadialGradient(lx, ly, 4, lx, ly, r);
      cGrad.addColorStop(0, 'rgba(4, 8, 15, 0.62)');
      cGrad.addColorStop(0.75, 'rgba(7, 11, 18, 0.34)');
      cGrad.addColorStop(1, 'rgba(7, 11, 18, 0)');
      cCtx.fillStyle = cGrad;
      cCtx.beginPath();
      cCtx.arc(lx, ly, r, 0, Math.PI * 2);
      cCtx.fill();

      const rGrad = rCtx.createRadialGradient(lx, ly, 4, lx, ly, r);
      rGrad.addColorStop(0, 'rgba(18, 18, 18, 0.96)'); // ~0.07 glossy wet puddle reflection
      rGrad.addColorStop(0.65, 'rgba(60, 60, 60, 0.72)');
      rGrad.addColorStop(1, 'rgba(230, 230, 230, 0)');
      rCtx.fillStyle = rGrad;
      rCtx.beginPath();
      rCtx.arc(lx, ly, r, 0, Math.PI * 2);
      rCtx.fill();

      // Flatten bump slightly inside water puddles
      const bGrad = bCtx.createRadialGradient(lx, ly, 2, lx, ly, r);
      bGrad.addColorStop(0, 'rgba(128, 128, 128, 0.85)');
      bGrad.addColorStop(1, 'rgba(128, 128, 128, 0)');
      bCtx.fillStyle = bGrad;
      bCtx.beginPath();
      bCtx.arc(lx, ly, r, 0, Math.PI * 2);
      bCtx.fill();
    }
  }

  // Faded weathered double-yellow center road markings
  cCtx.fillStyle = 'rgba(217, 154, 16, 0.35)';
  for (const ry of [18, 188, 358]) {
    cCtx.fillRect(245, ry, 7, 108);
    cCtx.fillRect(260, ry, 7, 108);
  }
  cCtx.fillStyle = 'rgba(18, 23, 32, 0.58)';
  for (let s = 0; s < 14; s++) {
    cCtx.fillRect(240 + Math.random() * 32, Math.random() * size, 28, 3 + Math.random() * 7);
  }

  // Branching asphalt cracks
  for (let c = 0; c < 22; c++) {
    let cx = Math.random() * size;
    let cy = Math.random() * size;
    let angle = Math.random() * Math.PI * 2;
    cCtx.strokeStyle = 'rgba(3, 5, 9, 0.9)';
    cCtx.lineWidth = 1.6;
    bCtx.strokeStyle = '#181818';
    bCtx.lineWidth = 2.2;

    cCtx.beginPath();
    bCtx.beginPath();
    cCtx.moveTo(cx, cy);
    bCtx.moveTo(cx, cy);
    const segs = 6 + Math.floor(Math.random() * 9);
    for (let s = 0; s < segs; s++) {
      angle += (Math.random() - 0.5) * 0.9;
      cx += Math.cos(angle) * (10 + Math.random() * 14);
      cy += Math.sin(angle) * (10 + Math.random() * 14);
      cCtx.lineTo(cx, cy);
      bCtx.lineTo(cx, cy);
    }
    cCtx.stroke();
    bCtx.stroke();
  }

  return {
    map: finalizeTexture(colorCanvas, renderer, true, 14, 14, isMobilePreview),
    bumpMap: finalizeTexture(bumpCanvas, renderer, false, 14, 14, isMobilePreview),
    roughnessMap: finalizeTexture(roughCanvas, renderer, false, 14, 14, isMobilePreview),
  };
}

function createBrickConcreteTextures(
  renderer: THREE.WebGLRenderer,
  isMobilePreview = false,
): TextureSet {
  const size = isMobilePreview ? 256 : 512;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  cCtx.fillStyle = '#2a2e36';
  cCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#484848';
  bCtx.fillRect(0, 0, size, size);

  const brickH = 24;
  const brickW = 64;
  for (let row = 0; row < size / brickH; row++) {
    const y = row * brickH;
    const offset = (row % 2) * (brickW * 0.5);
    for (let col = -1; col <= size / brickW; col++) {
      const x = col * brickW + offset;
      const shade = 42 + Math.floor(Math.random() * 26);
      const warm = Math.floor(Math.random() * 15);
      cCtx.fillStyle = `rgb(${shade + warm}, ${shade + Math.floor(warm * 0.5)}, ${shade - 4})`;
      cCtx.fillRect(x + 2, y + 2, brickW - 4, brickH - 4);

      const bv = 135 + Math.floor(Math.random() * 55);
      bCtx.fillStyle = `rgb(${bv}, ${bv}, ${bv})`;
      bCtx.fillRect(x + 2, y + 2, brickW - 4, brickH - 4);
    }
  }

  for (let p = 0; p < 16; p++) {
    const px = Math.random() * size;
    const py = Math.random() * size;
    cCtx.fillStyle = 'rgba(71, 80, 92, 0.36)';
    cCtx.fillRect(px, py, 24 + Math.random() * 56, 18 + Math.random() * 44);
  }

  for (let i = 0; i < 48; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 8 + Math.random() * 26;
    const h = 30 + Math.random() * 110;
    const grad = cCtx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, 'rgba(8, 10, 14, 0.48)');
    grad.addColorStop(1, 'rgba(8, 10, 14, 0)');
    cCtx.fillStyle = grad;
    cCtx.fillRect(x, y, w, h);
  }

  return {
    map: finalizeTexture(colorCanvas, renderer, true, 3, 2, isMobilePreview),
    bumpMap: finalizeTexture(bumpCanvas, renderer, false, 3, 2, isMobilePreview),
  };
}

function createCorrugatedMetalTextures(
  renderer: THREE.WebGLRenderer,
  baseHex: string,
  rustTint: string,
): TextureSet {
  const size = 256;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  cCtx.fillStyle = baseHex;
  cCtx.fillRect(0, 0, size, size);

  const ribWidth = 16;
  for (let x = 0; x < size; x += ribWidth) {
    const grad = cCtx.createLinearGradient(x, 0, x + ribWidth, 0);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.35)');
    grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.08)');
    grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.12)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.38)');
    cCtx.fillStyle = grad;
    cCtx.fillRect(x, 0, ribWidth, size);

    const bGrad = bCtx.createLinearGradient(x, 0, x + ribWidth, 0);
    bGrad.addColorStop(0, '#3a3a3a');
    bGrad.addColorStop(0.5, '#e8e8e8');
    bGrad.addColorStop(1, '#3a3a3a');
    bCtx.fillStyle = bGrad;
    bCtx.fillRect(x, 0, ribWidth, size);
  }

  for (let i = 0; i < 70; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    cCtx.fillStyle = rustTint;
    cCtx.fillRect(x, y, 3 + Math.random() * 14, 2 + Math.random() * 16);
  }

  return {
    map: finalizeTexture(colorCanvas, renderer, true, 2, 1),
    bumpMap: finalizeTexture(bumpCanvas, renderer, false, 2, 1),
  };
}

function createHazardStripeTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, 256, 64);

  ctx.fillStyle = '#d97706';
  for (let x = -64; x < 320; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 64);
    ctx.lineTo(x + 16, 64);
    ctx.lineTo(x + 48, 0);
    ctx.lineTo(x + 32, 0);
    ctx.closePath();
    ctx.fill();
  }

  return finalizeTexture(canvas, renderer, true, 3, 1);
}

function createCheckpointBannerTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, 1024, 192);

  // Top & bottom hazard trim
  ctx.fillStyle = '#b45309';
  for (let x = -32; x < 1056; x += 36) {
    ctx.fillRect(x, 0, 18, 22);
    ctx.fillRect(x + 12, 170, 18, 22);
  }

  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 30, 988, 132);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 58px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('QUARANTINE SECTOR OMEGA', 512, 82);

  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 28px monospace';
  ctx.fillText('BIO-CONTAINMENT CHECKPOINT · LETHAL FORCE AUTHORIZED', 512, 134);

  // Grime weathering
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(Math.random() * 1024, Math.random() * 192, 6 + Math.random() * 28, 3 + Math.random() * 14);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function createNeonSignTexture(
  renderer: THREE.WebGLRenderer,
  label: string,
  primaryHex: string,
  glowHex: string,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, 512, 128);

  ctx.strokeStyle = primaryHex;
  ctx.lineWidth = 6;
  ctx.shadowColor = glowHex;
  ctx.shadowBlur = 18;
  ctx.strokeRect(10, 10, 492, 108);

  ctx.fillStyle = primaryHex;
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 66);

  // Broken dark dead-letter cutout streak
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(5, 7, 11, 0.72)';
  ctx.fillRect(290, 22, 46, 86);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function createVolumetricBeamTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.55)');
  grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.22)');
  grad.addColorStop(0.75, 'rgba(255, 255, 255, 0.05)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 256);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSteamPuffTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(134, 239, 172, 0.65)');
  grad.addColorStop(0.5, 'rgba(74, 222, 128, 0.25)');
  grad.addColorStop(1, 'rgba(22, 101, 52, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createOvercastSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#7c91a6');
  grad.addColorStop(0.42, '#9fb1c2');
  grad.addColorStop(0.74, '#c2cfd9');
  grad.addColorStop(1.0, '#aebcc9');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  for (let i = 0; i < 65; i++) {
    const x = Math.random() * 512;
    const y = 26 + Math.random() * 145;
    const rx = 38 + Math.random() * 90;
    const ry = 12 + Math.random() * 28;
    const cGrad = ctx.createRadialGradient(x, y, 2, x, y, rx);
    const bright = Math.random() > 0.45 ? 'rgba(236, 242, 248, 0.32)' : 'rgba(110, 126, 144, 0.22)';
    cGrad.addColorStop(0, bright);
    cGrad.addColorStop(1, 'rgba(159, 177, 194, 0)');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.fillStyle = cGrad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildQuarantineArena(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  isMobilePreview = false,
): ArenaResult {
  const arenaHalfSize = 28;
  const obstacles: Collider[] = [];
  const beacons: THREE.Mesh[] = [];
  const volumetricCones: THREE.Mesh[] = [];
  const checkpointCones: THREE.Mesh[] = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const arenaTextures: THREE.CanvasTexture[] = [];
  const staticBatchGroup = new THREE.Group();
  const arenaLights: Array<{
    light: THREE.PointLight;
    x: number;
    z: number;
    baseIntensity: number;
    kind: 'checkpoint' | 'street' | 'flare';
    subIndex: number;
  }> = [];
  const mergedShadowCasters: THREE.Mesh[] = [];
  let activeQuality: GraphicsQuality = 'MED';
  let checkpointPowerOn = true;
  let lastWetnessApplied = -1;

  const track = <T extends { dispose: () => void }>(res: T): T => {
    disposables.push(res);
    return res;
  };
  const trackArenaTex = (tex: THREE.CanvasTexture): THREE.CanvasTexture => {
    arenaTextures.push(tex);
    return track(tex);
  };

  // 1. Procedural PBR Textures & Sky Dome
  const asphaltTex = createAsphaltTextures(renderer, isMobilePreview);
  const brickTex = createBrickConcreteTextures(renderer, isMobilePreview);
  const oliveMetalTex = createCorrugatedMetalTextures(renderer, '#243429', 'rgba(108, 56, 26, 0.35)');
  const rustMetalTex = createCorrugatedMetalTextures(renderer, '#4a2b20', 'rgba(130, 62, 24, 0.45)');
  const hazardMap = createHazardStripeTexture(renderer);
  const bannerMap = createCheckpointBannerTexture(renderer);
  const beamMap = createVolumetricBeamTexture();
  const steamMap = createSteamPuffTexture();
  const skyMap = createOvercastSkyTexture();

  trackArenaTex(asphaltTex.map);
  trackArenaTex(asphaltTex.bumpMap);
  if (asphaltTex.roughnessMap) trackArenaTex(asphaltTex.roughnessMap);
  trackArenaTex(brickTex.map);
  trackArenaTex(brickTex.bumpMap);
  trackArenaTex(oliveMetalTex.map);
  trackArenaTex(oliveMetalTex.bumpMap);
  trackArenaTex(rustMetalTex.map);
  trackArenaTex(rustMetalTex.bumpMap);
  trackArenaTex(hazardMap);
  trackArenaTex(bannerMap);
  track(beamMap);
  track(steamMap);
  track(skyMap);

  const skyDomeMat = track(
    new THREE.MeshBasicMaterial({ map: skyMap, side: THREE.BackSide, fog: false }),
  );
  const skyDome = new THREE.Mesh(track(new THREE.SphereGeometry(135, 24, 16)), skyDomeMat);
  skyDome.userData.noBulletRaycast = true;
  scene.add(skyDome);

  // Rain-slicked asphalt with crisp envMap puddle reflections (modulated dynamically by groundWetness)
  const groundMat = track(
    new THREE.MeshStandardMaterial({
      map: asphaltTex.map,
      bumpMap: asphaltTex.bumpMap,
      bumpScale: 0.048,
      roughnessMap: asphaltTex.roughnessMap,
      roughness: 1.0,
      metalness: 0.12,
      envMapIntensity: isMobilePreview ? 0 : 0.85,
    }),
  );
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(190, 190)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.castShadow = false;
  ground.receiveShadow = false;
  scene.add(ground);

  // Standing rainwater puddle zones (low roughness 0.12 + overcast sky reflection tint)
  const puddleMat = track(
    new THREE.MeshStandardMaterial({
      color: isMobilePreview ? 0x526578 : 0x354556,
      roughness: 0.12,
      metalness: 0.24,
      envMapIntensity: isMobilePreview ? 0 : 1.0,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    }),
  );
  const puddleGeo = track(new THREE.CircleGeometry(1, 20));
  puddleGeo.rotateX(-Math.PI * 0.5);
  const puddleSpots: Array<[number, number, number, number, number]> = [
    [-2.0, -2.0, 2.8, 2.0, 0.3],
    [4.2, 8.8, 3.1, 2.1, -0.5],
    [-8.4, 4.2, 2.5, 1.8, 0.9],
    [8.6, -4.5, 2.9, 2.2, -0.2],
    [0.4, -12.8, 3.6, 2.2, 0.15],
    [-12.2, -11.5, 2.7, 1.9, 0.6],
    [12.0, 11.6, 2.8, 2.0, -0.4],
  ];
  for (const [px, pz, sx, sz, ry] of puddleSpots) {
    const puddle = new THREE.Mesh(puddleGeo, puddleMat);
    puddle.position.set(px, 0.008, pz);
    puddle.scale.set(sx, 1, sz);
    puddle.rotation.y = ry;
    puddle.receiveShadow = false;
    puddle.userData.noBulletRaycast = true;
    scene.add(puddle);
  }

  // Shared Material Pool
  const brickConcreteMat = track(
    new THREE.MeshStandardMaterial({
      map: brickTex.map,
      bumpMap: brickTex.bumpMap,
      bumpScale: 0.06,
      roughness: 0.9,
      metalness: 0.08,
    }),
  );
  const sidewalkMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x3b424d,
      bumpMap: asphaltTex.bumpMap,
      bumpScale: 0.025,
      roughness: 0.88,
      metalness: 0.06,
    }),
  );
  const concreteBarrierMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x475569,
      bumpMap: brickTex.bumpMap,
      bumpScale: 0.03,
      roughness: 0.86,
      metalness: 0.08,
    }),
  );
  const curbInstancedMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.88,
      metalness: 0.06,
    }),
  );
  const rubbleInstancedMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.08,
    }),
  );
  const oliveContainerMat = track(
    new THREE.MeshStandardMaterial({
      map: oliveMetalTex.map,
      bumpMap: oliveMetalTex.bumpMap,
      bumpScale: 0.05,
      roughness: 0.56,
      metalness: 0.55,
    }),
  );
  const rustContainerMat = track(
    new THREE.MeshStandardMaterial({
      map: rustMetalTex.map,
      bumpMap: rustMetalTex.bumpMap,
      bumpScale: 0.055,
      roughness: 0.62,
      metalness: 0.58,
    }),
  );
  const militaryArmorMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x2b3628,
      bumpMap: oliveMetalTex.bumpMap,
      bumpScale: 0.03,
      roughness: 0.68,
      metalness: 0.4,
    }),
  );
  const biohazardGlowMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x15803d,
      emissive: 0x22c55e,
      emissiveIntensity: 1.7,
      roughness: 0.28,
      metalness: 0.2,
    }),
  );
  const hazardMat = track(
    new THREE.MeshStandardMaterial({
      map: hazardMap,
      roughness: 0.5,
      metalness: 0.25,
    }),
  );
  const darkIronMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.36,
      metalness: 0.85,
    }),
  );
  const windowDarkMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x05070b,
      roughness: 0.16,
      metalness: 0.72,
    }),
  );
  const windowEmberMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x451a03,
      emissive: 0xd97706,
      emissiveIntensity: 0.55,
      roughness: 0.25,
      metalness: 0.4,
    }),
  );

  // Helper scratch objects for InstancedMesh matrix batching
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();

  // 2. Raised Concrete Sidewalks + Instanced Beveled Curbs + Instanced Rubble/Debris
  const walkWidth = 3.2;
  const walkOffset = arenaHalfSize + walkWidth * 0.5;
  const sidewalkSegments: Array<[number, number, number, number]> = [
    [0, -walkOffset, arenaHalfSize * 2 + walkWidth * 2, walkWidth],
    [0, walkOffset, arenaHalfSize * 2 + walkWidth * 2, walkWidth],
    [-walkOffset, 0, walkWidth, arenaHalfSize * 2],
    [walkOffset, 0, walkWidth, arenaHalfSize * 2],
  ];
  for (const [sx, sz, sw, sd] of sidewalkSegments) {
    const slab = new THREE.Mesh(track(new THREE.BoxGeometry(sw, 0.24, sd)), sidewalkMat);
    slab.position.set(sx, 0.12, sz);
    staticBatchGroup.add(slab);
  }

  // Instanced concrete curb blocks framing the street perimeter & sidewalk edges
  const curbTransforms: Array<{ x: number; y: number; z: number; ry: number; shade: number }> = [];
  for (let i = -26; i <= 26; i += 2.6) {
    curbTransforms.push({ x: -27.7, y: 0.15, z: i, ry: Math.PI * 0.5, shade: 0.9 + Math.random() * 0.2 });
    curbTransforms.push({ x: 27.7, y: 0.15, z: i, ry: Math.PI * 0.5, shade: 0.9 + Math.random() * 0.2 });
    curbTransforms.push({ x: i, y: 0.15, z: -27.7, ry: 0, shade: 0.9 + Math.random() * 0.2 });
    curbTransforms.push({ x: i, y: 0.15, z: 27.7, ry: 0, shade: 0.9 + Math.random() * 0.2 });
  }
  const curbGeo = track(new THREE.BoxGeometry(2.35, 0.3, 0.36));
  const curbInstanced = new THREE.InstancedMesh(curbGeo, curbInstancedMat, curbTransforms.length);
  curbTransforms.forEach((c, idx) => {
    dummy.position.set(c.x, c.y, c.z);
    dummy.rotation.set(0, c.ry, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(idx, dummy.matrix);
    tmpColor.setRGB(0.45 * c.shade, 0.5 * c.shade, 0.56 * c.shade);
    curbInstanced.setColorAt(idx, tmpColor);
  });
  curbInstanced.instanceMatrix.needsUpdate = true;
  if (curbInstanced.instanceColor) curbInstanced.instanceColor.needsUpdate = true;
  curbInstanced.computeBoundingSphere();
  curbInstanced.userData.noBulletRaycast = true;
  scene.add(curbInstanced);

  // Instanced scattered concrete rubble & debris chunks around street curbs & ruins
  const rubbleCount = 110;
  const rubbleGeo = track(new THREE.DodecahedronGeometry(0.28, 0));
  const rubbleInstanced = new THREE.InstancedMesh(rubbleGeo, rubbleInstancedMat, rubbleCount);
  for (let i = 0; i < rubbleCount; i++) {
    const edgeCluster = i % 4;
    let rx = 0;
    let rz = 0;
    if (edgeCluster === 0) {
      rx = (Math.random() - 0.5) * 52;
      rz = -26.5 + (Math.random() - 0.5) * 3.5;
    } else if (edgeCluster === 1) {
      rx = (Math.random() - 0.5) * 52;
      rz = 26.5 + (Math.random() - 0.5) * 3.5;
    } else if (edgeCluster === 2) {
      rx = -26.2 + (Math.random() - 0.5) * 3.5;
      rz = (Math.random() - 0.5) * 50;
    } else {
      rx = 26.2 + (Math.random() - 0.5) * 3.5;
      rz = (Math.random() - 0.5) * 50;
    }
    const sx = 0.55 + Math.random() * 1.15;
    const sy = 0.3 + Math.random() * 0.55;
    const sz = 0.55 + Math.random() * 1.15;
    dummy.position.set(rx, sy * 0.14, rz);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    rubbleInstanced.setMatrixAt(i, dummy.matrix);
    const v = 0.18 + Math.random() * 0.18;
    tmpColor.setRGB(v, v * 1.02, v * 1.08);
    rubbleInstanced.setColorAt(i, tmpColor);
  }
  rubbleInstanced.instanceMatrix.needsUpdate = true;
  if (rubbleInstanced.instanceColor) rubbleInstanced.instanceColor.needsUpdate = true;
  rubbleInstanced.computeBoundingSphere();
  rubbleInstanced.userData.noBulletRaycast = true;
  scene.add(rubbleInstanced);

  // 3. Multi-Story Ruined Cityscape + Instanced Windows + Broken Neon Storefront Signs
  const darkWindowMatrices: THREE.Matrix4[] = [];
  const litWindowMatrices: THREE.Matrix4[] = [];

  const buildingSpecs: Array<{
    x: number;
    z: number;
    w: number;
    d: number;
    h: number;
    rotY: number;
    litWindows: boolean;
    hasWaterTower?: boolean;
  }> = [
    { x: -27, z: -38, w: 15, d: 12, h: 21, rotY: 0.04, litWindows: true, hasWaterTower: true },
    { x: -8, z: -40, w: 16, d: 14, h: 26, rotY: -0.02, litWindows: false },
    { x: 10, z: -38, w: 14, d: 12, h: 18, rotY: 0.03, litWindows: true, hasWaterTower: true },
    { x: 28, z: -39, w: 16, d: 13, h: 23, rotY: -0.05, litWindows: false },
    { x: -26, z: 39, w: 15, d: 12, h: 19, rotY: -0.03, litWindows: false },
    { x: -6, z: 40, w: 17, d: 13, h: 24, rotY: 0.02, litWindows: true, hasWaterTower: true },
    { x: 12, z: 38, w: 14, d: 12, h: 16, rotY: -0.04, litWindows: false },
    { x: 28, z: 40, w: 15, d: 14, h: 22, rotY: 0.05, litWindows: true },
    { x: -39, z: -20, w: 13, d: 16, h: 20, rotY: 0.02, litWindows: false },
    { x: -40, z: 0, w: 14, d: 18, h: 25, rotY: -0.03, litWindows: true, hasWaterTower: true },
    { x: -38, z: 20, w: 12, d: 15, h: 17, rotY: 0.04, litWindows: false },
    { x: 39, z: -20, w: 13, d: 16, h: 22, rotY: -0.02, litWindows: true },
    { x: 40, z: 0, w: 14, d: 18, h: 27, rotY: 0.03, litWindows: false },
    { x: 38, z: 20, w: 13, d: 15, h: 19, rotY: -0.04, litWindows: true },
    { x: -37, z: -37, w: 14, d: 14, h: 15, rotY: Math.PI * 0.25, litWindows: false },
    { x: 37, z: 37, w: 14, d: 14, h: 15, rotY: Math.PI * 0.25, litWindows: false },
  ];

  for (const b of buildingSpecs) {
    const bGroup = new THREE.Group();
    bGroup.position.set(b.x, 0, b.z);
    bGroup.rotation.y = b.rotY;

    const mainHull = new THREE.Mesh(track(new THREE.BoxGeometry(b.w, b.h, b.d)), brickConcreteMat);
    mainHull.position.y = b.h * 0.5;
    bGroup.add(mainHull);

    const parapet = new THREE.Mesh(
      track(new THREE.BoxGeometry(b.w + 0.6, 0.75, b.d + 0.6)),
      concreteBarrierMat,
    );
    parapet.position.y = b.h + 0.35;
    bGroup.add(parapet);

    const hvac = new THREE.Mesh(
      track(new THREE.BoxGeometry(b.w * 0.26, 1.7, b.d * 0.26)),
      darkIronMat,
    );
    hvac.position.set(-b.w * 0.18, b.h + 1.1, 0);
    bGroup.add(hvac);

    if (b.hasWaterTower) {
      const wtGroup = new THREE.Group();
      wtGroup.position.set(b.w * 0.18, b.h + 0.5, 0);
      for (const lx of [-0.9, 0.9]) {
        for (const lz of [-0.9, 0.9]) {
          const leg = new THREE.Mesh(track(new THREE.BoxGeometry(0.18, 2.4, 0.18)), darkIronMat);
          leg.position.set(lx, 1.2, lz);
          wtGroup.add(leg);
        }
      }
      const barrel = new THREE.Mesh(
        track(new THREE.CylinderGeometry(1.35, 1.35, 2.6, 12)),
        rustContainerMat,
      );
      barrel.position.y = 3.6;
      wtGroup.add(barrel);
      const cap = new THREE.Mesh(track(new THREE.ConeGeometry(1.5, 1.0, 12)), darkIronMat);
      cap.position.y = 5.4;
      wtGroup.add(cap);
      bGroup.add(wtGroup);
    }

    const floors = Math.max(2, Math.floor(b.h / 4.2));
    const facingZ = b.z < 0 ? b.d * 0.5 + 0.04 : b.z > 0 ? -b.d * 0.5 - 0.04 : 0;
    const facingX =
      b.x < 0 && Math.abs(b.z) < 28 ? b.w * 0.5 + 0.04 : b.x > 0 && Math.abs(b.z) < 28 ? -b.w * 0.5 - 0.04 : 0;

    bGroup.updateMatrixWorld(true);

    for (let fl = 1; fl <= floors; fl++) {
      const fy = fl * 3.8 - 1.5;
      if (fy > b.h - 1.2) break;

      const ledge = new THREE.Mesh(
        track(new THREE.BoxGeometry(b.w + 0.3, 0.26, b.d + 0.3)),
        concreteBarrierMat,
      );
      ledge.position.y = fy - 1.1;
      bGroup.add(ledge);

      if (facingZ !== 0) {
        for (let wx = -b.w * 0.32; wx <= b.w * 0.32 + 0.01; wx += b.w * 0.32) {
          const isLit = b.litWindows && (fl + Math.round(wx)) % 3 === 0;
          dummy.position.set(wx, fy, facingZ);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          const worldMat = bGroup.matrixWorld.clone().multiply(dummy.matrix);
          if (isLit) litWindowMatrices.push(worldMat);
          else darkWindowMatrices.push(worldMat);
        }
      } else if (facingX !== 0) {
        for (let wz = -b.d * 0.32; wz <= b.d * 0.32 + 0.01; wz += b.d * 0.32) {
          const isLit = b.litWindows && (fl + Math.round(wz)) % 3 === 0;
          dummy.position.set(facingX, fy, wz);
          dummy.rotation.set(0, Math.PI * 0.5, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          const worldMat = bGroup.matrixWorld.clone().multiply(dummy.matrix);
          if (isLit) litWindowMatrices.push(worldMat);
          else darkWindowMatrices.push(worldMat);
        }
      }
    }

    staticBatchGroup.add(bGroup);
  }

  const baseWindowGeo = track(new THREE.BoxGeometry(2.1, 1.9, 0.22));
  if (darkWindowMatrices.length > 0) {
    const darkWinMesh = new THREE.InstancedMesh(baseWindowGeo, windowDarkMat, darkWindowMatrices.length);
    darkWindowMatrices.forEach((m, i) => darkWinMesh.setMatrixAt(i, m));
    darkWinMesh.instanceMatrix.needsUpdate = true;
    darkWinMesh.computeBoundingSphere();
    darkWinMesh.userData.noBulletRaycast = true;
    scene.add(darkWinMesh);
  }
  if (litWindowMatrices.length > 0) {
    const litWinMesh = new THREE.InstancedMesh(baseWindowGeo, windowEmberMat, litWindowMatrices.length);
    litWindowMatrices.forEach((m, i) => litWinMesh.setMatrixAt(i, m));
    litWinMesh.instanceMatrix.needsUpdate = true;
    litWinMesh.computeBoundingSphere();
    litWinMesh.userData.noBulletRaycast = true;
    scene.add(litWinMesh);
  }

  // Broken Neon Storefront Signs glowing dimly in the fog
  const neonSignSpecs: Array<{
    text: string;
    primary: string;
    glow: string;
    x: number;
    y: number;
    z: number;
    ry: number;
  }> = [
    { text: 'PHARMACY', primary: '#34d399', glow: '#10b981', x: -26.8, y: 4.1, z: -31.7, ry: 0.04 },
    { text: 'DINER 24H', primary: '#fb7185', glow: '#f43f5e', x: 10.2, y: 3.9, z: -31.7, ry: 0.03 },
    { text: 'MOTEL', primary: '#38bdf8', glow: '#0ea5e9', x: -32.7, y: 4.3, z: -0.2, ry: Math.PI * 0.5 - 0.03 },
    { text: 'BIO-LAB', primary: '#facc15', glow: '#eab308', x: 32.7, y: 4.0, z: -19.8, ry: -Math.PI * 0.5 - 0.02 },
  ];
  const neonMaterials: THREE.MeshStandardMaterial[] = [];

  for (const ns of neonSignSpecs) {
    const signGroup = new THREE.Group();
    signGroup.position.set(ns.x, ns.y, ns.z);
    signGroup.rotation.y = ns.ry;

    const frame = new THREE.Mesh(track(new THREE.BoxGeometry(5.6, 1.5, 0.25)), darkIronMat);
    signGroup.add(frame);

    const tex = track(createNeonSignTexture(renderer, ns.text, ns.primary, ns.glow));
    const faceMat = track(
      new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: new THREE.Color(ns.primary),
        emissiveIntensity: 1.45,
        roughness: 0.3,
        metalness: 0.2,
      }),
    );
    neonMaterials.push(faceMat);

    const face = new THREE.Mesh(track(new THREE.PlaneGeometry(5.2, 1.28)), faceMat);
    face.position.z = 0.14;
    signGroup.add(face);
    scene.add(signGroup);
  }

  // 4. Collapsed Highway Overpass Looming in the Northern Fog
  const overpassGroup = new THREE.Group();
  overpassGroup.position.set(0, 0, -56);

  for (const px of [-26, -6, 14, 34]) {
    const col = new THREE.Mesh(track(new THREE.BoxGeometry(2.4, 13.5, 2.4)), concreteBarrierMat);
    col.position.set(px, 6.75, 0);
    overpassGroup.add(col);
    const cap = new THREE.Mesh(track(new THREE.BoxGeometry(4.4, 1.3, 6.8)), concreteBarrierMat);
    cap.position.set(px, 13.8, 0);
    overpassGroup.add(cap);
  }
  const intactDeck = new THREE.Mesh(track(new THREE.BoxGeometry(62, 1.35, 8.6)), concreteBarrierMat);
  intactDeck.position.set(14, 15.1, 0);
  overpassGroup.add(intactDeck);
  const deckGuardFront = new THREE.Mesh(track(new THREE.BoxGeometry(62, 0.95, 0.45)), brickConcreteMat);
  deckGuardFront.position.set(14, 16.2, 4.1);
  overpassGroup.add(deckGuardFront);

  const collapsedSpan = new THREE.Group();
  collapsedSpan.position.set(-22, 8.8, 2.6);
  collapsedSpan.rotation.set(0.28, 0.08, -0.34);
  const spanSlab = new THREE.Mesh(track(new THREE.BoxGeometry(22, 1.3, 8.4)), concreteBarrierMat);
  collapsedSpan.add(spanSlab);
  for (let r = -3; r <= 3; r++) {
    const rod = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 5)), darkIronMat);
    rod.rotation.z = Math.PI * 0.5;
    rod.position.set(11.6, (r % 2) * 0.22, r * 1.05);
    collapsedSpan.add(rod);
  }
  overpassGroup.add(collapsedSpan);
  staticBatchGroup.add(overpassGroup);

  // 5. Quarantine Checkpoint Gate / Archway with Flashing Amber Hazard Beacons + Searchlight Cones
  const checkpointGroup = new THREE.Group();
  checkpointGroup.position.set(0, 0, -17.8);

  for (const side of [-1, 1]) {
    const px = side * 9.6;
    const pier = new THREE.Mesh(track(new THREE.BoxGeometry(1.8, 5.2, 2.2)), concreteBarrierMat);
    pier.position.set(px, 2.6, 0);
    pier.castShadow = !isSoftwareGl;
    checkpointGroup.add(pier);

    const pierSkirt = new THREE.Mesh(track(new THREE.BoxGeometry(1.92, 0.55, 2.32)), hazardMat);
    pierSkirt.position.set(px, 0.275, 0);
    checkpointGroup.add(pierSkirt);

    const towerPost = new THREE.Mesh(track(new THREE.BoxGeometry(0.42, 1.5, 0.42)), darkIronMat);
    towerPost.position.set(px, 5.8, 0);
    checkpointGroup.add(towerPost);

    obstacles.push(makeObbCollider(px, -17.8, 1.84, 2.24, 0, 5.2));
  }

  const gantryBeam = new THREE.Mesh(track(new THREE.BoxGeometry(21.2, 1.45, 1.25)), darkIronMat);
  gantryBeam.position.set(0, 5.45, 0);
  checkpointGroup.add(gantryBeam);

  const gantryMat = track(
    new THREE.MeshStandardMaterial({
      map: bannerMap,
      roughness: 0.45,
      metalness: 0.25,
      emissive: 0x1e293b,
      emissiveIntensity: 0.35,
    }),
  );
  const bannerFront = new THREE.Mesh(track(new THREE.PlaneGeometry(15.2, 1.22)), gantryMat);
  bannerFront.position.set(0, 5.45, 0.64);
  checkpointGroup.add(bannerFront);
  const bannerBack = new THREE.Mesh(track(new THREE.PlaneGeometry(15.2, 1.22)), gantryMat);
  bannerBack.position.set(0, 5.45, -0.64);
  bannerBack.rotation.y = Math.PI;
  checkpointGroup.add(bannerBack);

  const amberBeaconMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.5,
      roughness: 0.2,
    }),
  );
  const amberCheckpointBeacons: THREE.Mesh[] = [];
  for (const bx of [-9.6, 9.6]) {
    const amberLamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.24, 10, 10)), amberBeaconMat);
    amberLamp.position.set(bx, 6.7, 0);
    checkpointGroup.add(amberLamp);
    amberCheckpointBeacons.push(amberLamp);
  }
  const checkpointAmberLight = new THREE.PointLight(0xf59e0b, 14, 18, 1.6);
  checkpointAmberLight.position.set(0, 6.5, 0.8);
  checkpointGroup.add(checkpointAmberLight);

  // Overhead Checkpoint Searchlights + Additive Cones
  const searchlightConeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xcbe3ff,
      map: beamMap,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const searchlightConeGeo = track(new THREE.ConeGeometry(2.1, 5.8, 14, 1, true));
  for (const sx of [-4.4, 4.4]) {
    const housing = new THREE.Mesh(track(new THREE.CylinderGeometry(0.24, 0.3, 0.48, 10)), darkIronMat);
    housing.position.set(sx, 4.6, 0.45);
    housing.rotation.x = 0.26;
    checkpointGroup.add(housing);

    const cone = new THREE.Mesh(searchlightConeGeo, searchlightConeMat);
    cone.position.set(sx, 1.85, 1.15);
    cone.rotation.x = 0.26;
    checkpointGroup.add(cone);
    volumetricCones.push(cone);
    checkpointCones.push(cone);
  }
  scene.add(checkpointGroup);

  // (Wrecked military ambulances at (-18.5, -16.8) and (13.5, 13.5) are loaded via vehicles.ts GLB pipeline)

  // (Realistic GLB barricades & roadside guard rails are loaded via props.ts)

  const spawnMgNest = (sx: number, sz: number, rotY: number) => {
    const mgGroup = new THREE.Group();
    mgGroup.position.set(sx, 0, sz);
    mgGroup.rotation.y = rotY;

    for (const legAngle of [-0.55, 0.55, Math.PI]) {
      const leg = new THREE.Mesh(track(new THREE.CylinderGeometry(0.03, 0.035, 1.15, 6)), darkIronMat);
      leg.position.set(Math.sin(legAngle) * 0.32, 0.52, -0.42 + Math.cos(legAngle) * 0.25);
      leg.rotation.set(Math.cos(legAngle) * 0.42, 0, -Math.sin(legAngle) * 0.42);
      mgGroup.add(leg);
    }
    const receiver = new THREE.Mesh(track(new THREE.BoxGeometry(0.18, 0.2, 0.68)), darkIronMat);
    receiver.position.set(0, 1.16, -0.32);
    mgGroup.add(receiver);

    const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.04, 1.05, 8)), darkIronMat);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(0, 1.18, 0.48);
    mgGroup.add(barrel);

    const ammoBox = new THREE.Mesh(track(new THREE.BoxGeometry(0.32, 0.24, 0.24)), oliveContainerMat);
    ammoBox.position.set(0.24, 1.12, -0.28);
    mgGroup.add(ammoBox);

    const crate = new THREE.Mesh(track(new THREE.BoxGeometry(0.68, 0.42, 0.48)), militaryArmorMat);
    crate.position.set(-0.78, 0.21, -0.58);
    mgGroup.add(crate);

    staticBatchGroup.add(mgGroup);
    obstacles.push(
      makeObbCollider(sx, sz, 0.72, 0.80, rotY, 1.25, 0, -0.30),
      makeObbCollider(sx, sz, 0.70, 0.50, rotY, 0.55, -0.78, -0.58),
    );
  };

  spawnMgNest(-4.2, -3.2, 0.32);
  spawnMgNest(4.8, -2.5, -0.28);

  // Checkpoint amber light tracked in arenaLights for distance-based intensity attenuation
  arenaLights.push({
    light: checkpointAmberLight,
    x: 0,
    z: -17.0,
    baseIntensity: 14,
    kind: 'checkpoint',
    subIndex: 0,
  });

  // 12. Flickering Streetlamps + Soft Additive Volumetric Light Cones + Perimeter Guard Rails
  const lampHeadMatSteady = track(
    new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
  );
  const lampHeadMatFlicker = track(
    new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
  );
  const steadyBeamConeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      map: beamMap,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const flickerBeamConeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      map: beamMap,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const lampConeGeo = track(new THREE.ConeGeometry(2.7, 6.2, 14, 1, true));

  const flickeringLampLights: THREE.PointLight[] = [];
  const streetlampCoords: Array<[number, number, number, boolean]> = [
    [-25, -25, Math.PI * 0.25, true],
    [25, -25, -Math.PI * 0.25, false],
    [-25, 25, Math.PI * 0.75, false],
    [25, 25, -Math.PI * 0.75, true],
  ];

  for (const [lx, lz, rotY, flickers] of streetlampCoords) {
    const poleGroup = new THREE.Group();
    poleGroup.position.set(lx, 0, lz);
    poleGroup.rotation.y = rotY;

    const base = new THREE.Mesh(track(new THREE.CylinderGeometry(0.28, 0.34, 0.7, 8)), concreteBarrierMat);
    base.position.y = 0.35;
    poleGroup.add(base);

    const mast = new THREE.Mesh(track(new THREE.CylinderGeometry(0.1, 0.14, 6.4, 8)), darkIronMat);
    mast.position.y = 3.5;
    poleGroup.add(mast);

    const arm = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.14, 1.8)), darkIronMat);
    arm.position.set(0, 6.55, 0.85);
    poleGroup.add(arm);

    const lampHousing = new THREE.Mesh(track(new THREE.BoxGeometry(0.45, 0.14, 0.72)), darkIronMat);
    lampHousing.position.set(0, 6.46, 1.65);
    poleGroup.add(lampHousing);

    const bulb = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.32, 0.08, 0.56)),
      flickers ? lampHeadMatFlicker : lampHeadMatSteady,
    );
    bulb.position.set(0, 6.38, 1.65);
    staticBatchGroup.add(poleGroup);

    // Keep volumetric cones & PointLights out of static geometry merge
    const dynamicPoleGroup = new THREE.Group();
    dynamicPoleGroup.position.set(lx, 0, lz);
    dynamicPoleGroup.rotation.y = rotY;
    dynamicPoleGroup.add(bulb);
    bulb.updateMatrixWorld(true);

    const lightCone = new THREE.Mesh(lampConeGeo, flickers ? flickerBeamConeMat : steadyBeamConeMat);
    lightCone.position.set(0, 3.25, 1.65);
    dynamicPoleGroup.add(lightCone);
    volumetricCones.push(lightCone);

    const streetLight = new THREE.PointLight(0xf59e0b, 14, 24, 1.6);
    streetLight.position.set(0, 6.1, 1.65);
    streetLight.castShadow = false;
    dynamicPoleGroup.add(streetLight);
    if (flickers) {
      flickeringLampLights.push(streetLight);
    }

    dynamicPoleGroup.updateMatrixWorld(true);
    const lWorld = new THREE.Vector3();
    streetLight.getWorldPosition(lWorld);
    arenaLights.push({
      light: streetLight,
      x: lWorld.x,
      z: lWorld.z,
      baseIntensity: 14,
      kind: 'street',
      subIndex: 0,
    });

    scene.add(dynamicPoleGroup);
    obstacles.push(makeCircleCollider(lx, lz, 0.34, 6.5));
  }

  // Quarantine Hazard Beacons
  const beaconMatTemplate = track(
    new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xdc2626,
      emissiveIntensity: 1.5,
      roughness: 0.2,
    }),
  );
  const towerPositions: Array<[number, number]> = [
    [0, -arenaHalfSize],
    [0, arenaHalfSize],
    [-arenaHalfSize, 0],
    [arenaHalfSize, 0],
  ];
  for (const [tx, tz] of towerPositions) {
    const tower = new THREE.Group();
    tower.position.set(tx, 0, tz);

    const plinth = new THREE.Mesh(track(new THREE.BoxGeometry(1.5, 0.75, 1.5)), concreteBarrierMat);
    plinth.position.y = 0.375;
    tower.add(plinth);

    const mast = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.2, 4.8, 8)), darkIronMat);
    mast.position.y = 2.8;
    tower.add(mast);

    const crossArm = new THREE.Mesh(track(new THREE.BoxGeometry(1.1, 0.14, 0.24)), hazardMat);
    crossArm.position.y = 5.05;
    tower.add(crossArm);

    staticBatchGroup.add(tower);

    const beaconMat = track(beaconMatTemplate.clone());
    const lamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 8, 8)), beaconMat);
    lamp.position.set(tx, 5.35, tz);
    scene.add(lamp);
    beacons.push(lamp);
    obstacles.push(makeObbCollider(tx, tz, 1.54, 1.54, 0, 5.4));
  }

  // Low Perimeter Quarantine Curbs (roadside GLB guard rails placed via props.ts)
  const railLength = arenaHalfSize * 2;
  const railConfigs: Array<[number, number, number]> = [
    [0, -arenaHalfSize, 0],
    [0, arenaHalfSize, 0],
    [-arenaHalfSize, 0, Math.PI * 0.5],
    [arenaHalfSize, 0, Math.PI * 0.5],
  ];
  for (const [rx, rz, rotY] of railConfigs) {
    const railGroup = new THREE.Group();
    railGroup.position.set(rx, 0, rz);
    railGroup.rotation.y = rotY;

    const curb = new THREE.Mesh(track(new THREE.BoxGeometry(railLength, 0.5, 0.45)), concreteBarrierMat);
    curb.position.y = 0.25;
    railGroup.add(curb);

    staticBatchGroup.add(railGroup);
  }

  // 13. Glowing Red Emergency Flares + Toxic Biohazard Manhole Vents
  const flareEmberMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xff6b5b,
      emissive: 0xff2211,
      emissiveIntensity: 4.5,
      roughness: 0.2,
    }),
  );
  const flareTubeMat = track(new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.5, metalness: 0.3 }));

  const flarePositions: Array<[number, number, number]> = [
    [-2.4, -2.2, 0.4],
    [3.8, 9.6, -0.7],
  ];
  for (let i = 0; i < flarePositions.length; i++) {
    const [fx, fz, fRot] = flarePositions[i];
    const flareGroup = new THREE.Group();
    flareGroup.position.set(fx, 0, fz);

    const flareTube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.045, 0.38, 10)), flareTubeMat);
    flareTube.rotation.z = Math.PI * 0.46;
    flareTube.rotation.y = fRot;
    flareTube.position.y = 0.045;
    flareGroup.add(flareTube);

    const flareTip = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 10, 10)), flareEmberMat);
    flareTip.position.set(0.18, 0.08, -0.07);
    flareGroup.add(flareTip);

    const flareLight = new THREE.PointLight(0xef4444, 15, 18, 1.65);
    flareLight.castShadow = false;
    flareLight.position.set(0.18, 0.45, -0.07);
    flareGroup.add(flareLight);
    arenaLights.push({
      light: flareLight,
      x: fx + 0.18,
      z: fz - 0.07,
      baseIntensity: 15,
      kind: 'flare',
      subIndex: i,
    });

    scene.add(flareGroup);
  }

  // Toxic Manhole Vents with Glowing Grates & Rising Biohazard Steam
  const manholeCoords: Array<[number, number]> = [
    [-3.2, 3.8],
    [7.5, -9.5],
    [-8.0, -10.5],
  ];
  const manholeRingGeo = track(new THREE.CylinderGeometry(0.62, 0.66, 0.06, 14));
  const manholeCoreGeo = track(new THREE.CylinderGeometry(0.46, 0.46, 0.07, 12));

  for (const [mx, mz] of manholeCoords) {
    const rim = new THREE.Mesh(manholeRingGeo, darkIronMat);
    rim.position.set(mx, 0.03, mz);
    staticBatchGroup.add(rim);

    const toxicCore = new THREE.Mesh(manholeCoreGeo, biohazardGlowMat);
    toxicCore.position.set(mx, 0.035, mz);
    staticBatchGroup.add(toxicCore);
  }

  // Merge all static arena meshes into per-material batches (~300+ draw calls -> ~14 draw calls)
  staticBatchGroup.updateMatrixWorld(true);
  const mergeBuckets = new Map<
    string,
    { mat: THREE.Material; castShadow: boolean; geos: THREE.BufferGeometry[] }
  >();
  const matIds = new Map<THREE.Material, number>();
  let nextMatId = 1;

  staticBatchGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat) return;
    let id = matIds.get(mat);
    if (!id) {
      id = nextMatId++;
      matIds.set(mat, id);
    }
    const key = `${id}_${mesh.castShadow ? 1 : 0}`;
    let bucket = mergeBuckets.get(key);
    if (!bucket) {
      bucket = { mat, castShadow: mesh.castShadow, geos: [] };
      mergeBuckets.set(key, bucket);
    }
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    bucket.geos.push(g);
  });

  for (const bucket of mergeBuckets.values()) {
    if (bucket.geos.length === 0) continue;
    const merged = mergeGeometries(bucket.geos, false);
    for (const g of bucket.geos) g.dispose();
    if (!merged) continue;
    track(merged);
    merged.computeBoundingSphere();
    const batchMesh = new THREE.Mesh(merged, bucket.mat);
    batchMesh.castShadow = bucket.castShadow;
    batchMesh.receiveShadow = false;
    if (bucket.castShadow) {
      mergedShadowCasters.push(batchMesh);
    }
    scene.add(batchMesh);
  }

  const steamCount = 72;
  const steamPositions = new Float32Array(steamCount * 3);
  const steamSpeeds = new Float32Array(steamCount);
  const steamOrigins = new Uint8Array(steamCount);
  for (let i = 0; i < steamCount; i++) {
    const originIdx = i % manholeCoords.length;
    steamOrigins[i] = originIdx;
    const [ox, oz] = manholeCoords[originIdx];
    steamPositions[i * 3] = ox + (Math.random() - 0.5) * 0.42;
    steamPositions[i * 3 + 1] = 0.1 + Math.random() * 2.8;
    steamPositions[i * 3 + 2] = oz + (Math.random() - 0.5) * 0.42;
    steamSpeeds[i] = 0.65 + Math.random() * 0.7;
  }
  const steamGeo = track(new THREE.BufferGeometry());
  const steamPosAttr = new THREE.BufferAttribute(steamPositions, 3);
  steamGeo.setAttribute('position', steamPosAttr);

  const steamPoints = new THREE.Points(
    steamGeo,
    track(
      new THREE.PointsMaterial({
        map: steamMap,
        color: 0x86efac,
        size: 0.95,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  steamPoints.frustumCulled = false;
  scene.add(steamPoints);

  // 14. Slowly Drifting 3D Ash + Rising Ember Particles (THREE.Points)
  const ashCount = 420;
  const ashPositions = new Float32Array(ashCount * 3);
  const ashVelocities = new Float32Array(ashCount * 3);
  for (let i = 0; i < ashCount; i++) {
    ashPositions[i * 3] = (Math.random() - 0.5) * 68;
    ashPositions[i * 3 + 1] = 0.2 + Math.random() * 14;
    ashPositions[i * 3 + 2] = (Math.random() - 0.5) * 68;

    ashVelocities[i * 3] = (Math.random() - 0.35) * 0.55;
    ashVelocities[i * 3 + 1] = -(0.2 + Math.random() * 0.38);
    ashVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.45;
  }
  const ashGeo = track(new THREE.BufferGeometry());
  const ashPosAttr = new THREE.BufferAttribute(ashPositions, 3);
  ashGeo.setAttribute('position', ashPosAttr);

  const ashPoints = new THREE.Points(
    ashGeo,
    track(
      new THREE.PointsMaterial({
        color: 0xd6cfc7,
        size: 0.11,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    ),
  );
  ashPoints.frustumCulled = false;
  scene.add(ashPoints);

  const emberCount = 130;
  const emberPositions = new Float32Array(emberCount * 3);
  const emberVelocities = new Float32Array(emberCount * 3);
  for (let i = 0; i < emberCount; i++) {
    emberPositions[i * 3] = (Math.random() - 0.5) * 52;
    emberPositions[i * 3 + 1] = 0.2 + Math.random() * 8;
    emberPositions[i * 3 + 2] = (Math.random() - 0.5) * 52;

    emberVelocities[i * 3] = (Math.random() - 0.5) * 0.45;
    emberVelocities[i * 3 + 1] = 0.45 + Math.random() * 0.75;
    emberVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.45;
  }
  const emberGeo = track(new THREE.BufferGeometry());
  const emberPosAttr = new THREE.BufferAttribute(emberPositions, 3);
  emberGeo.setAttribute('position', emberPosAttr);

  const emberPoints = new THREE.Points(
    emberGeo,
    track(
      new THREE.PointsMaterial({
        color: 0xfb923c,
        size: 0.1,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    ),
  );
  emberPoints.frustumCulled = false;
  scene.add(emberPoints);

  const spawnPoints = [
    new THREE.Vector3(-22, 0, -22),
    new THREE.Vector3(0, 0, -24),
    new THREE.Vector3(22, 0, -22),
    new THREE.Vector3(-24, 0, 0),
    new THREE.Vector3(24, 0, 0),
    new THREE.Vector3(-21, 0, 21),
    new THREE.Vector3(21, 0, 21),
  ];

  let activeSteamCount = 48;
  let activeAshCount = 240;
  let activeEmberCount = 72;

  const updateAtmosphere = (
    dt: number,
    nowMs: number,
    cameraPos?: THREE.Vector3,
    quality: GraphicsQuality = activeQuality,
  ) => {
    const t = nowMs * 0.001;
    const camX = cameraPos ? cameraPos.x : 0;
    const camZ = cameraPos ? cameraPos.z : 6;
    const lightCullDistSq = quality === 'HIGH' ? 38 * 38 : quality === 'MED' ? 27 * 27 : 0;

    // Modulate intensity instead of toggling .visible so WebGL never recompiles scene shaders mid-frame
    const amberOn = checkpointPowerOn && Math.sin(t * 5.2) > 0;
    amberBeaconMat.emissiveIntensity = checkpointPowerOn ? (amberOn ? 3.4 : 0.45) : 0.08;
    for (const ab of amberCheckpointBeacons) {
      ab.scale.setScalar(amberOn ? 1.12 : 0.92);
    }

    const flareFlicker = 13 + Math.sin(nowMs * 0.023) * 3.5 + Math.cos(nowMs * 0.057) * 2.2;
    flareEmberMat.emissiveIntensity = 3.2 + Math.sin(nowMs * 0.03) * 1.4;

    const lightsAllowed = !isSoftwareGl && quality !== 'LOW';
    for (let i = 0; i < arenaLights.length; i++) {
      const al = arenaLights[i];
      if (!lightsAllowed) {
        al.light.intensity = 0;
        continue;
      }
      const dx = al.x - camX;
      const dz = al.z - camZ;
      if (dx * dx + dz * dz > lightCullDistSq) {
        al.light.intensity = 0;
        continue;
      }
      if (al.kind === 'flare') {
        al.light.intensity = flareFlicker + Math.sin(nowMs * 0.04 + al.subIndex * 2) * 1.5;
      } else if (al.kind === 'checkpoint') {
        al.light.intensity = checkpointPowerOn ? (amberOn ? 15 : 3) : 0;
      } else {
        al.light.intensity = al.baseIntensity;
      }
    }

    // Sputtering broken neon storefront signs
    for (let i = 0; i < neonMaterials.length; i++) {
      const buzz = Math.sin(t * (9 + i * 3.1)) * Math.sin(t * (23 + i * 5)) > 0.78;
      neonMaterials[i].emissiveIntensity = buzz ? 0.25 : 1.35 + Math.sin(t * 2.5 + i) * 0.18;
    }

    // Pulse perimeter hazard beacons
    for (let i = 0; i < beacons.length; i++) {
      const mat = beacons[i].material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.0 + Math.sin(nowMs * 0.008 + i) * 0.9;
    }

    // Rising toxic manhole steam (loop bounded to activeSteamCount)
    if (steamPoints.visible && activeSteamCount > 0) {
      steamGeo.setDrawRange(0, activeSteamCount);
      for (let i = 0; i < activeSteamCount; i++) {
        const idx = i * 3;
        steamPositions[idx] += Math.sin(t * 1.8 + i) * 0.18 * dt;
        steamPositions[idx + 1] += steamSpeeds[i] * dt;
        steamPositions[idx + 2] += Math.cos(t * 1.5 + i) * 0.18 * dt;

        if (steamPositions[idx + 1] > 3.1) {
          const [ox, oz] = manholeCoords[steamOrigins[i]];
          steamPositions[idx] = ox + (Math.random() - 0.5) * 0.35;
          steamPositions[idx + 1] = 0.08;
          steamPositions[idx + 2] = oz + (Math.random() - 0.5) * 0.35;
        }
      }
      steamPosAttr.needsUpdate = true;
    }

    // Drift 3D falling ash (loop bounded to activeAshCount)
    if (ashPoints.visible && activeAshCount > 0) {
      ashGeo.setDrawRange(0, activeAshCount);
      for (let i = 0; i < activeAshCount; i++) {
        const idx = i * 3;
        ashPositions[idx] += (ashVelocities[idx] + Math.sin(t + i) * 0.15) * dt;
        ashPositions[idx + 1] += ashVelocities[idx + 1] * dt;
        ashPositions[idx + 2] += (ashVelocities[idx + 2] + Math.cos(t * 0.8 + i) * 0.15) * dt;

        if (ashPositions[idx + 1] < 0.08) {
          ashPositions[idx] = (Math.random() - 0.5) * 68;
          ashPositions[idx + 1] = 12 + Math.random() * 4;
          ashPositions[idx + 2] = (Math.random() - 0.5) * 68;
        }
        if (ashPositions[idx] > 35) ashPositions[idx] = -35;
        else if (ashPositions[idx] < -35) ashPositions[idx] = 35;
        if (ashPositions[idx + 2] > 35) ashPositions[idx + 2] = -35;
        else if (ashPositions[idx + 2] < -35) ashPositions[idx + 2] = 35;
      }
      ashPosAttr.needsUpdate = true;
    }

    // Drift rising ambient embers (loop bounded to activeEmberCount)
    if (emberPoints.visible && activeEmberCount > 0) {
      emberGeo.setDrawRange(0, activeEmberCount);
      for (let i = 0; i < activeEmberCount; i++) {
        const idx = i * 3;
        emberPositions[idx] += (emberVelocities[idx] + Math.cos(t * 1.4 + i) * 0.22) * dt;
        emberPositions[idx + 1] += emberVelocities[idx + 1] * dt;
        emberPositions[idx + 2] += (emberVelocities[idx + 2] + Math.sin(t * 1.2 + i) * 0.22) * dt;

        if (emberPositions[idx + 1] > 10.5) {
          emberPositions[idx] = (Math.random() - 0.5) * 50;
          emberPositions[idx + 1] = 0.25 + Math.random() * 1.2;
          emberPositions[idx + 2] = (Math.random() - 0.5) * 50;
        }
      }
      emberPosAttr.needsUpdate = true;
    }
  };

  const setGroundWetness = (wetness: number) => {
    const w = THREE.MathUtils.clamp(wetness, 0, 1);
    if (Math.abs(w - lastWetnessApplied) < 0.008) return;
    lastWetnessApplied = w;
    groundMat.roughness = THREE.MathUtils.lerp(0.96, 0.34, w);
    groundMat.metalness = THREE.MathUtils.lerp(0.1, 0.24, w);
    groundMat.envMapIntensity = mobilePreviewMode ? 0 : THREE.MathUtils.lerp(0.65, 1.05, w);
    puddleMat.color.setHex(mobilePreviewMode ? 0x526578 : 0x354556);
    puddleMat.opacity = mobilePreviewMode ? THREE.MathUtils.lerp(0.08, 0.28, w) : THREE.MathUtils.lerp(0.1, 0.42, w);
    puddleMat.roughness = THREE.MathUtils.lerp(0.32, 0.12, w);
    puddleMat.envMapIntensity = mobilePreviewMode ? 0 : THREE.MathUtils.lerp(0.75, 1.15, w);
  };

  let mobilePreviewMode = isMobilePreview;

  const setCheckpointPower = (enabled: boolean) => {
    checkpointPowerOn = enabled;
    gantryMat.emissiveIntensity = enabled ? 0.35 : 0.04;
    const showCones = enabled && !mobilePreviewMode && activeQuality !== 'LOW';
    for (const cc of checkpointCones) {
      cc.visible = showCones;
    }
    if (!enabled) {
      checkpointAmberLight.intensity = 0;
      amberBeaconMat.emissiveIntensity = 0.08;
    }
  };

  const setQuality = (quality: GraphicsQuality, mobilePreview = mobilePreviewMode) => {
    activeQuality = quality;
    mobilePreviewMode = mobilePreview;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const targetAniso =
      mobilePreview || quality === 'LOW' ? 1 : quality === 'MED' ? Math.min(4, maxAniso) : maxAniso;
    for (const tex of arenaTextures) {
      tex.anisotropy = targetAniso;
      tex.needsUpdate = true;
    }

    if (mobilePreview || quality === 'LOW') {
      activeSteamCount = mobilePreview && quality === 'HIGH' ? Math.min(18, steamCount) : 0;
      activeAshCount = mobilePreview && quality === 'HIGH' ? Math.min(64, ashCount) : 0;
      activeEmberCount = 0;
      steamPoints.visible = activeSteamCount > 0;
      ashPoints.visible = activeAshCount > 0;
      emberPoints.visible = false;
      volumetricCones.forEach((c) => {
        c.visible = false;
      });
      for (const sm of mergedShadowCasters) sm.castShadow = false;
      renderer.shadowMap.enabled = false;
    } else if (quality === 'MED') {
      activeSteamCount = Math.min(36, steamCount);
      activeAshCount = Math.min(140, ashCount);
      activeEmberCount = 0;
      steamPoints.visible = true;
      ashPoints.visible = true;
      emberPoints.visible = false;
      volumetricCones.forEach((c) => {
        c.visible = checkpointCones.includes(c) ? checkpointPowerOn : true;
      });
      for (const sm of mergedShadowCasters) sm.castShadow = false;
      renderer.shadowMap.enabled = false;
    } else {
      activeSteamCount = steamCount;
      activeAshCount = Math.min(280, ashCount);
      activeEmberCount = Math.min(72, emberCount);
      steamPoints.visible = true;
      ashPoints.visible = true;
      emberPoints.visible = true;
      volumetricCones.forEach((c) => {
        c.visible = checkpointCones.includes(c) ? checkpointPowerOn : true;
      });
      for (const sm of mergedShadowCasters) sm.castShadow = !isSoftwareGl;
      renderer.shadowMap.enabled = !isSoftwareGl;
    }
    const pointLightsOn = !isSoftwareGl && !mobilePreview && quality !== 'LOW';
    for (let i = 0; i < arenaLights.length; i++) {
      const al = arenaLights[i];
      al.light.visible = pointLightsOn;
      if (!pointLightsOn) {
        al.light.intensity = 0;
      }
    }

    // Re-evaluate puddle/ground env reflections immediately when switching desktop <-> mobile
    const curW = lastWetnessApplied;
    lastWetnessApplied = -1;
    setGroundWetness(curW);
  };

  const dispose = () => {
    for (const d of disposables) {
      d.dispose();
    }
  };

  return {
    arenaHalfSize,
    obstacles,
    spawnPoints,
    beacons,
    skyDomeMat,
    updateAtmosphere,
    setGroundWetness,
    setCheckpointPower,
    setQuality,
    dispose,
  };
}
