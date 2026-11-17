import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  computeMeshPartBounds,
  computeTorsoBounds,
  makeCircleCollider,
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

export const PROP_URLS = {
  surveillanceCamera:
    'https://file.garden/avaubS0ShqQb7IVS/surveilance_camera_advanced_pbr.glb',
  industrialSwitch:
    'https://file.garden/avaubS0ShqQb7IVS/simple_industrial_onoff_switch.glb',
  electricalEnvironment:
    'https://file.garden/avaubS0ShqQb7IVS/simple_electrical_environment.glb',
  lowPolyContainer:
    'https://file.garden/avaubS0ShqQb7IVS/simple_low_poly_ship_container.glb',
  damagedRoadblock:
    'https://file.garden/avaubS0ShqQb7IVS/damaged_roadblock_01.glb',
  apocalypticContainer:
    'https://file.garden/avaubS0ShqQb7IVS/post_apocalytpic_style_container.glb',
  woodenBarricade:
    'https://file.garden/avaubS0ShqQb7IVS/wooden_barricade.glb',
  guardRail:
    'https://file.garden/avaubS0ShqQb7IVS/guard_rail.glb',
  lowPolyBarricade:
    'https://file.garden/avaubS0ShqQb7IVS/barricade_low_polly.glb',
} as const;

export interface PropPackResult {
  group: THREE.Group;
  obstacles: Collider[];
  raycastTargets: THREE.Object3D[];
  update: (
    dt: number,
    nowSec: number,
    stormIntensity: number,
    camera: THREE.Camera,
  ) => void;
  setQuality: (quality: GraphicsQuality, mobilePreview?: boolean) => void;
  togglePower: () => boolean;
  isPowerOn: () => boolean;
  getDistanceToSwitch: (pos: THREE.Vector3) => number;
  dispose: () => void;
}

export interface PropLoadOptions {
  profile?: RuntimePerfProfile;
  onProgress?: (loaded: number, total: number) => void;
  isAborted?: () => boolean;
}

interface CameraRig {
  headPivot: THREE.Object3D;
  baseYaw: number;
  phase: number;
  ledMat: THREE.MeshBasicMaterial;
}

interface LodEntry {
  lod: THREE.LOD;
  detailObj: THREE.Object3D;
  proxyObj: THREE.Object3D;
  cullObj: THREE.Object3D;
  allowShadowCast: boolean;
}

type PrimitiveShape = 'box' | 'capsule';

const SHARED_PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });
SHARED_PROXY_MAT.name = 'prop_raycast_proxy_mat';

function createPropGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setCrossOrigin('anonymous');
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
        const glossiness = typeof sg.glossinessFactor === 'number' ? sg.glossinessFactor : 0.45;
        materialParams.roughness = sg.specularGlossinessTexture
          ? THREE.MathUtils.clamp(1.0 - glossiness * 0.52, 0.34, 0.88)
          : THREE.MathUtils.clamp(1.0 - glossiness, 0.25, 0.9);
        materialParams.metalness = 0.1;

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

function loadGlbWithFallback(
  loader: GLTFLoader,
  url: string,
  createFallback: () => THREE.Group,
  timeoutMs = 20000,
): Promise<THREE.Group> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (group: THREE.Group) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(group);
    };

    const timer = window.setTimeout(() => {
      finish(createFallback());
    }, timeoutMs);

    fetch(url, { mode: 'cors', credentials: 'omit' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (buf.byteLength < 12) throw new Error('Empty GLB buffer');
        const magic = new DataView(buf).getUint32(0, true);
        if (magic !== 0x46546c67) {
          throw new Error('Invalid GLB header');
        }
        loader.parse(
          buf,
          '',
          (gltf) => finish(gltf.scene),
          () => finish(createFallback()),
        );
      })
      .catch(() => {
        finish(createFallback());
      });
  });
}

function makeFallbackBox(
  w: number,
  h: number,
  d: number,
  color: number,
  roughness = 0.85,
  metalness = 0.25,
): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.y = h * 0.5;
  g.add(m);
  return g;
}

interface NormalizedPropMeta {
  model: THREE.Group;
  size: THREE.Vector3;
  torso: TorsoBounds;
  parts: MeshPartBounds[];
}

function applyRainWeatheringToProp(
  root: THREE.Object3D,
  weatheredMaterials: THREE.MeshStandardMaterial[],
): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const std = mat as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial) {
        // Damp rainy sheen while preserving original albedo/normal/AO textures
        const baseRough =
          typeof std.roughness === 'number' ? std.roughness : 0.72;
        std.roughness = THREE.MathUtils.clamp(baseRough * 0.78, 0.24, 0.72);
        std.envMapIntensity = 0.85;
        if (!weatheredMaterials.includes(std)) {
          weatheredMaterials.push(std);
        }
      }
    }
  });
}

