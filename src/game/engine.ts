import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { buildQuarantineArena, type ArenaResult } from './arena';
import { TacticalAudioEngine } from './audio';
import { BloodEffectsSystem } from './bloodFx';
import {
  ActorSeparationGrid,
  StaticColliderGrid,
  hasStaticLineOfSight,
  pointBlockedByStaticColliders,
  resolveCircleColliders,
  resolveCircleMovement,
} from './colliders';
import {
  HybridControls,
  createDefaultTouchHudLayout,
} from './controls';
import { loadAndIntegrateProps, type PropPackResult } from './props';
import { DynamicWeatherSystem } from './weather';
import { loadAndIntegrateVehicles, type VehiclePackResult } from './vehicles';
import {
  GUN_POS,
  WEAPON_CONFIGS,
  WEAPON_ORDER,
  ZombiePool,
  disposeDireWolf,
  disposeEnemyRoster,
  disposeWeaponRig,
  loadDireWolfCompanion,
  loadEnemyRoster,
  loadWeaponRig,
  type EnemyRoster,
  type LoadedGunRig,
} from './models';
import {
  detectMobileBrowserEnvironment,
  resolveRuntimePerfProfile,
  yieldToMainThread,
  type RuntimePerfProfile,
} from './performance';
import type {
  BestRecord,
  DireWolfAnimState,
  DireWolfCompanion,
  GameState,
  GraphicsQuality,
  MobilePresetMode,
  PcSettings,
  PickupEntity,
  ShellCasing3D,
  SparkParticle3D,
  TouchControlId,
  TouchHudLayout,
  Tracer3D,
  UpgradeStatKey,
  WeaponConfig,
  WeaponKey,
  WolfUpgradeKey,
  WolfUpgrades,
  ZombieArchetype,
  ZombieEntity,
} from './types';

const BEST_RECORD_STORAGE_KEY = 'outbreak_last_stand_best_v1';
const PC_SETTINGS_STORAGE_KEY = 'outbreak_last_stand_pc_settings_v1';
const HUD_LAYOUT_STORAGE_KEY = 'outbreak_last_stand_touch_hud_v1';
const TIME_DILATION_FACTOR = 0.35;
const PLAYER_EYE_HEIGHT = 1.68;
const CROUCH_EYE_HEIGHT = 1.05;
const PLAYER_RADIUS = 0.32;
const MAX_UPGRADE_LEVEL = 5;
const UPGRADE_COSTS = [150, 250, 375, 525, 700];
const AMMO_RESTOCK_COST = 100;
const WOLF_UPGRADE_COSTS = [140, 220, 320, 440, 580];
const WOLF_HEAL_COST = 80;
const WOLF_REVIVE_SHOP_COST = 120;
const ARENA_SUPPLY_POINTS: Array<[number, number]> = [
  [-12, -12],
  [12, 12],
];
const MAX_CASINGS = 24;
const MAX_SPARKS = 48;

// Pre-allocated scratch math helpers (Zero GC in render loop)
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _moveVec = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();
const _projVec = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _bounceDir = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _ndcCenter = new THREE.Vector2(0, 0);
const _raycaster = new THREE.Raycaster();
const _localHit = new THREE.Vector3();
const _localRayOrigin = new THREE.Vector3();
const _localRayDir = new THREE.Vector3();
const _invRootMat = new THREE.Matrix4();
const _closestBoxPt = new THREE.Vector3();
const _closestRayPt = new THREE.Vector3();
const _hitWorldPt = new THREE.Vector3();
const _assistImpactDir = new THREE.Vector3();
const _assistBestPt = new THREE.Vector3();
const _tracerEnd = new THREE.Vector3();
const _wolfUpAxis = new THREE.Vector3(0, 1, 0);
const _wolfTargetQuat = new THREE.Quaternion();

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface ScreenOrientationWithLock {
  lock?: (orientation: 'landscape' | 'landscape-primary' | 'landscape-secondary' | 'portrait' | 'any' | 'natural') => Promise<void>;
  unlock?: () => void;
}

function detectSoftwareWebGL(): boolean {
  const probeCanvas = document.createElement('canvas');
  const gl = probeCanvas.getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
}

function buildWeaponState(key: WeaponKey): WeaponConfig {
  const t = WEAPON_CONFIGS[key];
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    caliber: t.caliber,
    fireMode: t.auto ? 'FULL-AUTO' : 'SEMI-AUTO',
    currentAmmo: t.magSize,
    magCapacity: t.magSize,
    baseMagCapacity: t.magSize,
    reserveAmmo: Infinity,
    maxReserve: Infinity,
    fireDelay: t.fireRate,
    baseFireDelay: t.fireRate,
    pellets: 1,
    spread: t.spread,
    hudSpreadPx: t.hudSpreadPx,
    shakeClass: t.shakeClass,
    kickClass: t.kickClass,
    baseDmg: t.damage,
    unupgradedDmg: t.damage,
    autoFire: t.auto,
    adsFov: t.adsFov,
    reloadDuration: t.reloadDuration,
    reloadEmptyDuration: t.reloadEmptyDuration,
    moveSpeedMult: t.moveSpeedMult,
    recoilKick: t.recoilKick,
    pitchKick: t.pitchKick,
    upgrades: { damage: 0, magCapacity: 0, fireRate: 0 },
  };
}

function createInitialWeapons(): Record<WeaponKey, WeaponConfig> {
  return {
    mark23: buildWeaponState('mark23'),
    kriss: buildWeaponState('kriss'),
    m4fps: buildWeaponState('m4fps'),
  };
}

let activeEngineInstance: OutbreakGameEngine | null = null;

export class OutbreakGameEngine {
  private readonly container: HTMLElement;
  private readonly isSoftwareGl: boolean;
  private readonly detectedMobilePreview: boolean;
  private perfProfile: RuntimePerfProfile;
  private readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private bloomEnabled = false;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly audio: TacticalAudioEngine;
  private readonly controls: HybridControls;
  private readonly arena: ArenaResult;
  private readonly obstacleGrid = new StaticColliderGrid();
  private readonly actorSepGrid = new ActorSeparationGrid();
  private readonly muzzleLight: THREE.PointLight;
  private readonly flashlight: THREE.SpotLight;
  private readonly flashlightTarget: THREE.Object3D;
  private readonly flashlightCone: THREE.Mesh;
  private isFlashlightOn = true;
  private readonly sceneFog: THREE.FogExp2;
  private readonly ambientLight: THREE.AmbientLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly moonRimLight: THREE.DirectionalLight;
  private readonly bossAuraLight: THREE.PointLight;
  private readonly weather: DynamicWeatherSystem;
  private readonly envRaycastTargets: THREE.Object3D[] = [];

  // Shared 3D combat FX & pickup geometries/materials (Zero leak, 60 FPS pool)
  private readonly casingGeo: THREE.CylinderGeometry;
  private readonly casingMat: THREE.MeshStandardMaterial;
  private readonly sparkGeo: THREE.BoxGeometry;
  private readonly sparkMat: THREE.MeshBasicMaterial;
  private readonly waterSplashGeo: THREE.SphereGeometry;
  private readonly splashMat: THREE.MeshBasicMaterial;
  private readonly bloodFx: BloodEffectsSystem;
  private readonly tracerGeo: THREE.CylinderGeometry;
  private readonly medkitBoxGeo: THREE.BoxGeometry;
  private readonly medkitCrossHGeo: THREE.BoxGeometry;
  private readonly medkitCrossVGeo: THREE.BoxGeometry;
  private readonly medkitFloatAGeo: THREE.BoxGeometry;
  private readonly medkitFloatBGeo: THREE.BoxGeometry;
  private readonly medkitCrateMat: THREE.MeshStandardMaterial;
  private readonly medkitCrossMat: THREE.MeshStandardMaterial;
  private readonly ammoBoxGeo: THREE.BoxGeometry;
  private readonly ammoStripeGeo: THREE.BoxGeometry;
  private readonly ammoBoxMat: THREE.MeshStandardMaterial;
  private readonly ammoStripeMat: THREE.MeshStandardMaterial;
  private readonly hitTargetsCache: THREE.Object3D[] = [];
  private readonly freeTracers3D: Tracer3D[] = [];
  private readonly freeCasings3D: ShellCasing3D[] = [];
  private readonly freeSparks3D: SparkParticle3D[] = [];

  private gunRig: LoadedGunRig | null = null;
  private enemyRoster: EnemyRoster | null = null;
  private direWolf: DireWolfCompanion | null = null;
  private vehiclePack: VehiclePackResult | null = null;
  private propsPack: PropPackResult | null = null;
  private readonly zombiePool = new ZombiePool();
  private wolfUpgrades: WolfUpgrades = {
    biteDamage: 0,
    maxHealth: 0,
    agilityFerocity: 0,
  };
  private lastWolfHudHp = -1;
  private lastWolfHudMaxHp = -1;
  private lastWolfHudStatus = '';
  private lastWolfHudDowned = false;
  private wolfAvoidSign = 1;
  private wolfAvoidTimer = 0;

  private gameState: GameState = 'START';
  private weapons: Record<WeaponKey, WeaponConfig> = createInitialWeapons();
  private activeWeapon: WeaponKey = 'mark23';
  private isReloading = false;
  private reloadTimer = 0;
  private staticReloadTilt = 0;
  private inspectTimer = 0;
  private isFiringHeld = false;
  private lastShotMs = 0;
  private lastBrassClinkMs = 0;

  // Player state
  private playerPos = new THREE.Vector3(0, PLAYER_EYE_HEIGHT, 6);
  private playerVel = new THREE.Vector3();
  private playerVelY = 0;
  private isGrounded = true;
  private hp = 100;
  private readonly maxHp = 100;
  private recoilKick = 0;
  private gunFlashTimer = 0;
  private walkBobPhase = 0;
  private lastFootstepIndex = 0;
  private startOrbitAngle = 0;
  private isAdsActive = false;
  private adsBlend = 0;
  private crouchBlend = 0;
  private pcSettings: PcSettings;
  private hudLayout: TouchHudLayout;
  private hudEditDraft: TouchHudLayout | null = null;

  // Wave, points & stats
  private wave = 1;
  private kills = 0;
  private points = 0;
  private armoryWeapon: WeaponKey = 'mark23';
  private shotsFired = 0;
  private shotsHit = 0;
  private waveZombiesTotal = 6;
  private waveZombiesRemainingToSpawn = 6;
  private bossSpawnedForWave = false;
  private waveSpawnCooldown = 0;
  private waveIntermissionTimer = 0;
  private nextZombieId = 1;
  private supplyPoints: Array<[number, number]> = [...ARENA_SUPPLY_POINTS];
  private supplyRespawnTimers: number[] = [3, 6];
  private waveBannerTimeout = 0;
  private healFlashTimeout = 0;

  // Bullet-Time
  private isBulletTime = false;
  private adrenaline = 100;

  // Active entities
  private zombies: ZombieEntity[] = [];
  private pickups: PickupEntity[] = [];
  private tracers3D: Tracer3D[] = [];
  private casings3D: ShellCasing3D[] = [];
  private sparks3D: SparkParticle3D[] = [];

  // Radar Canvas + Cached hot-loop DOM refs
  private fxCanvas: HTMLCanvasElement | null = null;
  private radarCanvas: HTMLCanvasElement | null = null;
  private radarCtx: CanvasRenderingContext2D | null = null;
  private crosshairRigEl: HTMLElement | null = null;
  private cameraViewportEl: HTMLElement | null = null;
  private bloodScreenOverlayEl: HTMLElement | null = null;
  private radarCountEl: HTMLElement | null = null;
  private wolfRevivePromptEl: HTMLElement | null = null;
  private wolfReviveTextEl: HTMLElement | null = null;
  private interactPropPromptEl: HTMLElement | null = null;
  private interactPropTextEl: HTMLElement | null = null;
  private interactPropDotEl: HTMLElement | null = null;
  private adrenalineValEl: HTMLElement | null = null;
  private adrenalineBannerEl: HTMLElement | null = null;
  private adrenalineBarEl: HTMLElement | null = null;
  private bulletFxContainerEl: HTMLElement | null = null;
  private acousticRipplesLayerEl: HTMLElement | null = null;
  private critHudLayerEl: HTMLElement | null = null;
  private damageNumbersLayerEl: HTMLElement | null = null;
  private hitmarkerEl: HTMLElement | null = null;
  private critHitmarkerEl: HTMLElement | null = null;
  private cameraShakeAnim: Animation | null = null;
  private crosshairKickAnim: Animation | null = null;
  private lastCrosshairScale = -1;
  private lastRadarRenderMs = 0;
  private lastRadarCount = -1;
  private lastAdrenalineRounded = -1;
  private lastAdrenalineFilled = -1;
  private lastWolfPromptVisible = false;
  private lastWolfDistTenths = -1;
  private lastInteractPromptVisible = false;
  private lastInteractPowerOn = true;
  private frameCounter = 0;
  private lastAppliedPixelRatio = 0;
  private lastAppliedWidth = 0;
  private lastAppliedHeight = 0;
  private lastAppliedQuality: GraphicsQuality | null = null;

  // Loop timing, visibility, context loss & fullscreen state
  private lastFrameTime = performance.now();
  private frameId = 0;
  private frameIsTimeout = false;
  private disposed = false;
  private isContextLost = false;
  private isPageVisible = true;
  private isViewportVisible = true;
  private visibilityObserver: IntersectionObserver | null = null;
  private wantFullscreen = false;
  private lastFullscreenAttemptMs = 0;
  private readonly uiAc = new AbortController();

  constructor(container: HTMLElement) {
    // Guarantee only a single active WebGLRenderer & animation loop exists at any time
    if (activeEngineInstance && !activeEngineInstance.disposed) {
      activeEngineInstance.dispose();
    }
    activeEngineInstance = this;

    this.container = container;
    this.container.replaceChildren();
    this.isSoftwareGl = detectSoftwareWebGL();
    this.detectedMobilePreview = detectMobileBrowserEnvironment();
    this.audio = new TacticalAudioEngine();

    const isTouchCapable =
      'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
    this.pcSettings = this.loadPcSettings(isTouchCapable);
    this.perfProfile = resolveRuntimePerfProfile(
      this.pcSettings.graphicsQuality,
      this.pcSettings.mobilePreset,
      this.isSoftwareGl,
      this.detectedMobilePreview,
    );
    this.hudLayout = this.loadHudLayout();

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.perfProfile.allowAntialias,
      powerPreference: this.perfProfile.isMobilePreview ? 'default' : 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(this.computeTargetPixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = this.perfProfile.allowShadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = this.renderer.domElement;
    canvas.id = 'gameCanvas';
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.zIndex = '1';
    canvas.style.display = 'block';

    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        this.isContextLost = true;
        this.stopRenderLoop();
        this.isFiringHeld = false;
        this.controls.clearTransientInputs();
        if (this.gameState === 'PLAYING') {
          this.pauseGame();
        }
        this.audio.suspendContext();
      },
      { signal: this.uiAc.signal },
    );
    canvas.addEventListener(
      'webglcontextrestored',
      () => {
        if (this.disposed) return;
        this.isContextLost = false;
        this.syncEnvironmentAndPostProcessing();
        this.handleResize();
        if (!this.isSoftwareGl) {
          this.renderer.compile(this.scene, this.camera);
        }
        this.lastFrameTime = performance.now();
        this.syncLoopRunningState();
      },
      { signal: this.uiAc.signal },
    );
    this.container.appendChild(canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fb2c4);
    this.sceneFog = new THREE.FogExp2(0x9fb2c4, 0.0115);
    this.scene.fog = this.sceneFog;

    // Desktop studio reflection PMREM (skipped on mobile preview to avoid cubemap FBO VRAM overhead)
    const hasEnvReflections = this.perfProfile.allowEnvReflections && !this.isSoftwareGl;
    this.syncEnvironmentReflection(hasEnvReflections);

    this.camera = new THREE.PerspectiveCamera(
      this.pcSettings.fov,
      window.innerWidth / window.innerHeight,
      0.08,
      160,
    );
    this.scene.add(this.camera);

    // Overcast Daytime Illumination + Mobile Non-PMREM Ambient/Hemi Compensation
    this.ambientLight = new THREE.AmbientLight(0xdbe5ef, hasEnvReflections ? 0.28 : 0.56);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(
      0xdeebf7,
      0x5b5d61,
      hasEnvReflections ? 1.12 : 1.54,
    );
    this.scene.add(this.hemiLight);

    this.moonLight = new THREE.DirectionalLight(0xf4f8fc, 2.25);
    this.moonLight.position.set(22, 38, 18);
    this.moonLight.castShadow = this.perfProfile.allowShadows;
    const shadowRes = this.perfProfile.isMobilePreview ? 256 : 1024;
    this.moonLight.shadow.mapSize.set(shadowRes, shadowRes);
    this.moonLight.shadow.camera.near = 2;
    this.moonLight.shadow.camera.far = 85;
    this.moonLight.shadow.camera.left = -32;
    this.moonLight.shadow.camera.right = 32;
    this.moonLight.shadow.camera.top = 32;
    this.moonLight.shadow.camera.bottom = -32;
    this.moonLight.shadow.bias = -0.0005;
    this.moonLight.shadow.normalBias = 0.02;
    this.scene.add(this.moonLight);

    // Cool overcast sky fill backlight + soft warm concrete bounce rim
    this.moonRimLight = new THREE.DirectionalLight(0xcbd8e6, 1.05);
    this.moonRimLight.position.set(-24, 20, -26);
    this.scene.add(this.moonRimLight);

    const emberRimLight = new THREE.DirectionalLight(0xe8dfd5, 0.42);
    emberRimLight.position.set(18, 11, -22);
    this.scene.add(emberRimLight);

    this.bossAuraLight = new THREE.PointLight(0xef4444, 0, 9, 2);
    this.bossAuraLight.castShadow = false;
    this.scene.add(this.bossAuraLight);

    this.weather = new DynamicWeatherSystem({
      scene: this.scene,
      fog: this.sceneFog,
      hemiLight: this.hemiLight,
      moonLight: this.moonLight,
      moonRimLight: this.moonRimLight,
    });

    // Muzzle Flash Point Light attached to camera
    this.muzzleLight = new THREE.PointLight(0xfbbf24, 0, 10, 2);
    this.muzzleLight.position.set(0.28, -0.1, -0.9);
    this.camera.add(this.muzzleLight);

    // Tactical Weapon Flashlight (SpotLight + soft volumetric beam cone)
    this.flashlight = new THREE.SpotLight(0xeef6ff, 10, 46, Math.PI / 7.5, 0.55, 1.35);
    this.flashlight.position.set(0.22, -0.14, -0.35);
    this.flashlight.castShadow = false;
    this.flashlightTarget = new THREE.Object3D();
    this.flashlightTarget.position.set(0, -0.04, -18);
    this.camera.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;
    this.camera.add(this.flashlight);

