import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MENU_SHOWCASE_WEAPON_ASSETS, WEAPON_CONFIGS, WEAPON_ORDER } from './weaponConfigs';
import {
  disposeObject3DResources,
  optimizeObjectTexturesAndMaterials,
  runProgressiveTasks,
  type RuntimePerfProfile,
} from './performance';
import type { DireWolfCompanion, WeaponKey, ZombieArchetype, ZombieEntity } from './types';

export { MENU_SHOWCASE_WEAPON_ASSETS, WEAPON_CONFIGS, WEAPON_ORDER };

export const GUN_POS = new THREE.Vector3(0, 0, 0);

export const ZOMBIE_TARGET_HEIGHT = 1.85;
export const DIRE_WOLF_URL = '/Dire_Wolf_Lite.glb';
export const DIRE_WOLF_TARGET_HEIGHT = 1.08;

export const ZOMBIE_ASSET_SOURCES: Record<ZombieArchetype, { label: string; urls: string[] }> = {
  runner: {
    label: 'Zombie Running',
    urls: ['/enemy.glb'],
  },
  walker_survivor: {
    label: 'Zombie Walk (1)',
    urls: ['/zombie-walk-1.glb'],
  },
  walker_yaku: {
    label: 'Zombie Walk',
    urls: ['/zombie-walk.glb'],
  },
  walker_shambler: {
    label: 'Walking Shambler',
    urls: ['/walking.glb'],
  },
  crawler: {
    label: 'Zombie Crawl',
    urls: ['/zombie-crawl.glb'],
  },
};

export interface WeaponAnimationRig {
  mixer: THREE.AnimationMixer | null;
  drawAction: THREE.AnimationAction | null;
  fireAction: THREE.AnimationAction | null;
  reloadAction: THREE.AnimationAction | null;
  reloadEmptyAction: THREE.AnimationAction | null;
  holsterAction: THREE.AnimationAction | null;
  inspectAction: THREE.AnimationAction | null;
}

export interface WeaponRigSlot extends WeaponAnimationRig {
  key: WeaponKey;
  pivotGroup: THREE.Group;
  modelRoot: THREE.Object3D;
  isStatic: boolean;
  isExternalGlb: boolean;
  muzzleLocal: THREE.Vector3;
  basePos: THREE.Vector3;
  adsPos: THREE.Vector3;
  baseRotY: number;
}

export interface LoadedGunRig {
  root: THREE.Group;
  muzzlePoint: THREE.Object3D;
  muzzleFlashMesh: THREE.Mesh;
  slots: Record<WeaponKey, WeaponRigSlot>;
}

export interface ZombieTemplate {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  naturalClipSpeeds: WeakMap<THREE.AnimationClip, number>;
  isExternalGlb: boolean;
  scaleFactor: number;
}

export type EnemyRoster = Record<ZombieArchetype, ZombieTemplate>;

const gltfLoader = new GLTFLoader();

// Support legacy Sketchfab KHR_materials_pbrSpecularGlossiness GLBs in Three.js r187+
gltfLoader.register((parser) => {
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

async function fetchValidGlbBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < 12) return null;
    const magic = new DataView(buffer).getUint32(0, true);
    // 'glTF' ASCII magic = 0x46546C67
    if (magic !== 0x46546c67) return null;
    return buffer;
  } catch {
    return null;
  }
}

function parseGlbBuffer(buffer: ArrayBuffer): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(buffer, '', (gltf) => {
      resolve({ scene: gltf.scene, animations: gltf.animations || [] });
    }, reject);
  });
}

function trimClipToActiveRange(clip: THREE.AnimationClip): THREE.AnimationClip {
  let firstActive = Infinity;
  let lastActive = 0;

  for (const track of clip.tracks) {
    const times = track.times;
    const vals = track.values;
    const stride = track.getValueSize();
    if (times.length < 2) continue;

    for (let i = 1; i < times.length; i++) {
      let diff = 0;
      for (let c = 0; c < stride; c++) {
        diff += Math.abs(vals[i * stride + c] - vals[(i - 1) * stride + c]);
      }
      if (diff > 0.002) {
        if (times[i - 1] < firstActive) firstActive = times[i - 1];
        if (times[i] > lastActive) lastActive = times[i];
      }
    }
  }

  if (!Number.isFinite(firstActive) || lastActive <= firstActive) {
    return clip;
  }

  // Subclip shared-timeline FBX->glTF exports so every clip begins at t = 0
  if (firstActive > 0.08 || clip.duration - lastActive > 0.15) {
    const fps = 30;
    const startFrame = Math.max(0, Math.floor((firstActive - 0.02) * fps));
    const endFrame = Math.max(startFrame + 2, Math.ceil((lastActive + 0.04) * fps));
    return THREE.AnimationUtils.subclip(clip, clip.name, startFrame, endFrame, fps);
  }

  return clip;
}

function findClipCaseInsensitive(
  clips: THREE.AnimationClip[],
  matcher: (normalizedName: string, rawLower: string) => boolean,
): THREE.AnimationClip | null {
  for (const clip of clips) {
    const rawLower = clip.name.toLowerCase();
    const normalized = rawLower.replace(/[\s_-]+/g, '');
    if (matcher(normalized, rawLower)) {
      return clip;
    }
  }
  return null;
}

/**
 * Reusable helper that binds an AnimationMixer onto a weapon model and maps
 * Draw, Fire/Shoot, Reload, Reload Empty, and Holster/Hide clips case-insensitively.
 */
export function setupWeaponAnimations(
  gltf: { animations: THREE.AnimationClip[] },
  model: THREE.Object3D,
): WeaponAnimationRig {
  const rawClips = gltf.animations || [];
  if (rawClips.length === 0) {
    return {
      mixer: null,
      drawAction: null,
      fireAction: null,
      reloadAction: null,
      reloadEmptyAction: null,
      holsterAction: null,
      inspectAction: null,
    };
  }

  const clips = rawClips.map(trimClipToActiveRange);
  const mixer = new THREE.AnimationMixer(model);

  const makeOnceAction = (clip: THREE.AnimationClip | null): THREE.AnimationAction | null => {
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    action.loop = THREE.LoopOnce;
    action.clampWhenFinished = true;
    return action;
  };

  const drawClip = findClipCaseInsensitive(clips, (norm) => norm.includes('draw') || norm.includes('equip'));
  const fireClip = findClipCaseInsensitive(clips, (norm) => norm.includes('fire') || norm.includes('shoot'));
  const reloadEmptyClip = findClipCaseInsensitive(
    clips,
    (norm) => norm.includes('reloadempty') || (norm.includes('reload') && norm.includes('empty')),
  );
  const reloadClip =
    findClipCaseInsensitive(clips, (norm) => norm.includes('reload') && !norm.includes('empty')) ||
    clips[0] ||
    null;
  const holsterClip = findClipCaseInsensitive(clips, (norm) => norm.includes('holster') || norm.includes('hide'));
  const inspectClip = findClipCaseInsensitive(
    clips,
    (norm) => norm.includes('inspect') || norm.includes('check') || norm.includes('idlelook'),
  );

  const reloadAction = makeOnceAction(reloadClip);

  return {
    mixer,
    drawAction: makeOnceAction(drawClip),
    fireAction: makeOnceAction(fireClip),
    reloadAction,
    reloadEmptyAction: makeOnceAction(reloadEmptyClip) || reloadAction,
    holsterAction: makeOnceAction(holsterClip),
    inspectAction: makeOnceAction(inspectClip),
  };
}