function normalizeAndGroundModel(
  rawModel: THREE.Object3D,
  targetLength: number,
  targetAxis: 'maxHorizontal' | 'maxDim' | 'height' = 'maxHorizontal',
  castShadow = true,
  receiveShadow = true,
  alignHorizontalLengthToX = false,
): NormalizedPropMeta {
  rawModel.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(rawModel);
  const rawSize = new THREE.Vector3();
  rawBox.getSize(rawSize);

  // Align horizontal length onto local +X/-X axis when asset was authored along Z
  if (alignHorizontalLengthToX && rawSize.z > rawSize.x * 1.05) {
    rawModel.rotation.y += Math.PI * 0.5;
    rawModel.updateMatrixWorld(true);
    rawBox.setFromObject(rawModel);
    rawBox.getSize(rawSize);
  }

  let basis = 1;
  if (targetAxis === 'maxHorizontal') {
    basis = Math.max(rawSize.x, rawSize.z, 0.01);
  } else if (targetAxis === 'height') {
    basis = Math.max(rawSize.y, 0.01);
  } else {
    basis = Math.max(rawSize.x, rawSize.y, rawSize.z, 0.01);
  }

  const scale = targetLength / basis;
  rawModel.scale.multiplyScalar(scale);
  rawModel.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(rawModel);
  const scaledCenter = new THREE.Vector3();
  scaledBox.getCenter(scaledCenter);

  rawModel.position.x -= scaledCenter.x;
  rawModel.position.z -= scaledCenter.z;
  rawModel.position.y -= scaledBox.min.y;
  rawModel.updateMatrixWorld(true);

  // Identity wrapper ensures computeMeshPartBounds computes exact post-scale, post-centered local bounds
  const wrapper = new THREE.Group();
  wrapper.add(rawModel);
  wrapper.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(wrapper);
  const finalSize = new THREE.Vector3();
  finalBox.getSize(finalSize);
  const parts = computeMeshPartBounds(wrapper, 0.14, 1.75);
  const torso = computeTorsoBounds(wrapper, 0.14, 1.75);

  wrapper.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    }
  });

  return { model: wrapper, size: finalSize, torso, parts };
}

function createPrimitiveMesh(
  part: MeshPartBounds,
  shape: PrimitiveShape,
  material: THREE.Material,
  createdGeos: THREE.BufferGeometry[],
): THREE.Mesh {
  if (shape === 'capsule') {
    if (part.width >= part.depth) {
      const r = Math.max(0.12, part.depth * 0.5);
      const midLen = Math.max(0.02, part.width - r * 2);
      const geo = new THREE.CapsuleGeometry(r, midLen, 4, 8);
      createdGeos.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.rotation.z = Math.PI * 0.5;
      mesh.scale.set(Math.max(0.25, part.height / (r * 2)), 1, 1);
      mesh.position.set(part.centerX, part.minY + part.height * 0.5, part.centerZ);
      return mesh;
    } else {
      const r = Math.max(0.12, part.width * 0.5);
      const midLen = Math.max(0.02, part.depth - r * 2);
      const geo = new THREE.CapsuleGeometry(r, midLen, 4, 8);
      createdGeos.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.rotation.x = Math.PI * 0.5;
      mesh.scale.set(1, 1, Math.max(0.25, part.height / (r * 2)));
      mesh.position.set(part.centerX, part.minY + part.height * 0.5, part.centerZ);
      return mesh;
    }
  }

  const geo = new THREE.BoxGeometry(
    Math.max(0.12, part.width),
    Math.max(0.25, part.height),
    Math.max(0.12, part.depth),
  );
  createdGeos.push(geo);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(part.centerX, part.minY + part.height * 0.5, part.centerZ);
  return mesh;
}

function buildSimplifiedPrimitiveLod(
  parts: readonly MeshPartBounds[],
  shape: PrimitiveShape,
  color: number,
  createdGeos: THREE.BufferGeometry[],
  createdMats: THREE.Material[],
  roughness = 0.85,
  metalness = 0.25,
): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  createdMats.push(mat);

  for (const part of parts) {
    const mesh = createPrimitiveMesh(part, shape, mat, createdGeos);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  group.matrixAutoUpdate = false;
  group.updateMatrix();
  return group;
}

function attachPrimitiveRaycastProxies(
  parent: THREE.Object3D,
  parts: readonly MeshPartBounds[],
  shape: PrimitiveShape,
  userDataFlags: Record<string, boolean>,
  raycastTargets: THREE.Object3D[],
  createdGeos: THREE.BufferGeometry[],
): void {
  for (const part of parts) {
    const proxy = createPrimitiveMesh(part, shape, SHARED_PROXY_MAT, createdGeos);
    Object.assign(proxy.userData, userDataFlags);
    proxy.userData.isRaycastProxy = true;
    proxy.matrixAutoUpdate = false;
    proxy.updateMatrix();
    parent.add(proxy);
    raycastTargets.push(proxy);
  }
}

