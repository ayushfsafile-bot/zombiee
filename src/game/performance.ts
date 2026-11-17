import * as THREE from 'three';
import type { GraphicsQuality, MobilePresetMode } from './types';

export interface RuntimePerfProfile {
  isMobilePreview: boolean;
  isEmbeddedPreview: boolean;
  maxDpr: number;
  maxTextureDim: number;
  maxAnisotropy: number;
  allowAntialias: boolean;
  allowBloom: boolean;
  allowEnvReflections: boolean;
  allowShadows: boolean;
  allowPointLights: boolean;
  maxActiveZombies: number;
  zombiePrewarmPerArch: number;
  zombiePoolMaxPerArch: number;
  rainDropCap: number;
  splashRingCap: number;
  loaderConcurrency: number;
  progressiveLoadYield: boolean;
  disableDecalGeo: boolean;
}

const TEXTURE_MAP_KEYS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'bumpMap',
  'alphaMap',
  'specularMap',
] as const;

const processedTextures = new WeakSet<THREE.Texture>();
let scratchResizeCanvas: HTMLCanvasElement | null = null;
let scratchResizeCtx: CanvasRenderingContext2D | null = null;

function getScratchResizeContext(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (typeof document === 'undefined') return null;
  if (!scratchResizeCanvas) {
    scratchResizeCanvas = document.createElement('canvas');
    scratchResizeCtx = scratchResizeCanvas.getContext('2d');
  }
  if (!scratchResizeCtx) return null;
  return { canvas: scratchResizeCanvas, ctx: scratchResizeCtx };
}

export function isEmbeddedIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function detectMobileBrowserEnvironment(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent || '';
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) {
    return true;
  }
  // Treat compact touch viewports inside embedded previews as mobile-preview targets
  // without impacting desktop monitors or desktop touchscreen laptops.
  const isTouch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const minScreenSide = Math.min(window.screen?.width || 9999, window.screen?.height || 9999);
  const minViewportSide = Math.min(window.innerWidth || 9999, window.innerHeight || 9999);
  return isTouch && (minScreenSide <= 900 || (isEmbeddedIframe() && minViewportSide <= 620));
}

export function resolveRuntimePerfProfile(
  quality: GraphicsQuality,
  mobilePreset: MobilePresetMode,
  isSoftwareGl: boolean,
  detectedMobile = detectMobileBrowserEnvironment(),
): RuntimePerfProfile {
  const embedded = isEmbeddedIframe();
  const isMobilePreview =
    mobilePreset === 'mobile' ? true : mobilePreset === 'desktop' ? false : detectedMobile;

  if (isSoftwareGl) {
    return {
      isMobilePreview: true,
      isEmbeddedPreview: embedded,
      maxDpr: 1,
      maxTextureDim: 256,
      maxAnisotropy: 1,
      allowAntialias: false,
      allowBloom: false,
      allowEnvReflections: false,
      allowShadows: false,
      allowPointLights: false,
      maxActiveZombies: 8,
      zombiePrewarmPerArch: 1,
      zombiePoolMaxPerArch: 4,
      rainDropCap: 100,
      splashRingCap: 8,
      loaderConcurrency: 1,
      progressiveLoadYield: true,
      disableDecalGeo: true,
    };
  }

  if (isMobilePreview) {
    // Dedicated low-memory mobile preview profile (preserves gameplay while preventing Android Chrome WebView OOM crashes)
    return {
      isMobilePreview: true,
      isEmbeddedPreview: embedded,
      maxDpr: 1.25,
      maxTextureDim: quality === 'LOW' ? 256 : 512,
      maxAnisotropy: 1,
      allowAntialias: false,
      allowBloom: false,
      allowEnvReflections: false,
      allowShadows: false,
      allowPointLights: false,
      maxActiveZombies: quality === 'HIGH' ? 10 : 8,
      zombiePrewarmPerArch: 1,
      zombiePoolMaxPerArch: 5,
      rainDropCap: quality === 'HIGH' ? 140 : 100,
      splashRingCap: quality === 'HIGH' ? 12 : 8,
      loaderConcurrency: 1,
      progressiveLoadYield: true,
      disableDecalGeo: true,
    };
  }

  // Desktop High-Fidelity Configuration (preserved intact)
  return {
    isMobilePreview: false,
    isEmbeddedPreview: embedded,
    maxDpr: quality === 'LOW' ? 1 : quality === 'MED' ? 1.35 : 2,
    maxTextureDim: quality === 'LOW' ? 512 : quality === 'MED' ? 1024 : 2048,
    maxAnisotropy: quality === 'LOW' ? 1 : quality === 'MED' ? 4 : 8,
    allowAntialias: true,
    allowBloom: quality !== 'LOW',
    allowEnvReflections: true,
    allowShadows: quality === 'HIGH',
    allowPointLights: quality !== 'LOW',
    maxActiveZombies: 24,
    zombiePrewarmPerArch: 2,
    zombiePoolMaxPerArch: 28,
    rainDropCap: quality === 'HIGH' ? 960 : quality === 'MED' ? 520 : 180,
    splashRingCap: quality === 'HIGH' ? 44 : quality === 'MED' ? 28 : 12,
    loaderConcurrency: 3,
    progressiveLoadYield: false,
    disableDecalGeo: quality === 'LOW',
  };
}