function createProceduralMagazineClip(magTargetName: string, gunBodyName: string): THREE.AnimationClip {
  const magPosTrack = new THREE.VectorKeyframeTrack(
    `${magTargetName}.position`,
    [0, 0.25, 0.55, 0.85, 1.05],
    [
      0, -0.075, 0.04,
      0, -0.28, 0.04,
      -0.06, -0.34, 0.06,
      0, -0.075, 0.04,
      0, -0.075, 0.04,
    ],
  );
  const tiltQ0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));
  const tiltQ1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0, 0.25));
  const tiltQ2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 0, -0.06));
  const gunTiltTrack = new THREE.QuaternionKeyframeTrack(
    `${gunBodyName}.quaternion`,
    [0, 0.25, 0.75, 1.05],
    [
      tiltQ0.x, tiltQ0.y, tiltQ0.z, tiltQ0.w,
      tiltQ1.x, tiltQ1.y, tiltQ1.z, tiltQ1.w,
      tiltQ2.x, tiltQ2.y, tiltQ2.z, tiltQ2.w,
      tiltQ0.x, tiltQ0.y, tiltQ0.z, tiltQ0.w,
    ],
  );
  return new THREE.AnimationClip('MagazineReload', 1.05, [magPosTrack, gunTiltTrack]);
}

function buildCompositeWeaponViewmodel(key: WeaponKey): {
  group: THREE.Group;
  magGroup: THREE.Group;
  bodyGroup: THREE.Group;
} {
  const group = new THREE.Group();
  const bodyGroup = new THREE.Group();
  bodyGroup.name = `WeaponBody_${key}`;
  group.add(bodyGroup);

  const gunmetal = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.34,
    metalness: 0.88,
  });
  const polymer = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.78,
    metalness: 0.12,
  });
  const brushedSteel = new THREE.MeshStandardMaterial({
    color: 0x64748b,
    roughness: 0.22,
    metalness: 0.94,
  });
  const opticGlass = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0xdc2626,
    emissiveIntensity: 1.4,
    roughness: 0.15,
    metalness: 0.5,
  });
  const amberAccent = new THREE.MeshStandardMaterial({
    color: 0xd97706,
    roughness: 0.4,
    metalness: 0.5,
  });

  const magGroup = new THREE.Group();
  magGroup.name = `WeaponMag_${key}`;

  if (key === 'mark23') {
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.046, 0.24), brushedSteel);
    slide.position.set(0, 0.028, -0.06);
    bodyGroup.add(slide);

    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.032, 0.2), polymer);
    frame.position.set(0, -0.006, -0.05);
    bodyGroup.add(frame);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.115, 0.052), polymer);
    grip.position.set(0, -0.068, 0.025);
    grip.rotation.x = 0.24;
    bodyGroup.add(grip);

    const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 12), gunmetal);
    suppressor.rotation.x = Math.PI * 0.5;
    suppressor.position.set(0, 0.024, -0.25);
    bodyGroup.add(suppressor);

    const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.012, 0.012), opticGlass);
    frontSight.position.set(0, 0.056, -0.16);
    bodyGroup.add(frontSight);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.11, 0.04), amberAccent);
    mag.rotation.x = 0.24;
    magGroup.add(mag);
    magGroup.position.set(0, -0.08, 0.028);
    bodyGroup.add(magGroup);
  } else {
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.088, 0.26), gunmetal);
    bodyGroup.add(receiver);

    const upperRail = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.02, 0.44), brushedSteel);
    upperRail.position.set(0, 0.052, -0.07);
    bodyGroup.add(upperRail);

    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.064, 0.24), polymer);
    handguard.position.set(0, 0.014, -0.24);
    bodyGroup.add(handguard);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.015, 0.28, 10), brushedSteel);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(0, 0.022, -0.44);
    bodyGroup.add(barrel);

    const flashHider = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.017, 0.06, 10), gunmetal);
    flashHider.rotation.x = Math.PI * 0.5;
    flashHider.position.set(0, 0.022, -0.58);
    bodyGroup.add(flashHider);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.11, 0.22), polymer);
    stock.position.set(0, -0.015, 0.22);
    bodyGroup.add(stock);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.11, 0.05), polymer);
    grip.position.set(0, -0.085, 0.08);
    grip.rotation.x = 0.28;
    bodyGroup.add(grip);

    const opticHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.044, 0.048, 0.075),
      key === 'm4fps' ? amberAccent : gunmetal,
    );
    opticHousing.position.set(0, 0.084, -0.02);
    bodyGroup.add(opticHousing);

    const opticDot = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 8), opticGlass);
    opticDot.position.set(0, 0.086, -0.02);
    bodyGroup.add(opticDot);

    const magMesh = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.16, 0.064), amberAccent);
    magMesh.rotation.x = -0.14;
    magGroup.add(magMesh);
    magGroup.position.set(0, -0.075, -0.05);
    bodyGroup.add(magGroup);
  }

  return { group, magGroup, bodyGroup };
}

async function loadSingleWeaponSlot(
  key: WeaponKey,
  profile?: RuntimePerfProfile,
): Promise<WeaponRigSlot> {
  const cfg = WEAPON_CONFIGS[key];
  const pivotGroup = new THREE.Group();
  pivotGroup.name = `WeaponPivot_${key}`;
  pivotGroup.position.set(...cfg.pos);
  pivotGroup.rotation.y = cfg.rotY;
  pivotGroup.scale.setScalar(cfg.scale);

  const candidateUrls = [cfg.url];
  for (const url of candidateUrls) {
    const buffer = await fetchValidGlbBuffer(url);
    if (!buffer) continue;
    try {
      const gltf = await parseGlbBuffer(buffer);
      const modelRoot = gltf.scene;
      modelRoot.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = false;
          child.receiveShadow = false;
          child.frustumCulled = false;
        }
      });

      if (profile) {
        optimizeObjectTexturesAndMaterials(modelRoot, profile);
      }

      // Keep loaded model inside its dedicated child pivotGroup so embedded animations never override hand placement
      pivotGroup.add(modelRoot);

      const animRig = setupWeaponAnimations(gltf, modelRoot);

      return {
        key,
        pivotGroup,
        modelRoot,
        ...animRig,
        isStatic: !animRig.mixer,
        isExternalGlb: true,
        muzzleLocal: new THREE.Vector3(...cfg.muzzleLocal),
        basePos: new THREE.Vector3(...cfg.pos),
        adsPos: new THREE.Vector3(...cfg.adsPos),
        baseRotY: cfg.rotY,
      };
    } catch (err) {
      console.warn(`Failed parsing ${cfg.name} from ${url}:`, err);
    }
  }

  // Fallback procedural viewmodel if external GLB could not load
  const fallback = buildCompositeWeaponViewmodel(key);
  pivotGroup.rotation.y = 0;
  pivotGroup.scale.setScalar(1.0);
  pivotGroup.position.set(0.24, -0.22, -0.48);
  pivotGroup.add(fallback.group);

  const clip = createProceduralMagazineClip(`WeaponMag_${key}`, `WeaponBody_${key}`);
  const animRig = setupWeaponAnimations({ animations: [clip] }, fallback.group);

  return {
    key,
    pivotGroup,
    modelRoot: fallback.group,
    ...animRig,
    isStatic: false,
    isExternalGlb: false,
    muzzleLocal: new THREE.Vector3(...cfg.muzzleLocal),
    basePos: new THREE.Vector3(0.24, -0.22, -0.48),
    adsPos: new THREE.Vector3(0, -0.15, -0.40),
    baseRotY: 0,
  };
}