    const coneLength = 14;
    const coneRadius = 3.2;
    const coneGeo = new THREE.ConeGeometry(coneRadius, coneLength, 20, 1, true);
    coneGeo.translate(0, -coneLength * 0.5, 0);
    coneGeo.rotateX(Math.PI * 0.5);
    const coneMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xdbeafe) },
        uOpacity: { value: 0.055 },
      },
      vertexShader: `
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        varying float vAlong;
        void main() {
          vAlong = clamp(-position.z / ${coneLength.toFixed(1)}, 0.0, 1.0);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mvPos.xyz;
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        varying float vAlong;
        void main() {
          vec3 V = normalize(vViewPos);
          float fresnel = pow(abs(dot(normalize(vNormalView), V)), 1.75);
          float nearFade = smoothstep(0.0, 0.08, vAlong);
          float farFade = pow(1.0 - vAlong, 1.85);
          float alpha = uOpacity * fresnel * nearFade * farFade;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.flashlightCone = new THREE.Mesh(coneGeo, coneMat);
    this.flashlightCone.position.copy(this.flashlight.position);
    this.camera.add(this.flashlightCone);

    this.arena = buildQuarantineArena(
      this.scene,
      this.renderer,
      this.isSoftwareGl,
      this.perfProfile.isMobilePreview,
    );
    this.weather.setSkyDomeMaterial(this.arena.skyDomeMat);
    this.obstacleGrid.rebuild(this.arena.obstacles);

    // Collect opaque arena geometry for wall/ground bullet impact sparks
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh === this.flashlightCone) return;
      if (mesh.userData.noBulletRaycast) return;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (mat && mat.transparent) return;
      const sphereParams = (mesh.geometry as THREE.SphereGeometry)?.parameters;
      if (sphereParams && typeof sphereParams.radius === 'number' && sphereParams.radius >= 50) return;
      this.envRaycastTargets.push(mesh);
    });

    // Shared 3D combat FX geometries/materials
    this.casingGeo = new THREE.CylinderGeometry(0.0085, 0.0085, 0.032, 6);
    this.casingGeo.rotateZ(Math.PI * 0.5);
    this.casingMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      metalness: 0.9,
      roughness: 0.24,
    });
    this.sparkGeo = new THREE.BoxGeometry(0.022, 0.022, 0.11);
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.6, 1.3, 0.25),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.waterSplashGeo = new THREE.SphereGeometry(0.055, 5, 5);
    this.splashMat = new THREE.MeshBasicMaterial({
      color: 0xbae6fd,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.tracerGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 5);
    this.tracerGeo.rotateX(Math.PI * 0.5);

    this.medkitBoxGeo = new THREE.BoxGeometry(0.54, 0.34, 0.4);
    this.medkitCrossHGeo = new THREE.BoxGeometry(0.28, 0.08, 0.42);
    this.medkitCrossVGeo = new THREE.BoxGeometry(0.08, 0.24, 0.42);
    this.medkitFloatAGeo = new THREE.BoxGeometry(0.24, 0.06, 0.06);
    this.medkitFloatBGeo = new THREE.BoxGeometry(0.06, 0.24, 0.06);
    this.medkitCrateMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.25,
      metalness: 0.18,
      emissive: 0x064e3b,
      emissiveIntensity: 0.35,
    });
    this.medkitCrossMat = new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x22c55e,
      emissiveIntensity: 1.8,
      roughness: 0.2,
    });

    this.ammoBoxGeo = new THREE.BoxGeometry(0.46, 0.3, 0.34);
    this.ammoStripeGeo = new THREE.BoxGeometry(0.16, 0.32, 0.36);
    this.ammoBoxMat = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      roughness: 0.35,
      metalness: 0.4,
      emissive: 0x78350f,
      emissiveIntensity: 0.6,
    });
    this.ammoStripeMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.3,
      metalness: 0.2,
    });

    this.prewarmCombatPools();
    this.bloodFx = new BloodEffectsSystem(
      this.scene,
      this.isSoftwareGl,
      this.pcSettings.graphicsQuality,
      this.perfProfile.maxAnisotropy,
      this.perfProfile.isMobilePreview,
    );

    // Lazy selective Bloom pipeline (Desktop MED / HIGH only; bypassed and unallocated on mobile preview)
    this.syncPostProcessing(this.perfProfile.allowBloom);

    this.controls = new HybridControls(this.container, {
      getGameState: () => this.gameState,
      onFireStart: () => {
        this.isFiringHeld = true;
        this.tryFire();
      },
      onFireEnd: () => {
        this.isFiringHeld = false;
      },
      onJump: () => this.triggerJump(),
      onAdsChange: (active) => {
        this.isAdsActive = active;
      },
      onReload: () => this.reloadWeapon(),
      onSwitchWeapon: (key) => this.switchWeapon(key),
      onCycleWeapon: (dir) => this.cycleWeapon(dir),
      onToggleBulletTime: () => this.toggleBulletTime(),
      onToggleFlashlight: () => this.toggleFlashlight(),
      onInspectWeapon: () => this.inspectWeapon(),
      onReviveWolf: () => this.handlePrimaryInteract(),
      onToggleMute: () => this.toggleMute(),
      onPauseRequest: () => {
        if (this.gameState === 'PAUSED') {
          this.resumeGame(false);
        } else {
          this.pauseGame();
        }
      },
      onPointerLockChange: (locked) => this.updateTargetLockBadge(locked),
      onEnsureAudio: () => this.audio.ensureContext(),
    });

    this.fxCanvas = document.getElementById('fx-canvas') as HTMLCanvasElement | null;
    this.fxCanvas?.getContext('2d')?.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    this.radarCanvas = document.getElementById('radar-canvas') as HTMLCanvasElement | null;
    this.radarCtx = this.radarCanvas?.getContext('2d') ?? null;
    this.crosshairRigEl = document.getElementById('crosshair-rig');
    this.cameraViewportEl = document.getElementById('camera-viewport');
    this.bloodScreenOverlayEl = document.getElementById('blood-screen-overlay');
    this.radarCountEl = document.getElementById('radar-count-label');
    this.wolfRevivePromptEl = document.getElementById('wolf-revive-prompt');
    this.wolfReviveTextEl = document.getElementById('wolf-revive-prompt-text');
    this.interactPropPromptEl = document.getElementById('interact-prop-prompt');
    this.interactPropTextEl = document.getElementById('interact-prop-prompt-text');
    this.interactPropDotEl = document.getElementById('interact-prop-dot');
    this.adrenalineValEl = document.getElementById('adrenaline-value-txt');
    this.adrenalineBannerEl = document.getElementById('bt-banner-progress');
    this.adrenalineBarEl = document.getElementById('adrenaline-segments-bar');
    this.bulletFxContainerEl = document.getElementById('bullet-fx-container');
    this.acousticRipplesLayerEl = document.getElementById('acoustic-ripples-layer');
    this.critHudLayerEl = document.getElementById('crit-hud-layer');
    this.damageNumbersLayerEl = document.getElementById('damage-numbers-layer');
    this.hitmarkerEl = document.getElementById('hitmarker');
    this.critHitmarkerEl = document.getElementById('crit-hitmarker');
    this.resizeCanvases();

    window.addEventListener('resize', this.handleResize, { signal: this.uiAc.signal });
    this.bindVisibilityListeners();
    this.bindUIButtons();
    this.applyPcSettings();
    this.controls.applyHudLayout(this.hudLayout);
    this.refreshBestRecordUI();
    this.switchScreen('START');

    void this.initAsyncModels();
    this.lastFrameTime = performance.now();
    this.syncLoopRunningState();
  }

  private computeTargetPixelRatio(): number {
    if (this.isSoftwareGl) return 1;
    const raw = window.devicePixelRatio || 1;
    return Math.min(raw, this.perfProfile.maxDpr);
  }

  private syncEnvironmentReflection(enabled: boolean): void {
    if (enabled && !this.isSoftwareGl) {
      if (!this.scene.environment) {
        const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
        pmremGenerator.dispose();
      }
    } else if (this.scene.environment) {
      this.scene.environment.dispose();
      this.scene.environment = null;
    }
  }

  private syncPostProcessing(enabled: boolean): void {
    if (enabled && !this.isSoftwareGl) {
      if (!this.composer) {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloomPass = new UnrealBloomPass(
          new THREE.Vector2(window.innerWidth, window.innerHeight),
          0.22,
          0.45,
          0.94,
        );
        this.composer.addPass(this.bloomPass);
        this.composer.addPass(new OutputPass());
      }
      this.bloomEnabled = true;
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(window.innerWidth, window.innerHeight);
      if (this.bloomPass) {
        this.bloomPass.enabled = true;
        const scale = this.pcSettings.graphicsQuality === 'MED' ? 0.5 : 1.0;
        this.bloomPass.resolution.set(
          Math.max(1, window.innerWidth * scale),
          Math.max(1, window.innerHeight * scale),
        );
      }
    } else {
      this.bloomEnabled = false;
      if (this.bloomPass) {
        this.bloomPass.dispose();
        this.bloomPass = null;
      }
      if (this.composer) {
        this.composer.dispose();
        this.composer = null;
      }
    }
  }

  private syncEnvironmentAndPostProcessing(): void {
    const hasEnv = this.perfProfile.allowEnvReflections && !this.isSoftwareGl;
    this.ambientLight.intensity = hasEnv ? 0.28 : 0.56;
    this.hemiLight.intensity = hasEnv ? 1.12 : 1.54;
    this.syncEnvironmentReflection(hasEnv);
    this.syncPostProcessing(this.perfProfile.allowBloom);
  }

  private bindVisibilityListeners(): void {
    const { signal } = this.uiAc;
    this.isPageVisible = document.visibilityState !== 'hidden';

    document.addEventListener(
      'visibilitychange',
      () => {
        this.isPageVisible = document.visibilityState !== 'hidden';
        if (!this.isPageVisible) {
          this.onPreviewHidden();
        } else {
          this.onPreviewVisible();
        }
      },
      { signal },
    );

    window.addEventListener(
      'pagehide',
      () => {
        this.isPageVisible = false;
        this.onPreviewHidden();
      },
      { signal },
    );

    window.addEventListener(
      'pageshow',
      () => {
        this.isPageVisible = document.visibilityState !== 'hidden';
        if (this.isPageVisible) {
          this.onPreviewVisible();
        }
      },
      { signal },
    );

    if (typeof IntersectionObserver !== 'undefined') {
      this.visibilityObserver = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          const visible = entry.isIntersecting || entry.intersectionRatio > 0;
          if (visible === this.isViewportVisible) return;
          this.isViewportVisible = visible;
          if (!visible) {
            this.onPreviewHidden();
          } else {
            this.onPreviewVisible();
          }
        },
        { threshold: 0.01 },
      );
      this.visibilityObserver.observe(this.container);
    }
  }

  private onPreviewHidden(): void {
    this.stopRenderLoop();
    this.isFiringHeld = false;
    this.controls.clearTransientInputs();
    if (this.gameState === 'PLAYING') {
      this.pauseGame();
    }
    this.audio.suspendContext();
  }

  private onPreviewVisible(): void {
    if (this.disposed || this.isContextLost) return;
    this.lastFrameTime = performance.now();
    this.audio.resumeContext();
    this.syncLoopRunningState();
  }

  private prewarmCombatPools(): void {
    const tracerPrewarm = this.perfProfile.isMobilePreview ? 8 : 12;
    const casingPrewarm = this.perfProfile.isMobilePreview ? 12 : MAX_CASINGS;
    const sparkPrewarm = this.perfProfile.isMobilePreview ? 16 : 28;

    for (let i = 0; i < tracerPrewarm; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this.freeTracers3D.push({ mesh, life: 0, maxLife: 0.06 });
    }

    for (let i = 0; i < casingPrewarm; i++) {
      const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.freeCasings3D.push({
        mesh,
        vel: new THREE.Vector3(),
        rotVel: new THREE.Vector3(),
        life: 0,
        bounces: 0,
      });
    }

    for (let i = 0; i < sparkPrewarm; i++) {
      const mat = this.sparkMat.clone();
      const mesh = new THREE.Mesh(this.sparkGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.freeSparks3D.push({
        mesh,
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.25,
        gravity: 9.8,
      });
    }
  }

  private async initAsyncModels(): Promise<void> {
    const statusEl = document.getElementById('start-model-status');
    const enterBtn = document.getElementById('btn-enter-quarantine') as HTMLButtonElement | null;
    const setStatus = (txt: string) => {
      if (statusEl) statusEl.innerText = txt;
    };

    // Stage 1: Weapons
    setStatus('LOADING WEAPON RIGS...');
    const gunRig = await loadWeaponRig(this.camera, this.perfProfile, () => this.disposed);
    if (this.disposed) {
      disposeWeaponRig(gunRig);
      return;
    }
    this.gunRig = gunRig;
    gunRig.root.visible = this.gameState === 'PLAYING' || this.gameState === 'HUD_EDIT';
    this.syncWeaponModels(false);
    if (this.perfProfile.progressiveLoadYield) await yieldToMainThread(16);

    // Stage 2: Enemy Zombie Roster (progressive 1-by-1 on mobile preview)
    const roster = await loadEnemyRoster(
      (loaded, total) => {
        setStatus(`LOADING HOSTILE MODELS (${loaded}/${total})...`);
      },
      this.perfProfile,
      () => this.disposed,
    );
    if (this.disposed) {
      disposeEnemyRoster(roster);
      return;
    }
    this.enemyRoster = roster;
    this.zombiePool.setPoolLimits(this.perfProfile.zombiePoolMaxPerArch);
    this.zombiePool.prewarm(
      roster,
      this.isSoftwareGl || !this.perfProfile.allowShadows,
      this.perfProfile.zombiePrewarmPerArch,
    );
    if (this.perfProfile.progressiveLoadYield) await yieldToMainThread(16);

    // Stage 3: Dire Wolf K9 Companion
    setStatus('DEPLOYING K9 COMPANION...');
    const wolf = await loadDireWolfCompanion(this.isSoftwareGl, this.perfProfile);
    if (this.disposed) {
      disposeDireWolf(wolf, this.scene);
      return;
    }
    this.direWolf = wolf;
    this.applyWolfUpgradesToEntity();
    this.direWolf.root.position.set(this.playerPos.x - 2.1, 0, this.playerPos.z + 1.6);
    this.scene.add(this.direWolf.root);
    this.updateWolfHUD(true);
    if (this.perfProfile.progressiveLoadYield) await yieldToMainThread(16);

    // Stage 4: Vehicles
    const vehiclePack = await loadAndIntegrateVehicles(
      this.scene,
      this.isSoftwareGl,
      this.pcSettings.graphicsQuality,
      {
        profile: this.perfProfile,
        onProgress: (loaded, total) => {
          setStatus(`LOADING CHECKPOINT VEHICLES (${loaded}/${total})...`);
        },
        isAborted: () => this.disposed,
      },
    );
    if (this.disposed) {
      vehiclePack.dispose();
      return;
    }
    this.vehiclePack = vehiclePack;
    this.arena.obstacles.push(...vehiclePack.newObstacles);
    this.envRaycastTargets.push(...vehiclePack.vehicleMeshes);
    if (vehiclePack.milAmbRearMedkitPos) {
      this.supplyPoints.push([
        vehiclePack.milAmbRearMedkitPos.x,
        vehiclePack.milAmbRearMedkitPos.z,
      ]);
      this.supplyRespawnTimers.push(0.4);
    }
    vehiclePack.setQuality(this.pcSettings.graphicsQuality, this.perfProfile.isMobilePreview);
    this.obstacleGrid.rebuild(this.arena.obstacles);
    if (this.perfProfile.progressiveLoadYield) await yieldToMainThread(16);

    // Stage 5: Barricades & Quarantine Props
    const propsPack = await loadAndIntegrateProps(
      this.scene,
      this.isSoftwareGl,
      this.pcSettings.graphicsQuality,
      {
        profile: this.perfProfile,
        onProgress: (loaded, total) => {
          setStatus(`LOADING BARRICADES & PROPS (${loaded}/${total})...`);
        },
        isAborted: () => this.disposed,
      },
    );
    if (this.disposed) {
      propsPack.dispose();
      return;
    }
    this.propsPack = propsPack;
    this.arena.obstacles.push(...propsPack.obstacles);
    this.envRaycastTargets.push(...propsPack.raycastTargets);
    propsPack.setQuality(this.pcSettings.graphicsQuality, this.perfProfile.isMobilePreview);
    this.obstacleGrid.rebuild(this.arena.obstacles);

    // Free any cached decoded ArrayBuffers held by Three's Cache
    THREE.Cache.clear();

    // Preview infected wandering in the start-screen background pan (fewer concurrent skeletons on mobile)
    if (this.gameState === 'START' && this.zombies.length === 0) {
      const startBatch: ZombieArchetype[] = this.perfProfile.isMobilePreview
        ? ['runner', 'walker_survivor', 'walker_yaku']
        : ['runner', 'walker_survivor', 'walker_yaku', 'walker_shambler', 'crawler'];
      this.spawnWaveBatch(startBatch.length, startBatch);
    }

    // Compile shaders cleanly before unlocking PLAY
    if (!this.isSoftwareGl) {
      setStatus('COMPILING SHADERS...');
      if (this.perfProfile.isMobilePreview) {
        if (typeof this.renderer.compileAsync === 'function') {
          await this.renderer.compileAsync(this.scene, this.camera);
        } else {
          this.renderer.compile(this.scene, this.camera);
        }
        if (this.disposed) return;
      } else {
        gunRig.root.visible = true;
        for (const k of WEAPON_ORDER) {
          gunRig.slots[k].pivotGroup.visible = true;
        }
        const warmupBoss = this.zombiePool.acquire(
          roster.walker_shambler,
          -1,
          'walker_shambler',
          1,
          new THREE.Vector3(0, -100, 0),
          this.isSoftwareGl,
          true,
        );
        this.scene.add(warmupBoss.root);

        const warmupMedkit = new THREE.Mesh(this.medkitBoxGeo, this.medkitCrateMat);
        const warmupCross = new THREE.Mesh(this.medkitFloatAGeo, this.medkitCrossMat);
        const warmupAmmo = new THREE.Mesh(this.ammoBoxGeo, this.ammoBoxMat);
        const warmupAmmoStripe = new THREE.Mesh(this.ammoStripeGeo, this.ammoStripeMat);
        warmupMedkit.position.set(0, -100, 0);
        warmupCross.position.set(0, -100, 0);
        warmupAmmo.position.set(0, -100, 0);
        warmupAmmoStripe.position.set(0, -100, 0);
        this.scene.add(warmupMedkit, warmupCross, warmupAmmo, warmupAmmoStripe);

        if (typeof this.renderer.compileAsync === 'function') {
          await this.renderer.compileAsync(this.scene, this.camera);
        } else {
          this.renderer.compile(this.scene, this.camera);
        }

        this.scene.remove(warmupMedkit, warmupCross, warmupAmmo, warmupAmmoStripe);
        this.zombiePool.release(warmupBoss, this.scene);
        if (this.disposed) return;

        gunRig.root.visible = this.gameState === 'PLAYING' || this.gameState === 'HUD_EDIT';
        this.syncWeaponModels(false);
      }
    }

    if (statusEl) {
      statusEl.innerText = this.perfProfile.isMobilePreview
        ? 'MOBILE SAFE MODE READY [5/5]'
        : 'HOSTILE BIO-SIGNATURES READY [5/5]';
      statusEl.classList.remove('text-amber-400');
      statusEl.classList.add('text-emerald-400');
    }
    if (enterBtn) {
      enterBtn.disabled = false;
      enterBtn.classList.remove('cursor-wait', 'opacity-60');
      enterBtn.classList.add('cursor-pointer');
    }
  }

  private bindUIButtons(): void {
    const { signal } = this.uiAc;

    document.getElementById('btn-enter-quarantine')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.audio.playMechanicalClick(0.6, 1500);
        this.startGame();
      },
      { signal },
    );

    document.getElementById('btn-deploy-again')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.audio.playMechanicalClick(0.6, 1500);
        this.startGame();
      },
      { signal },
    );

    document.getElementById('btn-resume-mission')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.audio.playMechanicalClick(0.5, 1400);
        this.resumeGame();
      },
      { signal },
    );

    const bindHudTapButton = (id: string, handler: () => void) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      let lastTouchEndMs = 0;
      btn.addEventListener(
        'touchstart',
        (e) => {
          e.stopPropagation();
        },
        { passive: true, signal },
      );
      btn.addEventListener(
        'touchend',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          lastTouchEndMs = performance.now();
          this.audio.ensureContext();
          handler();
        },
        { passive: false, signal },
      );
      btn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          if (performance.now() - lastTouchEndMs < 400) return;
          this.audio.ensureContext();
          handler();
        },
        { signal },
      );
    };

    bindHudTapButton('btn-pause-game', () => {
      this.pauseGame();
    });

    bindHudTapButton('sfx-toggle-btn', () => {
      this.toggleMute();
    });

    bindHudTapButton('btn-toggle-fullscreen', () => {
      this.audio.playMechanicalClick(0.5, 1400);
      this.toggleFullscreen();
    });

    const onFullscreenChanged = () => {
      this.updateFullscreenButtonUI();
      this.handleResize();
    };
    document.addEventListener('fullscreenchange', onFullscreenChanged, { signal });
    document.addEventListener('webkitfullscreenchange', onFullscreenChanged, { signal });

    const onCanvasTapReenterFullscreen = (ev: Event) => {
      if (this.gameState !== 'PLAYING' || !this.wantFullscreen || this.isFullscreenActive()) {
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const isArenaSurface =
        target === this.renderer.domElement ||
        target === this.container ||
        target.id === 'touchLookLayer' ||
        target.id === 'camera-viewport';
      if (!isArenaSurface) return;
      const now = performance.now();
      if (now - this.lastFullscreenAttemptMs < 450) return;
      this.lastFullscreenAttemptMs = now;
      this.enterFullscreenAndLandscape();
    };
    window.addEventListener('pointerup', onCanvasTapReenterFullscreen, { passive: true, signal });
    window.addEventListener('touchend', onCanvasTapReenterFullscreen, { passive: true, signal });
    this.updateFullscreenButtonUI();

    bindHudTapButton('btn-top-bullet-time', () => {
      this.toggleBulletTime();
    });

    bindHudTapButton('adrenaline-hud-panel', () => {
      this.toggleBulletTime();
    });

    bindHudTapButton('weapon-status-badge', () => {
      this.reloadWeapon();
    });

    bindHudTapButton('wolf-revive-prompt', () => {
      this.tryReviveWolf();
    });

    bindHudTapButton('interact-prop-prompt', () => {
      this.handlePrimaryInteract();
    });

    WEAPON_ORDER.forEach((key) => {
      document.getElementById(`slot-${key}`)?.addEventListener(
        'click',
        () => {
          this.audio.ensureContext();
          this.switchWeapon(key);
        },
        { signal },
      );
      document.getElementById(`armory-tab-${key}`)?.addEventListener(
        'click',
        () => {
          this.audio.ensureContext();
          this.audio.playMechanicalClick(0.45, 1300);
          this.armoryWeapon = key;
          this.renderArmoryUI();
        },
        { signal },
      );
    });

    document.getElementById('btn-upgrade-dmg')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseUpgrade('damage');
      },
      { signal },
    );
    document.getElementById('btn-upgrade-mag')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseUpgrade('magCapacity');
      },
      { signal },
    );
    document.getElementById('btn-upgrade-rate')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseUpgrade('fireRate');
      },
      { signal },
    );
    document.getElementById('btn-armory-ammo')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseAmmoRestock();
      },
      { signal },
    );
    document.getElementById('btn-wolf-heal')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseWolfHeal();
      },
      { signal },
    );
    document.getElementById('btn-wolf-upgrade-dmg')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseWolfUpgrade('biteDamage');
      },
      { signal },
    );
    document.getElementById('btn-wolf-upgrade-hp')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseWolfUpgrade('maxHealth');
      },
      { signal },
    );
    document.getElementById('btn-wolf-upgrade-agility')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.purchaseWolfUpgrade('agilityFerocity');
      },
      { signal },
    );
    document.getElementById('btn-next-wave')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.audio.playMechanicalClick(0.6, 1500);
        this.deployNextWave();
      },
      { signal },
    );

    // Pause Tactical Settings bindings
    const mouseSensSlider = document.getElementById('setting-mouse-sens') as HTMLInputElement | null;
    mouseSensSlider?.addEventListener(
      'input',
      () => {
        this.pcSettings.mouseSensitivity = Number(mouseSensSlider.value) / 100;
        this.applyPcSettings();
        this.savePcSettings();
      },
      { signal },
    );

    const fovSlider = document.getElementById('setting-fov') as HTMLInputElement | null;
    fovSlider?.addEventListener(
      'input',
      () => {
        this.pcSettings.fov = Number(fovSlider.value);
        this.applyPcSettings();
        this.savePcSettings();
      },
      { signal },
    );

    (['LOW', 'MED', 'HIGH'] as GraphicsQuality[]).forEach((q) => {
      document.getElementById(`btn-quality-${q.toLowerCase()}`)?.addEventListener(
        'click',
        () => {
          this.audio.ensureContext();
          this.audio.playMechanicalClick(0.45, 1300);
          this.pcSettings.graphicsQuality = q;
          this.applyPcSettings();
          this.savePcSettings();
        },
        { signal },
      );
    });

    (['auto', 'mobile', 'desktop'] as MobilePresetMode[]).forEach((mode) => {
      document.getElementById(`btn-profile-${mode}`)?.addEventListener(
        'click',
        () => {
          this.audio.ensureContext();
          this.audio.playMechanicalClick(0.45, 1300);
          this.pcSettings.mobilePreset = mode;
          this.applyPcSettings();
          this.savePcSettings();
        },
        { signal },
      );
    });

    const showTouchCheckbox = document.getElementById('setting-show-touch') as HTMLInputElement | null;
    showTouchCheckbox?.addEventListener(
      'change',
      () => {
        this.pcSettings.forceTouchControls = showTouchCheckbox.checked;
        this.applyPcSettings();
        this.savePcSettings();
      },
      { signal },
    );

    document.getElementById('btn-customize-hud')?.addEventListener(
      'click',
      () => {
        this.audio.ensureContext();
        this.audio.playMechanicalClick(0.5, 1400);
        this.enterHudEditor();
      },
      { signal },
    );

    // HUD Layout Editor Toolbar bindings
    const sizeSlider = document.getElementById('hud-edit-size-slider') as HTMLInputElement | null;
    sizeSlider?.addEventListener(
      'input',
      () => {
        if (!this.hudEditDraft) return;
        const id = this.controls.getSelectedHudControl();
        const scale = Number(sizeSlider.value) / 100;
        this.hudEditDraft = this.controls.getHudLayoutSnapshot();
        this.hudEditDraft.controls[id].scale = scale;
        this.controls.applyHudLayout(this.hudEditDraft);
        const valEl = document.getElementById('hud-edit-size-val');
        if (valEl) valEl.innerText = `${sizeSlider.value}%`;
      },
      { signal },
    );

    const opacitySlider = document.getElementById('hud-edit-opacity-slider') as HTMLInputElement | null;
    opacitySlider?.addEventListener(
      'input',
      () => {
        if (!this.hudEditDraft) return;
        const id = this.controls.getSelectedHudControl();
        const opacity = Number(opacitySlider.value) / 100;
        this.hudEditDraft = this.controls.getHudLayoutSnapshot();
        this.hudEditDraft.controls[id].opacity = opacity;
        this.controls.applyHudLayout(this.hudEditDraft);
        const valEl = document.getElementById('hud-edit-opacity-val');
        if (valEl) valEl.innerText = `${opacitySlider.value}%`;
      },
      { signal },
    );

    const touchSensSlider = document.getElementById('hud-edit-sens-slider') as HTMLInputElement | null;
    touchSensSlider?.addEventListener(
      'input',
      () => {
        if (!this.hudEditDraft) return;
        const sens = Number(touchSensSlider.value) / 100;
        this.hudEditDraft = this.controls.getHudLayoutSnapshot();
        this.hudEditDraft.touchSensitivity = sens;
        this.controls.applyHudLayout(this.hudEditDraft);
        const valEl = document.getElementById('hud-edit-sens-val');
        if (valEl) valEl.innerText = `${sens.toFixed(1)}x`;
      },
      { signal },
    );

    document.getElementById('btn-hud-edit-reset')?.addEventListener(
      'click',
      () => {
        this.audio.playMechanicalClick(0.5, 1100);
        this.hudEditDraft = createDefaultTouchHudLayout();
        this.controls.applyHudLayout(this.hudEditDraft);
        this.syncHudEditorToolbarUI(this.controls.getSelectedHudControl());
      },
      { signal },
    );

    document.getElementById('btn-hud-edit-save')?.addEventListener(
      'click',
      () => {
        this.audio.playUpgradePurchase();
        this.exitHudEditor(true);
      },
      { signal },
    );

    this.controls.setHudEditSelectionCallback((id) => {
      this.syncHudEditorToolbarUI(id);
    });
  }

  private handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const targetPr = this.computeTargetPixelRatio();
    if (Math.abs(this.renderer.getPixelRatio() - targetPr) > 0.01) {
      this.renderer.setPixelRatio(targetPr);
    }
    const pr = this.renderer.getPixelRatio();
    if (
      w === this.lastAppliedWidth &&
      h === this.lastAppliedHeight &&
      pr === this.lastAppliedPixelRatio
    ) {
      return;
    }
    this.lastAppliedWidth = w;
    this.lastAppliedHeight = h;
    this.lastAppliedPixelRatio = pr;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    }
    if (this.bloomPass) {
      const scale = this.pcSettings.graphicsQuality === 'MED' ? 0.5 : 1.0;
      this.bloomPass.resolution.set(Math.max(1, w * scale), Math.max(1, h * scale));
    }
    this.resizeCanvases();
  };

  private isFullscreenActive(): boolean {
    const doc = document as WebkitFullscreenDocument;
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
  }

  private enterFullscreenAndLandscape(): void {
    try {
      const root = document.documentElement as WebkitFullscreenElement;
      if (!this.isFullscreenActive()) {
        const req = root.requestFullscreen
          ? root.requestFullscreen()
          : root.webkitRequestFullscreen?.();
        if (req && typeof (req as Promise<void>).catch === 'function') {
          (req as Promise<void>).catch(() => {});
        }
      }
    } catch {
      // Ignored cleanly on browsers/WebViews that restrict fullscreen requests
    }

    try {
      const orientation = screen.orientation as ScreenOrientationWithLock | undefined;
      if (orientation && typeof orientation.lock === 'function') {
        const lockPromise = orientation.lock('landscape');
        if (lockPromise && typeof lockPromise.catch === 'function') {
          lockPromise.catch(() => {});
        }
      }
    } catch {
      // Ignored cleanly when orientation lock is unavailable
    }

    this.updateFullscreenButtonUI();
  }

  private exitFullscreenSafe(): void {
    try {
      const doc = document as WebkitFullscreenDocument;
      if (this.isFullscreenActive()) {
        const exit = doc.exitFullscreen
          ? doc.exitFullscreen()
          : doc.webkitExitFullscreen?.();
        if (exit && typeof (exit as Promise<void>).catch === 'function') {
          (exit as Promise<void>).catch(() => {});
        }
      }
    } catch {
      // Ignored safely
    }

    try {
      const orientation = screen.orientation as ScreenOrientationWithLock | undefined;
      orientation?.unlock?.();
    } catch {
      // Ignored safely
    }

    this.updateFullscreenButtonUI();
  }

  private toggleFullscreen(): void {
    if (this.isFullscreenActive()) {
      this.wantFullscreen = false;
      this.exitFullscreenSafe();
    } else {
      this.wantFullscreen = true;
      this.enterFullscreenAndLandscape();
    }
  }

  private updateFullscreenButtonUI(): void {
    const active = this.isFullscreenActive();
    const btn = document.getElementById('btn-toggle-fullscreen');
    const label = document.getElementById('btn-fullscreen-label');
    if (btn) {
      btn.classList.toggle('fullscreen-active', active);
    }
    if (label) {
      label.innerText = active ? 'EXIT FS' : 'FULLSCREEN';
    }
  }

  private renderSceneFrame(): void {
    if (this.bloomEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private resizeCanvases(): void {
    if (this.fxCanvas) {
      this.fxCanvas.width = window.innerWidth;
      this.fxCanvas.height = window.innerHeight;
    }
  }

  private switchScreen(next: GameState): void {
    this.gameState = next;
    const startScreen = document.getElementById('start-screen');
    const gameplayHud = document.getElementById('gameplay-hud');
    const armoryModal = document.getElementById('armory-modal');
    const gameOverModal = document.getElementById('gameover-modal');
    const hudEditorToolbar = document.getElementById('hud-editor-toolbar');

    const applyVisibility = (el: HTMLElement | null, visible: boolean) => {
      if (!el) return;
      el.classList.toggle('screen-active', visible);
    };

    applyVisibility(startScreen, next === 'START');
    applyVisibility(gameplayHud, next === 'PLAYING' || next === 'HUD_EDIT');
    applyVisibility(armoryModal, next === 'ARMORY');
    applyVisibility(gameOverModal, next === 'GAME_OVER' || next === 'PAUSED');
    applyVisibility(hudEditorToolbar, next === 'HUD_EDIT');

    this.controls.updateMobileControlsVisibility();
    if (this.gunRig) {
      this.gunRig.root.visible = next === 'PLAYING' || next === 'HUD_EDIT';
    }
    if (next !== 'PLAYING' && this.lastInteractPromptVisible) {
      this.lastInteractPromptVisible = false;
      this.interactPropPromptEl?.classList.add('hidden');
    }
  }

  public startGame(): void {
    this.clearArenaEntities();

    this.weapons = createInitialWeapons();
    this.activeWeapon = 'mark23';
    this.armoryWeapon = 'mark23';
    this.isReloading = false;
    this.reloadTimer = 0;
    this.staticReloadTilt = 0;
    this.inspectTimer = 0;
    this.isFiringHeld = false;
    this.isAdsActive = false;
    this.adsBlend = 0;
    this.crouchBlend = 0;

    this.playerPos.set(0, PLAYER_EYE_HEIGHT, 6);
    this.playerVel.set(0, 0, 0);
    this.playerVelY = 0;
    this.isGrounded = true;
    this.controls.clearInputs();
    this.controls.resetLook(0, 0);
    this.hp = this.maxHp;
    this.recoilKick = 0;
    this.walkBobPhase = 0;
    this.lastFootstepIndex = 0;

    this.wolfUpgrades = {
      biteDamage: 0,
      maxHealth: 0,
      agilityFerocity: 0,
    };
    if (this.direWolf) {
      const w = this.direWolf;
      w.root.position.set(this.playerPos.x - 2.1, 0, this.playerPos.z + 1.6);
      w.root.rotation.set(0, Math.PI, 0);
      w.visual.rotation.set(0, 0, 0);
      w.visual.position.set(0, 0, 0);
      w.isDowned = false;
      w.biteWindowTimer = 0;
      w.pendingBiteImpactTimer = 0;
      w.pendingBiteTargetId = null;
      w.pendingBiteDamage = 0;
      w.lungeOffset = 0;
      w.attackCooldown = 0;
      w.hitFlashTimer = 0;
      w.targetZombieId = null;
      w.alertCooldown = 0;
      w.statusLabel = 'GUARDING';
      this.applyWolfUpgradesToEntity();
      w.currentHp = w.maxHp;
      for (let m = 0; m < w.materials.length; m++) {
        w.materials[m].emissive.copy(w.baseEmissives[m]);
      }
      this.transitionDireWolfState(w, 'idle', 0.15);
    }

    this.wave = 1;
    this.kills = 0;
    this.points = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.waveZombiesTotal = 6;
    this.waveZombiesRemainingToSpawn = 6;
    this.bossSpawnedForWave = false;
    this.waveSpawnCooldown = 0.4;
    this.waveIntermissionTimer = 0;
    this.supplyRespawnTimers = this.supplyPoints.map((_, idx) =>
      idx === 0 ? 2.0 : idx === 1 ? 5.0 : 0.4,
    );

    this.adrenaline = 100;
    if (this.isBulletTime) {
      this.deactivateBulletTime();
    }
    this.audio.ensureContext();
    this.audio.setLowHealthAlarm(false);
    this.weather.reset();
    this.setFlashlightEnabled(true);

    this.wantFullscreen = true;
    this.enterFullscreenAndLandscape();
    this.handleResize();
    this.switchScreen('PLAYING');
    this.syncWeaponModels(true);
    this.updateAllHud();
    this.updateBossHealthHUD();
    this.showWaveAnnouncement('HOSTILE BREACH DETECTED', 'WAVE 01 // ENGAGE', 'amber');
    this.updateTargetLockBadge(this.controls.isPointerLocked);
    this.renderSceneFrame();
    this.controls.requestPointerLock();
  }

  public pauseGame(): void {
    if (this.gameState !== 'PLAYING') return;
    this.playerVel.set(0, 0, 0);
    this.isFiringHeld = false;
    this.controls.clearInputs();
    this.controls.exitPointerLock();
    if (this.isBulletTime) this.deactivateBulletTime();
    this.audio.stopAllLoops();
    this.populateModal(true);
    this.switchScreen('PAUSED');
  }

  public resumeGame(allowPointerLock = true): void {
    if (this.gameState !== 'PAUSED') return;
    this.handleResize();
    this.switchScreen('PLAYING');
    this.renderSceneFrame();
    if (allowPointerLock) {
      this.controls.requestPointerLock();
    }
  }

  private enterHudEditor(): void {
    this.hudEditDraft = this.controls.getHudLayoutSnapshot();
    this.switchScreen('HUD_EDIT');
    this.controls.selectHudControl('btn-touch-fire');
    this.syncHudEditorToolbarUI('btn-touch-fire');
  }

  private exitHudEditor(save: boolean): void {
    if (save) {
      this.hudLayout = this.controls.getHudLayoutSnapshot();
      this.saveHudLayout();
    }
    this.controls.applyHudLayout(this.hudLayout);
    this.hudEditDraft = null;
    this.populateModal(true);
    this.switchScreen('PAUSED');
  }

  private syncHudEditorToolbarUI(id: TouchControlId): void {
    const snap = this.controls.getHudLayoutSnapshot();
    const item = snap.controls[id];
    const el = document.getElementById(id);

    const labelEl = document.getElementById('hud-edit-selected-label');
    if (labelEl) labelEl.innerText = el?.dataset.hudLabel || id.toUpperCase();

    const sizeSlider = document.getElementById('hud-edit-size-slider') as HTMLInputElement | null;
    const sizeVal = document.getElementById('hud-edit-size-val');
    const sizePct = Math.round((item?.scale ?? 1) * 100);
    if (sizeSlider) sizeSlider.value = String(sizePct);
    if (sizeVal) sizeVal.innerText = `${sizePct}%`;

    const opSlider = document.getElementById('hud-edit-opacity-slider') as HTMLInputElement | null;
    const opVal = document.getElementById('hud-edit-opacity-val');
    const opPct = Math.round((item?.opacity ?? 0.8) * 100);
    if (opSlider) opSlider.value = String(opPct);
    if (opVal) opVal.innerText = `${opPct}%`;

    const sensSlider = document.getElementById('hud-edit-sens-slider') as HTMLInputElement | null;
    const sensVal = document.getElementById('hud-edit-sens-val');
    const sensPct = Math.round(snap.touchSensitivity * 100);
    if (sensSlider) sensSlider.value = String(sensPct);
    if (sensVal) sensVal.innerText = `${snap.touchSensitivity.toFixed(1)}x`;
  }

  private triggerGameOver(): void {
    this.playerVel.set(0, 0, 0);
    this.isFiringHeld = false;
    this.controls.clearInputs();
    this.controls.exitPointerLock();
    this.audio.stopAllLoops();
    const bloodOverlay = document.getElementById('blood-screen-overlay');
    bloodOverlay?.classList.remove('low-hp-heartbeat');
    this.saveBestRecord();
    this.populateModal(false);
    this.switchScreen('GAME_OVER');
  }

  private populateModal(isPause: boolean): void {
    const eyebrow = document.getElementById('modal-eyebrow');
    const title = document.getElementById('modal-title');
    const resumeBtn = document.getElementById('btn-resume-mission');
    const settingsPanel = document.getElementById('pause-settings-panel');
    const waveEl = document.getElementById('gameover-wave');
    const killsEl = document.getElementById('gameover-kills');
    const accEl = document.getElementById('gameover-accuracy');
    const bestEl = document.getElementById('gameover-best');

    if (eyebrow) {
      eyebrow.innerText = isPause ? '// TACTICAL PAUSE' : '// FATAL CASUALTY';
    }
    if (title) {
      title.innerHTML = isPause
        ? 'MISSION <span class="text-amber-400">PAUSED</span>'
        : 'YOU WERE <span class="text-red-600">OVERRUN</span>';
    }
    if (resumeBtn) {
      resumeBtn.classList.toggle('hidden', !isPause);
    }
    if (settingsPanel) {
      settingsPanel.classList.toggle('hidden', !isPause);
    }
    if (isPause) {
      this.syncPauseSettingsUI();
    }

    const waveStr = this.wave < 10 ? `WAVE 0${this.wave}` : `WAVE ${this.wave}`;
    const killsStr = this.kills < 10 ? `0${this.kills}` : String(this.kills);
    const acc = this.shotsFired > 0 ? Math.min(100, Math.round((this.shotsHit / this.shotsFired) * 100)) : 0;
    const best = this.loadBestRecord();

    if (waveEl) waveEl.innerText = waveStr;
    if (killsEl) killsEl.innerText = killsStr;
    if (accEl) accEl.innerText = `${acc}%`;
    if (bestEl) bestEl.innerText = `W${best.bestWave < 10 ? '0' + best.bestWave : best.bestWave} · ${best.bestKills} KILLS`;
  }

  private loadPcSettings(isTouchCapable: boolean): PcSettings {
    const defaults: PcSettings = {
      mouseSensitivity: 1.0,
      fov: 72,
      graphicsQuality: isTouchCapable || this.detectedMobilePreview ? 'MED' : 'HIGH',
      forceTouchControls: false,
      mobilePreset: 'auto',
    };
    try {
      const raw = localStorage.getItem(PC_SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PcSettings>;
        return {
          mouseSensitivity: THREE.MathUtils.clamp(Number(parsed.mouseSensitivity) || 1.0, 0.3, 2.5),
          fov: THREE.MathUtils.clamp(Number(parsed.fov) || 72, 65, 95),
          graphicsQuality:
            parsed.graphicsQuality === 'LOW' ||
            parsed.graphicsQuality === 'MED' ||
            parsed.graphicsQuality === 'HIGH'
              ? parsed.graphicsQuality
              : defaults.graphicsQuality,
          forceTouchControls: Boolean(parsed.forceTouchControls),
          mobilePreset:
            parsed.mobilePreset === 'auto' ||
            parsed.mobilePreset === 'mobile' ||
            parsed.mobilePreset === 'desktop'
              ? parsed.mobilePreset
              : 'auto',
        };
      }
    } catch {
      // Ignore storage errors
    }
    return defaults;
  }

  private savePcSettings(): void {
    try {
      localStorage.setItem(PC_SETTINGS_STORAGE_KEY, JSON.stringify(this.pcSettings));
    } catch {
      // Ignore storage errors
    }
  }

  private lastAppliedMobilePreview: boolean | null = null;

  private applyPcSettings(): void {
    this.controls.mouseSensitivityMult = this.pcSettings.mouseSensitivity;
    this.controls.forceShowTouch = this.pcSettings.forceTouchControls;
    this.controls.updateMobileControlsVisibility();

    const quality = this.pcSettings.graphicsQuality;
    this.perfProfile = resolveRuntimePerfProfile(
      quality,
      this.pcSettings.mobilePreset,
      this.isSoftwareGl,
      this.detectedMobilePreview,
    );

    const qualityChanged = quality !== this.lastAppliedQuality;
    const profileChanged = this.perfProfile.isMobilePreview !== this.lastAppliedMobilePreview;

    if (qualityChanged || profileChanged) {
      this.lastAppliedQuality = quality;
      this.lastAppliedMobilePreview = this.perfProfile.isMobilePreview;

      const targetPr = this.computeTargetPixelRatio();
      if (Math.abs(this.renderer.getPixelRatio() - targetPr) > 0.01) {
        this.renderer.setPixelRatio(targetPr);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.lastAppliedPixelRatio = this.renderer.getPixelRatio();
      }

      this.renderer.shadowMap.enabled = this.perfProfile.allowShadows;
      this.moonLight.castShadow = this.perfProfile.allowShadows;
      const hasEnv = this.perfProfile.allowEnvReflections && !this.isSoftwareGl;
      this.ambientLight.intensity = hasEnv ? 0.28 : 0.56;
      this.hemiLight.intensity = hasEnv ? 1.12 : 1.54;
      this.syncEnvironmentReflection(hasEnv);
      this.syncPostProcessing(this.perfProfile.allowBloom);

      this.arena.setQuality(quality, this.perfProfile.isMobilePreview);
      this.vehiclePack?.setQuality(quality, this.perfProfile.isMobilePreview);
      this.propsPack?.setQuality(quality, this.perfProfile.isMobilePreview);
      this.bloodFx.setQuality(quality, this.perfProfile.isMobilePreview);
      this.zombiePool.setPoolLimits(this.perfProfile.zombiePoolMaxPerArch);

      this.camera.far = this.perfProfile.isMobilePreview
        ? 72
        : quality === 'LOW'
          ? 78
          : quality === 'MED'
            ? 118
            : 165;
      this.bossAuraLight.visible = this.perfProfile.allowPointLights;
      if (!this.bossAuraLight.visible) {
        this.bossAuraLight.intensity = 0;
      }
    }
    if (this.adsBlend < 0.05) {
      this.camera.fov = this.pcSettings.fov;
      this.camera.updateProjectionMatrix();
    } else if (qualityChanged || profileChanged) {
      this.camera.updateProjectionMatrix();
    }
    this.syncPauseSettingsUI();
  }

  private syncPauseSettingsUI(): void {
    const sensSlider = document.getElementById('setting-mouse-sens') as HTMLInputElement | null;
    const sensVal = document.getElementById('setting-mouse-sens-val');
    if (sensSlider) sensSlider.value = String(Math.round(this.pcSettings.mouseSensitivity * 100));
    if (sensVal) sensVal.innerText = `${this.pcSettings.mouseSensitivity.toFixed(1)}x`;

    const fovSlider = document.getElementById('setting-fov') as HTMLInputElement | null;
    const fovVal = document.getElementById('setting-fov-val');
    if (fovSlider) fovSlider.value = String(this.pcSettings.fov);
    if (fovVal) fovVal.innerText = `${this.pcSettings.fov}°`;

    (['LOW', 'MED', 'HIGH'] as GraphicsQuality[]).forEach((q) => {
      document
        .getElementById(`btn-quality-${q.toLowerCase()}`)
        ?.classList.toggle('active', this.pcSettings.graphicsQuality === q);
    });

    (['auto', 'mobile', 'desktop'] as MobilePresetMode[]).forEach((mode) => {
      document
        .getElementById(`btn-profile-${mode}`)
        ?.classList.toggle('active', this.pcSettings.mobilePreset === mode);
    });

    const showTouch = document.getElementById('setting-show-touch') as HTMLInputElement | null;
    if (showTouch) showTouch.checked = this.pcSettings.forceTouchControls;
  }

  private loadHudLayout(): TouchHudLayout {
    const defaults = createDefaultTouchHudLayout();
    try {
      const raw = localStorage.getItem(HUD_LAYOUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TouchHudLayout>;
        return {
          touchSensitivity: THREE.MathUtils.clamp(Number(parsed.touchSensitivity) || 1.0, 0.4, 2.2),
          controls: {
            ...defaults.controls,
            ...(parsed.controls || {}),
          },
        };
      }
    } catch {
      // Ignore storage errors
    }
    return defaults;
  }

  private saveHudLayout(): void {
    try {
      localStorage.setItem(HUD_LAYOUT_STORAGE_KEY, JSON.stringify(this.hudLayout));
    } catch {
      // Ignore storage errors
    }
  }

  private loadBestRecord(): BestRecord {
    try {
      const raw = localStorage.getItem(BEST_RECORD_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<BestRecord>;
        return {
          bestWave: Number(parsed.bestWave) || 0,
          bestKills: Number(parsed.bestKills) || 0,
        };
      }
    } catch {
      // Ignore storage errors
    }
    return { bestWave: 0, bestKills: 0 };
  }

  private saveBestRecord(): void {
    const current = this.loadBestRecord();
    const updated: BestRecord = {
      bestWave: Math.max(current.bestWave, this.wave),
      bestKills: Math.max(current.bestKills, this.kills),
    };
    try {
      localStorage.setItem(BEST_RECORD_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Ignore storage errors
    }
    this.refreshBestRecordUI();
  }

  private refreshBestRecordUI(): void {
    const best = this.loadBestRecord();
    const waveEl = document.getElementById('start-best-wave');
    const killsEl = document.getElementById('start-best-kills');
    if (waveEl) waveEl.innerText = best.bestWave < 10 ? `WAVE 0${best.bestWave}` : `WAVE ${best.bestWave}`;
    if (killsEl) killsEl.innerText = best.bestKills < 10 ? `0${best.bestKills}` : String(best.bestKills);
  }

  private clearArenaEntities(): void {
    this.bossAuraLight.intensity = 0;
    this.bloodFx.clearAll();
    for (const z of this.zombies) {
      this.bloodFx.clearWoundsForZombie(z);
      this.zombiePool.release(z, this.scene);
    }
    this.zombies = [];

    for (const p of this.pickups) {
      this.scene.remove(p.root);
    }
    this.pickups = [];

    for (const t of this.tracers3D) {
      t.mesh.visible = false;
      this.freeTracers3D.push(t);
    }
    this.tracers3D.length = 0;

    for (const c of this.casings3D) {
      c.mesh.visible = false;
      this.freeCasings3D.push(c);
    }
    this.casings3D.length = 0;

    for (const s of this.sparks3D) {
      s.mesh.visible = false;
      this.freeSparks3D.push(s);
    }
    this.sparks3D.length = 0;
  }

  private toggleMute(): void {
    const active = this.audio.toggleMute();
    const led = document.getElementById('sfx-status-led');
    const icon = document.getElementById('sfx-icon');
    const label = document.getElementById('sfx-label');
    const eqBars = document.getElementById('sfx-eq-bars');

    if (active) {
      if (led) led.className = 'w-2 h-2 rounded-xs bg-amber-400';
      if (icon) icon.innerText = '🔊';
      if (label) {
        label.innerText = 'SFX [M]';
        label.className = 'text-[10px] font-mono-numbers font-bold text-amber-400';
      }
      eqBars?.classList.remove('opacity-30');
      this.audio.playMechanicalClick(0.45, 1800);
    } else {
      if (led) led.className = 'w-2 h-2 rounded-xs bg-slate-600';
      if (icon) icon.innerText = '🔇';
      if (label) {
        label.innerText = 'MUTED [M]';
        label.className = 'text-[10px] font-mono-numbers font-bold text-slate-500';
      }
      eqBars?.classList.add('opacity-30');
    }
  }

  private toggleBulletTime(): void {
    if (this.gameState !== 'PLAYING') return;
    if (this.isBulletTime) {
      this.deactivateBulletTime();
    } else if (this.adrenaline >= 15) {
      this.activateBulletTime();
    }
  }

  private activateBulletTime(): void {
    if (this.isBulletTime) return;
    this.isBulletTime = true;
    this.audio.enterBulletTime();

    document.body.classList.add('bullet-time-active');
    const overlay = document.getElementById('bullet-time-overlay');
    const banner = document.getElementById('bullet-time-active-banner');
    const btn = document.getElementById('btn-top-bullet-time');
    const btnLabel = document.getElementById('btn-top-bullet-time-label');
    const btRing = document.getElementById('crosshair-bt-ring');
    const stateLabel = document.getElementById('adrenaline-state-label');
    const keyBadge = document.getElementById('bt-key-badge');
    const dot = document.getElementById('crosshair-center-dot');

    if (overlay) overlay.style.opacity = '1';
    if (banner) {
      banner.style.opacity = '1';
      banner.style.transform = 'translateY(0)';
    }
    if (btn) {
      btn.className =
        'tac-panel bg-cyan-500 text-[10px] uppercase font-bold text-black px-2.5 py-1.5 transition-all border border-cyan-200 shadow-[0_0_20px_#06b6d4] font-mono-numbers flex items-center gap-1.5 active:scale-95 cursor-pointer';
    }
    if (btnLabel) btnLabel.innerText = '⚡ Bullet-Time ACTIVE';
    if (btRing) btRing.style.opacity = '1';
    if (stateLabel) stateLabel.innerText = 'OVERCLOCK ENGAGED [0.35x]';
    if (keyBadge) {
      keyBadge.className =
        'text-[9px] font-mono-numbers px-1.5 py-0.5 rounded-xs bg-cyan-400 text-black font-bold ml-1.5';
      keyBadge.innerText = 'ACTIVE [Q]';
    }
    if (dot) dot.className = 'w-1.5 h-1.5 bg-cyan-300 rounded-full shadow-[0_0_8px_#06b6d4]';
  }

  private deactivateBulletTime(): void {
    if (!this.isBulletTime) return;
    this.isBulletTime = false;
    this.audio.exitBulletTime();

    document.body.classList.remove('bullet-time-active');
    const overlay = document.getElementById('bullet-time-overlay');
    const banner = document.getElementById('bullet-time-active-banner');
    const btn = document.getElementById('btn-top-bullet-time');
    const btnLabel = document.getElementById('btn-top-bullet-time-label');
    const btRing = document.getElementById('crosshair-bt-ring');
    const stateLabel = document.getElementById('adrenaline-state-label');
    const keyBadge = document.getElementById('bt-key-badge');
    const dot = document.getElementById('crosshair-center-dot');

    if (overlay) overlay.style.opacity = '0';
    if (banner) {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-8px)';
    }
    if (btn) {
      btn.className =
        'tac-panel bg-cyan-950/90 hover:bg-cyan-900 text-[10px] uppercase font-bold text-cyan-300 px-2.5 py-1.5 transition-all border border-cyan-400/80 font-mono-numbers flex items-center gap-1.5 active:scale-95 cursor-pointer';
    }
    if (btnLabel) btnLabel.innerText = 'Bullet-Time [F]';
    if (btRing) btRing.style.opacity = '0';
    if (stateLabel) {
      stateLabel.innerText = this.adrenaline >= 99 ? 'OVERCLOCK READY' : 'RECHARGING DRIVE...';
    }
    if (keyBadge) {
      keyBadge.className =
        'text-[9px] font-mono-numbers px-1.5 py-0.5 rounded-xs bg-cyan-950/80 text-cyan-300 border border-cyan-500/60 ml-1.5';
      keyBadge.innerText = '[F]';
    }
    if (dot) dot.className = 'w-1.5 h-1.5 bg-amber-400/90 rounded-full shadow-[0_0_6px_#f59e0b]';
  }

  private toggleFlashlight(): void {
    if (this.gameState !== 'PLAYING') return;
    this.setFlashlightEnabled(!this.isFlashlightOn);
    this.audio.playMechanicalClick(0.45, this.isFlashlightOn ? 1680 : 1120);
  }

  private setFlashlightEnabled(on: boolean): void {
    this.isFlashlightOn = on;
    this.flashlight.intensity = on ? 10 : 0;
    this.flashlightCone.visible = on;
    const btn = document.getElementById('btn-touch-light');
    btn?.classList.toggle('flashlight-active', on);
  }

  private switchWeapon(key: WeaponKey): void {
    if (this.activeWeapon === key || this.isReloading) return;
    this.activeWeapon = key;
    this.staticReloadTilt = 0;
    this.inspectTimer = 0;
    this.audio.playMechanicalClick(0.5, 1250);
    this.syncWeaponModels(true);
    this.updateAmmoHUD();
  }

  private inspectWeapon(): void {
    if (this.gameState !== 'PLAYING' || this.isReloading || this.isAdsActive) return;
    this.audio.playMechanicalClick(0.42, 1520);
    const slot = this.gunRig?.slots[this.activeWeapon];
    if (slot?.inspectAction && slot.mixer) {
      slot.mixer.stopAllAction();
      slot.inspectAction.reset();
      slot.inspectAction.timeScale = 1.0;
      slot.inspectAction.play();
      this.inspectTimer = Math.max(1.2, slot.inspectAction.getClip().duration);
    } else {
      // Smooth procedural weapon inspect showcase tilt/rotation
      this.inspectTimer = 1.65;
    }
  }

  private triggerJump(): void {
    if (this.gameState !== 'PLAYING' || !this.isGrounded) return;
    this.playerVelY = 6.5;
    this.isGrounded = false;
    this.audio.playMechanicalClick(0.35, 920);
  }

  private cycleWeapon(dir: 1 | -1): void {
    const idx = WEAPON_ORDER.indexOf(this.activeWeapon);
    const next = WEAPON_ORDER[(idx + dir + WEAPON_ORDER.length) % WEAPON_ORDER.length];
    this.switchWeapon(next);
  }

  private syncWeaponModels(playDraw = false): void {
    if (!this.gunRig) return;
    WEAPON_ORDER.forEach((k) => {
      const slot = this.gunRig!.slots[k];
      const active = k === this.activeWeapon;
      slot.pivotGroup.visible = active;
      slot.pivotGroup.position.copy(slot.basePos);
      slot.pivotGroup.rotation.set(0, slot.baseRotY, 0);
      if (!active) {
        slot.mixer?.stopAllAction();
      } else {
        this.gunRig!.muzzlePoint.position.copy(slot.muzzleLocal);
        if (playDraw && slot.drawAction) {
          slot.mixer?.stopAllAction();
          slot.drawAction.reset();
          slot.drawAction.timeScale = 1.0;
          slot.drawAction.play();
        }
      }
      const slotBtn = document.getElementById(`slot-${k}`);
      slotBtn?.classList.toggle('active', active);
    });
  }

  private reloadWeapon(): void {
    if (this.gameState !== 'PLAYING' || this.isReloading) return;
    const w = this.weapons[this.activeWeapon];
    if (w.currentAmmo >= w.magCapacity) return;
    if (w.reserveAmmo !== Infinity && w.reserveAmmo <= 0) return;

    const wasEmpty = w.currentAmmo <= 0;
    this.isReloading = true;
    this.inspectTimer = 0;
    const dilation = this.isBulletTime ? 1.55 : 1.0;
    const targetDuration = wasEmpty ? w.reloadEmptyDuration : w.reloadDuration;
    this.reloadTimer = targetDuration * dilation;
    this.audio.playReload(this.activeWeapon, dilation);

    // Trigger clip-mapped reload animation across all 3 weapons (Reload Empty at 0 ammo, Reload mid-mag)
    const slot = this.gunRig?.slots[this.activeWeapon];
    if (slot) {
      const chosenAction =
        wasEmpty && slot.reloadEmptyAction ? slot.reloadEmptyAction : slot.reloadAction;
      if (chosenAction && slot.mixer) {
        slot.mixer.stopAllAction();
        chosenAction.reset();
        const clipDur = Math.max(0.25, chosenAction.getClip().duration);
        chosenAction.timeScale = (clipDur / targetDuration) / dilation;
        chosenAction.play();
      }
    }

    const badge = document.getElementById('weapon-status-text');
    if (badge) badge.innerText = 'RELOADING...';
  }

  private finishReload(): void {
    const w = this.weapons[this.activeWeapon];
    const needed = w.magCapacity - w.currentAmmo;
    if (w.reserveAmmo === Infinity) {
      w.currentAmmo = w.magCapacity;
    } else {
      const taken = Math.min(needed, w.reserveAmmo);
      w.currentAmmo += taken;
      w.reserveAmmo -= taken;
    }
    this.isReloading = false;

    const badge = document.getElementById('weapon-status-text');
    if (badge) badge.innerText = 'READY';
    this.updateAmmoHUD();
  }

  private evaluateHitboxHeadshot(zombie: ZombieEntity, worldHitPoint: THREE.Vector3): boolean {
    zombie.root.updateMatrixWorld(true);
    _localHit.copy(worldHitPoint);
    zombie.root.worldToLocal(_localHit);
    const ext = zombie.hitboxExtents;
    if (ext.headMinZ !== undefined) {
      return _localHit.z > ext.headMinZ || _localHit.y > ext.headMinY;
    }
    return _localHit.y > ext.headMinY;
  }

  private findAimAssistHit(
    ray: THREE.Ray,
    maxDistance: number,
  ): { zombie: ZombieEntity; distance: number; point: THREE.Vector3 } | null {
    let bestZombie: ZombieEntity | null = null;
    let bestDist = maxDistance;
    const coneTolerance = 0.35;

    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (z.isDead) continue;
      z.root.updateMatrixWorld(true);
      _invRootMat.copy(z.root.matrixWorld).invert();

      _localRayOrigin.copy(ray.origin).applyMatrix4(_invRootMat);
      _localRayDir.copy(ray.direction).transformDirection(_invRootMat).normalize();

      const ext = z.hitboxExtents;
      const dx = -_localRayOrigin.x;
      const dy = ext.centerY - _localRayOrigin.y;
      const dz = -_localRayOrigin.z;
      const t = dx * _localRayDir.x + dy * _localRayDir.y + dz * _localRayDir.z;
      if (t <= 0.1 || t >= bestDist) continue;

      _closestRayPt.copy(_localRayOrigin).addScaledVector(_localRayDir, t);
      _closestBoxPt.set(
        THREE.MathUtils.clamp(_closestRayPt.x, -ext.halfX, ext.halfX),
        THREE.MathUtils.clamp(_closestRayPt.y, ext.centerY - ext.halfY, ext.centerY + ext.halfY),
        THREE.MathUtils.clamp(_closestRayPt.z, -ext.halfZ, ext.halfZ),
      );

      if (_closestRayPt.distanceToSquared(_closestBoxPt) <= coneTolerance * coneTolerance) {
        bestDist = t;
        bestZombie = z;
        _assistBestPt.copy(_closestBoxPt).applyMatrix4(z.root.matrixWorld);
      }
    }

    return bestZombie ? { zombie: bestZombie, distance: bestDist, point: _assistBestPt } : null;
  }

  private tryFire(): void {
    if (this.gameState !== 'PLAYING' || this.isReloading) return;
    const w = this.weapons[this.activeWeapon];
    const now = performance.now();
    const effectiveDelay = this.isBulletTime ? w.fireDelay * 1.45 : w.fireDelay;
    if (now - this.lastShotMs < effectiveDelay) return;

    if (w.currentAmmo <= 0) {
      this.reloadWeapon();
      return;
    }

    this.lastShotMs = now;
    this.inspectTimer = 0;
    w.currentAmmo -= 1;
    this.shotsFired += 1;
    this.updateAmmoHUD();

    const dilation = this.isBulletTime ? 1.65 : 1.0;
    this.audio.playWeaponFire(this.activeWeapon, dilation);

    // Trigger embedded Fire/Shoot animation on active weapon + procedural recoil kickback
    const slot = this.gunRig?.slots[this.activeWeapon];
    if (slot?.fireAction) {
      slot.drawAction?.stop();
      slot.inspectAction?.stop();
      slot.fireAction.reset();
      slot.fireAction.timeScale = 1.65 / dilation;
      slot.fireAction.play();
    }

    this.recoilKick = Math.min(0.14, this.recoilKick + w.recoilKick);
    this.controls.addRecoilPitch(w.pitchKick);
    this.gunFlashTimer = 0.06;
    this.muzzleLight.intensity = 15;
    if (this.gunRig) {
      const mat = this.gunRig.muzzleFlashMesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.95;
      this.gunRig.muzzleFlashMesh.rotation.z = Math.random() * Math.PI;
    }

    const camWrap = this.cameraViewportEl ?? document.getElementById('camera-viewport');
    if (camWrap) {
      this.triggerCameraShake(camWrap, this.isBulletTime ? 'slowmo-camera-recoil' : w.shakeClass);
    }

    const cross = this.crosshairRigEl ?? document.getElementById('crosshair-rig');
    if (cross) {
      this.triggerCrosshairKick(cross, w.kickClass);
    }

    // Eject spinning brass shell casing from right side of weapon
    this.spawnShellCasing();

    // Raycast directly against unified oversized invisible hitbox meshes (never skinned mesh triangles)
    const hitTargets = this.hitTargetsCache;
    hitTargets.length = 0;
    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (!z.isDead) {
        hitTargets.push(z.hitbox);
      }
    }

    if (this.gunRig) {
      this.gunRig.muzzlePoint.getWorldPosition(_muzzleWorld);
    } else {
      _muzzleWorld.copy(this.camera.position);
    }

    const originX = window.innerWidth * 0.78;
    const originY = window.innerHeight * 0.78;
    const centerX = window.innerWidth * 0.5;
    const centerY = window.innerHeight * 0.5;

    let anyHit = false;
    let anyHeadshot = false;
    let totalCritDmg = 0;

    const effectiveSpread = w.spread * THREE.MathUtils.lerp(1.0, 0.32, this.adsBlend);

    for (let p = 0; p < w.pellets; p++) {
      _raycaster.setFromCamera(_ndcCenter, this.camera);
      _rayDir.copy(_raycaster.ray.direction);
      _rayDir.x += (Math.random() - 0.5) * effectiveSpread;
      _rayDir.y += (Math.random() - 0.5) * effectiveSpread;
      _rayDir.z += (Math.random() - 0.5) * effectiveSpread;
      _rayDir.normalize();
      _raycaster.ray.direction.copy(_rayDir);
      _raycaster.far = 85;

      _raycaster.layers.set(1);
      const zombieHits = _raycaster.intersectObjects(hitTargets, false);
      _raycaster.layers.set(0);
      const envHits = _raycaster.intersectObjects(this.envRaycastTargets, false);

      const closestEnv = envHits[0];
      const maxEnvDist = closestEnv ? closestEnv.distance : 85;
      const directHit = zombieHits[0];

      let resolvedZombie: ZombieEntity | undefined;
      let resolvedPoint: THREE.Vector3 | undefined;

      if (directHit && directHit.distance <= maxEnvDist) {
        resolvedZombie = directHit.object.userData.zombie as ZombieEntity | undefined;
        resolvedPoint = directHit.point;
      } else {
        // Secondary proximity-cone check (0.35 world unit forgiveness around crawler & standing hitboxes)
        const assistHit = this.findAimAssistHit(_raycaster.ray, maxEnvDist);
        if (assistHit) {
          resolvedZombie = assistHit.zombie;
          resolvedPoint = assistHit.point;
        }
      }

      const endPoint = _tracerEnd.copy(_muzzleWorld).addScaledVector(_rayDir, 48);

      if (resolvedZombie && !resolvedZombie.isDead && resolvedPoint) {
        endPoint.copy(resolvedPoint);
        const isHead = this.evaluateHitboxHeadshot(resolvedZombie, resolvedPoint);
        anyHit = true;
        const mult = isHead ? (this.isBulletTime ? 3.5 : 2.5) : this.isBulletTime ? 1.5 : 1.0;
        const dmg = Math.round(w.baseDmg * mult);
        if (isHead) {
          anyHeadshot = true;
          totalCritDmg += dmg;
        }
        const willKill = resolvedZombie.hp - dmg <= 0;
        _assistImpactDir.copy(_rayDir);
        this.bloodFx.spawnZombieBloodHit({
          zombie: resolvedZombie,
          hitPoint: resolvedPoint,
          shotDir: _assistImpactDir,
          isHead,
          isKill: willKill,
          isHeavyWeapon: w.pellets > 1 || w.baseDmg >= 45,
          cameraPos: this.camera.position,
          envTargets: this.envRaycastTargets,
        });
        this.spawnFloatingDamageNumber(resolvedPoint, dmg, isHead, resolvedZombie.isBoss);
        this.damageZombie(resolvedZombie, dmg, isHead, _assistImpactDir);
      } else if (closestEnv) {
        endPoint.copy(closestEnv.point);
        if (closestEnv.face) {
          _normalMatrix.getNormalMatrix(closestEnv.object.matrixWorld);
          _hitNormal.copy(closestEnv.face.normal).applyMatrix3(_normalMatrix).normalize();
        } else {
          _hitNormal.set(0, 1, 0);
        }
        const isMetalHit = Boolean(closestEnv.object.userData.isVehicleMetal);
        this.spawnImpactSparks(closestEnv.point, _hitNormal, isMetalHit);
        if (isMetalHit) {
          const nowRicochet = performance.now();
          if (nowRicochet - this.lastBrassClinkMs > 75) {
            this.lastBrassClinkMs = nowRicochet;
            this.audio.playBrassClink();
          }
        }
      }

      this.spawn3DTracer(_muzzleWorld, endPoint);
      const offsetX = (Math.random() - 0.5) * w.hudSpreadPx;
      const offsetY = (Math.random() - 0.5) * w.hudSpreadPx;
      this.spawnHudTracer(originX, originY, centerX + offsetX, centerY + offsetY);
    }

    if (anyHit) {
      this.shotsHit += 1;
      if (anyHeadshot) {
        this.audio.playHeadshotCrit(this.isBulletTime);
        this.triggerHeadshotPopup(centerX, centerY - 25, totalCritDmg);
      } else {
        this.audio.playBodyHit();
        const hm = this.hitmarkerEl ?? document.getElementById('hitmarker');
        if (hm) {
          hm.style.opacity = '1';
          window.setTimeout(() => {
            hm.style.opacity = '0';
          }, 120);
        }
      }
      this.spawnAcousticRipple(centerX, centerY, w.pellets > 1, this.isBulletTime ? 'cyan' : 'amber');
    }

    if (!w.autoFire) {
      this.isFiringHeld = false;
    }
  }

  private triggerCameraShake(
    el: HTMLElement,
    shakeClass: string,
  ): void {
    if (typeof el.animate !== 'function') return;
    this.cameraShakeAnim?.cancel();
    if (shakeClass === 'heavy-screen-shake-active') {
      this.cameraShakeAnim = el.animate(
        [
          { transform: 'translate3d(0, 0, 0)' },
          { transform: 'translate3d(-6px, -6px, 0)', offset: 0.2 },
          { transform: 'translate3d(5px, 3px, 0)', offset: 0.5 },
          { transform: 'translate3d(-3px, 2px, 0)', offset: 0.8 },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 160, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    } else if (shakeClass === 'slowmo-camera-recoil') {
      this.cameraShakeAnim = el.animate(
        [
          { transform: 'scale(1) translate3d(0, 0, 0)' },
          { transform: 'scale(1.015) translate3d(0, -3px, 0)', offset: 0.35 },
          { transform: 'scale(1) translate3d(0, 0, 0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    } else {
      this.cameraShakeAnim = el.animate(
        [
          { transform: 'translate3d(0, 0, 0)' },
          { transform: 'translate3d(-2px, -3px, 0)', offset: 0.25 },
          { transform: 'translate3d(2px, 1px, 0)', offset: 0.5 },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 95, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    }
  }

  private triggerCrosshairKick(
    el: HTMLElement,
    kickClass: string,
  ): void {
    if (typeof el.animate !== 'function') return;
    this.crosshairKickAnim?.cancel();
    if (kickClass === 'crosshair-kick-shotgun') {
      this.crosshairKickAnim = el.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.48)', offset: 0.3 },
          { transform: 'scale(1)' },
        ],
        { duration: 180, easing: 'ease-out' },
      );
    } else {
      this.crosshairKickAnim = el.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.24)', offset: 0.35 },
          { transform: 'scale(1)' },
        ],
        { duration: 110, easing: 'ease-out' },
      );
    }
  }

  private spawnFloatingDamageNumber(
    worldPos: THREE.Vector3,
    dmg: number,
    isHead: boolean,
    isBoss: boolean,
  ): void {
    const layer = this.damageNumbersLayerEl ?? document.getElementById('damage-numbers-layer');
    if (!layer) return;

    _projVec.copy(worldPos).project(this.camera);
    if (_projVec.z >= 1) return;

    const sx = (_projVec.x * 0.5 + 0.5) * window.innerWidth + (Math.random() - 0.5) * 18;
    const sy = (-_projVec.y * 0.5 + 0.5) * window.innerHeight - 10;

    const el = document.createElement('div');
    el.className = `damage-number-float font-mono-numbers font-bold ${
      isHead
        ? 'text-xl sm:text-2xl text-amber-300 drop-shadow-[0_0_8px_rgba(245,158,11,0.9)]'
        : isBoss
          ? 'text-base sm:text-lg text-orange-400 drop-shadow-[0_0_6px_rgba(249,115,22,0.8)]'
          : 'text-sm sm:text-base text-slate-100 drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]'
    }`;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.innerText = isHead ? `${dmg}!` : String(dmg);
    layer.appendChild(el);
    window.setTimeout(() => el.remove(), 700);
  }

  private damageZombie(
    zombie: ZombieEntity,
    dmg: number,
    isHead: boolean,
    impactDir?: THREE.Vector3,
    fromWolf = false,
  ): void {
    zombie.hp -= dmg;
    zombie.hitFlashTimer = 0.14;

    if (impactDir) {
      _toPlayer.copy(impactDir).setY(0);
    } else {
      _toPlayer.subVectors(zombie.root.position, this.playerPos).setY(0);
    }
    if (_toPlayer.lengthSq() > 0.0001) {
      _toPlayer.normalize();
      if (fromWolf) {
        // Non-lethal wolf jaw impact: heavy 1.2-unit stagger knockback + backward tilt
        const wolfKnockVel = zombie.isBoss ? 5.5 : 13.5;
        zombie.staggerVel.copy(_toPlayer).multiplyScalar(wolfKnockVel);
        zombie.staggerTimer = zombie.isBoss ? 0.18 : 0.34;
      } else {
        const impulse = zombie.isBoss ? 1.4 : isHead ? 4.2 : 2.6;
        zombie.staggerVel.addScaledVector(_toPlayer, impulse);
        zombie.staggerTimer = zombie.isBoss ? 0.09 : isHead ? 0.22 : 0.14;
      }
    }

    if (zombie.isBoss) {
      this.updateBossHealthHUD();
    }

    if (zombie.hp <= 0 && !zombie.isDead) {
      zombie.isDead = true;
      zombie.deathTimer = 0;
      zombie.killedByWolf = fromWolf;

      // Immediately disable hitbox and stop all animations for ragdoll collapse
      zombie.hitbox.visible = false;
      zombie.root.remove(zombie.hitbox);
      zombie.walkAction?.stop();
      zombie.idleAction?.stop();
      zombie.attackAction?.stop();

      // Stronger knockback impulse away from bullet / wolf direction on lethal blow
      if (_toPlayer.lengthSq() > 0.0001) {
        if (fromWolf) {
          const wolfDeathImpulse = zombie.isBoss ? 5.2 : 9.2;
          zombie.staggerVel.copy(_toPlayer).multiplyScalar(wolfDeathImpulse);
          zombie.staggerTimer = 0.4;
        } else {
          const deathImpulse = zombie.isBoss ? 3.2 : isHead ? 7.2 : 4.4;
          zombie.staggerVel.addScaledVector(_toPlayer, deathImpulse);
          zombie.staggerTimer = isHead ? 0.45 : 0.32;
        }
      }

      this.kills += 1;

      const baseKillPts = zombie.isBoss
        ? 500
        : zombie.archetype === 'runner'
          ? 150
          : zombie.archetype === 'walker_shambler'
            ? 125
            : zombie.archetype === 'crawler'
              ? 90
              : 100;
      const headshotBonus = isHead ? 50 : 0;
      this.points += baseKillPts + headshotBonus;

      this.adrenaline = Math.min(100, this.adrenaline + (zombie.isBoss ? 40 : isHead ? 18 : 10));
      this.audio.playZombieGroan(
        zombie.root.position.distanceTo(this.playerPos),
        zombie.isBoss ? 'boss' : zombie.variant === 'screamer' ? 'screamer' : 'normal',
        this.isBulletTime,
      );
      this.maybeDropPickup(zombie.root.position, zombie.isBoss);
      this.updateWaveKillsHUD();
      if (zombie.isBoss) {
        this.updateBossHealthHUD();
      }
    }
  }

  private spawnMedkitCrate(
    x: number,
    z: number,
    life: number,
    supplySlotIndex?: number,
    healAmount = 45,
  ): void {
    const group = new THREE.Group();

    const box = new THREE.Mesh(this.medkitBoxGeo, this.medkitCrateMat);
    box.position.y = 0.28;
    group.add(box);

    const crossH = new THREE.Mesh(this.medkitCrossHGeo, this.medkitCrossMat);
    crossH.position.y = 0.28;
    group.add(crossH);

    const crossV = new THREE.Mesh(this.medkitCrossVGeo, this.medkitCrossMat);
    crossV.position.y = 0.28;
    group.add(crossV);

    // Floating glowing green halo cross above the crate
    const floatCrossA = new THREE.Mesh(this.medkitFloatAGeo, this.medkitCrossMat);
    floatCrossA.position.y = 0.72;
    group.add(floatCrossA);

    const floatCrossB = new THREE.Mesh(this.medkitFloatBGeo, this.medkitCrossMat);
    floatCrossB.position.y = 0.72;
    group.add(floatCrossB);

    group.position.set(x, 0, z);
    this.scene.add(group);
    this.pickups.push({
      root: group,
      type: 'medkit',
      position: group.position,
      life,
      healAmount,
      supplySlotIndex,
    });
  }

  private maybeDropPickup(pos: THREE.Vector3, guaranteedMedkit = false): void {
    if (guaranteedMedkit || (this.hp <= 65 && Math.random() < 0.6)) {
      this.spawnMedkitCrate(pos.x, pos.z, 32, undefined, 45);
      return;
    }

    if (Math.random() > 0.26) return;

    const group = new THREE.Group();
    const box = new THREE.Mesh(this.ammoBoxGeo, this.ammoBoxMat);
    box.position.y = 0.25;
    group.add(box);

    const stripe = new THREE.Mesh(this.ammoStripeGeo, this.ammoStripeMat);
    stripe.position.y = 0.25;
    group.add(stripe);

    group.position.set(pos.x, 0, pos.z);
    this.scene.add(group);
    this.pickups.push({
      root: group,
      type: 'ammo',
      position: group.position,
      life: 24,
    });
  }

  private spawn3DTracer(start: THREE.Vector3, end: THREE.Vector3): void {
    const dist = start.distanceTo(end);
    if (dist < 0.2) return;

    let entry = this.freeTracers3D.pop();
    if (!entry) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      entry = { mesh, life: 0, maxLife: 0.06 };
    }

    const mat = entry.mesh.material as THREE.MeshBasicMaterial;
    if (this.isBulletTime) {
      mat.color.setRGB(0.6, 2.0, 2.8);
    } else {
      mat.color.setRGB(2.6, 2.1, 0.9);
    }
    mat.opacity = 0.9;
    entry.mesh.scale.set(1, 1, dist);
    entry.mesh.position.copy(start).lerp(end, 0.5);
    entry.mesh.lookAt(end);
    entry.mesh.visible = true;
    entry.maxLife = this.isBulletTime ? 0.18 : 0.06;
    entry.life = entry.maxLife;
    this.tracers3D.push(entry);
  }

  private spawnShellCasing(): void {
    let entry: ShellCasing3D;
    if (this.casings3D.length >= MAX_CASINGS) {
      entry = this.casings3D.shift()!;
    } else if (this.freeCasings3D.length > 0) {
      entry = this.freeCasings3D.pop()!;
    } else {
      const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
      this.scene.add(mesh);
      entry = {
        mesh,
        vel: new THREE.Vector3(),
        rotVel: new THREE.Vector3(),
        life: 1.6,
        bounces: 0,
      };
    }

    this.camera.matrixWorld.extractBasis(_camRight, _camUp, _camFwd);
    const adsOffset = THREE.MathUtils.lerp(0.24, 0.09, this.adsBlend);
    entry.mesh.position
      .copy(this.camera.position)
      .addScaledVector(_camRight, adsOffset)
      .addScaledVector(_camUp, -0.1)
      .addScaledVector(_camFwd, -0.42);
    entry.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    entry.mesh.visible = true;

    entry.vel
      .set(0, 0, 0)
      .addScaledVector(_camRight, 2.1 + Math.random() * 1.1)
      .addScaledVector(_camUp, 1.55 + Math.random() * 0.75)
      .addScaledVector(_camFwd, 0.4 + (Math.random() - 0.5) * 0.6);
    entry.rotVel.set(
      (Math.random() - 0.5) * 28,
      (Math.random() - 0.5) * 28,
      (Math.random() - 0.5) * 28,
    );
    entry.life = 1.6;
    entry.bounces = 0;

    this.casings3D.push(entry);
  }

  private acquireSparkParticle(geo: THREE.BufferGeometry): SparkParticle3D {
    let entry: SparkParticle3D;
    if (this.sparks3D.length >= MAX_SPARKS) {
      entry = this.sparks3D.shift()!;
    } else if (this.freeSparks3D.length > 0) {
      entry = this.freeSparks3D.pop()!;
    } else {
      const mat = this.sparkMat.clone();
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      entry = {
        mesh,
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.25,
        gravity: 9.8,
      };
    }
    if (entry.mesh.geometry !== geo) {
      entry.mesh.geometry = geo;
    }
    entry.mesh.visible = true;
    return entry;
  }

  private spawnImpactSparks(point: THREE.Vector3, normal: THREE.Vector3, isMetal = false): void {
    const baseCount = this.pcSettings.graphicsQuality === 'LOW' ? 4 : 8;
    const count = isMetal ? baseCount + 4 : baseCount;
    const speedMult = isMetal ? 1.35 : 1.0;

    for (let i = 0; i < count; i++) {
      const sp = this.acquireSparkParticle(this.sparkGeo);
      const mat = sp.mesh.material as THREE.MeshBasicMaterial;
      if (isMetal) {
        mat.color.setHex(i % 2 === 0 ? 0xfef08a : 0xfb923c);
      } else {
        mat.color.copy(this.sparkMat.color);
      }
      mat.opacity = 0.95;

      sp.mesh.scale.setScalar(1);
      sp.mesh.position.copy(point).addScaledVector(normal, 0.04);

      _bounceDir
        .copy(normal)
        .multiplyScalar((2.6 + Math.random() * 2.8) * speedMult)
        .add(
          _toPlayer.set(
            (Math.random() - 0.5) * 3.8 * speedMult,
            Math.random() * 2.4 * speedMult,
            (Math.random() - 0.5) * 3.8 * speedMult,
          ),
        );
      sp.mesh.lookAt(
        sp.mesh.position.x + _bounceDir.x,
        sp.mesh.position.y + _bounceDir.y,
        sp.mesh.position.z + _bounceDir.z,
      );
      sp.vel.copy(_bounceDir);
      const maxLife = 0.22 + Math.random() * 0.16;
      sp.life = maxLife;
      sp.maxLife = maxLife;
      sp.gravity = 13.5;
      this.sparks3D.push(sp);
    }
  }

  private spawnWaterSplashParticles(footPos: THREE.Vector3): void {
    const count = this.pcSettings.graphicsQuality === 'LOW' ? 3 : 6;
    for (let i = 0; i < count; i++) {
      const sp = this.acquireSparkParticle(this.waterSplashGeo);
      const mat = sp.mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(0xbae6fd);
      mat.opacity = 0.72;

      sp.mesh.rotation.set(0, 0, 0);
      sp.mesh.position.set(
        footPos.x + (Math.random() - 0.5) * 0.35,
        0.04,
        footPos.z + (Math.random() - 0.5) * 0.35,
      );
      sp.mesh.scale.setScalar(0.42 + Math.random() * 0.35);

      const angle = Math.random() * Math.PI * 2;
      const horiz = 0.7 + Math.random() * 1.4;
      sp.vel.set(
        Math.cos(angle) * horiz,
        0.85 + Math.random() * 1.25,
        Math.sin(angle) * horiz,
      );
      const maxLife = 0.24 + Math.random() * 0.12;
      sp.life = maxLife;
      sp.maxLife = maxLife;
      sp.gravity = 9.8;
      this.sparks3D.push(sp);
    }
  }

  private spawnHudTracer(originX: number, originY: number, targetX: number, targetY: number): void {
    const container = this.bulletFxContainerEl ?? document.getElementById('bullet-fx-container');
    if (!container) return;
    const dx = targetX - originX;
    const dy = targetY - originY;
    const distance = Math.hypot(dx, dy);
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    const tracer = document.createElement('div');
    tracer.className = this.isBulletTime ? 'tracer-line-slowmo' : 'tracer-line';
    tracer.style.width = `${distance}px`;
    tracer.style.left = `${originX}px`;
    tracer.style.top = `${originY}px`;
    tracer.style.setProperty('--x1', '0px');
    tracer.style.setProperty('--y1', '0px');
    tracer.style.setProperty('--angle', `${angleDeg}deg`);
    container.appendChild(tracer);

    window.setTimeout(() => tracer.remove(), this.isBulletTime ? 440 : 115);
  }

  private spawnAcousticRipple(x: number, y: number, isHeavy: boolean, color: 'cyan' | 'amber'): void {
    const layer = this.acousticRipplesLayerEl ?? document.getElementById('acoustic-ripples-layer');
    if (!layer) return;
    const rip = document.createElement('div');
    const borderColor =
      color === 'cyan'
        ? 'border-cyan-400 shadow-[0_0_15px_#06b6d4]'
        : 'border-amber-400 shadow-[0_0_15px_#f59e0b]';
    rip.className = `acoustic-ripple border-2 ${borderColor}`;
    rip.style.left = `${x}px`;
    rip.style.top = `${y}px`;
    rip.style.width = `${isHeavy ? 140 : 90}px`;
    rip.style.height = `${isHeavy ? 140 : 90}px`;
    layer.appendChild(rip);
    window.setTimeout(() => rip.remove(), 600);
  }

  private triggerHeadshotPopup(x: number, y: number, damage: number): void {
    const hudLayer = this.critHudLayerEl ?? document.getElementById('crit-hud-layer');
    if (!hudLayer) return;

    const critHitmarker = this.critHitmarkerEl ?? document.getElementById('crit-hitmarker');
    if (critHitmarker) {
      critHitmarker.classList.remove('opacity-0', 'scale-50');
      critHitmarker.classList.add('opacity-100', 'scale-125');
      window.setTimeout(() => {
        critHitmarker.classList.remove('opacity-100', 'scale-125');
        critHitmarker.classList.add('opacity-0', 'scale-50');
      }, this.isBulletTime ? 380 : 190);
    }

    const shockwave = document.createElement('div');
    shockwave.className = `crit-shockwave ${
      this.isBulletTime
        ? 'border-cyan-400 shadow-[0_0_20px_#06b6d4]'
        : 'border-amber-400 shadow-[0_0_15px_#f59e0b]'
    }`;
    shockwave.style.left = `${x}px`;
    shockwave.style.top = `${y}px`;
    shockwave.style.width = '64px';
    shockwave.style.height = '64px';
    hudLayer.appendChild(shockwave);
    window.setTimeout(() => shockwave.remove(), 650);

    const pop = document.createElement('div');
    pop.className = `absolute pointer-events-none flex flex-col items-center ${
      this.isBulletTime ? 'crit-popup-slowmo' : 'crit-popup-normal'
    }`;
    pop.style.left = `${x + (Math.random() * 18 - 9)}px`;
    pop.style.top = `${y - 16}px`;

    const isSlow = this.isBulletTime;
    const title = isSlow ? 'BULLET-TIME HEADSHOT' : 'HEADSHOT';
    const mult = isSlow ? '⚡ x3.5 OVERCLOCK' : 'x2.5 CRITICAL';

    pop.innerHTML = `
      <div class="relative px-3.5 py-1.5 rounded-sm border-2 ${
        isSlow
          ? 'cyan-crit-glow border-cyan-400 bg-slate-950/95'
          : 'gold-crit-glow border-amber-400 bg-slate-950/95'
      } flex flex-col items-center">
        <div class="font-heavy text-2xl sm:text-3xl tracking-wider uppercase leading-none font-bold ${
          isSlow ? 'text-white chromatic-crit-text' : 'text-amber-300'
        }">${title}</div>
        <div class="flex items-center gap-2 mt-0.5 font-mono-numbers">
          <span class="px-1.5 py-0.5 rounded-xs text-[10px] font-bold ${
            isSlow ? 'bg-cyan-500/30 text-cyan-200' : 'bg-amber-500/30 text-amber-300'
          }">${mult}</span>
          <span class="text-lg font-bold font-heavy text-white">+${damage}</span>
        </div>
      </div>
    `;
    hudLayer.appendChild(pop);
    window.setTimeout(() => pop.remove(), isSlow ? 1650 : 850);
  }

  private pickRandomArchetype(): ZombieArchetype {
    const runnerRatio = Math.min(0.46, 0.2 + (this.wave - 1) * 0.045);
    const r = Math.random();
    if (r < runnerRatio) return 'runner';
    const rem = (r - runnerRatio) / (1 - runnerRatio);
    if (rem < 0.27) return 'walker_survivor';
    if (rem < 0.54) return 'walker_yaku';
    if (rem < 0.8) return 'walker_shambler';
    return 'crawler';
  }

  private spawnWaveBatch(count: number, forcedOrder?: ZombieArchetype[]): void {
    if (!this.enemyRoster) return;
    for (let i = 0; i < count; i++) {
      const sp = this.arena.spawnPoints[Math.floor(Math.random() * this.arena.spawnPoints.length)];
      const jitter = new THREE.Vector3((Math.random() - 0.5) * 3.5, 0, (Math.random() - 0.5) * 3.5);
      const pos = sp.clone().add(jitter);

      const archetype = forcedOrder ? forcedOrder[i % forcedOrder.length] : this.pickRandomArchetype();
      const template = this.enemyRoster[archetype];
      const z = this.zombiePool.acquire(
        template,
        this.nextZombieId++,
        archetype,
        this.wave,
        pos,
        this.isSoftwareGl,
        false,
      );
      this.scene.add(z.root);
      this.zombies.push(z);
    }
  }

  private spawnWaveBoss(): void {
    if (!this.enemyRoster) return;
    const sp = this.arena.spawnPoints[Math.floor(Math.random() * this.arena.spawnPoints.length)];
    const bossArchetype: ZombieArchetype = this.wave % 2 === 0 ? 'walker_shambler' : 'walker_yaku';
    const template = this.enemyRoster[bossArchetype];
    const boss = this.zombiePool.acquire(
      template,
      this.nextZombieId++,
      bossArchetype,
      this.wave,
      sp.clone(),
      this.isSoftwareGl,
      true,
    );
    this.scene.add(boss.root);
    this.zombies.push(boss);

    const wStr = this.wave < 10 ? `WAVE 0${this.wave}` : `WAVE ${this.wave}`;
    this.showWaveAnnouncement('ALPHA BIO-THREAT DETECTED', `${wStr} // BOSS INCOMING`, 'red');
    this.updateBossHealthHUD();
  }

  private showWaveAnnouncement(sub: string, title: string, tone: 'amber' | 'red'): void {
    const banner = document.getElementById('wave-announcement-banner');
    const card = document.getElementById('wave-announcement-card');
    const subEl = document.getElementById('wave-announcement-sub');
    const titleEl = document.getElementById('wave-announcement-title');
    if (!banner || !card || !subEl || !titleEl) return;

    subEl.innerText = sub;
    titleEl.innerText = title;
    card.className =
      tone === 'red'
        ? 'tac-panel bg-red-950/90 border-2 border-red-500 px-6 py-2 rounded-sm shadow-[0_0_35px_rgba(220,38,38,0.55)] text-center'
        : 'tac-panel bg-slate-950/90 border border-amber-500/70 px-6 py-2 rounded-sm shadow-[0_0_30px_rgba(245,158,11,0.35)] text-center';
    subEl.className =
      tone === 'red'
        ? 'text-[10px] font-mono-numbers font-bold text-red-300 tracking-widest uppercase'
        : 'text-[10px] font-mono-numbers font-bold text-amber-400 tracking-widest uppercase';

    banner.style.opacity = '1';
    banner.style.transform = 'translateY(0)';
    window.clearTimeout(this.waveBannerTimeout);
    this.waveBannerTimeout = window.setTimeout(() => {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-12px)';
    }, 2800);
  }

  private updateBossHealthHUD(): void {
    const hud = document.getElementById('boss-health-hud');
    const fill = document.getElementById('boss-hp-fill');
    const txt = document.getElementById('boss-hp-text');
    if (!hud) return;

    const liveBoss = this.zombies.find((z) => z.isBoss && !z.isDead);
    if (!liveBoss) {
      hud.classList.add('hidden');
      return;
    }

    hud.classList.remove('hidden');
    const hp = Math.max(0, Math.round(liveBoss.hp));
    const pct = Math.max(0, Math.min(100, (hp / Math.max(1, liveBoss.maxHp)) * 100));
    if (fill) fill.style.width = `${pct}%`;
    if (txt) txt.innerText = `${hp} / ${liveBoss.maxHp}`;
  }

  private flashHealScreen(): void {
    const overlay = document.getElementById('heal-screen-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0.85';
    window.clearTimeout(this.healFlashTimeout);
    this.healFlashTimeout = window.setTimeout(() => {
      overlay.style.opacity = '0';
    }, 340);
  }

  private updateTargetLockBadge(locked: boolean): void {
    const badge = document.getElementById('tgt-lock-badge');
    if (!badge) return;
    if (this.controls.isTouchDevice) {
      badge.innerText = 'TOUCH COMBAT ACTIVE';
      return;
    }
    badge.innerText = locked ? 'AIM LOCKED [P / ESC PAUSE]' : 'CLICK ARENA TO LOCK AIM';
  }

  private updateAmmoHUD(): void {
    const w = this.weapons[this.activeWeapon];
    const ammoCount = document.getElementById('ammo-count');
    const ammoReserve = document.getElementById('ammo-reserve');
    const title = document.getElementById('weapon-title-label');
    const cat = document.getElementById('weapon-category-label');
    const mode = document.getElementById('weapon-firemode-indicator');
    const cal = document.getElementById('weapon-caliber-label');

    if (ammoCount) ammoCount.innerText = w.currentAmmo < 10 ? `0${w.currentAmmo}` : String(w.currentAmmo);
    if (ammoReserve) ammoReserve.innerText = w.reserveAmmo === Infinity ? '∞' : String(w.reserveAmmo);
    if (title) title.innerText = w.name;
    if (cat) cat.innerText = w.category;
    if (mode) mode.innerText = w.fireMode;
    if (cal) cal.innerText = w.caliber;

    WEAPON_ORDER.forEach((k) => {
      const slotAmmo = document.getElementById(`slot-ammo-${k}`);
      if (!slotAmmo) return;
      const wk = this.weapons[k];
      const cur = wk.currentAmmo < 10 ? `0${wk.currentAmmo}` : String(wk.currentAmmo);
      const res = wk.reserveAmmo === Infinity ? '∞' : String(wk.reserveAmmo);
      slotAmmo.innerText = `${cur}/${res}`;
    });
  }

  private updateHealthHUD(): void {
    const hpEl = document.getElementById('hp-value');
    const bar = document.getElementById('hp-segments-bar');
    const vitals = document.getElementById('vitals-status-label');
    const bloodOverlay = document.getElementById('blood-screen-overlay');
    const traumaBanner = document.getElementById('critical-trauma-banner');

    const roundedHp = Math.max(0, Math.round(this.hp));
    if (hpEl) hpEl.innerText = String(roundedHp);

    if (roundedHp > 0 && roundedHp < 30) {
      bloodOverlay?.classList.add('low-hp-heartbeat');
      if (bloodOverlay) bloodOverlay.style.opacity = '1';
      traumaBanner?.classList.remove('hidden');
      if (vitals) vitals.innerText = 'CRITICAL // BLEEDING';
      this.audio.setLowHealthAlarm(true);
    } else {
      bloodOverlay?.classList.remove('low-hp-heartbeat');
      if (bloodOverlay && roundedHp > 0) bloodOverlay.style.opacity = '0';
      traumaBanner?.classList.add('hidden');
      if (vitals) vitals.innerText = roundedHp >= 75 ? 'OPTIMAL' : 'WOUNDED';
      this.audio.setLowHealthAlarm(false);
    }

    if (bar) {
      const count = Math.round((roundedHp / this.maxHp) * 10);
      let html = '';
      for (let i = 0; i < 10; i++) {
        html +=
          i < count
            ? '<div class="flex-1 bg-red-600 h-full"></div>'
            : '<div class="flex-1 bg-slate-800 h-full"></div>';
      }
      bar.innerHTML = html;
    }
  }

  private updateWaveKillsHUD(): void {
    const waveEl = document.getElementById('wave-display');
    const killsEl = document.getElementById('kills-display');
    const pointsEl = document.getElementById('points-display');
    const progressEl = document.getElementById('wave-progress-bar');

    if (waveEl) waveEl.innerText = this.wave < 10 ? `WAVE 0${this.wave}` : `WAVE ${this.wave}`;
    if (killsEl) killsEl.innerText = `KILLS: ${this.kills < 10 ? `0${this.kills}` : this.kills}`;
    if (pointsEl) pointsEl.innerText = `${this.points} PTS`;

    const aliveCount = this.zombies.filter((z) => !z.isDead).length + this.waveZombiesRemainingToSpawn;
    const pct = Math.max(0, Math.min(100, Math.round((aliveCount / Math.max(1, this.waveZombiesTotal)) * 100)));
    if (progressEl) progressEl.style.width = `${pct}%`;
  }

  private getStatDmg(w: WeaponConfig, lvl: number): number {
    return Math.round(w.unupgradedDmg * (1 + lvl * 0.18));
  }

  private getStatMag(w: WeaponConfig, lvl: number): number {
    if (lvl === 0) return w.baseMagCapacity;
    return Math.max(w.baseMagCapacity + lvl, Math.round(w.baseMagCapacity * (1 + lvl * 0.2)));
  }

  private getStatDelay(w: WeaponConfig, lvl: number): number {
    return Math.max(45, Math.round(w.baseFireDelay * Math.pow(0.88, lvl)));
  }

  private openArmory(): void {
    this.playerVel.set(0, 0, 0);
    this.isFiringHeld = false;
    this.controls.clearInputs();
    this.controls.exitPointerLock();
    if (this.isBulletTime) this.deactivateBulletTime();
    this.audio.setLowHealthAlarm(false);
    this.audio.stopMovementAudio();

    const waveBonus = 150 * this.wave;
    this.points += waveBonus;
    this.hp = Math.min(this.maxHp, this.hp + 15);
    this.updateHealthHUD();
    this.updateWaveKillsHUD();

    this.armoryWeapon = this.activeWeapon;

    const clearedEl = document.getElementById('armory-wave-cleared');
    if (clearedEl) {
      const wLabel = this.wave < 10 ? `0${this.wave}` : String(this.wave);
      clearedEl.innerText = `Wave ${wLabel} Cleared · +${waveBonus} PTS Bonus · +15 HP Restored`;
    }

    const nextBtn = document.getElementById('btn-next-wave');
    const nextWave = this.wave + 1;
    if (nextBtn) {
      nextBtn.innerText = `Deploy Wave ${nextWave < 10 ? `0${nextWave}` : nextWave}`;
    }

    const feedbackEl = document.getElementById('armory-feedback');
    if (feedbackEl) {
      feedbackEl.innerText = 'Spend kill credits to upgrade weapon damage, magazine capacity, or fire rate.';
    }

    this.renderArmoryUI();
    this.switchScreen('ARMORY');
  }

  private renderArmoryUI(): void {
    const w = this.weapons[this.armoryWeapon];
    const ptsEl = document.getElementById('armory-points-display');
    if (ptsEl) ptsEl.innerText = `${this.points} PTS`;

    WEAPON_ORDER.forEach((k) => {
      document.getElementById(`armory-tab-${k}`)?.classList.toggle('active', k === this.armoryWeapon);
    });

    const nameEl = document.getElementById('armory-weapon-name');
    const catEl = document.getElementById('armory-weapon-category');
    if (nameEl) nameEl.innerText = w.name;
    if (catEl) catEl.innerText = w.category;

    // Damage card
    const dmgLvl = w.upgrades.damage;
    const dmgLvlEl = document.getElementById('upgrade-dmg-level');
    const dmgValEl = document.getElementById('upgrade-dmg-value');
    const dmgBtn = document.getElementById('btn-upgrade-dmg') as HTMLButtonElement | null;
    if (dmgLvlEl) dmgLvlEl.innerText = `LVL ${dmgLvl} / ${MAX_UPGRADE_LEVEL}`;
    if (dmgValEl) {
      const cur = this.getStatDmg(w, dmgLvl);
      dmgValEl.innerText =
        dmgLvl >= MAX_UPGRADE_LEVEL ? `${cur} DMG (MAX)` : `${cur} → ${this.getStatDmg(w, dmgLvl + 1)} DMG`;
    }
    if (dmgBtn) {
      if (dmgLvl >= MAX_UPGRADE_LEVEL) {
        dmgBtn.disabled = true;
        dmgBtn.innerText = 'MAXED';
      } else {
        const cost = UPGRADE_COSTS[dmgLvl];
        dmgBtn.disabled = this.points < cost;
        dmgBtn.innerHTML = `Upgrade · <span id="upgrade-dmg-cost">${cost} PTS</span>`;
      }
    }

    // Magazine card
    const magLvl = w.upgrades.magCapacity;
    const magLvlEl = document.getElementById('upgrade-mag-level');
    const magValEl = document.getElementById('upgrade-mag-value');
    const magBtn = document.getElementById('btn-upgrade-mag') as HTMLButtonElement | null;
    if (magLvlEl) magLvlEl.innerText = `LVL ${magLvl} / ${MAX_UPGRADE_LEVEL}`;
    if (magValEl) {
      const cur = this.getStatMag(w, magLvl);
      magValEl.innerText =
        magLvl >= MAX_UPGRADE_LEVEL ? `${cur} RDS (MAX)` : `${cur} → ${this.getStatMag(w, magLvl + 1)} RDS`;
    }
    if (magBtn) {
      if (magLvl >= MAX_UPGRADE_LEVEL) {
        magBtn.disabled = true;
        magBtn.innerText = 'MAXED';
      } else {
        const cost = UPGRADE_COSTS[magLvl];
        magBtn.disabled = this.points < cost;
        magBtn.innerHTML = `Upgrade · <span id="upgrade-mag-cost">${cost} PTS</span>`;
      }
    }

    // Fire rate card
    const rateLvl = w.upgrades.fireRate;
    const rateLvlEl = document.getElementById('upgrade-rate-level');
    const rateValEl = document.getElementById('upgrade-rate-value');
    const rateBtn = document.getElementById('btn-upgrade-rate') as HTMLButtonElement | null;
    if (rateLvlEl) rateLvlEl.innerText = `LVL ${rateLvl} / ${MAX_UPGRADE_LEVEL}`;
    if (rateValEl) {
      const curRpm = Math.round(60000 / this.getStatDelay(w, rateLvl));
      const nextRpm = Math.round(60000 / this.getStatDelay(w, rateLvl + 1));
      rateValEl.innerText =
        rateLvl >= MAX_UPGRADE_LEVEL ? `${curRpm} RPM (MAX)` : `${curRpm} → ${nextRpm} RPM`;
    }
    if (rateBtn) {
      if (rateLvl >= MAX_UPGRADE_LEVEL) {
        rateBtn.disabled = true;
        rateBtn.innerText = 'MAXED';
      } else {
        const cost = UPGRADE_COSTS[rateLvl];
        rateBtn.disabled = this.points < cost;
        rateBtn.innerHTML = `Upgrade · <span id="upgrade-rate-cost">${cost} PTS</span>`;
      }
    }

    // Field Medkit button (since all 3 weapons carry infinite reserve magazines)
    const ammoBtn = document.getElementById('btn-armory-ammo') as HTMLButtonElement | null;
    if (ammoBtn) {
      const needsHeal = this.hp < this.maxHp;
      ammoBtn.disabled = !needsHeal || this.points < AMMO_RESTOCK_COST;
      ammoBtn.innerText = needsHeal
        ? `Field Medkit (+35 HP) · ${AMMO_RESTOCK_COST} PTS`
        : 'Vitals Full';
    }

    // Dire Wolf Companion Upgrades UI
    const wolfMaxHp = this.getWolfMaxHp(this.wolfUpgrades.maxHealth);
    const wolfCurHp = this.direWolf ? Math.max(0, Math.round(this.direWolf.currentHp)) : wolfMaxHp;
    const wolfDowned = Boolean(this.direWolf?.isDowned);

    const wolfVitalsEl = document.getElementById('armory-wolf-vitals');
    if (wolfVitalsEl) {
      wolfVitalsEl.innerText = `HP: ${wolfCurHp} / ${wolfMaxHp} · STATUS: ${wolfDowned ? 'DOWNED (AUTO-REVIVES NEXT WAVE)' : 'ACTIVE'}`;
    }

    const wolfHealBtn = document.getElementById('btn-wolf-heal') as HTMLButtonElement | null;
    if (wolfHealBtn) {
      if (wolfDowned) {
        wolfHealBtn.disabled = this.points < WOLF_REVIVE_SHOP_COST;
        wolfHealBtn.innerText = `Revive & Full HP · ${WOLF_REVIVE_SHOP_COST} PTS`;
      } else if (wolfCurHp < wolfMaxHp) {
        wolfHealBtn.disabled = this.points < WOLF_HEAL_COST;
        wolfHealBtn.innerText = `Heal Wolf Full · ${WOLF_HEAL_COST} PTS`;
      } else {
        wolfHealBtn.disabled = true;
        wolfHealBtn.innerText = 'Wolf Full HP';
      }
    }

    // Wolf Bite Damage
    const wDmgLvl = this.wolfUpgrades.biteDamage;
    const wDmgLvlEl = document.getElementById('wolf-upgrade-dmg-level');
    const wDmgValEl = document.getElementById('wolf-upgrade-dmg-value');
    const wDmgBtn = document.getElementById('btn-wolf-upgrade-dmg') as HTMLButtonElement | null;
    if (wDmgLvlEl) wDmgLvlEl.innerText = `LVL ${wDmgLvl} / ${MAX_UPGRADE_LEVEL}`;
    if (wDmgValEl) {
      const cur = this.getWolfBiteDmg(wDmgLvl);
      wDmgValEl.innerText =
        wDmgLvl >= MAX_UPGRADE_LEVEL ? `${cur} DMG (MAX)` : `${cur} → ${this.getWolfBiteDmg(wDmgLvl + 1)} DMG`;
    }
    if (wDmgBtn) {
      if (wDmgLvl >= MAX_UPGRADE_LEVEL) {
        wDmgBtn.disabled = true;
        wDmgBtn.innerText = 'MAXED';
      } else {
        const cost = WOLF_UPGRADE_COSTS[wDmgLvl];
        wDmgBtn.disabled = this.points < cost;
        wDmgBtn.innerText = `Upgrade · ${cost} PTS`;
      }
    }

    // Wolf Max Health
    const wHpLvl = this.wolfUpgrades.maxHealth;
    const wHpLvlEl = document.getElementById('wolf-upgrade-hp-level');
    const wHpValEl = document.getElementById('wolf-upgrade-hp-value');
    const wHpBtn = document.getElementById('btn-wolf-upgrade-hp') as HTMLButtonElement | null;
    if (wHpLvlEl) wHpLvlEl.innerText = `LVL ${wHpLvl} / ${MAX_UPGRADE_LEVEL}`;
    if (wHpValEl) {
      const cur = this.getWolfMaxHp(wHpLvl);
      wHpValEl.innerText =
        wHpLvl >= MAX_UPGRADE_LEVEL ? `${cur} HP (MAX)` : `${cur} → ${this.getWolfMaxHp(wHpLvl + 1)} HP`;
    }
    if (wHpBtn) {
      if (wHpLvl >= MAX_UPGRADE_LEVEL) {
        wHpBtn.disabled = true;
        wHpBtn.innerText = 'MAXED';
      } else {
        const cost = WOLF_UPGRADE_COSTS[wHpLvl];
        wHpBtn.disabled = this.points < cost;
        wHpBtn.innerText = `Upgrade · ${cost} PTS`;
      }
    }

    // Wolf Agility & Ferocity
    const wAgiLvl = this.wolfUpgrades.agilityFerocity;
    const wAgiLvlEl = document.getElementById('wolf-upgrade-agility-level');
    const wAgiValEl = document.getElementById('wolf-upgrade-agility-value');
    const wAgiBtn = document.getElementById('btn-wolf-upgrade-agility') as HTMLButtonElement | null;
    if (wAgiLvlEl) wAgiLvlEl.innerText = `LVL ${wAgiLvl} / ${MAX_UPGRADE_LEVEL}`;
    if (wAgiValEl) {
      const spd = this.getWolfRunSpeed(wAgiLvl).toFixed(1);
      const cd = this.getWolfAttackDelay(wAgiLvl).toFixed(2);
      wAgiValEl.innerText =
        wAgiLvl >= MAX_UPGRADE_LEVEL
          ? `${spd}m/s · ${cd}s (MAX)`
          : `${spd}→${this.getWolfRunSpeed(wAgiLvl + 1).toFixed(1)}m/s · ${this.getWolfAttackDelay(wAgiLvl + 1).toFixed(2)}s`;
    }
    if (wAgiBtn) {
      if (wAgiLvl >= MAX_UPGRADE_LEVEL) {
        wAgiBtn.disabled = true;
        wAgiBtn.innerText = 'MAXED';
      } else {
        const cost = WOLF_UPGRADE_COSTS[wAgiLvl];
        wAgiBtn.disabled = this.points < cost;
        wAgiBtn.innerText = `Upgrade · ${cost} PTS`;
      }
    }
  }

  private getWolfMaxHp(lvl: number): number {
    return 150 + lvl * 40;
  }

  private getWolfBiteDmg(lvl: number): number {
    return 55 + lvl * 15;
  }

  private getWolfRunSpeed(lvl: number): number {
    return 8.8 + lvl * 0.8;
  }

  private getWolfWalkSpeed(lvl: number): number {
    return 4.5 + lvl * 0.35;
  }

  private getWolfAttackDelay(lvl: number): number {
    return Math.max(0.42, Number((1.0 * Math.pow(0.88, lvl)).toFixed(2)));
  }

  private applyWolfUpgradesToEntity(): void {
    const wolf = this.direWolf;
    if (!wolf) return;
    wolf.upgrades = { ...this.wolfUpgrades };
    wolf.maxHp = this.getWolfMaxHp(this.wolfUpgrades.maxHealth);
    wolf.currentHp = Math.min(wolf.maxHp, wolf.currentHp);
    wolf.biteDamage = this.getWolfBiteDmg(this.wolfUpgrades.biteDamage);
    wolf.runSpeed = this.getWolfRunSpeed(this.wolfUpgrades.agilityFerocity);
    wolf.walkSpeed = this.getWolfWalkSpeed(this.wolfUpgrades.agilityFerocity);
    wolf.attackDelay = this.getWolfAttackDelay(this.wolfUpgrades.agilityFerocity);
  }

  private purchaseWolfUpgrade(stat: WolfUpgradeKey): void {
    if (this.gameState !== 'ARMORY') return;
    const lvl = this.wolfUpgrades[stat];
    if (lvl >= MAX_UPGRADE_LEVEL) return;

    const cost = WOLF_UPGRADE_COSTS[lvl];
    if (this.points < cost) return;

    this.points -= cost;
    this.wolfUpgrades[stat] = lvl + 1;
    this.applyWolfUpgradesToEntity();
    if (stat === 'maxHealth' && this.direWolf && !this.direWolf.isDowned) {
      this.direWolf.currentHp = Math.min(this.direWolf.maxHp, this.direWolf.currentHp + 40);
    }

    this.audio.playUpgradePurchase();
    const feedbackEl = document.getElementById('armory-feedback');
    if (feedbackEl) {
      const label =
        stat === 'biteDamage'
          ? 'Bite Damage'
          : stat === 'maxHealth'
            ? 'Max Health'
            : 'Agility & Ferocity';
      feedbackEl.innerText = `Dire Wolf ${label} upgraded to Level ${this.wolfUpgrades[stat]}.`;
    }

    this.updateWolfHUD(true);
    this.updateWaveKillsHUD();
    this.renderArmoryUI();
  }

  private purchaseWolfHeal(): void {
    if (this.gameState !== 'ARMORY' || !this.direWolf) return;
    const wolf = this.direWolf;
    const cost = wolf.isDowned ? WOLF_REVIVE_SHOP_COST : WOLF_HEAL_COST;
    if (!wolf.isDowned && wolf.currentHp >= wolf.maxHp) return;
    if (this.points < cost) return;

    this.points -= cost;
    const wasDowned = wolf.isDowned;
    wolf.isDowned = false;
    wolf.currentHp = wolf.maxHp;
    wolf.biteWindowTimer = 0;
    wolf.pendingBiteImpactTimer = 0;
    wolf.pendingBiteTargetId = null;
    wolf.pendingBiteDamage = 0;
    wolf.lungeOffset = 0;
    wolf.visual.rotation.set(0, 0, 0);
    wolf.visual.position.set(0, 0, 0);
    wolf.statusLabel = 'GUARDING';
    this.transitionDireWolfState(wolf, 'idle', 0.15);
    this.audio.playPickup();

    const feedbackEl = document.getElementById('armory-feedback');
    if (feedbackEl) {
      feedbackEl.innerText = wasDowned
        ? 'Dire Wolf revived and restored to 100% HP!'
        : 'Dire Wolf healed to full HP!';
    }

    this.updateWolfHUD(true);
    this.updateWaveKillsHUD();
    this.renderArmoryUI();
  }

  private purchaseUpgrade(stat: UpgradeStatKey): void {
    if (this.gameState !== 'ARMORY') return;
    const w = this.weapons[this.armoryWeapon];
    const lvl = w.upgrades[stat];
    if (lvl >= MAX_UPGRADE_LEVEL) return;

    const cost = UPGRADE_COSTS[lvl];
    if (this.points < cost) return;

    this.points -= cost;
    w.upgrades[stat] = lvl + 1;

    w.baseDmg = this.getStatDmg(w, w.upgrades.damage);
    w.magCapacity = this.getStatMag(w, w.upgrades.magCapacity);
    w.fireDelay = this.getStatDelay(w, w.upgrades.fireRate);

    if (stat === 'magCapacity') {
      w.currentAmmo = w.magCapacity;
    }

    this.audio.playUpgradePurchase();
    const feedbackEl = document.getElementById('armory-feedback');
    if (feedbackEl) {
      const statLabel =
        stat === 'damage' ? 'Damage' : stat === 'magCapacity' ? 'Magazine Capacity' : 'Fire Rate';
      feedbackEl.innerText = `${w.name} ${statLabel} upgraded to Level ${w.upgrades[stat]}.`;
    }

    this.updateAmmoHUD();
    this.updateWaveKillsHUD();
    this.renderArmoryUI();
  }

  private purchaseAmmoRestock(): void {
    if (this.gameState !== 'ARMORY') return;
    if (this.points < AMMO_RESTOCK_COST || this.hp >= this.maxHp) return;

    this.points -= AMMO_RESTOCK_COST;
    this.hp = Math.min(this.maxHp, this.hp + 35);
    this.audio.playPickup();

    const feedbackEl = document.getElementById('armory-feedback');
    if (feedbackEl) {
      feedbackEl.innerText = 'Field Medkit applied (+35 HP restored).';
    }

    this.updateHealthHUD();
    this.updateWaveKillsHUD();
    this.renderArmoryUI();
  }

  private deployNextWave(): void {
    if (this.gameState !== 'ARMORY') return;
    this.wave += 1;
    this.waveIntermissionTimer = 0;
    this.waveZombiesTotal = 6 + this.wave * 3;
    this.waveZombiesRemainingToSpawn = this.waveZombiesTotal;
    this.bossSpawnedForWave = false;
    this.waveSpawnCooldown = 0.5;

    // Auto-revive and full-heal Dire Wolf at the start of every new wave
    if (this.direWolf) {
      const wolf = this.direWolf;
      wolf.isDowned = false;
      this.applyWolfUpgradesToEntity();
      wolf.currentHp = wolf.maxHp;
      wolf.biteWindowTimer = 0;
      wolf.pendingBiteImpactTimer = 0;
      wolf.pendingBiteTargetId = null;
      wolf.pendingBiteDamage = 0;
      wolf.lungeOffset = 0;
      wolf.attackCooldown = 0;
      wolf.hitFlashTimer = 0;
      wolf.visual.rotation.set(0, 0, 0);
      wolf.visual.position.set(0, 0, 0);
      wolf.statusLabel = 'GUARDING';
      for (let m = 0; m < wolf.materials.length; m++) {
        wolf.materials[m].emissive.copy(wolf.baseEmissives[m]);
      }
      this.transitionDireWolfState(wolf, 'idle', 0.15);
    }

    this.handleResize();
    this.switchWeapon(this.armoryWeapon);
    this.updateAllHud();
    this.updateBossHealthHUD();
    this.switchScreen('PLAYING');
    const wStr = this.wave < 10 ? `WAVE 0${this.wave}` : `WAVE ${this.wave}`;
    this.showWaveAnnouncement('CONTAINMENT SECTOR ESCALATING', `${wStr} // DEPLOYED`, 'amber');
    this.renderSceneFrame();
    this.controls.requestPointerLock();
  }

  private updateAdrenalineHUD(): void {
    const valTxt = this.adrenalineValEl ?? document.getElementById('adrenaline-value-txt');
    const bannerProgress =
      this.adrenalineBannerEl ?? document.getElementById('bt-banner-progress');
    const bar = this.adrenalineBarEl ?? document.getElementById('adrenaline-segments-bar');
    const rounded = Math.round(this.adrenaline);

    if (rounded !== this.lastAdrenalineRounded) {
      this.lastAdrenalineRounded = rounded;
      if (valTxt) valTxt.innerText = String(rounded);
      if (bannerProgress) bannerProgress.style.width = `${rounded}%`;
    }

    const filled = Math.round((this.adrenaline / 100) * 10);
    if (bar && filled !== this.lastAdrenalineFilled) {
      this.lastAdrenalineFilled = filled;
      let html = '';
      for (let i = 0; i < 10; i++) {
        html +=
          i < filled
            ? '<div class="flex-1 bg-cyan-400 h-full"></div>'
            : '<div class="flex-1 bg-slate-900 h-full"></div>';
      }
      bar.innerHTML = html;
    }
  }

  private updateAllHud(): void {
    this.lastAdrenalineRounded = -1;
    this.lastAdrenalineFilled = -1;
    this.lastRadarRenderMs = 0;
    this.lastRadarCount = -1;
    this.updateAmmoHUD();
    this.updateHealthHUD();
    this.updateWolfHUD(true);
    this.updateWaveKillsHUD();
    this.updateAdrenalineHUD();
  }

  private renderRadar(nowMs = performance.now()): void {
    if (!this.radarCtx || !this.radarCanvas) return;
    if (nowMs - this.lastRadarRenderMs < 55) return;
    this.lastRadarRenderMs = nowMs;

    const ctx = this.radarCtx;
    const w = this.radarCanvas.width;
    const h = this.radarCanvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radarRange = 28;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, cx - 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, (cx - 2) * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Player center dot
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    const cosY = Math.cos(this.controls.yaw);
    const sinY = Math.sin(this.controls.yaw);
    let activeCount = 0;

    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (z.isDead) continue;
      activeCount++;
      const dx = z.root.position.x - this.playerPos.x;
      const dz = z.root.position.z - this.playerPos.z;
      const localX = dx * cosY - dz * sinY;
      const localZ = dx * sinY + dz * cosY;

      const rx = cx + (localX / radarRange) * (cx - 4);
      const ry = cy + (localZ / radarRange) * (cy - 4);
      const dist = Math.hypot(rx - cx, ry - cy);
      const clampedScale = dist > cx - 4 ? (cx - 4) / dist : 1;

      ctx.fillStyle =
        z.archetype === 'runner'
          ? '#f59e0b'
          : z.archetype === 'crawler'
            ? '#c084fc'
            : '#ef4444';
      ctx.beginPath();
      ctx.arc(cx + (rx - cx) * clampedScale, cy + (ry - cy) * clampedScale, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Companion Dire Wolf marker + target direction vector on radar (amber if downed, cyan if active)
    if (this.direWolf) {
      const wdx = this.direWolf.root.position.x - this.playerPos.x;
      const wdz = this.direWolf.root.position.z - this.playerPos.z;
      const wLocalX = wdx * cosY - wdz * sinY;
      const wLocalZ = wdx * sinY + wdz * cosY;
      const wrx = cx + (wLocalX / radarRange) * (cx - 4);
      const wry = cy + (wLocalZ / radarRange) * (cy - 4);
      const wDist = Math.hypot(wrx - cx, wry - cy);
      const wScale = wDist > cx - 4 ? (cx - 4) / wDist : 1;
      const wx = cx + (wrx - cx) * wScale;
      const wy = cy + (wry - cy) * wScale;

      if (!this.direWolf.isDowned && this.direWolf.targetZombieId !== null) {
        const tz = this.zombies.find(
          (z) => z.id === this.direWolf!.targetZombieId && !z.isDead,
        );
        if (tz) {
          const tdx = tz.root.position.x - this.direWolf.root.position.x;
          const tdz = tz.root.position.z - this.direWolf.root.position.z;
          const tLen = Math.hypot(tdx, tdz);
          if (tLen > 0.1) {
            const tLocalX = (tdx / tLen) * cosY - (tdz / tLen) * sinY;
            const tLocalZ = (tdx / tLen) * sinY + (tdz / tLen) * cosY;
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(wx, wy);
            ctx.lineTo(wx + tLocalX * 6, wy + tLocalZ * 6);
            ctx.stroke();
          }
        }
      }

      ctx.fillStyle = this.direWolf.isDowned ? '#f59e0b' : '#38bdf8';
      ctx.beginPath();
      ctx.arc(wx, wy, 2.3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (activeCount !== this.lastRadarCount) {
      this.lastRadarCount = activeCount;
      const label = this.radarCountEl ?? document.getElementById('radar-count-label');
      if (label) label.innerText = `${activeCount} ACTIVE`;
    }
  }

  private updateStartOrbit(dt: number): void {
    this.startOrbitAngle += dt * 0.14;
    const radius = 20;
    this.camera.position.set(
      Math.cos(this.startOrbitAngle) * radius,
      7.2,
      Math.sin(this.startOrbitAngle) * radius,
    );
    this.camera.lookAt(0, 1.5, -4);

    for (const z of this.zombies) {
      z.mixer.update(dt);
    }
    this.direWolf?.mixer.update(dt);
  }

  private updateWolfHUD(force = false): void {
    const wolf = this.direWolf;
    if (!wolf) return;

    const roundedHp = Math.max(0, Math.round(wolf.currentHp));
    const maxHp = Math.max(1, Math.round(wolf.maxHp));
    const status = wolf.statusLabel;

    if (
      force ||
      roundedHp !== this.lastWolfHudHp ||
      maxHp !== this.lastWolfHudMaxHp ||
      status !== this.lastWolfHudStatus ||
      wolf.isDowned !== this.lastWolfHudDowned
    ) {
      this.lastWolfHudHp = roundedHp;
      this.lastWolfHudMaxHp = maxHp;
      this.lastWolfHudStatus = status;
      this.lastWolfHudDowned = wolf.isDowned;

      const hpValEl = document.getElementById('wolf-hp-value');
      const hpMaxEl = document.getElementById('wolf-hp-max');
      const statusEl = document.getElementById('wolf-status-label');
      const barEl = document.getElementById('wolf-hp-bar');
      const panelEl = document.getElementById('hud-wolf-panel');

      if (hpValEl) {
        hpValEl.innerText = String(roundedHp);
        hpValEl.className = `font-mono-numbers text-sm sm:text-lg font-bold leading-none ${
          wolf.isDowned
            ? 'text-red-500'
            : roundedHp / maxHp < 0.35
              ? 'text-amber-400'
              : 'text-cyan-300'
        }`;
      }
      if (hpMaxEl) hpMaxEl.innerText = `/ ${maxHp}`;
      if (statusEl) {
        statusEl.innerText = wolf.isDowned ? 'DOWNED' : status;
        statusEl.className = `text-[9px] sm:text-[10px] font-mono-numbers font-bold tracking-wider ${
          wolf.isDowned ? 'text-red-400 animate-pulse' : 'text-slate-200'
        }`;
      }
      if (barEl) {
        const pct = Math.max(0, Math.min(100, (roundedHp / maxHp) * 100));
        barEl.style.width = `${pct}%`;
        barEl.className = `h-full transition-all duration-150 ${
          wolf.isDowned
            ? 'bg-red-600'
            : pct < 30
              ? 'bg-gradient-to-r from-red-600 to-amber-500'
              : pct < 60
                ? 'bg-gradient-to-r from-amber-500 to-yellow-400'
                : 'bg-gradient-to-r from-cyan-500 to-emerald-400'
        }`;
      }
      if (panelEl) {
        panelEl.style.borderColor = wolf.isDowned
          ? 'rgba(239, 68, 68, 0.85)'
          : 'rgba(6, 182, 212, 0.45)';
      }
    }

    const promptBtn = this.wolfRevivePromptEl ?? document.getElementById('wolf-revive-prompt');
    if (promptBtn) {
      const showPrompt = this.gameState === 'PLAYING' && wolf.isDowned;
      if (force || showPrompt !== this.lastWolfPromptVisible) {
        this.lastWolfPromptVisible = showPrompt;
        promptBtn.classList.toggle('hidden', !showPrompt);
        if (!showPrompt) {
          this.lastWolfDistTenths = -1;
        }
      }
      if (showPrompt) {
        const dist = Math.hypot(
          wolf.root.position.x - this.playerPos.x,
          wolf.root.position.z - this.playerPos.z,
        );
        const distTenths = Math.round(dist * 10);
        if (force || distTenths !== this.lastWolfDistTenths) {
          this.lastWolfDistTenths = distTenths;
          const promptText =
            this.wolfReviveTextEl ?? document.getElementById('wolf-revive-prompt-text');
          if (promptText) {
            promptText.innerText =
              dist <= 3.0
                ? 'WOLF DOWNED - Press [E] near wolf to Revive'
                : `WOLF DOWNED - Press [E] near wolf to Revive (${dist.toFixed(1)}m)`;
          }
          promptBtn.classList.toggle('border-emerald-400', dist <= 3.0);
          promptBtn.classList.toggle('border-amber-400', dist > 3.0);
        }
      }
    }
  }

  private damageDireWolf(dmg: number): void {
    const wolf = this.direWolf;
    if (!wolf || wolf.isDowned) return;

    wolf.currentHp = Math.max(0, wolf.currentHp - dmg);
    wolf.hitFlashTimer = 0.16;

    if (wolf.currentHp <= 0) {
      wolf.currentHp = 0;
      wolf.isDowned = true;
      wolf.biteWindowTimer = 0;
      wolf.pendingBiteImpactTimer = 0;
      wolf.pendingBiteTargetId = null;
      wolf.pendingBiteDamage = 0;
      wolf.lungeOffset = 0;
      wolf.targetZombieId = null;
      wolf.statusLabel = 'DOWNED';
      this.transitionDireWolfState(wolf, 'idle', 0.25, 0.45);
      this.audio.playWolfAlert(Math.hypot(wolf.root.position.x - this.playerPos.x, wolf.root.position.z - this.playerPos.z));
    }

    this.updateWolfHUD(true);
  }

  private handlePrimaryInteract(): void {
    if (this.gameState !== 'PLAYING') return;
    if (this.direWolf?.isDowned) {
      const distWolf = Math.hypot(
        this.direWolf.root.position.x - this.playerPos.x,
        this.direWolf.root.position.z - this.playerPos.z,
      );
      if (distWolf <= 3.0) {
        this.tryReviveWolf();
        return;
      }
    }
    if (this.propsPack && this.propsPack.getDistanceToSwitch(this.playerPos) <= 3.0) {
      const powered = this.propsPack.togglePower();
      this.arena.setCheckpointPower(powered);
      this.audio.playMechanicalClick(0.6, powered ? 1750 : 980);
      this.updateInteractPropPrompt();
    }
  }

  private updateInteractPropPrompt(): void {
    const promptEl =
      this.interactPropPromptEl ?? document.getElementById('interact-prop-prompt');
    if (!promptEl) return;
    if (!this.propsPack || this.gameState !== 'PLAYING') {
      if (this.lastInteractPromptVisible) {
        this.lastInteractPromptVisible = false;
        promptEl.classList.add('hidden');
      }
      return;
    }

    const nearSwitch = this.propsPack.getDistanceToSwitch(this.playerPos) <= 3.0;
    const wolfRevivePriority = Boolean(
      this.direWolf?.isDowned &&
        Math.hypot(
          this.direWolf.root.position.x - this.playerPos.x,
          this.direWolf.root.position.z - this.playerPos.z,
        ) <= 3.0,
    );
    const shouldShow = nearSwitch && !wolfRevivePriority;
    if (shouldShow !== this.lastInteractPromptVisible) {
      this.lastInteractPromptVisible = shouldShow;
      promptEl.classList.toggle('hidden', !shouldShow);
    }
    if (shouldShow) {
      const powered = this.propsPack.isPowerOn();
      if (powered !== this.lastInteractPowerOn) {
        this.lastInteractPowerOn = powered;
        const textEl =
          this.interactPropTextEl ??
          document.getElementById('interact-prop-prompt-text');
        const dotEl =
          this.interactPropDotEl ?? document.getElementById('interact-prop-dot');
        if (textEl) {
          textEl.innerText = powered
            ? '[E] CUT CHECKPOINT POWER'
            : '[E] RESTORE CHECKPOINT POWER';
          textEl.className = powered
            ? 'font-mono-numbers text-xs sm:text-sm font-bold text-emerald-200 tracking-wider uppercase whitespace-nowrap'
            : 'font-mono-numbers text-xs sm:text-sm font-bold text-red-200 tracking-wider uppercase whitespace-nowrap';
        }
        if (dotEl) {
          dotEl.className = powered
            ? 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse'
            : 'w-2.5 h-2.5 rounded-full bg-red-500 animate-ping';
        }
      }
    }
  }

  private tryReviveWolf(): void {
    if (this.gameState !== 'PLAYING' || !this.direWolf || !this.direWolf.isDowned) return;
    const wolf = this.direWolf;
    const dist = Math.hypot(
      wolf.root.position.x - this.playerPos.x,
      wolf.root.position.z - this.playerPos.z,
    );
    if (dist > 3.0) return;

    wolf.isDowned = false;
    wolf.currentHp = Math.max(1, Math.round(wolf.maxHp * 0.5));
    wolf.biteWindowTimer = 0;
    wolf.pendingBiteImpactTimer = 0;
    wolf.pendingBiteTargetId = null;
    wolf.pendingBiteDamage = 0;
    wolf.lungeOffset = 0;
    wolf.attackCooldown = 0.25;
    wolf.visual.rotation.set(0, 0, 0);
    wolf.visual.position.set(0, 0, 0);
    wolf.statusLabel = 'GUARDING';
    this.transitionDireWolfState(wolf, 'idle', 0.2, 1.0);
    this.audio.playPickup();
    this.audio.playWolfAlert(1);
    this.updateWolfHUD(true);
  }

  private transitionDireWolfState(
    wolf: DireWolfCompanion,
    nextState: DireWolfAnimState,
    fadeDuration = 0.15,
    timeScale = 1.0,
  ): void {
    const nextAction = wolf.actions[nextState];
    if (!nextAction) return;

    if (wolf.currentState === nextState && wolf.currentAction === nextAction) {
      nextAction.setEffectiveTimeScale(timeScale);
      return;
    }

    const prevAction = wolf.currentAction;
    wolf.currentState = nextState;

    nextAction.enabled = true;
    nextAction.reset();
    nextAction.setEffectiveTimeScale(timeScale);
    nextAction.setEffectiveWeight(1);
    nextAction.play();

    if (prevAction && prevAction !== nextAction) {
      prevAction.crossFadeTo(nextAction, fadeDuration, true);
    }
    wolf.currentAction = nextAction;
  }

  private triggerDireWolfBite(wolf: DireWolfCompanion, target: ZombieEntity): void {
    const biteAction = wolf.actions.bite;
    if (!biteAction) return;

    // Snap facing directly at target zombie so jaws align cleanly
    wolf.root.lookAt(target.root.position.x, wolf.root.position.y, target.root.position.z);

    const prevAction = wolf.currentAction;
    biteAction.enabled = true;
    biteAction.reset();
    biteAction.setEffectiveTimeScale(1);
    biteAction.setEffectiveWeight(1);
    biteAction.play();

    if (prevAction && prevAction !== biteAction) {
      prevAction.crossFadeTo(biteAction, 0.1, true);
    }

    wolf.currentAction = biteAction;
    wolf.currentState = 'bite';
    wolf.biteWindowTimer = wolf.biteAnimDuration;
    wolf.pendingBiteImpactTimer = 0.35;
    wolf.pendingBiteTargetId = target.id;
    wolf.pendingBiteDamage = wolf.biteDamage;
    wolf.lungeOffset = 0;
  }

  private updateDireWolfCompanion(dt: number): void {
    const wolf = this.direWolf;
    if (!wolf) return;

    if (wolf.attackCooldown > 0) wolf.attackCooldown = Math.max(0, wolf.attackCooldown - dt);
    if (wolf.alertCooldown > 0) wolf.alertCooldown = Math.max(0, wolf.alertCooldown - dt);

    // Hit flash decay
    if (wolf.hitFlashTimer > 0) {
      wolf.hitFlashTimer -= dt;
      const flashing = wolf.hitFlashTimer > 0;
      for (let m = 0; m < wolf.materials.length; m++) {
        if (flashing) {
          wolf.materials[m].emissive.setHex(0x991b1b);
        } else {
          wolf.materials[m].emissive.copy(wolf.baseEmissives[m]);
        }
      }
    }

    const dxPlayer = this.playerPos.x - wolf.root.position.x;
    const dzPlayer = this.playerPos.z - wolf.root.position.z;
    const distToPlayer = Math.hypot(dxPlayer, dzPlayer);

    // Downed State: stop moving/attacking, slow idle, tilted posture, show revive prompt
    if (wolf.isDowned) {
      wolf.root.position.y = 0;
      wolf.visual.rotation.z = THREE.MathUtils.damp(wolf.visual.rotation.z, 0.34, 8, dt);
      wolf.visual.position.y = THREE.MathUtils.damp(wolf.visual.position.y, -0.14, 8, dt);
      wolf.visual.position.z = THREE.MathUtils.damp(wolf.visual.position.z, 0, 12, dt);
      wolf.statusLabel = 'DOWNED';
      this.transitionDireWolfState(wolf, 'idle', 0.25, 0.45);
      wolf.mixer.update(dt);
      this.updateWolfHUD(false);
      return;
    }

    // Smoothly return visual posture upright
    wolf.visual.rotation.z = THREE.MathUtils.damp(wolf.visual.rotation.z, 0, 12, dt);
    wolf.visual.position.y = THREE.MathUtils.damp(wolf.visual.position.y, 0, 12, dt);
    wolf.root.position.y = 0;

    // Resolve delayed jaw-snap bite impact at 0.35s into the bite animation
    if (wolf.pendingBiteImpactTimer > 0) {
      wolf.pendingBiteImpactTimer -= dt;
      if (wolf.pendingBiteImpactTimer <= 0) {
        wolf.pendingBiteImpactTimer = 0;
        const targetId = wolf.pendingBiteTargetId;
        const dmg = wolf.pendingBiteDamage || wolf.biteDamage;
        wolf.pendingBiteTargetId = null;

        const impactTarget =
          targetId !== null ? this.zombies.find((z) => z.id === targetId && !z.isDead) : undefined;
        if (impactTarget) {
          this.audio.playWolfBite(distToPlayer);
          _assistImpactDir.set(
            impactTarget.root.position.x - wolf.root.position.x,
            0,
            impactTarget.root.position.z - wolf.root.position.z,
          );
          if (_assistImpactDir.lengthSq() > 0.0001) {
            _assistImpactDir.normalize();
          } else {
            _assistImpactDir.set(0, 0, 1);
          }

          _hitWorldPt.set(
            impactTarget.root.position.x,
            impactTarget.hitboxExtents.centerY * 0.78,
            impactTarget.root.position.z,
          );
          this.bloodFx.spawnZombieBloodHit({
            zombie: impactTarget,
            hitPoint: _hitWorldPt,
            shotDir: _assistImpactDir,
            isHead: false,
            isKill: impactTarget.hp - dmg <= 0,
            isWolfBite: true,
            cameraPos: this.camera.position,
            envTargets: this.envRaycastTargets,
          });
          this.spawnFloatingDamageNumber(_hitWorldPt, dmg, false, impactTarget.isBoss);
          this.damageZombie(impactTarget, dmg, false, _assistImpactDir, true);
        }
      }
    }

    // Active bite window (0.7s): stay planted, face zombie, lunge +0.3u forward, exit immediately if target dies
    if (wolf.biteWindowTimer > 0) {
      const activeTargetId = wolf.pendingBiteTargetId ?? wolf.targetZombieId;
      const biteTarget =
        activeTargetId !== null
          ? this.zombies.find((z) => z.id === activeTargetId && !z.isDead)
          : undefined;

      if (!biteTarget) {
        // Target died: immediately cancel bite window and crossfade out in 0.15s
        wolf.biteWindowTimer = 0;
        wolf.pendingBiteImpactTimer = 0;
        wolf.pendingBiteTargetId = null;
        wolf.lungeOffset = 0;
      } else {
        wolf.biteWindowTimer = Math.max(0, wolf.biteWindowTimer - dt);
        wolf.root.lookAt(biteTarget.root.position.x, wolf.root.position.y, biteTarget.root.position.z);

        // Lunge jaws forward up to +0.3u at the 0.35s snap frame, then retract smoothly
        const elapsed = Math.max(0, wolf.biteAnimDuration - wolf.biteWindowTimer);
        const targetLunge =
          elapsed <= 0.35
            ? (elapsed / 0.35) * 0.3
            : Math.max(0, (1 - (elapsed - 0.35) / Math.max(0.05, wolf.biteAnimDuration - 0.35)) * 0.3);
        wolf.lungeOffset = targetLunge;
        wolf.visual.position.z = wolf.lungeOffset;

        if (wolf.biteWindowTimer > 0) {
          wolf.statusLabel = 'BITING';
          wolf.mixer.update(dt);
          this.updateWolfHUD(false);
          return;
        }
      }
    }

    // Smoothly reset forward lunge when not biting
    wolf.lungeOffset = THREE.MathUtils.damp(wolf.lungeOffset, 0, 18, dt);
    wolf.visual.position.z = wolf.lungeOffset;

    // Scan live zombies for Priority 1 (<=15u of player or wolf) and Priority 2 (closest overall)
    let combatTarget: ZombieEntity | null = null;
    let combatBestScore = Infinity;
    let closestGlobalZombie: ZombieEntity | null = null;
    let closestGlobalDistToPlayer = Infinity;

    for (const z of this.zombies) {
      if (z.isDead) continue;
      const dPlayer = Math.hypot(z.root.position.x - this.playerPos.x, z.root.position.z - this.playerPos.z);
      const dWolf = Math.hypot(z.root.position.x - wolf.root.position.x, z.root.position.z - wolf.root.position.z);

      if (dPlayer < closestGlobalDistToPlayer) {
        closestGlobalDistToPlayer = dPlayer;
        closestGlobalZombie = z;
      }

      if (dPlayer <= 15 || dWolf <= 15) {
        const score = Math.min(dWolf, dPlayer);
        if (score < combatBestScore) {
          combatBestScore = score;
          combatTarget = z;
        }
      }
    }

    let moveSpeed = 0;
    let moveDirX = 0;
    let moveDirZ = 0;
    let faceDirX = 0;
    let faceDirZ = 0;
    let startedBiteThisFrame = false;

    if (combatTarget) {
      // PRIORITY 1: Aggressive Zombie Combat (within 15 units of player or wolf)
      if (wolf.targetZombieId !== combatTarget.id) {
        wolf.targetZombieId = combatTarget.id;
        if (wolf.alertCooldown <= 0) {
          wolf.alertCooldown = 4.0;
          this.audio.playWolfAlert(distToPlayer);
        }
      }

      const zDx = combatTarget.root.position.x - wolf.root.position.x;
      const zDz = combatTarget.root.position.z - wolf.root.position.z;
      const distToZombie = Math.hypot(zDx, zDz);

      // Compute true snout-contact attack distance (~1.1u center-to-center)
      const zombieRadius = combatTarget.isBoss ? 0.65 : combatTarget.archetype === 'crawler' ? 0.55 : 0.45;
      const attackRange = Math.min(1.22, Math.max(1.05, wolf.halfLength + zombieRadius * 0.7));

      const hasBiteLos =
        distToZombie <= attackRange &&
        hasStaticLineOfSight(
          wolf.root.position.x,
          wolf.root.position.z,
          combatTarget.root.position.x,
          combatTarget.root.position.z,
          this.arena.obstacles,
          this.obstacleGrid,
          0.85,
        );

      if (hasBiteLos) {
        moveSpeed = 0;
        if (distToZombie > 0.01) {
          faceDirX = zDx / distToZombie;
          faceDirZ = zDz / distToZombie;
        }
        wolf.statusLabel = 'BITING';

        if (wolf.attackCooldown <= 0) {
          wolf.attackCooldown = wolf.attackDelay;
          this.triggerDireWolfBite(wolf, combatTarget);
          startedBiteThisFrame = true;
        } else {
          wolf.root.lookAt(combatTarget.root.position.x, wolf.root.position.y, combatTarget.root.position.z);
        }
      } else {
        wolf.statusLabel = 'HUNTING';
        moveSpeed = wolf.runSpeed;
        const invDist = distToZombie > 0.01 ? 1 / distToZombie : 0;
        moveDirX = zDx * invDist;
        moveDirZ = zDz * invDist;
        faceDirX = moveDirX;
        faceDirZ = moveDirZ;
      }
    } else if (closestGlobalZombie) {
      // PRIORITY 2: Guiding to Next Zombie (area within 15 units is clear)
      if (wolf.targetZombieId !== closestGlobalZombie.id) {
        wolf.targetZombieId = closestGlobalZombie.id;
        if (wolf.alertCooldown <= 0) {
          wolf.alertCooldown = 4.5;
          this.audio.playWolfAlert(distToPlayer);
        }
      }

      const p2zX = closestGlobalZombie.root.position.x - this.playerPos.x;
      const p2zZ = closestGlobalZombie.root.position.z - this.playerPos.z;
      const p2zLen = Math.max(0.01, Math.hypot(p2zX, p2zZ));
      const zDx = closestGlobalZombie.root.position.x - wolf.root.position.x;
      const zDz = closestGlobalZombie.root.position.z - wolf.root.position.z;
      const zLen = Math.max(0.01, Math.hypot(zDx, zDz));

      if (distToPlayer > 7) {
        moveSpeed = 0;
        faceDirX = zDx / zLen;
        faceDirZ = zDz / zLen;
        wolf.statusLabel = 'WAITING';
      } else {
        const guideX = this.playerPos.x + (p2zX / p2zLen) * 5.0;
        const guideZ = this.playerPos.z + (p2zZ / p2zLen) * 5.0;
        const gDx = guideX - wolf.root.position.x;
        const gDz = guideZ - wolf.root.position.z;
        const distToGuide = Math.hypot(gDx, gDz);

        if (distToGuide > 0.9) {
          moveSpeed = wolf.walkSpeed;
          moveDirX = gDx / distToGuide;
          moveDirZ = gDz / distToGuide;
          faceDirX = moveDirX;
          faceDirZ = moveDirZ;
          wolf.statusLabel = 'GUIDING';
        } else {
          moveSpeed = 0;
          faceDirX = zDx / zLen;
          faceDirZ = zDz / zLen;
          wolf.statusLabel = 'GUIDING';
        }
      }
    } else {
      // PRIORITY 3: Escort / Follow (Between waves / 0 zombies alive)
      wolf.targetZombieId = null;
      if (distToPlayer > 8) {
        moveSpeed = wolf.runSpeed;
        moveDirX = dxPlayer / distToPlayer;
        moveDirZ = dzPlayer / distToPlayer;
        faceDirX = moveDirX;
        faceDirZ = moveDirZ;
        wolf.statusLabel = 'FOLLOWING';
      } else if (distToPlayer >= 3) {
        moveSpeed = wolf.walkSpeed;
        moveDirX = dxPlayer / distToPlayer;
        moveDirZ = dzPlayer / distToPlayer;
        faceDirX = moveDirX;
        faceDirZ = moveDirZ;
        wolf.statusLabel = 'ESCORTING';
      } else {
        moveSpeed = 0;
        wolf.statusLabel = 'GUARDING';
      }
    }

    if (this.wolfAvoidTimer > 0) {
      this.wolfAvoidTimer = Math.max(0, this.wolfAvoidTimer - dt);
    }

    const prevWolfX = wolf.root.position.x;
    const prevWolfZ = wolf.root.position.z;
    if (moveSpeed > 0) {
      const stepLen = moveSpeed * dt;
      wolf.root.position.x += moveDirX * stepLen;
      wolf.root.position.z += moveDirZ * stepLen;
      resolveCircleMovement(
        wolf.root.position,
        prevWolfX,
        prevWolfZ,
        0.38,
        this.arena.obstacles,
        this.arena.arenaHalfSize,
        this.obstacleGrid,
      );

      const movedX = wolf.root.position.x - prevWolfX;
      const movedZ = wolf.root.position.z - prevWolfZ;
      const forwardProgress = movedX * moveDirX + movedZ * moveDirZ;
      if (stepLen > 0.001 && forwardProgress < stepLen * 0.45) {
        const perpLeftX = -moveDirZ;
        const perpLeftZ = moveDirX;
        if (this.wolfAvoidTimer <= 0) {
          const probeDist = 1.25;
          const leftBlocked = pointBlockedByStaticColliders(
            prevWolfX + perpLeftX * probeDist,
            prevWolfZ + perpLeftZ * probeDist,
            0.38,
            this.arena.obstacles,
            this.arena.arenaHalfSize,
            this.obstacleGrid,
          );
          const rightBlocked = pointBlockedByStaticColliders(
            prevWolfX - perpLeftX * probeDist,
            prevWolfZ - perpLeftZ * probeDist,
            0.38,
            this.arena.obstacles,
            this.arena.arenaHalfSize,
            this.obstacleGrid,
          );
          if (leftBlocked !== rightBlocked) {
            this.wolfAvoidSign = leftBlocked ? -1 : 1;
          }
          this.wolfAvoidTimer = 0.65;
        }
        const tangX = perpLeftX * this.wolfAvoidSign;
        const tangZ = perpLeftZ * this.wolfAvoidSign;
        const preSlideX = wolf.root.position.x;
        const preSlideZ = wolf.root.position.z;
        wolf.root.position.x += tangX * stepLen * 0.92;
        wolf.root.position.z += tangZ * stepLen * 0.92;
        resolveCircleMovement(
          wolf.root.position,
          preSlideX,
          preSlideZ,
          0.38,
          this.arena.obstacles,
          this.arena.arenaHalfSize,
          this.obstacleGrid,
        );
        faceDirX = moveDirX * 0.35 + tangX * 0.65;
        faceDirZ = moveDirZ * 0.35 + tangZ * 0.65;
      }
    }

    // Measure actual post-collision velocity to prevent foot sliding
    const currentSpeed =
      dt > 0.0001
        ? Math.hypot(wolf.root.position.x - prevWolfX, wolf.root.position.z - prevWolfZ) / dt
        : 0;

    if (!startedBiteThisFrame) {
      if (currentSpeed > 5.5) {
        this.transitionDireWolfState(wolf, 'run', 0.15, currentSpeed / 8.0);
      } else if (currentSpeed > 0.2) {
        this.transitionDireWolfState(wolf, 'walk', 0.15, currentSpeed / 3.5);
      } else {
        this.transitionDireWolfState(wolf, 'idle', 0.15, 1.0);
      }

      if (faceDirX !== 0 || faceDirZ !== 0) {
        const targetAngle = Math.atan2(faceDirX, faceDirZ);
        _wolfTargetQuat.setFromAxisAngle(_wolfUpAxis, targetAngle);
        wolf.root.quaternion.slerp(_wolfTargetQuat, Math.min(1, dt * 11));
      }
    }

    wolf.mixer.update(dt);
    this.updateWolfHUD(false);
  }

  private updateGameplay(rawDt: number): void {
    const worldDt = this.isBulletTime ? rawDt * TIME_DILATION_FACTOR : rawDt;

    // 1. Bullet-Time Adrenaline Management
    if (this.isBulletTime) {
      this.adrenaline = Math.max(0, this.adrenaline - rawDt * 18);
      if (this.adrenaline <= 0) {
        this.deactivateBulletTime();
      }
      this.updateAdrenalineHUD();
    } else if (this.adrenaline < 100) {
      this.adrenaline = Math.min(100, this.adrenaline + rawDt * 7.5);
      this.updateAdrenalineHUD();
    }

    // 2. Reload Timer, ADS Blend & Active Weapon AnimationMixer / Viewmodel Positioning
    if (this.isReloading) {
      this.reloadTimer -= rawDt;
      if (this.reloadTimer <= 0) {
        this.finishReload();
      }
    }
    const targetAds = this.isAdsActive && !this.isReloading ? 1 : 0;
    this.adsBlend = THREE.MathUtils.damp(this.adsBlend, targetAds, 14, rawDt);
    this.crouchBlend = THREE.MathUtils.damp(this.crouchBlend, this.controls.isCrouching ? 1 : 0, 14, rawDt);

    if (this.inspectTimer > 0) {
      this.inspectTimer = Math.max(0, this.inspectTimer - rawDt);
    }

    if (this.gunRig) {
      const slot = this.gunRig.slots[this.activeWeapon];
      slot.mixer?.update(rawDt);

      const tiltTarget = this.isReloading && slot.isStatic ? 1 : 0;
      this.staticReloadTilt = THREE.MathUtils.damp(this.staticReloadTilt, tiltTarget, 10, rawDt);

      slot.pivotGroup.position.lerpVectors(slot.basePos, slot.adsPos, this.adsBlend);
      if (slot.isStatic) {
        slot.pivotGroup.position.y -= this.staticReloadTilt * 0.14;
        slot.pivotGroup.position.z += this.staticReloadTilt * 0.06;
        slot.pivotGroup.rotation.set(
          -this.staticReloadTilt * 0.55,
          slot.baseRotY,
          this.staticReloadTilt * 0.28,
        );
      } else if (this.inspectTimer > 0 && !slot.inspectAction) {
        // Procedural inspect showcase when model has no dedicated inspect clip
        const p = Math.sin((this.inspectTimer / 1.65) * Math.PI);
        slot.pivotGroup.position.x -= p * 0.06;
        slot.pivotGroup.position.y += p * 0.04;
        slot.pivotGroup.rotation.set(p * 0.28, slot.baseRotY - p * 0.55, p * 0.35);
      } else {
        slot.pivotGroup.rotation.set(0, slot.baseRotY, 0);
      }
    }

    // 3. Auto-fire while held
    if (this.isFiringHeld && this.weapons[this.activeWeapon].autoFire) {
      this.tryFire();
    }

    // 4. Smooth delta-time-independent aim interpolation
    this.controls.updateAimSmoothing(rawDt);

    // 5. Player WASD + Floating Left Thumbstick Movement + Sprint + Crouch + Jump Physics
    const moveF =
      (this.controls.keys['KeyW'] || this.controls.keys['ArrowUp'] ? 1 : 0) -
      (this.controls.keys['KeyS'] || this.controls.keys['ArrowDown'] ? 1 : 0) -
      this.controls.moveStickY;
    const moveR =
      (this.controls.keys['KeyD'] || this.controls.keys['ArrowRight'] ? 1 : 0) -
      (this.controls.keys['KeyA'] || this.controls.keys['ArrowLeft'] ? 1 : 0) +
      this.controls.moveStickX;

    _forward.set(-Math.sin(this.controls.yaw), 0, -Math.cos(this.controls.yaw));
    _right.set(Math.cos(this.controls.yaw), 0, -Math.sin(this.controls.yaw));
    _moveVec.set(0, 0, 0);
    _moveVec.addScaledVector(_forward, moveF);
    _moveVec.addScaledVector(_right, moveR);

    const hasMoveInput = _moveVec.lengthSq() > 0.01;
    const sprinting = Boolean(
      hasMoveInput &&
        (this.controls.keys['ShiftLeft'] ||
          this.controls.keys['ShiftRight'] ||
          this.controls.touchSprinting) &&
        !this.controls.isCrouching &&
        !this.isAdsActive,
    );

    const targetEyeHeight = THREE.MathUtils.lerp(
      PLAYER_EYE_HEIGHT,
      CROUCH_EYE_HEIGHT,
      this.crouchBlend,
    );

    const wetness = this.weather.getGroundWetness();
    const prevX = this.playerPos.x;
    const prevZ = this.playerPos.z;

    if (hasMoveInput) {
      _moveVec.normalize();
      const weaponMoveMult = this.weapons[this.activeWeapon].moveSpeedMult;
      const stanceMult = sprinting
        ? 1.45
        : this.controls.isCrouching
          ? 0.58
          : this.isAdsActive
            ? 0.72
            : 1.0;
      const speed = 5.6 * weaponMoveMult * stanceMult;
      this.playerPos.addScaledVector(_moveVec, speed * rawDt);
      resolveCircleMovement(
        this.playerPos,
        prevX,
        prevZ,
        PLAYER_RADIUS,
        this.arena.obstacles,
        this.arena.arenaHalfSize,
        this.obstacleGrid,
      );
    }
    this.updateInteractPropPrompt();

    // Measure actual character velocity after collision resolution alongside input state
    const safeDt = Math.max(0.0001, rawDt);
    this.playerVel.x = hasMoveInput ? (this.playerPos.x - prevX) / safeDt : 0;
    this.playerVel.z = hasMoveInput ? (this.playerPos.z - prevZ) / safeDt : 0;
    this.playerVel.y = this.playerVelY;
    const horizontalSpeed = Math.hypot(this.playerVel.x, this.playerVel.z);
    const isMoving = hasMoveInput && horizontalSpeed > 0.35;

    if (isMoving) {
      if (this.isGrounded) {
        const weaponMoveMult = this.weapons[this.activeWeapon].moveSpeedMult;
        const strideRate = sprinting ? 13 : this.controls.isCrouching ? 6.8 : 9;
        this.walkBobPhase += rawDt * strideRate * weaponMoveMult;
        const stepIndex = Math.floor(this.walkBobPhase / Math.PI);
        if (stepIndex !== this.lastFootstepIndex) {
          this.lastFootstepIndex = stepIndex;
          if (!this.audio.hasRunAudioLoopReady()) {
            this.audio.playFootstep(sprinting, this.controls.isCrouching, this.isBulletTime);
          }
          if (sprinting && wetness > 0.4) {
            this.spawnWaterSplashParticles(this.playerPos);
          }
        }
      }
    } else if (this.isGrounded) {
      this.walkBobPhase += rawDt * 1.5;
      this.lastFootstepIndex = Math.floor(this.walkBobPhase / Math.PI);
    }

    // Update continuous looping run footsteps + exhaust breathing (stops immediately when movement stops)
    this.audio.updateMovementLoops({
      dt: rawDt,
      isPlaying: this.gameState === 'PLAYING',
      isMoving,
      horizontalSpeed,
      isGrounded: this.isGrounded,
      isSprinting: sprinting && isMoving,
      isCrouching: this.controls.isCrouching,
      hp: this.hp,
      bulletTime: this.isBulletTime,
    });

    if (!this.isGrounded) {
      this.playerVelY -= 18.5 * rawDt;
      this.playerPos.y += this.playerVelY * rawDt;
      if (this.playerPos.y <= targetEyeHeight) {
        this.playerPos.y = targetEyeHeight;
        this.playerVelY = 0;
        this.isGrounded = true;
        if (!this.audio.hasRunAudioLoopReady()) {
          this.audio.playFootstep(true, this.controls.isCrouching, this.isBulletTime);
        }
        if (wetness > 0.4) {
          this.spawnWaterSplashParticles(this.playerPos);
        }
      }
    } else {
      this.playerPos.y = targetEyeHeight;
    }

    // 6. Camera Transform + Dynamic ADS/Sprint FOV + Weapon Sway & Recoil Damping
    const activeW = this.weapons[this.activeWeapon];
    const baseFov = this.pcSettings.fov;
    const sprintFov = sprinting ? baseFov + 7 : baseFov;
    const desiredFov = THREE.MathUtils.lerp(sprintFov, activeW.adsFov, this.adsBlend);
    if (Math.abs(this.camera.fov - desiredFov) > 0.02) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, desiredFov, 12, rawDt);
      this.camera.updateProjectionMatrix();
    }

    const bobScale = THREE.MathUtils.lerp(1.0, 0.25, this.adsBlend);
    const bobY = !this.isGrounded
      ? 0
      : isMoving
        ? Math.sin(this.walkBobPhase) * 0.045 * bobScale
        : Math.sin(this.walkBobPhase) * 0.008 * bobScale;
    this.camera.position.set(this.playerPos.x, this.playerPos.y + bobY, this.playerPos.z);
    _euler.set(this.controls.pitch, this.controls.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);

    this.recoilKick = THREE.MathUtils.damp(this.recoilKick, 0, 14, rawDt);
    if (this.gunRig) {
      const swayScale = 0.55 * bobScale;
      const swayX = isMoving ? Math.cos(this.walkBobPhase * 0.5) * 0.014 * swayScale : 0;
      const swayY = isMoving ? Math.abs(Math.sin(this.walkBobPhase)) * -0.014 * swayScale : 0;
      this.gunRig.root.position.set(
        GUN_POS.x + swayX,
        GUN_POS.y + swayY + this.recoilKick * 0.25,
        GUN_POS.z + this.recoilKick,
      );
      this.gunRig.root.rotation.x = this.recoilKick * 0.5;
    }

    // Crosshair tightness during ADS (update style only when scale delta is meaningful)
    const crosshairRig = this.crosshairRigEl ?? document.getElementById('crosshair-rig');
    if (crosshairRig) {
      const chScale = THREE.MathUtils.lerp(1.0, 0.62, this.adsBlend);
      if (Math.abs(chScale - this.lastCrosshairScale) > 0.002) {
        this.lastCrosshairScale = chScale;
        crosshairRig.style.transform = `scale(${chScale.toFixed(3)})`;
      }
    }

    // Muzzle light decay
    if (this.gunFlashTimer > 0) {
      this.gunFlashTimer -= rawDt;
      if (this.gunFlashTimer <= 0) {
        this.muzzleLight.intensity = 0;
        if (this.gunRig) {
          (this.gunRig.muzzleFlashMesh.material as THREE.MeshBasicMaterial).opacity = 0;
        }
      }
    }

    // 7. Escalating Wave Spawning, Wave Bosses & Progression (bounded active zombies on mobile preview)
    if (this.waveZombiesRemainingToSpawn > 0) {
      if (this.enemyRoster) {
        this.waveSpawnCooldown -= worldDt;
        if (this.waveSpawnCooldown <= 0) {
          let liveCount = 0;
          for (let i = 0; i < this.zombies.length; i++) {
            if (!this.zombies[i].isDead) liveCount++;
          }
          const availSlots = Math.max(0, this.perfProfile.maxActiveZombies - liveCount);
          if (availSlots > 0) {
            const batch = Math.min(
              availSlots,
              this.waveZombiesRemainingToSpawn,
              this.wave >= 3 ? 3 : 2,
            );
            this.spawnWaveBatch(batch);
            this.waveZombiesRemainingToSpawn -= batch;
            this.waveSpawnCooldown = Math.max(0.85, 2.75 - this.wave * 0.18);
            this.updateWaveKillsHUD();
          } else {
            this.waveSpawnCooldown = 0.45;
          }
        }
      }
    } else if (!this.bossSpawnedForWave && this.enemyRoster) {
      let liveCount = 0;
      for (let i = 0; i < this.zombies.length; i++) {
        if (!this.zombies[i].isDead) liveCount++;
      }
      if (!this.perfProfile.isMobilePreview || liveCount < this.perfProfile.maxActiveZombies) {
        this.bossSpawnedForWave = true;
        this.spawnWaveBoss();
        this.updateWaveKillsHUD();
      }
    } else if (this.zombies.every((z) => z.isDead)) {
      this.waveIntermissionTimer += rawDt;
      if (this.waveIntermissionTimer >= 1.6) {
        this.waveIntermissionTimer = 0;
        this.openArmory();
        return;
      }
    }

    // 8. Update Zombies (Distance-LOD Skinned Mixers, Hit Stagger Impulse, Collapse Physics, Boss Slam)
    this.frameCounter = (this.frameCounter + 1) & 0x0fffffff;
    const wolfAlive = Boolean(this.direWolf && !this.direWolf.isDowned);
    const wolfX = this.direWolf ? this.direWolf.root.position.x : 0;
    const wolfZ = this.direWolf ? this.direWolf.root.position.z : 0;
    const wolfTargetId = this.direWolf ? this.direWolf.targetZombieId : null;

    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];
      if (z.isDead) {
        if (z.hitFlashTimer > 0) {
          z.hitFlashTimer -= rawDt;
          if (z.hitFlashTimer <= 0) {
            for (let m = 0; m < z.materials.length; m++) {
              z.materials[m].emissive.copy(z.baseEmissives[m]);
            }
          }
        }
        if (z.staggerVel.lengthSq() > 0.002) {
          const prevZx = z.root.position.x;
          const prevZz = z.root.position.z;
          z.root.position.addScaledVector(z.staggerVel, rawDt);
          resolveCircleMovement(
            z.root.position,
            prevZx,
            prevZz,
            z.isBoss ? 0.65 : 0.46,
            this.arena.obstacles,
            this.arena.arenaHalfSize,
            this.obstacleGrid,
          );
          z.staggerVel.multiplyScalar(Math.exp(-7.5 * rawDt));
        }

        z.deathTimer += worldDt;
        const collapseDuration = z.killedByWolf ? 0.3 : 0.52;
        const sinkStart = z.killedByWolf ? 0.65 : 0.92;
        const sinkDur = z.killedByWolf ? 0.35 : 0.38;
        const removeAt = z.killedByWolf ? 1.0 : 1.3;

        const fallT = Math.min(1, z.deathTimer / collapseDuration);
        const easedFall = 1 - Math.pow(1 - fallT, 2.2);
        const bounce = fallT > 0.4 ? Math.abs(Math.sin((fallT - 0.4) * Math.PI * 1.6)) * (1 - fallT) * 0.16 : 0;
        const sinkProgress = z.deathTimer > sinkStart ? Math.min(1, (z.deathTimer - sinkStart) / sinkDur) : 0;

        if (z.killedByWolf) {
          z.root.rotation.x = -easedFall * (Math.PI * 0.5);
          z.root.rotation.z = z.collapseDir * easedFall * 0.18;
          z.root.position.y = Math.max(-0.65, bounce + easedFall * 0.08 - sinkProgress * 0.65);
        } else if (z.collapseAxis === 'z') {
          z.root.rotation.z = z.collapseDir * easedFall * (Math.PI * 0.5);
          z.root.rotation.x = easedFall * 0.14;
          z.root.position.y = bounce - sinkProgress * 0.65;
        } else {
          z.root.rotation.x = -easedFall * (Math.PI * 0.5);
          z.root.rotation.z = z.collapseDir * easedFall * 0.2;
          z.root.position.y = bounce - sinkProgress * 0.65;
        }

        if (z.deathTimer >= removeAt) {
          this.bloodFx.clearWoundsForZombie(z);
          this.zombiePool.release(z, this.scene);
          this.zombies.splice(i, 1);
        }
        continue;
      }

      const dxP = this.playerPos.x - z.root.position.x;
      const dzP = this.playerPos.z - z.root.position.z;
      const distSqToPlayer = dxP * dxP + dzP * dzP;

      // Distance-based skeletal AnimationMixer LOD (preserves full 60Hz kinematics & combat timing)
      z.lodAnimAccum = (z.lodAnimAccum ?? 0) + worldDt;
      const animStride =
        distSqToPlayer <= 324 || z.isBoss || z.staggerTimer > 0 || z.hitFlashTimer > 0
          ? 1
          : distSqToPlayer <= 1024
            ? 2
            : 3;
      if (animStride === 1 || (this.frameCounter + z.id) % animStride === 0) {
        z.mixer.update(z.lodAnimAccum);
        z.lodAnimAccum = 0;
      }

      // Apply backward hit stagger knockback impulse + torso recoil
      if (z.staggerVel.lengthSq() > 0.002) {
        const prevZx = z.root.position.x;
        const prevZz = z.root.position.z;
        z.root.position.addScaledVector(z.staggerVel, rawDt);
        resolveCircleMovement(
          z.root.position,
          prevZx,
          prevZz,
          z.isBoss ? 0.65 : 0.46,
          this.arena.obstacles,
          this.arena.arenaHalfSize,
          this.obstacleGrid,
        );
        const dampFactor = Math.exp(-11 * rawDt);
        z.staggerVel.multiplyScalar(dampFactor);
      }
      if (z.staggerTimer > 0) {
        z.staggerTimer = Math.max(0, z.staggerTimer - rawDt);
      }

      // Hit flash feedback (preserves original material emissive once expired)
      if (z.hitFlashTimer > 0) {
        z.hitFlashTimer -= rawDt;
        const flashing = z.hitFlashTimer > 0;
        for (let m = 0; m < z.materials.length; m++) {
          if (flashing) {
            z.materials[m].emissive.setHex(0x991b1b);
          } else {
            z.materials[m].emissive.copy(z.baseEmissives[m]);
          }
        }
      }

      // Periodic zombie groan (pitch-scaled by zombie type)
      z.groanTimer -= worldDt;
      const distToPlayer = Math.sqrt(distSqToPlayer);
      if (z.groanTimer <= 0) {
        z.groanTimer = 4 + Math.random() * 6;
        if (distSqToPlayer < 676) {
          this.audio.playZombieGroan(
            distToPlayer,
            z.isBoss ? 'boss' : z.variant === 'screamer' ? 'screamer' : 'normal',
            this.isBulletTime,
          );
        }
      }

      // Choose between player or alive Dire Wolf companion
      let targetingWolf = false;
      let targetX = this.playerPos.x;
      let targetZ = this.playerPos.z;
      if (wolfAlive) {
        const distToWolf = Math.hypot(wolfX - z.root.position.x, wolfZ - z.root.position.z);
        if (
          distToWolf < distToPlayer * 0.88 ||
          (wolfTargetId === z.id && distToWolf < 3.4)
        ) {
          targetingWolf = true;
          targetX = wolfX;
          targetZ = wolfZ;
        }
      }

      // Move toward chosen target with obstacle-circumvention steering around barricades
      _toPlayer.set(targetX - z.root.position.x, 0, targetZ - z.root.position.z);
      const flatDist = _toPlayer.length();
      if (flatDist > 0.01) {
        _toPlayer.divideScalar(flatDist);
        const moveScale = z.staggerTimer > 0 ? 0.2 : 1.0;
        let faceX = _toPlayer.x;
        let faceZ = _toPlayer.z;
        if (z.avoidTimer && z.avoidTimer > 0) {
          z.avoidTimer = Math.max(0, z.avoidTimer - worldDt);
        }

        if (flatDist > z.stopDistance) {
          const zRadius = z.isBoss ? 0.65 : 0.46;
          const stepLen = z.speed * moveScale * worldDt;
          const preMoveX = z.root.position.x;
          const preMoveZ = z.root.position.z;

          z.root.position.addScaledVector(_toPlayer, stepLen);
          resolveCircleColliders(
            z.root.position,
            zRadius,
            this.arena.obstacles,
            this.arena.arenaHalfSize,
            this.obstacleGrid,
          );

          const movedX = z.root.position.x - preMoveX;
          const movedZ = z.root.position.z - preMoveZ;
          const forwardProgress = movedX * _toPlayer.x + movedZ * _toPlayer.z;

          // If directly blocked by a barricade/vehicle/container, steer tangentially around it
          if (stepLen > 0.0005 && forwardProgress < stepLen * 0.45) {
            const perpLeftX = -_toPlayer.z;
            const perpLeftZ = _toPlayer.x;
            if (!z.avoidTimer || z.avoidTimer <= 0) {
              const probeDist = zRadius + 0.85;
              const leftBlocked = pointBlockedByStaticColliders(
                preMoveX + perpLeftX * probeDist,
                preMoveZ + perpLeftZ * probeDist,
                zRadius,
                this.arena.obstacles,
                this.arena.arenaHalfSize,
                this.obstacleGrid,
              );
              const rightBlocked = pointBlockedByStaticColliders(
                preMoveX - perpLeftX * probeDist,
                preMoveZ - perpLeftZ * probeDist,
                zRadius,
                this.arena.obstacles,
                this.arena.arenaHalfSize,
                this.obstacleGrid,
              );
              if (leftBlocked !== rightBlocked) {
                z.avoidSign = leftBlocked ? -1 : 1;
              } else if (!z.avoidSign) {
                z.avoidSign = (z.id & 1) ? 1 : -1;
              }
              z.avoidTimer = 0.72;
            }

            const sign = z.avoidSign ?? 1;
            const tangX = perpLeftX * sign;
            const tangZ = perpLeftZ * sign;
            const steerStep = stepLen * 0.92;
            z.root.position.x += tangX * steerStep;
            z.root.position.z += tangZ * steerStep;
            resolveCircleColliders(
              z.root.position,
              zRadius,
              this.arena.obstacles,
              this.arena.arenaHalfSize,
              this.obstacleGrid,
            );
            faceX = _toPlayer.x * 0.35 + tangX * 0.65;
            faceZ = _toPlayer.z * 0.35 + tangZ * 0.65;
          }

          if (z.walkAction) {
            z.walkAction.timeScale = z.baseTimeScale;
            z.walkAction.setEffectiveWeight(1);
          }
          if (z.idleAction) z.idleAction.setEffectiveWeight(0);
        } else if (z.walkAction) {
          if (z.idleAction) {
            z.walkAction.setEffectiveWeight(0);
            z.idleAction.setEffectiveWeight(1);
          } else {
            z.walkAction.timeScale = THREE.MathUtils.damp(z.walkAction.timeScale, 0.15, 10, worldDt);
          }
        }
        z.root.rotation.y = Math.atan2(faceX, faceZ);
        z.walkPhase += worldDt * (z.variant === 'screamer' ? 9.5 : 5.0);
        const swayZ =
          z.variant === 'screamer' && flatDist > z.stopDistance && distSqToPlayer < 576
            ? Math.sin(z.walkPhase) * 0.055
            : 0;
        const staggerTiltX = z.staggerTimer > 0 ? -Math.min(0.42, z.staggerTimer * 1.5) : 0;
        z.visual.rotation.set(staggerTiltX, 0, swayZ);
        z.visual.position.set(0, 0, 0);
      }

      // Melee Attack (requires unobstructed LOS so zombies never strike through solid barricades)
      if (z.attackCooldown > 0) z.attackCooldown -= worldDt;
      if (
        flatDist <= z.attackRange &&
        z.attackCooldown <= 0 &&
        hasStaticLineOfSight(
          z.root.position.x,
          z.root.position.z,
          targetX,
          targetZ,
          this.arena.obstacles,
          this.obstacleGrid,
          0.85,
        )
      ) {
        z.attackCooldown = z.isBoss ? 1.35 : 1.15;
        z.attackAction?.reset().play();
        const dmg = z.isBoss ? 35 : z.archetype === 'runner' ? 14 : z.archetype === 'crawler' ? 9 : 11;

        if (targetingWolf) {
          this.damageDireWolf(dmg);
        } else {
          this.hp = Math.max(0, this.hp - dmg);
          this.audio.playPlayerHurt();
          this.updateHealthHUD();

          if (z.isBoss) {
            const camWrap = this.cameraViewportEl ?? document.getElementById('camera-viewport');
            if (camWrap) {
              this.triggerCameraShake(camWrap, 'heavy-screen-shake-active');
            }
          }

          const flash = this.bloodScreenOverlayEl ?? document.getElementById('blood-screen-overlay');
          if (flash && this.hp >= 30) {
            flash.style.opacity = '0.6';
            window.setTimeout(() => {
              if (this.hp >= 30) flash.style.opacity = '0';
            }, 220);
          }

          if (this.hp <= 0) {
            this.triggerGameOver();
            return;
          }
        }
      }
    }

    this.actorSepGrid.resolveZombieCrowd(
      this.zombies,
      this.playerPos,
      PLAYER_RADIUS,
      wolfAlive && this.direWolf ? this.direWolf.root.position : null,
      0.38,
      this.arena.obstacles,
      this.arena.arenaHalfSize,
      this.obstacleGrid,
      worldDt,
    );

    // Update persistent boss crimson aura light without toggling .visible
    const liveBoss = this.zombies.find((z) => z.isBoss && !z.isDead);
    if (liveBoss && !this.isSoftwareGl && this.pcSettings.graphicsQuality !== 'LOW') {
      this.bossAuraLight.position.set(
        liveBoss.root.position.x,
        liveBoss.root.position.y + 2.2,
        liveBoss.root.position.z + 0.4,
      );
      this.bossAuraLight.intensity = 11;
    } else {
      this.bossAuraLight.intensity = 0;
    }

    // 9. Periodic Arena Medkit Supply Points + Active Pickups
    for (let s = 0; s < this.supplyPoints.length; s++) {
      let hasSupply = false;
      for (let p = 0; p < this.pickups.length; p++) {
        if (this.pickups[p].supplySlotIndex === s) {
          hasSupply = true;
          break;
        }
      }
      if (!hasSupply) {
        this.supplyRespawnTimers[s] -= rawDt;
        if (this.supplyRespawnTimers[s] <= 0) {
          const [sx, sz] = this.supplyPoints[s];
          this.spawnMedkitCrate(sx, sz, 999, s, 45);
          this.supplyRespawnTimers[s] = 22;
        }
      }
    }

    const pickupBobY = Math.sin(this.lastFrameTime * 0.004) * 0.09;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p.supplySlotIndex === undefined) {
        p.life -= rawDt;
      }
      p.root.rotation.y += rawDt * 2.2;
      p.root.position.y = pickupBobY;

      const dx = p.position.x - this.playerPos.x;
      const dz = p.position.z - this.playerPos.z;
      if (dx * dx + dz * dz < 2.56) {
        if (p.type === 'medkit') {
          this.hp = Math.min(this.maxHp, this.hp + (p.healAmount ?? 45));
          this.updateHealthHUD();
          this.flashHealScreen();
          if (p.supplySlotIndex !== undefined) {
            this.supplyRespawnTimers[p.supplySlotIndex] = 22;
          }
        } else {
          const active = this.weapons[this.activeWeapon];
          active.currentAmmo = active.magCapacity;
          this.adrenaline = Math.min(100, this.adrenaline + 18);
          this.updateAmmoHUD();
          this.updateAdrenalineHUD();
        }
        this.audio.playPickup();
        this.scene.remove(p.root);
        this.pickups.splice(i, 1);
        continue;
      }

      if (p.life <= 0) {
        this.scene.remove(p.root);
        this.pickups.splice(i, 1);
      }
    }

    // 10. Pooled 3D Bullet Tracers, Ejecting Brass Casings & Impact Sparks/Mist
    for (let i = this.tracers3D.length - 1; i >= 0; i--) {
      const tr = this.tracers3D[i];
      tr.life -= rawDt;
      const mat = tr.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, tr.life / tr.maxLife);
      if (tr.life <= 0) {
        tr.mesh.visible = false;
        this.freeTracers3D.push(tr);
        this.tracers3D.splice(i, 1);
      }
    }

    for (let i = this.casings3D.length - 1; i >= 0; i--) {
      const c = this.casings3D[i];
      c.life -= worldDt;
      c.vel.y -= 13.5 * worldDt;
      c.mesh.position.addScaledVector(c.vel, worldDt);
      c.mesh.rotation.x += c.rotVel.x * worldDt;
      c.mesh.rotation.y += c.rotVel.y * worldDt;
      c.mesh.rotation.z += c.rotVel.z * worldDt;

      if (c.mesh.position.y <= 0.025) {
        c.mesh.position.y = 0.025;
        if (Math.abs(c.vel.y) > 0.65) {
          c.vel.y = Math.abs(c.vel.y) * 0.42;
          c.vel.x *= 0.68;
          c.vel.z *= 0.68;
          c.rotVel.multiplyScalar(0.55);
          if (c.bounces === 0) {
            c.bounces = 1;
            if (this.lastFrameTime - this.lastBrassClinkMs > 85) {
              this.lastBrassClinkMs = this.lastFrameTime;
              this.audio.playBrassClink();
            }
          }
        } else {
          c.vel.set(0, 0, 0);
          c.rotVel.set(0, 0, 0);
        }
      }

      if (c.life <= 0) {
        c.mesh.visible = false;
        this.freeCasings3D.push(c);
        this.casings3D.splice(i, 1);
      }
    }

    for (let i = this.sparks3D.length - 1; i >= 0; i--) {
      const sp = this.sparks3D[i];
      sp.life -= worldDt;
      sp.vel.y -= sp.gravity * worldDt;
      sp.mesh.position.addScaledVector(sp.vel, worldDt);
      const mat = sp.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, sp.life / sp.maxLife);
      if (sp.life <= 0 || sp.mesh.position.y < -0.2) {
        sp.mesh.visible = false;
        this.freeSparks3D.push(sp);
        this.sparks3D.splice(i, 1);
      }
    }

    // 10b. Update pooled blood splatter decals, directional droplets & mist
    this.bloodFx.update(worldDt, this.camera.position, this.envRaycastTargets);

    // 10c. Update 3D Dire Wolf Companion
    this.updateDireWolfCompanion(worldDt);

    this.renderRadar(this.lastFrameTime);
  }

  private tick = (): void => {
    this.frameId = 0;
    this.frameIsTimeout = false;
    if (this.disposed || this.isContextLost || !this.isPageVisible || !this.isViewportVisible) {
      return;
    }

    const now = performance.now();
    const rawDt = Math.min((now - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = now;

    this.arena.updateAtmosphere(rawDt, now, this.camera.position, this.pcSettings.graphicsQuality);
    this.vehiclePack?.update(
      rawDt,
      now,
      this.weather.getStormIntensity(),
      this.camera.position,
    );
    this.propsPack?.update(
      rawDt,
      now * 0.001,
      this.weather.getStormIntensity(),
      this.camera,
    );
    this.weather.update({
      dt: rawDt,
      cameraPos: this.camera.position,
      wave: this.wave,
      quality: this.pcSettings.graphicsQuality,
      isPlaying: this.gameState === 'PLAYING',
      mobilePreview: this.perfProfile.isMobilePreview,
      hasEnvReflections: this.perfProfile.allowEnvReflections && !this.isSoftwareGl,
      onThunder: (strength, delaySec) => {
        if (this.gameState === 'PLAYING' || this.gameState === 'ARMORY') {
          this.audio.playThunder(strength, delaySec);
        }
      },
    });
    this.arena.setGroundWetness(this.weather.getGroundWetness());

    const rainMix =
      this.gameState === 'PLAYING'
        ? 1.0
        : this.gameState === 'PAUSED' || this.gameState === 'ARMORY' || this.gameState === 'HUD_EDIT'
          ? 0.35
          : this.gameState === 'GAME_OVER'
            ? 0
            : 0.45;
    this.audio.setRainAmbience(this.weather.getStormIntensity(), rainMix);

    if (this.gameState === 'START') {
      this.updateStartOrbit(rawDt);
    } else if (this.gameState === 'PLAYING') {
      this.updateGameplay(rawDt);
    }

    this.renderSceneFrame();
    this.scheduleNextTick();
  };

  private stopRenderLoop(): void {
    if (this.frameId !== 0) {
      if (this.frameIsTimeout) {
        window.clearTimeout(this.frameId);
      } else {
        cancelAnimationFrame(this.frameId);
      }
      this.frameId = 0;
      this.frameIsTimeout = false;
    }
  }

  private syncLoopRunningState(): void {
    if (this.disposed || this.isContextLost || !this.isPageVisible || !this.isViewportVisible) {
      this.stopRenderLoop();
      return;
    }
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (
      this.frameId !== 0 ||
      this.disposed ||
      this.isContextLost ||
      !this.isPageVisible ||
      !this.isViewportVisible
    ) {
      return;
    }
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameIsTimeout = false;
      this.frameId = requestAnimationFrame(this.tick);
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
    gl.flush();
    const poll = () => {
      this.frameId = 0;
      this.frameIsTimeout = false;
      if (this.disposed || this.isContextLost || !this.isPageVisible || !this.isViewportVisible) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      if (!sync) {
        this.frameIsTimeout = true;
        this.frameId = window.setTimeout(cb, 80);
        return;
      }
      const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameIsTimeout = true;
        this.frameId = window.setTimeout(poll, 5);
      } else {
        gl.deleteSync(sync);
        this.frameIsTimeout = true;
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameIsTimeout = true;
    this.frameId = window.setTimeout(poll, 5);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (activeEngineInstance === this) {
      activeEngineInstance = null;
    }
    this.stopRenderLoop();
    window.clearTimeout(this.waveBannerTimeout);
    window.clearTimeout(this.healFlashTimeout);
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.uiAc.abort();
    this.controls.dispose();
    this.clearArenaEntities();
    this.zombiePool.disposeAll();
    disposeWeaponRig(this.gunRig);
    this.gunRig = null;
    disposeEnemyRoster(this.enemyRoster);
    this.enemyRoster = null;
    disposeDireWolf(this.direWolf, this.scene);
    this.direWolf = null;
    for (const tr of this.freeTracers3D) {
      this.scene.remove(tr.mesh);
      (tr.mesh.material as THREE.Material).dispose();
    }
    this.freeTracers3D.length = 0;
    for (const c of this.freeCasings3D) {
      this.scene.remove(c.mesh);
    }
    this.freeCasings3D.length = 0;
    for (const s of this.freeSparks3D) {
      this.scene.remove(s.mesh);
      (s.mesh.material as THREE.Material).dispose();
    }
    this.freeSparks3D.length = 0;

    this.casingGeo.dispose();
    this.casingMat.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.waterSplashGeo.dispose();
    this.splashMat.dispose();
    this.bloodFx.dispose();
    this.tracerGeo.dispose();
    this.medkitBoxGeo.dispose();
    this.medkitCrossHGeo.dispose();
    this.medkitCrossVGeo.dispose();
    this.medkitFloatAGeo.dispose();
    this.medkitFloatBGeo.dispose();
    this.medkitCrateMat.dispose();
    this.medkitCrossMat.dispose();
    this.ammoBoxGeo.dispose();
    this.ammoStripeGeo.dispose();
    this.ammoBoxMat.dispose();
    this.ammoStripeMat.dispose();
    this.flashlightCone.geometry.dispose();
    (this.flashlightCone.material as THREE.Material).dispose();
    if (this.scene.environment) {
      this.scene.environment.dispose();
      this.scene.environment = null;
    }
    this.bloomPass?.dispose();
    this.bloomPass = null;
    this.composer?.dispose();
    this.composer = null;
    this.weather.dispose();
    this.propsPack?.dispose();
    this.propsPack = null;
    this.vehiclePack?.dispose();
    this.vehiclePack = null;
    this.arena.dispose();
    this.audio.dispose();
    THREE.Cache.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