function computeTextureQualityCap(
  root: THREE.Object3D,
  aniso: number,
): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const m = (obj as THREE.Mesh).material;
    const mats = Array.isArray(m) ? m : [m];
    for (const mat of mats) {
      if (!mat) continue;
      const std = mat as THREE.MeshStandardMaterial;
      const maps = [
        std.map,
        std.normalMap,
        std.roughnessMap,
        std.metalnessMap,
        std.aoMap,
        std.emissiveMap,
      ];
      for (const tex of maps) {
        if (tex) {
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }
    }
  });
}

export async function loadAndIntegrateProps(
  scene: THREE.Scene,
  isSoftwareGl: boolean,
  initialQuality: GraphicsQuality,
  options: PropLoadOptions = {},
): Promise<PropPackResult> {
  const { profile, onProgress, isAborted } = options;
  const rootGroup = new THREE.Group();
  rootGroup.name = 'quarantine_props_pack';
  scene.add(rootGroup);

  const obstacles: Collider[] = [];
  const raycastTargets: THREE.Object3D[] = [];
  const lodEntries: LodEntry[] = [];
  const cameraRigs: CameraRig[] = [];
  const createdGeos: THREE.BufferGeometry[] = [];
  const createdMats: THREE.Material[] = [];
  const loadedTemplates: THREE.Object3D[] = [];
  const weatheredMaterials: THREE.MeshStandardMaterial[] = [];

  let currentQuality: GraphicsQuality = initialQuality;
  let mobilePreviewMode = Boolean(profile?.isMobilePreview);
  let powerOn = true;

  const loader = createPropGltfLoader();

  const propSpecs: Array<{ url: string; fallback: () => THREE.Group }> = [
    {
      url: PROP_URLS.surveillanceCamera,
      fallback: () => makeFallbackBox(0.32, 0.28, 0.45, 0x3b424d, 0.5, 0.6),
    },
    {
      url: PROP_URLS.industrialSwitch,
      fallback: () => makeFallbackBox(0.32, 0.42, 0.24, 0x475569, 0.45, 0.7),
    },
    {
      url: PROP_URLS.electricalEnvironment,
      fallback: () => makeFallbackBox(2.4, 2.2, 1.3, 0x3f4946, 0.65, 0.55),
    },
    {
      url: PROP_URLS.lowPolyContainer,
      fallback: () => makeFallbackBox(2.45, 2.55, 6.0, 0x36474f, 0.85, 0.35),
    },
    {
      url: PROP_URLS.damagedRoadblock,
      fallback: () => makeFallbackBox(3.2, 1.05, 0.85, 0x5c6066, 0.9, 0.1),
    },
    {
      url: PROP_URLS.apocalypticContainer,
      fallback: () => makeFallbackBox(2.45, 2.55, 6.0, 0x573b2f, 0.88, 0.4),
    },
    {
      url: PROP_URLS.woodenBarricade,
      fallback: () => makeFallbackBox(0.95, 1.54, 0.85, 0x6b4f35, 0.85, 0.08),
    },
    {
      url: PROP_URLS.guardRail,
      fallback: () => makeFallbackBox(3.05, 1.23, 0.87, 0x64748b, 0.55, 0.72),
    },
    {
      url: PROP_URLS.lowPolyBarricade,
      fallback: () => makeFallbackBox(2.42, 1.59, 0.67, 0x4b535c, 0.82, 0.18),
    },
  ];

  let propLoadedCount = 0;
  const loadedRawModels = await runProgressiveTasks(
    propSpecs.map((spec) => async () => {
      const obj = await loadGlbWithFallback(loader, spec.url, spec.fallback);
      if (profile) {
        optimizeObjectTexturesAndMaterials(obj, profile);
      }
      propLoadedCount += 1;
      onProgress?.(propLoadedCount, propSpecs.length);
      return obj;
    }),
    profile?.loaderConcurrency ?? 3,
    Boolean(profile?.progressiveLoadYield),
    isAborted,
  );

  if (isAborted?.()) {
    scene.remove(rootGroup);
    for (const raw of loadedRawModels) {
      disposeObject3DResources(raw);
    }
    return {
      group: rootGroup,
      obstacles,
      raycastTargets,
      togglePower: () => powerOn,
      isPowerOn: () => powerOn,
      getDistanceToSwitch: () => Infinity,
      setQuality: () => {},
      update: () => {},
      dispose: () => {},
    };
  }

  const [
    rawCamTemplate,
    rawSwitchTemplate,
    rawElecTemplate,
    rawLowPolyContainerTemplate,
    rawRoadblockTemplate,
    rawApocContainerTemplate,
    rawWoodenBarricadeTemplate,
    rawGuardRailTemplate,
    rawLowPolyBarricadeTemplate,
  ] = loadedRawModels.map((item, idx) => item ?? propSpecs[idx].fallback());

  const highQualityShadow = !isSoftwareGl && initialQuality === 'HIGH';

  // Normalize master templates in advance so clones reuse cached textures/geometries
  const lowPolyContMeta = normalizeAndGroundModel(
    rawLowPolyContainerTemplate,
    6.0,
    'maxHorizontal',
    !isSoftwareGl,
    true,
  );
  const apocContMeta = normalizeAndGroundModel(
    rawApocContainerTemplate,
    6.0,
    'maxHorizontal',
    !isSoftwareGl,
    true,
  );
  const roadblockMeta = normalizeAndGroundModel(
    rawRoadblockTemplate,
    3.2,
    'maxHorizontal',
    !isSoftwareGl,
    true,
    true,
  );
  const elecMeta = normalizeAndGroundModel(
    rawElecTemplate,
    2.8,
    'maxHorizontal',
    !isSoftwareGl,
    true,
  );
  const camMeta = normalizeAndGroundModel(
    rawCamTemplate,
    0.62,
    'maxDim',
    false,
    true,
  );
  const switchMeta = normalizeAndGroundModel(
    rawSwitchTemplate,
    0.56,
    'maxDim',
    !isSoftwareGl,
    true,
  );
  const woodenBarricadeMeta = normalizeAndGroundModel(
    rawWoodenBarricadeTemplate,
    1.54,
    'height',
    highQualityShadow,
    !isSoftwareGl,
    true,
  );
  const guardRailMeta = normalizeAndGroundModel(
    rawGuardRailTemplate,
    3.05,
    'maxHorizontal',
    highQualityShadow,
    !isSoftwareGl,
    true,
  );
  const lowPolyBarricadeMeta = normalizeAndGroundModel(
    rawLowPolyBarricadeTemplate,
    2.42,
    'maxHorizontal',
    highQualityShadow,
    !isSoftwareGl,
    true,
  );

  loadedTemplates.push(
    camMeta.model,
    switchMeta.model,
    elecMeta.model,
    lowPolyContMeta.model,
    roadblockMeta.model,
    apocContMeta.model,
    woodenBarricadeMeta.model,
    guardRailMeta.model,
    lowPolyBarricadeMeta.model,
  );

  // Subtle wet-surface calibration for rainy night checkpoint integration (preserves base textures)
  applyRainWeatheringToProp(woodenBarricadeMeta.model, weatheredMaterials);
  applyRainWeatheringToProp(guardRailMeta.model, weatheredMaterials);
  applyRainWeatheringToProp(lowPolyBarricadeMeta.model, weatheredMaterials);

  const registerLodInstance = (
    detailModel: THREE.Object3D,
    meta: NormalizedPropMeta,
    shape: PrimitiveShape,
    proxyColor: number,
    x: number,
    z: number,
    rotY: number,
    rayFlags: Record<string, boolean>,
    allowShadowCast = true,
  ): THREE.Group => {
    const holder = new THREE.Group();
    holder.position.set(x, 0, z);
    holder.rotation.y = rotY;
    holder.matrixAutoUpdate = false;
    holder.updateMatrix();

    const lod = new THREE.LOD();
    const proxyObj = buildSimplifiedPrimitiveLod(
      meta.parts,
      shape,
      proxyColor,
      createdGeos,
      createdMats,
    );
    const cullDummy = new THREE.Group();
    cullDummy.visible = false;

    lod.addLevel(detailModel, 0);
    lod.addLevel(proxyObj, 32);
    lod.addLevel(cullDummy, 110);
    lod.matrixAutoUpdate = false;
    lod.updateMatrix();

    holder.add(lod);
    attachPrimitiveRaycastProxies(
      holder,
      meta.parts,
      shape,
      rayFlags,
      raycastTargets,
      createdGeos,
    );
    rootGroup.add(holder);

    lodEntries.push({
      lod,
      detailObj: detailModel,
      proxyObj,
      cullObj: cullDummy,
      allowShadowCast,
    });

    return holder;
  };

  // 1. SHIPPING CONTAINERS (tailored BoxGeometry primitives matching solid mesh hull)
  const lowPolyContainers = [
    { x: -16.5, z: -2.2, rotY: 0.16, color: 0x30454d },
    { x: 17.5, z: 3.5, rotY: 0.22, color: 0x3b4840 },
  ];
  for (const cfg of lowPolyContainers) {
    const model = lowPolyContMeta.model.clone(true);
    registerLodInstance(
      model,
      lowPolyContMeta,
      'box',
      cfg.color,
      cfg.x,
      cfg.z,
      cfg.rotY,
      { isVehicleMetal: true },
    );
    for (const part of lowPolyContMeta.parts) {
      obstacles.push(
        makeObbCollider(
          cfg.x,
          cfg.z,
          Math.max(0.2, part.width - 0.04),
          Math.max(0.2, part.depth - 0.04),
          cfg.rotY,
          part.height,
          part.centerX,
          part.centerZ,
        ),
      );
    }
  }

  const apocContainers = [
    { x: 16.8, z: -13.5, rotY: -0.28, color: 0x52372c },
    { x: -15.5, z: 19.5, rotY: 0.35, color: 0x45352c },
  ];
  for (const cfg of apocContainers) {
    const model = apocContMeta.model.clone(true);
    registerLodInstance(
      model,
      apocContMeta,
      'box',
      cfg.color,
      cfg.x,
      cfg.z,
      cfg.rotY,
      { isVehicleMetal: true },
    );
    for (const part of apocContMeta.parts) {
      obstacles.push(
        makeObbCollider(
          cfg.x,
          cfg.z,
          Math.max(0.2, part.width - 0.04),
          Math.max(0.2, part.depth - 0.04),
          cfg.rotY,
          part.height,
          part.centerX,
          part.centerZ,
        ),
      );
    }
  }

  // 2. DAMAGED ROADBLOCKS (tailored CapsuleGeometry primitives matching concrete mesh silhouette)
  const roadblocks = [
    { x: -14.2, z: -18.2, rotY: 0.12 },
    { x: 14.2, z: -18.2, rotY: -0.12 },
    { x: -4.8, z: -22.2, rotY: 0.08 },
  ];
  for (const rb of roadblocks) {
    const model = roadblockMeta.model.clone(true);
    registerLodInstance(
      model,
      roadblockMeta,
      'capsule',
      0x585c63,
      rb.x,
      rb.z,
      rb.rotY,
      { isConcrete: true },
    );
    for (const part of roadblockMeta.parts) {
      obstacles.push(
        makeOrientedCapsuleCollider(
          rb.x,
          rb.z,
          Math.max(0.22, part.width - 0.04),
          Math.max(0.22, part.depth - 0.04),
          rb.rotY,
          part.height,
          part.centerX,
          part.centerZ,
        ),
      );
    }
  }

  // 3. LOW POLY MILITARY BARRICADES (checkpoint road closures & tactical defensive lanes)
  const lowPolyBarricades: Array<{ x: number; z: number; rotY: number }> = [
    { x: -0.2, z: -11.4, rotY: 0.06 },
    { x: -8.9, z: 1.8, rotY: 1.28 },
    { x: 8.9, z: 2.9, rotY: -1.16 },
    { x: 0.15, z: 16.4, rotY: -0.05 },
    { x: -14.6, z: 7.4, rotY: 0.66 },
    { x: 4.8, z: -16.8, rotY: -0.14 },
  ];
  for (const lb of lowPolyBarricades) {
    const model = lowPolyBarricadeMeta.model.clone(true);
    registerLodInstance(
      model,
      lowPolyBarricadeMeta,
      'capsule',
      0x4b535c,
      lb.x,
      lb.z,
      lb.rotY,
      { isConcrete: true },
    );
    for (const part of lowPolyBarricadeMeta.parts) {
      obstacles.push(
        makeOrientedCapsuleCollider(
          lb.x,
          lb.z,
          Math.max(0.22, part.width - 0.04),
          Math.max(0.22, part.depth - 0.04),
          lb.rotY,
          part.height,
          part.centerX,
          part.centerZ,
        ),
      );
    }
  }

  // 4. WOODEN BARRICADES (survivor emergency cover around defensive positions & checkpoint breaches)
  const woodenBarricades: Array<{ x: number; z: number; rotY: number }> = [
    // NW inner defensive pocket near MG nest
    { x: -5.4, z: -1.4, rotY: 0.42 },
    { x: -6.25, z: -2.05, rotY: 0.62 },
    // NE inner defensive pocket near MG nest
    { x: 6.1, z: -0.9, rotY: -0.36 },
    { x: 6.95, z: -1.55, rotY: -0.58 },
    // West damaged checkpoint breach cover
    { x: -17.8, z: -9.8, rotY: 1.38 },
    { x: -18.35, z: -8.85, rotY: 1.62 },
    // SE survivor cover pocket
    { x: 14.4, z: 8.6, rotY: -0.82 },
    { x: 15.25, z: 7.95, rotY: -1.04 },
    // South-central emergency cover
    { x: -5.6, z: 13.8, rotY: 0.28 },
    { x: -4.65, z: 14.1, rotY: 0.08 },
  ];
  for (const wb of woodenBarricades) {
    const model = woodenBarricadeMeta.model.clone(true);
    registerLodInstance(
      model,
      woodenBarricadeMeta,
      'box',
      0x5c432d,
      wb.x,
      wb.z,
      wb.rotY,
      { isWood: true },
    );
    for (const part of woodenBarricadeMeta.parts) {
      obstacles.push(
        makeObbCollider(
          wb.x,
          wb.z,
          Math.max(0.2, part.width - 0.05),
          Math.max(0.2, part.depth - 0.05),
          wb.rotY,
          part.height,
          part.centerX,
          part.centerZ,
        ),
      );
    }
  }

  // 5. ROADSIDE GUARD RAILS (along perimeter roadsides, damaged curbs & vehicle-blocked shoulders)
  const guardRails: Array<{ x: number; z: number; rotY: number }> = [
    // North roadside segments
    { x: -10.8, z: -26.4, rotY: 0.03 },
    { x: -7.6, z: -26.35, rotY: -0.02 },
    { x: 7.4, z: -26.4, rotY: -0.04 },
    { x: 10.6, z: -26.28, rotY: 0.05 },
    // West roadside segments
    { x: -26.35, z: -11.8, rotY: Math.PI * 0.5 + 0.04 },
    { x: -26.25, z: -8.6, rotY: Math.PI * 0.5 - 0.03 },
    { x: -26.3, z: 8.8, rotY: Math.PI * 0.5 - 0.05 },
    { x: -26.4, z: 12.1, rotY: Math.PI * 0.5 + 0.04 },
    // East roadside segments
    { x: 26.35, z: -11.4, rotY: -Math.PI * 0.5 - 0.03 },
    { x: 26.25, z: -8.1, rotY: -Math.PI * 0.5 + 0.05 },
    { x: 26.3, z: 8.6, rotY: -Math.PI * 0.5 + 0.03 },
    { x: 26.4, z: 11.9, rotY: -Math.PI * 0.5 - 0.04 },
    // South roadside segments
    { x: -9.8, z: 26.35, rotY: Math.PI + 0.04 },
    { x: -6.5, z: 26.25, rotY: Math.PI - 0.02 },
    { x: 6.8, z: 26.3, rotY: Math.PI - 0.05 },
    { x: 10.1, z: 26.4, rotY: Math.PI + 0.03 },
    // Interior damaged road shoulders & vehicle-blocked edge accents
    { x: 11.8, z: -11.6, rotY: -0.22 },
    { x: 6.6, z: 19.6, rotY: 0.14 },
  ];
  for (const gr of guardRails) {
    const model = guardRailMeta.model.clone(true);
    registerLodInstance(
      model,
      guardRailMeta,
      'capsule',
      0x4b5563,
      gr.x,
      gr.z,
      gr.rotY,
      { isVehicleMetal: true },
    );
    for (const part of guardRailMeta.parts) {
      obstacles.push(
        makeOrientedCapsuleCollider(
          gr.x,
          gr.z,
          Math.max(0.22, part.width - 0.04),
          Math.max(0.22, part.depth - 0.04),
          gr.rotY,
          part.height,
          part.centerX,
          part.centerZ,
        ),
      );
    }
  }

  // 6. ELECTRICAL ENVIRONMENT STATION (near NE checkpoint pier, decomposed BoxGeometry OBBs)
  const elecX = 13.4;
  const elecZ = -21.2;
  const elecRotY = -0.35;
  const elecHolder = registerLodInstance(
    elecMeta.model,
    elecMeta,
    'box',
    0x37433f,
    elecX,
    elecZ,
    elecRotY,
    { isVehicleMetal: true },
  );
  for (const part of elecMeta.parts) {
    obstacles.push(
      makeObbCollider(
        elecX,
        elecZ,
        Math.max(0.2, part.width - 0.04),
        Math.max(0.2, part.depth - 0.04),
        elecRotY,
        part.height,
        part.centerX,
        part.centerZ,
      ),
    );
  }

  // Electrical station power status indicator LED
  const elecLedGeo = new THREE.SphereGeometry(0.06, 8, 6);
  const elecLedMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });
  createdGeos.push(elecLedGeo);
  createdMats.push(elecLedMat);
  const elecLed = new THREE.Mesh(elecLedGeo, elecLedMat);
  elecLed.position.set(0, Math.min(1.65, elecMeta.size.y * 0.78), elecMeta.torso.depth * 0.5 + 0.04);
  elecHolder.add(elecLed);

  // 7. INTERACTIVE INDUSTRIAL ON/OFF SWITCH (steel pedestal in front of electrical bay)
  const switchWorldPos = new THREE.Vector3(11.65, 0, -19.55);
  const switchGroup = new THREE.Group();
  switchGroup.position.copy(switchWorldPos);
  switchGroup.rotation.y = 0.35;
  rootGroup.add(switchGroup);

  const postMat = new THREE.MeshStandardMaterial({
    color: 0x333a42,
    roughness: 0.72,
    metalness: 0.75,
  });
  const hazardStripeMat = new THREE.MeshStandardMaterial({
    color: 0xd97706,
    roughness: 0.65,
    metalness: 0.3,
  });
  const postGeo = new THREE.BoxGeometry(0.14, 1.18, 0.14);
  const plateGeo = new THREE.BoxGeometry(0.28, 0.34, 0.06);
  const collarGeo = new THREE.BoxGeometry(0.18, 0.12, 0.18);
  createdGeos.push(postGeo, plateGeo, collarGeo);
  createdMats.push(postMat, hazardStripeMat);

  const postMesh = new THREE.Mesh(postGeo, postMat);
  postMesh.position.y = 0.59;
  postMesh.castShadow = !isSoftwareGl;
  postMesh.receiveShadow = true;
  switchGroup.add(postMesh);

  const collarMesh = new THREE.Mesh(collarGeo, hazardStripeMat);
  collarMesh.position.y = 0.96;
  switchGroup.add(collarMesh);

  const plateMesh = new THREE.Mesh(plateGeo, postMat);
  plateMesh.position.set(0, 1.18, 0.06);
  switchGroup.add(plateMesh);

  const switchPivot = new THREE.Group();
  switchPivot.position.set(0, 1.14, 0.11);
  switchMeta.model.position.set(0, -0.18, 0);
  switchPivot.add(switchMeta.model);
  switchGroup.add(switchPivot);

  const switchLedGeo = new THREE.SphereGeometry(0.042, 8, 6);
  const switchLedMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });
  createdGeos.push(switchLedGeo);
  createdMats.push(switchLedMat);
  const switchLed = new THREE.Mesh(switchLedGeo, switchLedMat);
  switchLed.position.set(0, 1.4, 0.12);
  switchGroup.add(switchLed);

  let switchLight: THREE.PointLight | null = null;
  if (!isSoftwareGl) {
    switchLight = new THREE.PointLight(0x10b981, 1.6, 4.5, 2);
    switchLight.position.set(0, 1.4, 0.25);
    switchLight.visible = currentQuality !== 'LOW';
    switchGroup.add(switchLight);
  }
  obstacles.push(makeCircleCollider(switchWorldPos.x, switchWorldPos.z, 0.12, 1.4));
  attachPrimitiveRaycastProxies(
    switchGroup,
    [{ width: 0.28, depth: 0.24, height: 1.38, minY: 0, maxY: 1.38, centerX: 0, centerZ: 0.04 }],
    'box',
    { isVehicleMetal: true },
    raycastTargets,
    createdGeos,
  );

  // 8. SURVEILLANCE CAMERAS (mounted high at y = 4.55..4.8m; zero player collider)
  const camConfigs = [
    { x: -8.75, y: 4.55, z: -16.75, yaw: 0.4, phase: 0.0 },
    { x: 8.75, y: 4.55, z: -16.75, yaw: -0.4, phase: 1.5 },
    { x: -24.6, y: 4.8, z: -24.6, yaw: 0.78, phase: 2.8 },
    { x: 24.6, y: 4.8, z: 24.6, yaw: -2.35, phase: 4.1 },
  ];
  const camBracketGeo = new THREE.BoxGeometry(0.1, 0.1, 0.34);
  const camLedGeo = new THREE.SphereGeometry(0.026, 6, 5);
  createdGeos.push(camBracketGeo, camLedGeo);

  for (let i = 0; i < camConfigs.length; i++) {
    const cc = camConfigs[i];
    const rigHolder = new THREE.Group();
    rigHolder.position.set(cc.x, cc.y, cc.z);
    rigHolder.rotation.y = cc.yaw;

    const bracket = new THREE.Mesh(camBracketGeo, postMat);
    bracket.position.set(0, 0.08, -0.14);
    rigHolder.add(bracket);

    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0, 0.04);
    const camModel = camMeta.model.clone(true);
    camModel.position.y = -camMeta.size.y * 0.45;
    camModel.rotation.x = 0.28;
    headPivot.add(camModel);

    const ledMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    createdMats.push(ledMat);
    const led = new THREE.Mesh(camLedGeo, ledMat);
    led.position.set(0.08, 0.04, 0.2);
    headPivot.add(led);

    rigHolder.add(headPivot);
    rootGroup.add(rigHolder);

    cameraRigs.push({
      headPivot,
      baseYaw: 0,
      phase: cc.phase,
      ledMat,
    });
  }

  const applyQualityToAll = (quality: GraphicsQuality, mobilePreview = mobilePreviewMode) => {
    currentQuality = quality;
    mobilePreviewMode = mobilePreview;
    const maxAniso = mobilePreview || quality === 'LOW' ? 1 : quality === 'MED' ? 4 : 8;
    for (const tmpl of loadedTemplates) {
      computeTextureQualityCap(tmpl, maxAniso);
    }

    const targetEnv = mobilePreview ? 0 : quality === 'HIGH' ? 0.95 : quality === 'LOW' ? 0.7 : 0.85;
    for (const mat of weatheredMaterials) {
      mat.envMapIntensity = targetEnv;
    }

    const detailDist = mobilePreview ? 14 : quality === 'LOW' ? 18 : quality === 'MED' ? 28 : 40;
    const cullDist = mobilePreview ? 44 : quality === 'LOW' ? 56 : quality === 'MED' ? 88 : 136;
    const castShadows = !isSoftwareGl && !mobilePreview && quality === 'HIGH';

    for (let i = 0; i < lodEntries.length; i++) {
      const entry = lodEntries[i];
      entry.lod.levels[0].distance = 0;
      entry.lod.levels[1].distance = detailDist;
      entry.lod.levels[2].distance = cullDist;
      if (entry.allowShadowCast) {
        entry.detailObj.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = castShadows;
            mesh.receiveShadow = !isSoftwareGl && !mobilePreview;
          }
        });
      }
    }

    const pointLightsOn = !isSoftwareGl && !mobilePreview && quality !== 'LOW';
    if (switchLight) {
      switchLight.visible = pointLightsOn;
    }
  };

  applyQualityToAll(initialQuality, mobilePreviewMode);

  const syncPowerVisuals = () => {
    if (powerOn) {
      switchLedMat.color.setHex(0x10b981);
      elecLedMat.color.setHex(0x10b981);
      if (switchLight) {
        switchLight.color.setHex(0x10b981);
        switchLight.intensity = 1.6;
      }
    } else {
      switchLedMat.color.setHex(0xef4444);
      elecLedMat.color.setHex(0xef4444);
      if (switchLight) {
        switchLight.color.setHex(0xef4444);
        switchLight.intensity = 1.1;
      }
    }
  };
  syncPowerVisuals();

  return {
    group: rootGroup,
    obstacles,
    raycastTargets,
    togglePower: () => {
      powerOn = !powerOn;
      syncPowerVisuals();
      return powerOn;
    },
    isPowerOn: () => powerOn,
    getDistanceToSwitch: (pos: THREE.Vector3) =>
      Math.hypot(pos.x - switchWorldPos.x, pos.z - switchWorldPos.z),
    setQuality: applyQualityToAll,
    update: (
      dt: number,
      nowSec: number,
      _stormIntensity: number,
      camera: THREE.Camera,
    ) => {
      // Animate industrial switch lever tilt
      const targetTilt = powerOn ? -0.18 : 0.36;
      switchPivot.rotation.x += (targetTilt - switchPivot.rotation.x) * Math.min(1, dt * 12);

      // Update LOD visibility against real scene camera
      for (let i = 0; i < lodEntries.length; i++) {
        lodEntries[i].lod.update(camera);
      }

      // Surveillance cameras pan & blink when checkpoint power is ON
      for (let i = 0; i < cameraRigs.length; i++) {
        const rig = cameraRigs[i];
        if (powerOn) {
          rig.headPivot.rotation.y =
            rig.baseYaw + Math.sin(nowSec * 0.55 + rig.phase) * 0.62;
          const blinkOn = Math.sin(nowSec * 4.5 + rig.phase) > 0.25;
          rig.ledMat.color.setHex(blinkOn ? 0xef4444 : 0x3b0d0d);
        } else {
          rig.headPivot.rotation.y += (rig.baseYaw - rig.headPivot.rotation.y) * Math.min(1, dt * 3);
          rig.ledMat.color.setHex(0x1f242b);
        }
      }
    },
    dispose: () => {
      scene.remove(rootGroup);
      for (const g of createdGeos) g.dispose();
      for (const m of createdMats) m.dispose();
      const geoSet = new Set<THREE.BufferGeometry>();
      const matSet = new Set<THREE.Material>();
      const texSet = new Set<THREE.Texture>();
      for (const tmpl of loadedTemplates) {
        tmpl.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            if (mesh.geometry) geoSet.add(mesh.geometry);
            const mats = Array.isArray(mesh.material)
              ? mesh.material
              : [mesh.material];
            for (const mat of mats) {
              if (!mat || mat === SHARED_PROXY_MAT) continue;
              matSet.add(mat);
              const rec = mat as unknown as Record<string, unknown>;
              for (const key of [
                'map',
                'normalMap',
                'roughnessMap',
                'metalnessMap',
                'emissiveMap',
                'aoMap',
              ]) {
                const tex = rec[key] as THREE.Texture | undefined;
                if (tex && tex.isTexture) texSet.add(tex);
              }
            }
          }
        });
      }
      for (const g of geoSet) g.dispose();
      for (const t of texSet) t.dispose();
      for (const m of matSet) m.dispose();
    },
  };
}