export async function loadWeaponRig(
  camera: THREE.Camera,
  profile?: RuntimePerfProfile,
  isAborted?: () => boolean,
): Promise<LoadedGunRig> {
  const gunHolder = new THREE.Group();
  gunHolder.name = 'GunHolder';
  gunHolder.position.copy(GUN_POS);
  camera.add(gunHolder);

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(...WEAPON_CONFIGS.mark23.muzzleLocal);
  gunHolder.add(muzzlePoint);

  const muzzleFlashMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.4, 1.75, 0.55),
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const muzzleFlashMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.085, 0), muzzleFlashMat);
  muzzleFlashMesh.scale.set(1.2, 1.2, 2.2);
  muzzlePoint.add(muzzleFlashMesh);

  const slotsList = await runProgressiveTasks(
    WEAPON_ORDER.map((k) => () => loadSingleWeaponSlot(k, profile)),
    profile?.loaderConcurrency ?? WEAPON_ORDER.length,
    Boolean(profile?.progressiveLoadYield),
    isAborted,
  );

  const resolvedSlots: Partial<Record<WeaponKey, WeaponRigSlot>> = {};
  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const key = WEAPON_ORDER[i];
    const slot = slotsList[i] ?? (await loadSingleWeaponSlot(key, profile));
    slot.pivotGroup.visible = key === 'mark23';
    gunHolder.add(slot.pivotGroup);
    resolvedSlots[key] = slot;
  }

  return {
    root: gunHolder,
    muzzlePoint,
    muzzleFlashMesh,
    slots: resolvedSlots as Record<WeaponKey, WeaponRigSlot>,
  };
}

export function disposeWeaponRig(rig: LoadedGunRig | null | undefined): void {
  if (!rig) return;
  for (const k of WEAPON_ORDER) {
    const slot = rig.slots[k];
    if (!slot) continue;
    slot.mixer?.stopAllAction();
    slot.mixer?.uncacheRoot(slot.modelRoot);
    disposeObject3DResources(slot.modelRoot);
  }
  disposeObject3DResources(rig.muzzleFlashMesh);
  rig.root.parent?.remove(rig.root);
}

function createProceduralZombieTemplate(): ZombieTemplate {
  const root = new THREE.Group();
  root.name = 'ZombieRoot';

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0x5c6b57,
    roughness: 0.88,
    metalness: 0.05,
  });
  const tornClothMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.92,
    metalness: 0.08,
  });
  const bloodMat = new THREE.MeshStandardMaterial({
    color: 0x7f1d1d,
    roughness: 0.45,
    metalness: 0.1,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0xdc2626,
    emissiveIntensity: 2.2,
    roughness: 0.15,
  });

  // Pelvis pivot at 0.85m
  const pelvis = new THREE.Group();
  pelvis.name = 'ZPelvis';
  pelvis.position.set(0, 0.85, 0);
  root.add(pelvis);

  const hipMesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.16, 0.24), tornClothMat);
  pelvis.add(hipMesh);

  // Torso
  const torso = new THREE.Group();
  torso.name = 'ZTorso';
  torso.position.set(0, 0.08, 0);
  pelvis.add(torso);

  const chestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.26), tornClothMat);
  chestMesh.position.y = 0.28;
  torso.add(chestMesh);

  const woundPatch = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.28, 0.27), bloodMat);
  woundPatch.position.set(0.05, 0.26, 0);
  torso.add(woundPatch);

  // Head
  const headGroup = new THREE.Group();
  headGroup.name = 'ZHead';
  headGroup.position.set(0, 0.62, 0.04);
  torso.add(headGroup);

  const cranium = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.28, 0.26), skinMat);
  cranium.position.y = 0.14;
  headGroup.add(cranium);

  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.2), bloodMat);
  jaw.position.set(0, 0.02, 0.04);
  headGroup.add(jaw);

  for (const ex of [-0.055, 0.055]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), eyeMat);
    eye.position.set(ex, 0.16, 0.13);
    headGroup.add(eye);
  }

  // Outstretched Arms
  const armL = new THREE.Group();
  armL.name = 'ZArmL';
  armL.position.set(-0.29, 0.52, 0);
  const armLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.12), skinMat);
  armLMesh.position.set(0, -0.26, 0.22);
  armLMesh.rotation.x = -Math.PI * 0.42;
  armL.add(armLMesh);
  torso.add(armL);

  const armR = new THREE.Group();
  armR.name = 'ZArmR';
  armR.position.set(0.29, 0.52, 0);
  const armRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.12), skinMat);
  armRMesh.position.set(0, -0.26, 0.22);
  armRMesh.rotation.x = -Math.PI * 0.42;
  armR.add(armRMesh);
  torso.add(armR);

  // Legs
  const legL = new THREE.Group();
  legL.name = 'ZLegL';
  legL.position.set(-0.11, 0, 0);
  const legLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.85, 0.15), tornClothMat);
  legLMesh.position.y = -0.425;
  legL.add(legLMesh);
  pelvis.add(legL);

  const legR = new THREE.Group();
  legR.name = 'ZLegR';
  legR.position.set(0.11, 0, 0);
  const legRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.85, 0.15), tornClothMat);
  legRMesh.position.y = -0.425;
  legR.add(legRMesh);
  pelvis.add(legR);

  // Procedural looped walk/lurch AnimationClip
  const times = [0, 0.4, 0.8, 1.2, 1.6];
  const legSwing = 0.48;
  const qLegF = new THREE.Quaternion().setFromEuler(new THREE.Euler(legSwing, 0, 0));
  const qLegB = new THREE.Quaternion().setFromEuler(new THREE.Euler(-legSwing, 0, 0));
  const qZero = new THREE.Quaternion();

  const legLTrack = new THREE.QuaternionKeyframeTrack(
    'ZLegL.quaternion',
    times,
    [
      qZero.x, qZero.y, qZero.z, qZero.w,
      qLegF.x, qLegF.y, qLegF.z, qLegF.w,
      qZero.x, qZero.y, qZero.z, qZero.w,
      qLegB.x, qLegB.y, qLegB.z, qLegB.w,
      qZero.x, qZero.y, qZero.z, qZero.w,
    ],
  );
  const legRTrack = new THREE.QuaternionKeyframeTrack(
    'ZLegR.quaternion',
    times,
    [
      qZero.x, qZero.y, qZero.z, qZero.w,
      qLegB.x, qLegB.y, qLegB.z, qLegB.w,
      qZero.x, qZero.y, qZero.z, qZero.w,
      qLegF.x, qLegF.y, qLegF.z, qLegF.w,
      qZero.x, qZero.y, qZero.z, qZero.w,
    ],
  );

  const qTorsoL = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.14, 0, -0.07));
  const qTorsoR = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, 0, 0.07));
  const torsoTrack = new THREE.QuaternionKeyframeTrack(
    'ZTorso.quaternion',
    times,
    [
      qTorsoL.x, qTorsoL.y, qTorsoL.z, qTorsoL.w,
      qTorsoR.x, qTorsoR.y, qTorsoR.z, qTorsoR.w,
      qTorsoL.x, qTorsoL.y, qTorsoL.z, qTorsoL.w,
      qTorsoR.x, qTorsoR.y, qTorsoR.z, qTorsoR.w,
      qTorsoL.x, qTorsoL.y, qTorsoL.z, qTorsoL.w,
    ],
  );

  const pelvisBobTrack = new THREE.VectorKeyframeTrack(
    'ZPelvis.position',
    times,
    [
      0, 0.85, 0,
      0, 0.89, 0,
      0, 0.84, 0,
      0, 0.89, 0,
      0, 0.85, 0,
    ],
  );

  const walkClip = new THREE.AnimationClip('ZombieWalk', 1.6, [
    legLTrack,
    legRTrack,
    torsoTrack,
    pelvisBobTrack,
  ]);

  return {
    scene: root,
    animations: [walkClip],
    naturalClipSpeeds: new WeakMap([[walkClip, 2.2]]),
    isExternalGlb: false,
    scaleFactor: 1.0,
  };
}