export function clampTextureResource(
  tex: THREE.Texture | null | undefined,
  maxDim: number,
  maxAnisotropy: number,
  stripMipmaps = false,
): void {
  if (!tex || !tex.isTexture) return;
  tex.anisotropy = Math.min(maxAnisotropy, tex.anisotropy || maxAnisotropy);

  if (processedTextures.has(tex)) return;
  processedTextures.add(tex);

  const img = tex.image as
    | (CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; close?: () => void })
    | undefined;
  if (!img) return;

  const srcW = Number(img.naturalWidth ?? img.width ?? 0);
  const srcH = Number(img.naturalHeight ?? img.height ?? 0);
  if (srcW <= 0 || srcH <= 0) return;

  if (srcW > maxDim || srcH > maxDim) {
    const scale = maxDim / Math.max(srcW, srcH);
    const dstW = Math.max(16, Math.round(srcW * scale));
    const dstH = Math.max(16, Math.round(srcH * scale));
    const scratch = getScratchResizeContext();
    if (scratch) {
      scratch.canvas.width = dstW;
      scratch.canvas.height = dstH;
      scratch.ctx.clearRect(0, 0, dstW, dstH);
      scratch.ctx.drawImage(img, 0, 0, dstW, dstH);

      // Copy into an independent compact canvas so future scratch resizes don't mutate this texture
      const outCanvas = document.createElement('canvas');
      outCanvas.width = dstW;
      outCanvas.height = dstH;
      const outCtx = outCanvas.getContext('2d');
      if (outCtx) {
        outCtx.drawImage(scratch.canvas, 0, 0);
        if (typeof img.close === 'function') {
          try {
            img.close();
          } catch {
            // Ignore closed ImageBitmap errors
          }
        }
        tex.image = outCanvas;
      }
    }
  }

  if (stripMipmaps) {
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
  }
  tex.needsUpdate = true;
}

export function optimizeObjectTexturesAndMaterials(
  root: THREE.Object3D,
  profile: Pick<RuntimePerfProfile, 'maxTextureDim' | 'maxAnisotropy' | 'isMobilePreview' | 'allowEnvReflections'>,
): void {
  const matSeen = new Set<THREE.Material>();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    for (const mat of mats) {
      if (!mat || matSeen.has(mat)) continue;
      matSeen.add(mat);

      const rec = mat as unknown as Record<string, unknown>;
      for (const key of TEXTURE_MAP_KEYS) {
        const tex = rec[key] as THREE.Texture | undefined;
        if (tex && tex.isTexture) {
          clampTextureResource(
            tex,
            profile.maxTextureDim,
            profile.maxAnisotropy,
            profile.isMobilePreview && key !== 'map',
          );
        }
      }

      if (!profile.allowEnvReflections && 'envMapIntensity' in mat) {
        (mat as THREE.MeshStandardMaterial).envMapIntensity = 0;
      }
    }
  });
}

export function disposeObject3DResources(
  root: THREE.Object3D | null | undefined,
  skipMaterials?: Set<THREE.Material>,
): void {
  if (!root) return;
  const geoSet = new Set<THREE.BufferGeometry>();
  const matSet = new Set<THREE.Material>();
  const texSet = new Set<THREE.Texture>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geoSet.add(mesh.geometry);
    if (!mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || skipMaterials?.has(mat)) continue;
      matSet.add(mat);
      const rec = mat as unknown as Record<string, unknown>;
      for (const key of TEXTURE_MAP_KEYS) {
        const tex = rec[key] as THREE.Texture | undefined;
        if (tex && tex.isTexture) {
          texSet.add(tex);
        }
      }
    }
  });

  for (const g of geoSet) g.dispose();
  for (const t of texSet) {
    const img = t.image as { close?: () => void } | undefined;
    if (img && typeof img.close === 'function') {
      try {
        img.close();
      } catch {
        // Ignore already-closed ImageBitmap
      }
    }
    t.dispose();
  }
  for (const m of matSet) m.dispose();
}

export function yieldToMainThread(ms = 16): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function runProgressiveTasks<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  yieldBetween: boolean,
  isAborted?: () => boolean,
): Promise<Array<T | null>> {
  const results: Array<T | null> = new Array(tasks.length).fill(null);
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < tasks.length) {
      if (isAborted?.()) return;
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
      if (yieldBetween && nextIdx < tasks.length && !isAborted?.()) {
        await yieldToMainThread(12);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