function clipHasActualMotion(clip: THREE.AnimationClip): boolean {
  if (!clip || clip.tracks.length === 0 || clip.duration <= 0.05) return false;
  for (const track of clip.tracks) {
    const stride = track.getValueSize();
    const vals = track.values;
    if (vals.length < stride * 2) continue;
    for (let c = 0; c < stride; c++) {
      const first = vals[c];
      for (let i = c + stride; i < vals.length; i += stride) {
        if (Math.abs(vals[i] - first) > 0.001) {
          return true;
        }
      }
    }
  }
  return false;
}

function getWrapperBoneTransforms(
  wrapper: THREE.Object3D,
  trackName: string,
): { parentToWrapper: THREE.Matrix4; wrapperToParent: THREE.Matrix4 } | null {
  const dotIdx = trackName.indexOf('.');
  const nodeName = dotIdx > 0 ? trackName.slice(0, dotIdx) : trackName;
  const target = wrapper.getObjectByName(nodeName);
  if (!target?.parent) return null;

  wrapper.updateMatrixWorld(true);
  const wrapperInv = new THREE.Matrix4().copy(wrapper.matrixWorld).invert();
  const parentToWrapper = new THREE.Matrix4().multiplyMatrices(wrapperInv, target.parent.matrixWorld);
  const wrapperToParent = new THREE.Matrix4().copy(parentToWrapper).invert();
  return { parentToWrapper, wrapperToParent };
}

function sanitizeAndCalibrateClip(
  clip: THREE.AnimationClip,
  normalizedRoot: THREE.Object3D,
): { clip: THREE.AnimationClip; naturalSpeed: number } {
  const cloned = clip.clone();
  let naturalSpeed = 2.6;

  const p0 = new THREE.Vector3();
  const pEnd = new THREE.Vector3();
  const pt = new THREE.Vector3();

  for (const track of cloned.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const lower = track.name.toLowerCase();
    if (!lower.includes('hips') && !lower.includes('root')) continue;
    const values = track.values;
    if (values.length < 6) continue;

    const xforms = getWrapperBoneTransforms(normalizedRoot, track.name);
    if (!xforms) continue;
    const { parentToWrapper, wrapperToParent } = xforms;

    // Transform frame-0 and last frame into wrapper/world space (handles both Y-up FBX_Root & Blender +90X Armature)
    p0.set(values[0], values[1], values[2]).applyMatrix4(parentToWrapper);
    pEnd.set(
      values[values.length - 3],
      values[values.length - 2],
      values[values.length - 1],
    ).applyMatrix4(parentToWrapper);

    let maxHorizSpan = 0;
    for (let i = 0; i < values.length; i += 3) {
      pt.set(values[i], values[i + 1], values[i + 2]).applyMatrix4(parentToWrapper);
      const span = Math.hypot(pt.x - p0.x, pt.z - p0.z);
      if (span > maxHorizSpan) maxHorizSpan = span;
    }

    const netTravelWorld = Math.hypot(pEnd.x - p0.x, pEnd.z - p0.z);
    if (netTravelWorld > 0.15 && cloned.duration > 0.05) {
      naturalSpeed = THREE.MathUtils.clamp(netTravelWorld / cloned.duration, 0.25, 6.0);
    }

    // Lock horizontal travel (X, Z in wrapper space) to frame-0 while keeping true vertical height (Y) intact
    if (maxHorizSpan > 0.12) {
      for (let i = 0; i < values.length; i += 3) {
        pt.set(values[i], values[i + 1], values[i + 2]).applyMatrix4(parentToWrapper);
        pt.x = p0.x;
        pt.z = p0.z;
        pt.applyMatrix4(wrapperToParent);
        values[i] = pt.x;
        values[i + 1] = pt.y;
        values[i + 2] = pt.z;
      }
    }
  }

  return { clip: cloned, naturalSpeed };
}

function normalizeZombieRoot(
  object: THREE.Group,
  animations: THREE.AnimationClip[],
  isExternalAsset: boolean,
): ZombieTemplate {
  object.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(object);
  const rawSize = new THREE.Vector3();
  rawBox.getSize(rawSize);

  const scaleFactor = rawSize.y > 0.01 ? ZOMBIE_TARGET_HEIGHT / rawSize.y : 1.0;
  object.scale.multiplyScalar(scaleFactor);
  object.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(object);
  const scaledCenter = new THREE.Vector3();
  scaledBox.getCenter(scaledCenter);

  // Wrap in a bottom-center pivoted group so feet sit cleanly at y = 0
  const wrapper = new THREE.Group();
  object.position.x -= scaledCenter.x;
  object.position.y -= scaledBox.min.y;
  object.position.z -= scaledCenter.z;
  wrapper.add(object);
  wrapper.updateMatrixWorld(true);

  const activeClips = animations.filter(clipHasActualMotion);
  const sourceClips = activeClips.length > 0 ? activeClips : animations;

  const naturalClipSpeeds = new WeakMap<THREE.AnimationClip, number>();
  const processedClips = sourceClips.map((raw) => {
    const { clip, naturalSpeed } = sanitizeAndCalibrateClip(raw, wrapper);
    naturalClipSpeeds.set(clip, naturalSpeed);
    return clip;
  });

  return {
    scene: wrapper,
    animations: processedClips,
    naturalClipSpeeds,
    isExternalGlb: isExternalAsset,
    scaleFactor,
  };
}

async function loadSingleEnemyTemplate(
  urls: string[],
  label: string,
  profile?: RuntimePerfProfile,
): Promise<ZombieTemplate> {
  for (const url of urls) {
    const buffer = await fetchValidGlbBuffer(url);
    if (!buffer) continue;
    try {
      const gltf = await parseGlbBuffer(buffer);
      const tpl = normalizeZombieRoot(gltf.scene, gltf.animations, true);
      if (profile) {
        optimizeObjectTexturesAndMaterials(tpl.scene, profile);
      }
      return tpl;
    } catch (err) {
      console.warn(`Failed to parse ${label} GLB from ${url}:`, err);
    }
  }
  return createProceduralZombieTemplate();
}

export async function loadEnemyRoster(
  onProgress?: (loaded: number, total: number) => void,
  profile?: RuntimePerfProfile,
  isAborted?: () => boolean,
): Promise<EnemyRoster> {
  const keys = Object.keys(ZOMBIE_ASSET_SOURCES) as ZombieArchetype[];
  const total = keys.length;
  let loaded = 0;

  const loadedTemplates = await runProgressiveTasks(
    keys.map((key) => async () => {
      const spec = ZOMBIE_ASSET_SOURCES[key];
      const tpl = await loadSingleEnemyTemplate(spec.urls, spec.label, profile);
      loaded += 1;
      onProgress?.(loaded, total);
      return tpl;
    }),
    profile?.loaderConcurrency ?? 2,
    Boolean(profile?.progressiveLoadYield),
    isAborted,
  );

  const roster = {} as EnemyRoster;
  for (let i = 0; i < keys.length; i++) {
    roster[keys[i]] = loadedTemplates[i] ?? createProceduralZombieTemplate();
  }
  return roster;
}

export function disposeEnemyRoster(roster: EnemyRoster | null | undefined): void {
  if (!roster) return;
  for (const key of Object.keys(roster) as ZombieArchetype[]) {
    disposeObject3DResources(roster[key]?.scene);
  }
}

function selectLocomotionClips(animations: THREE.AnimationClip[]): {
  walkClip: THREE.AnimationClip | null;
  runClip: THREE.AnimationClip | null;
  idleClip: THREE.AnimationClip | null;
  attackClip: THREE.AnimationClip | null;
} {
  if (!animations || animations.length === 0) {
    return { walkClip: null, runClip: null, idleClip: null, attackClip: null };
  }

  const walkNamed = animations.find((c) => /\bwalk\b|walking|zombie.?walk|shamble/i.test(c.name));
  const runNamed = animations.find((c) => /\brun\b|running|sprint|chase/i.test(c.name));
  const idleNamed = animations.find((c) => /\bidle\b|stand/i.test(c.name));
  const attackNamed = animations.find((c) => /\battack\b|bite|swipe|hit/i.test(c.name));

  const fallbackPrimary =
    animations.find((c) => c !== idleNamed && c !== attackNamed) || animations[0];

  const walkClip = walkNamed || fallbackPrimary;
  const runClip = runNamed || walkClip;

  return {
    walkClip,
    runClip,
    idleClip: idleNamed || null,
    attackClip: attackNamed || null,
  };
}

interface ArchetypeStats {
  variant: 'walker' | 'screamer';
  baseHp: number;
  baseSpeed: number;
  maxWaveSpeedBonus: number;
  waveSpeedStep: number;
  minTimeScale: number;
  maxTimeScale: number;
  minNaturalRef: number;
  stopDistance: number;
  attackRange: number;
}

const ARCHETYPE_TUNING: Record<ZombieArchetype, ArchetypeStats> = {
  runner: {
    variant: 'screamer',
    baseHp: 115,
    baseSpeed: 3.45,
    maxWaveSpeedBonus: 1.65,
    waveSpeedStep: 0.18,
    minTimeScale: 0.95,
    maxTimeScale: 2.1,
    minNaturalRef: 2.4,
    stopDistance: 1.45,
    attackRange: 1.75,
  },
  walker_survivor: {
    variant: 'walker',
    baseHp: 155,
    baseSpeed: 1.25,
    maxWaveSpeedBonus: 0.65,
    waveSpeedStep: 0.08,
    minTimeScale: 1.5,
    maxTimeScale: 2.95,
    minNaturalRef: 0.5,
    stopDistance: 1.45,
    attackRange: 1.75,
  },
  walker_yaku: {
    variant: 'walker',
    baseHp: 150,
    baseSpeed: 1.35,
    maxWaveSpeedBonus: 0.7,
    waveSpeedStep: 0.09,
    minTimeScale: 1.6,
    maxTimeScale: 3.05,
    minNaturalRef: 0.48,
    stopDistance: 1.45,
    attackRange: 1.75,
  },
  walker_shambler: {
    variant: 'walker',
    baseHp: 175,
    baseSpeed: 1.4,
    maxWaveSpeedBonus: 0.65,
    waveSpeedStep: 0.08,
    minTimeScale: 1.65,
    maxTimeScale: 3.05,
    minNaturalRef: 0.48,
    stopDistance: 1.45,
    attackRange: 1.75,
  },
  crawler: {
    variant: 'walker',
    baseHp: 95,
    baseSpeed: 0.98,
    maxWaveSpeedBonus: 0.52,
    waveSpeedStep: 0.07,
    minTimeScale: 1.65,
    maxTimeScale: 2.95,
    minNaturalRef: 0.42,
    stopDistance: 1.25,
    attackRange: 1.55,
  },
};

const SHARED_ZOMBIE_HITBOX_MAT = new THREE.MeshBasicMaterial({ visible: false });
const SHARED_ZOMBIE_HITBOX_GEOS = {
  crawler: new THREE.BoxGeometry(1.3, 1.35, 1.5),
  standing: new THREE.BoxGeometry(1.0, 1.9, 1.0),
  boss: new THREE.BoxGeometry(1.65, 1.9 * 1.65, 1.65),
};

export function spawnZombieFromTemplate(
  template: ZombieTemplate,
  id: number,
  archetype: ZombieArchetype,
  wave: number,
  position: THREE.Vector3,
  isSoftwareGl: boolean,
  isBoss = false,
): ZombieEntity {
  const root = new THREE.Group();
  root.position.copy(position);

  const visual = SkeletonUtils.clone(template.scene) as THREE.Group;
  const bossScale = isBoss ? 1.65 : 1.0;
  if (isBoss) {
    visual.scale.multiplyScalar(bossScale);
  }
  const tuning = ARCHETYPE_TUNING[archetype];
  const variant = tuning.variant;

  const materials: Array<
    THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial
  > = [];
  const baseEmissives: THREE.Color[] = [];

  void isSoftwareGl;
  visual.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        mesh.frustumCulled = false;
      }
      // Clone only material wrapper (preserving exact original textures, colors, alpha modes, and PBR values)
      // so per-instance damage flash or boss aura doesn't affect other zombies.
      if (mesh.material) {
        const cloneMat = (m: THREE.Material) => {
          const cloned = m.clone();
          if (
            !cloned.transparent &&
            ((cloned as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
              (cloned as THREE.MeshPhongMaterial).isMeshPhongMaterial ||
              (cloned as THREE.MeshLambertMaterial).isMeshLambertMaterial)
          ) {
            const litMat = cloned as
              | THREE.MeshStandardMaterial
              | THREE.MeshPhongMaterial
              | THREE.MeshLambertMaterial;
            if (isBoss) {
              litMat.emissive.setHex(0xb91c1c);
              if ('emissiveIntensity' in litMat) {
                litMat.emissiveIntensity = Math.max(litMat.emissiveIntensity ?? 0, 0.7);
              }
            }
            materials.push(litMat);
            baseEmissives.push(litMat.emissive.clone());
          }
          return cloned;
        };
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(cloneMat);
        } else {
          mesh.material = cloneMat(mesh.material);
        }
      }
    }
  });

  root.add(visual);

  const bossLight: THREE.PointLight | null = null;

  const waveHpScale = 1 + (wave - 1) * 0.2;
  const maxHp = isBoss
    ? Math.round((45 + wave * 25) * 10)
    : Math.round(tuning.baseHp * waveHpScale);
  const speed = isBoss
    ? 2.05 + Math.min(0.85, (wave - 1) * 0.1)
    : tuning.baseSpeed + Math.min(tuning.maxWaveSpeedBonus, (wave - 1) * tuning.waveSpeedStep);

  const mixer = new THREE.AnimationMixer(visual);
  const { walkClip, runClip, idleClip, attackClip } = selectLocomotionClips(template.animations);
  const chosenLocomotionClip = archetype === 'runner' ? runClip : walkClip;

  let walkAction: THREE.AnimationAction | null = null;
  let baseTimeScale = 1.0;

  if (chosenLocomotionClip) {
    const naturalSpeed = template.naturalClipSpeeds.get(chosenLocomotionClip) ?? tuning.minNaturalRef;
    const effectiveNatural = Math.max(tuning.minNaturalRef, naturalSpeed);
    baseTimeScale = THREE.MathUtils.clamp(
      speed / effectiveNatural,
      tuning.minTimeScale,
      tuning.maxTimeScale,
    );
    walkAction = mixer.clipAction(chosenLocomotionClip);
    walkAction.enabled = true;
    walkAction.setEffectiveWeight(1);
    walkAction.loop = THREE.LoopRepeat;
    walkAction.time = Math.random() * Math.max(0.1, chosenLocomotionClip.duration);
    walkAction.timeScale = baseTimeScale;
    walkAction.play();
  }

  let idleAction: THREE.AnimationAction | null = null;
  if (idleClip) {
    idleAction = mixer.clipAction(idleClip);
    idleAction.loop = THREE.LoopRepeat;
    idleAction.enabled = true;
    idleAction.setEffectiveWeight(0);
    idleAction.play();
  }

  let attackAction: THREE.AnimationAction | null = null;
  if (attackClip) {
    attackAction = mixer.clipAction(attackClip);
    attackAction.loop = THREE.LoopOnce;
    attackAction.clampWhenFinished = false;
  }

  // Dedicated Oversized Invisible Hitbox Mesh (shared geometry & material, never raycast skinned triangles)
  const isCrawler = archetype === 'crawler' && !isBoss;

  const boxW = isCrawler ? 1.3 : 1.0 * bossScale;
  const boxH = isCrawler ? 1.35 : 1.9 * bossScale;
  const boxD = isCrawler ? 1.5 : 1.0 * bossScale;
  const centerY = isCrawler ? 0.65 : 0.95 * bossScale;

  const hitboxGeo = isCrawler
    ? SHARED_ZOMBIE_HITBOX_GEOS.crawler
    : isBoss
      ? SHARED_ZOMBIE_HITBOX_GEOS.boss
      : SHARED_ZOMBIE_HITBOX_GEOS.standing;
  const hitbox = new THREE.Mesh(hitboxGeo, SHARED_ZOMBIE_HITBOX_MAT);
  hitbox.position.set(0, centerY, 0);
  hitbox.layers.set(1);
  root.add(hitbox);

  const entity: ZombieEntity = {
    id,
    root,
    visual,
    mixer,
    walkAction,
    idleAction,
    attackAction,
    baseTimeScale,
    hitbox,
    hitboxExtents: {
      halfX: boxW * 0.5,
      halfY: boxH * 0.5,
      halfZ: boxD * 0.5,
      centerY,
      // Crawlers: front (z > 0.25) or upper 30% height; Standing/Boss: upper 25% height
      headMinY: isCrawler ? centerY + boxH * 0.2 : 1.42 * bossScale,
      headMinZ: isCrawler ? 0.25 : undefined,
    },
    hp: maxHp,
    maxHp,
    speed,
    stopDistance: isBoss ? 1.95 : tuning.stopDistance,
    attackRange: isBoss ? 2.4 : tuning.attackRange,
    attackCooldown: 0,
    hitFlashTimer: 0,
    staggerVel: new THREE.Vector3(),
    staggerTimer: 0,
    collapseDir: Math.random() < 0.5 ? 1 : -1,
    collapseAxis: isCrawler || Math.random() < 0.35 ? 'z' : 'x',
    isDead: false,
    isBoss,
    deathTimer: 0,
    archetype,
    variant,
    groanTimer: 1.5 + Math.random() * 4.5,
    walkPhase: Math.random() * Math.PI * 2,
    poolKey: archetype,
    isBossSlot: isBoss,
    bossLight,
    materials,
    baseEmissives,
  };

  hitbox.userData = { zombie: entity };

  return entity;
}

export class ZombiePool {
  private readonly buckets = new Map<string, ZombieEntity[]>();
  private maxPerArchetypeBucket = 28;

  private getKey(archetype: ZombieArchetype, isBoss: boolean): string {
    return `${archetype}:${isBoss ? 'boss' : 'std'}`;
  }

  public setPoolLimits(maxPerArch: number): void {
    this.maxPerArchetypeBucket = Math.max(2, maxPerArch);
    for (const [key, list] of this.buckets.entries()) {
      const cap = key.endsWith(':boss') ? Math.min(2, this.maxPerArchetypeBucket) : this.maxPerArchetypeBucket;
      while (list.length > cap) {
        const z = list.pop()!;
        z.mixer.stopAllAction();
        z.mixer.uncacheRoot(z.visual);
        for (const m of z.materials) {
          m.dispose();
        }
      }
    }
  }

  public prewarm(roster: EnemyRoster, isSoftwareGl: boolean, prewarmPerArch = 2): void {
    const archetypes: ZombieArchetype[] = [
      'runner',
      'walker_survivor',
      'walker_yaku',
      'walker_shambler',
      'crawler',
    ];
    const tmpPos = new THREE.Vector3(0, -100, 0);
    const targetPerArch = Math.max(0, Math.min(prewarmPerArch, this.maxPerArchetypeBucket));
    for (const arch of archetypes) {
      const key = this.getKey(arch, false);
      const existing = this.buckets.get(key) ?? [];
      while (existing.length < targetPerArch) {
        const z = spawnZombieFromTemplate(roster[arch], -1, arch, 1, tmpPos, isSoftwareGl, false);
        z.root.visible = false;
        z.mixer.stopAllAction();
        z.root.remove(z.hitbox);
        existing.push(z);
      }
      this.buckets.set(key, existing);
    }

    if (prewarmPerArch > 0) {
      for (const bossArch of ['walker_shambler', 'walker_yaku'] as ZombieArchetype[]) {
        const key = this.getKey(bossArch, true);
        const existing = this.buckets.get(key) ?? [];
        if (existing.length === 0) {
          const boss = spawnZombieFromTemplate(roster[bossArch], -1, bossArch, 1, tmpPos, isSoftwareGl, true);
          boss.root.visible = false;
          boss.mixer.stopAllAction();
          boss.root.remove(boss.hitbox);
          existing.push(boss);
          this.buckets.set(key, existing);
        }
      }
    }
  }

  public acquire(
    template: ZombieTemplate,
    id: number,
    archetype: ZombieArchetype,
    wave: number,
    position: THREE.Vector3,
    isSoftwareGl: boolean,
    isBoss = false,
  ): ZombieEntity {
    const key = this.getKey(archetype, isBoss);
    const list = this.buckets.get(key);
    const reused = list && list.length > 0 ? list.pop()! : null;

    if (!reused) {
      return spawnZombieFromTemplate(
        template,
        id,
        archetype,
        wave,
        position,
        isSoftwareGl,
        isBoss,
      );
    }

    const tuning = ARCHETYPE_TUNING[archetype];
    const waveHpScale = 1 + (wave - 1) * 0.2;
    const maxHp = isBoss
      ? Math.round((45 + wave * 25) * 10)
      : Math.round(tuning.baseHp * waveHpScale);
    const speed = isBoss
      ? 2.05 + Math.min(0.85, (wave - 1) * 0.1)
      : tuning.baseSpeed + Math.min(tuning.maxWaveSpeedBonus, (wave - 1) * tuning.waveSpeedStep);

    let baseTimeScale = reused.baseTimeScale;
    if (reused.walkAction) {
      const clip = reused.walkAction.getClip();
      const naturalSpeed = template.naturalClipSpeeds.get(clip) ?? tuning.minNaturalRef;
      const effectiveNatural = Math.max(tuning.minNaturalRef, naturalSpeed);
      baseTimeScale = THREE.MathUtils.clamp(
        speed / effectiveNatural,
        tuning.minTimeScale,
        tuning.maxTimeScale,
      );
      reused.walkAction.reset();
      reused.walkAction.enabled = true;
      reused.walkAction.setEffectiveWeight(1);
      reused.walkAction.time = Math.random() * Math.max(0.1, clip.duration);
      reused.walkAction.timeScale = baseTimeScale;
      reused.walkAction.play();
    }
    if (reused.idleAction) {
      reused.idleAction.reset();
      reused.idleAction.enabled = true;
      reused.idleAction.setEffectiveWeight(0);
      reused.idleAction.play();
    }
    if (reused.attackAction) {
      reused.attackAction.stop();
    }

    reused.id = id;
    reused.hp = maxHp;
    reused.maxHp = maxHp;
    reused.speed = speed;
    reused.baseTimeScale = baseTimeScale;
    reused.attackCooldown = 0;
    reused.hitFlashTimer = 0;
    reused.staggerVel.set(0, 0, 0);
    reused.staggerTimer = 0;
    reused.collapseDir = Math.random() < 0.5 ? 1 : -1;
    reused.collapseAxis = archetype === 'crawler' && !isBoss || Math.random() < 0.35 ? 'z' : 'x';
    reused.isDead = false;
    reused.killedByWolf = false;
    reused.deathTimer = 0;
    reused.groanTimer = 1.5 + Math.random() * 4.5;
    reused.walkPhase = Math.random() * Math.PI * 2;
    reused.lodAnimAccum = 0;
    reused.avoidTimer = 0;
    reused.avoidSign = (id & 1) ? 1 : -1;

    reused.root.position.copy(position);
    reused.root.rotation.set(0, 0, 0);
    reused.root.visible = true;
    reused.visual.position.set(0, 0, 0);
    reused.visual.rotation.set(0, 0, 0);

    for (let i = 0; i < reused.materials.length; i++) {
      reused.materials[i].emissive.copy(reused.baseEmissives[i]);
    }
    if (!reused.hitbox.parent) {
      reused.root.add(reused.hitbox);
    }
    reused.hitbox.visible = true;
    reused.hitbox.userData = { zombie: reused };

    if (reused.bossLight) {
      reused.bossLight.visible = true;
    }

    return reused;
  }

  public release(z: ZombieEntity, scene: THREE.Scene): void {
    scene.remove(z.root);
    z.root.visible = false;
    z.mixer.stopAllAction();
    if (z.bossLight) {
      z.bossLight.visible = false;
    }
    if (z.hitbox.parent) {
      z.root.remove(z.hitbox);
    }

    const key = this.getKey(z.poolKey ?? z.archetype, z.isBossSlot ?? z.isBoss);
    const maxCap = (z.isBossSlot ?? z.isBoss)
      ? Math.min(4, this.maxPerArchetypeBucket)
      : this.maxPerArchetypeBucket;
    let list = this.buckets.get(key);
    if (!list) {
      list = [];
      this.buckets.set(key, list);
    }

    if (list.length < maxCap) {
      list.push(z);
    } else {
      z.mixer.uncacheRoot(z.visual);
      for (const m of z.materials) {
        m.dispose();
      }
    }
  }

  public disposeAll(): void {
    for (const list of this.buckets.values()) {
      for (const z of list) {
        z.mixer.stopAllAction();
        z.mixer.uncacheRoot(z.visual);
        for (const m of z.materials) {
          m.dispose();
        }
      }
    }
    this.buckets.clear();
  }
}

function findDireWolfClip(
  clips: THREE.AnimationClip[],
  keyword: string,
): THREE.AnimationClip | null {
  const lowerKw = keyword.toLowerCase();
  const exact = clips.find((c) => c.name.trim().toLowerCase() === lowerKw);
  if (exact) return exact;
  const wordMatch = clips.find((c) => new RegExp(`\\b${lowerKw}\\b`, 'i').test(c.name));
  if (wordMatch) return wordMatch;
  return clips.find((c) => c.name.toLowerCase().includes(lowerKw)) || null;
}

function collectDireWolfMaterials(
  root: THREE.Object3D,
  isSoftwareGl: boolean,
): {
  materials: Array<THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial>;
  baseEmissives: THREE.Color[];
} {
  const materials: Array<
    THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial
  > = [];
  const baseEmissives: THREE.Color[] = [];

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = !isSoftwareGl;
    mesh.receiveShadow = !isSoftwareGl;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      mesh.frustumCulled = false;
    }
    if (!mesh.material) return;

    const cloneMat = (m: THREE.Material) => {
      const cloned = m.clone();
      if (
        !cloned.transparent &&
        ((cloned as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
          (cloned as THREE.MeshPhongMaterial).isMeshPhongMaterial ||
          (cloned as THREE.MeshLambertMaterial).isMeshLambertMaterial)
      ) {
        const lit = cloned as
          | THREE.MeshStandardMaterial
          | THREE.MeshPhongMaterial
          | THREE.MeshLambertMaterial;
        materials.push(lit);
        baseEmissives.push(lit.emissive.clone());
      }
      return cloned;
    };

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(cloneMat);
    } else {
      mesh.material = cloneMat(mesh.material);
    }
  });

  return { materials, baseEmissives };
}

function buildFallbackDireWolfCompanion(isSoftwareGl: boolean): DireWolfCompanion {
  const root = new THREE.Group();
  const visual = new THREE.Group();
  visual.name = 'DireWolfVisual';

  const furMat = new THREE.MeshStandardMaterial({
    color: 0x475569,
    roughness: 0.82,
    metalness: 0.1,
  });
  const maneMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.88,
    metalness: 0.08,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0xd97706,
    emissiveIntensity: 1.9,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.46, 0.98), furMat);
  body.position.set(0, 0.66, 0);
  visual.add(body);

  const mane = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.5, 0.42), maneMat);
  mane.position.set(0, 0.7, 0.28);
  visual.add(mane);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.36), furMat);
  head.position.set(0, 0.92, 0.6);
  visual.add(head);

  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.15, 0.24), maneMat);
  snout.position.set(0, 0.86, 0.84);
  visual.add(snout);

  for (const ex of [-0.085, 0.085]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), furMat);
    ear.position.set(ex, 1.12, 0.54);
    visual.add(ear);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), eyeMat);
    eye.position.set(ex * 1.1, 0.95, 0.78);
    visual.add(eye);
  }

  for (const [lx, lz] of [
    [-0.15, 0.32],
    [0.15, 0.32],
    [-0.15, -0.34],
    [0.15, -0.34],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.13), furMat);
    leg.position.set(lx, 0.25, lz);
    visual.add(leg);
  }

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.46), maneMat);
  tail.position.set(0, 0.72, -0.66);
  tail.rotation.x = -0.4;
  visual.add(tail);

  const { materials, baseEmissives } = collectDireWolfMaterials(visual, isSoftwareGl);
  root.add(visual);

  const mixer = new THREE.AnimationMixer(visual);
  const bobTrack = new THREE.VectorKeyframeTrack(
    'DireWolfVisual.position',
    [0, 0.4, 0.8],
    [0, 0, 0, 0, 0.03, 0, 0, 0, 0],
  );
  const idleClip = new THREE.AnimationClip('idle', 0.8, [bobTrack]);
  const biteTrack = new THREE.VectorKeyframeTrack(
    'DireWolfVisual.position',
    [0, 0.15, 0.45],
    [0, 0, 0, 0, 0.08, 0.25, 0, 0, 0],
  );
  const biteClip = new THREE.AnimationClip('bite', 0.45, [biteTrack]);

  const idleAction = mixer.clipAction(idleClip);
  idleAction.loop = THREE.LoopRepeat;
  idleAction.play();

  const biteAction = mixer.clipAction(biteClip);
  biteAction.loop = THREE.LoopOnce;
  biteAction.clampWhenFinished = false;

  return {
    root,
    visual,
    mixer,
    actions: {
      idle: idleAction,
      walk: idleAction,
      run: idleAction,
      bite: biteAction,
    },
    currentAction: idleAction,
    currentState: 'idle',
    halfLength: 0.72,
    biteAnimDuration: 0.7,
    biteWindowTimer: 0,
    pendingBiteImpactTimer: 0,
    pendingBiteTargetId: null,
    pendingBiteDamage: 0,
    lungeOffset: 0,
    maxHp: 150,
    currentHp: 150,
    isDowned: false,
    biteDamage: 55,
    runSpeed: 8.8,
    walkSpeed: 4.5,
    attackDelay: 1.0,
    attackCooldown: 0,
    hitFlashTimer: 0,
    targetZombieId: null,
    alertCooldown: 0,
    statusLabel: 'GUARDING',
    upgrades: {
      biteDamage: 0,
      maxHealth: 0,
      agilityFerocity: 0,
    },
    materials,
    baseEmissives,
  };
}

export async function loadDireWolfCompanion(
  isSoftwareGl: boolean,
  profile?: RuntimePerfProfile,
): Promise<DireWolfCompanion> {
  try {
    let scene: THREE.Group | null = null;
    let animations: THREE.AnimationClip[] = [];

    const buffer = await fetchValidGlbBuffer(DIRE_WOLF_URL);
    if (buffer) {
      const parsed = await parseGlbBuffer(buffer);
      scene = parsed.scene;
      animations = parsed.animations;
    } else {
      const gltf = await gltfLoader.loadAsync(DIRE_WOLF_URL);
      scene = gltf.scene;
      animations = gltf.animations || [];
    }

    if (profile) {
      optimizeObjectTexturesAndMaterials(scene, profile);
    }
    const { materials, baseEmissives } = collectDireWolfMaterials(
      scene,
      isSoftwareGl || Boolean(profile && !profile.allowShadows),
    );

    // Scale Dire Wolf to match player and zombies & ground cleanly at y = 0
    scene.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(scene);
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);
    const scaleFactor = rawSize.y > 0.01 ? DIRE_WOLF_TARGET_HEIGHT / rawSize.y : 1.0;
    scene.scale.multiplyScalar(scaleFactor);
    scene.updateMatrixWorld(true);

    const scaledBox = new THREE.Box3().setFromObject(scene);
    const scaledCenter = new THREE.Vector3();
    const scaledSize = new THREE.Vector3();
    scaledBox.getCenter(scaledCenter);
    scaledBox.getSize(scaledSize);

    const wolfHalfLength = scaledBox.isEmpty()
      ? 0.72
      : THREE.MathUtils.clamp(Math.max(scaledSize.z, scaledSize.x) * 0.5, 0.55, 0.92);

    const visual = new THREE.Group();
    visual.name = 'DireWolfVisual';
    if (!scaledBox.isEmpty()) {
      scene.position.x -= scaledCenter.x;
      scene.position.y -= scaledBox.min.y;
      scene.position.z -= scaledCenter.z;
    }
    visual.add(scene);

    const root = new THREE.Group();
    root.name = 'DireWolfCompanionRoot';
    root.add(visual);

    // Case-insensitive clip mapping: idle, walk, run (LoopRepeat) and bite (LoopOnce, no clampWhenFinished)
    const mixer = new THREE.AnimationMixer(visual);
    const makeRepeatAction = (clip: THREE.AnimationClip | null): THREE.AnimationAction | null => {
      if (!clip) return null;
      const action = mixer.clipAction(clip);
      action.loop = THREE.LoopRepeat;
      action.clampWhenFinished = false;
      action.enabled = true;
      return action;
    };

    const idleClip = findDireWolfClip(animations, 'idle') || animations[0] || null;
    const walkClip = findDireWolfClip(animations, 'walk');
    const runClip = findDireWolfClip(animations, 'run');
    const biteClip = findDireWolfClip(animations, 'bite') || findDireWolfClip(animations, 'attack');

    const idleAction = makeRepeatAction(idleClip);
    const walkAction = makeRepeatAction(walkClip) || idleAction;
    const runAction = makeRepeatAction(runClip) || walkAction || idleAction;

    let biteAction: THREE.AnimationAction | null = null;
    if (biteClip) {
      biteAction = mixer.clipAction(biteClip);
      biteAction.loop = THREE.LoopOnce;
      biteAction.clampWhenFinished = false;
      biteAction.enabled = true;
    }

    const biteAnimDuration = 0.7;

    if (idleAction) {
      idleAction.reset();
      idleAction.setEffectiveWeight(1);
      idleAction.play();
    }

    return {
      root,
      visual,
      mixer,
      actions: {
        idle: idleAction,
        walk: walkAction,
        run: runAction,
        bite: biteAction || runAction || idleAction,
      },
      currentAction: idleAction,
      currentState: 'idle',
      halfLength: wolfHalfLength,
      biteAnimDuration,
      biteWindowTimer: 0,
      pendingBiteImpactTimer: 0,
      pendingBiteTargetId: null,
      pendingBiteDamage: 0,
      lungeOffset: 0,
      maxHp: 150,
      currentHp: 150,
      isDowned: false,
      biteDamage: 55,
      runSpeed: 8.8,
      walkSpeed: 4.5,
      attackDelay: 1.0,
      attackCooldown: 0,
      hitFlashTimer: 0,
      targetZombieId: null,
      alertCooldown: 0,
      statusLabel: 'GUARDING',
      upgrades: {
        biteDamage: 0,
        maxHealth: 0,
        agilityFerocity: 0,
      },
      materials,
      baseEmissives,
    };
  } catch (err) {
    console.warn('Failed to load Dire Wolf GLB, using fallback companion:', err);
    return buildFallbackDireWolfCompanion(isSoftwareGl);
  }
}

export function disposeDireWolf(wolf: DireWolfCompanion | null | undefined, scene: THREE.Scene): void {
  if (!wolf) return;
  wolf.mixer.stopAllAction();
  wolf.mixer.uncacheRoot(wolf.visual);
  disposeObject3DResources(wolf.visual);
  for (const mat of wolf.materials) {
    mat.dispose();
  }
  scene.remove(wolf.root);
}
