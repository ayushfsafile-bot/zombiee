import type * as THREE from 'three';
export type {
  AabbCollider,
  CapsuleCollider,
  CircleCollider,
  Collider,
  MeshPartBounds,
  ObbCollider,
} from './colliders';

export type GameState = 'START' | 'PLAYING' | 'PAUSED' | 'ARMORY' | 'HUD_EDIT' | 'GAME_OVER';
export type WeaponKey = 'mark23' | 'kriss' | 'm4fps';
export type UpgradeStatKey = 'damage' | 'magCapacity' | 'fireRate';
export type GraphicsQuality = 'LOW' | 'MED' | 'HIGH';
export type MobilePresetMode = 'auto' | 'mobile' | 'desktop';

export type TouchControlId =
  | 'stick-move-zone'
  | 'btn-touch-fire'
  | 'btn-touch-jump'
  | 'btn-touch-reload'
  | 'btn-touch-swap'
  | 'btn-touch-ads'
  | 'btn-touch-light'
  | 'btn-touch-inspect';

export interface TouchControlLayoutItem {
  xPct: number; // left% (0..100)
  yPct: number; // top% (0..100)
  scale: number; // 0.6..1.6
  opacity: number; // 0.3..1.0
}

export interface TouchHudLayout {
  touchSensitivity: number; // 0.4..2.2
  controls: Record<TouchControlId, TouchControlLayoutItem>;
}

export interface PcSettings {
  mouseSensitivity: number; // 0.3..2.5
  fov: number; // 65..95
  graphicsQuality: GraphicsQuality;
  forceTouchControls: boolean;
  mobilePreset: MobilePresetMode;
}

export type WeaponUpgrades = Record<UpgradeStatKey, number>;

export type MenuShowcaseWeaponKey = 'coltM4a1' | 'gun';

export interface MenuShowcaseWeaponConfig {
  id: MenuShowcaseWeaponKey;
  name: string;
  url: string;
  classification: 'menu-showcase-only';
  gameplayEnabled: false;
}

export interface WeaponTuningConfig {
  id: WeaponKey;
  name: string;
  shortName: string;
  category: string;
  caliber: string;
  url: string;
  magSize: number;
  fireRate: number; // delay in ms between shots
  damage: number;
  auto: boolean;
  scale: number;
  pos: [number, number, number];
  adsPos: [number, number, number];
  adsFov: number;
  rotY: number;
  muzzleLocal: [number, number, number];
  reloadDuration: number; // seconds (mid-mag reload)
  reloadEmptyDuration: number; // seconds (empty-mag reload)
  moveSpeedMult: number;
  spread: number;
  hudSpreadPx: number;
  shakeClass: string;
  kickClass: string;
  recoilKick: number;
  pitchKick: number;
}

export interface WeaponConfig {
  id: WeaponKey;
  name: string;
  category: string;
  caliber: string;
  fireMode: string;
  currentAmmo: number;
  magCapacity: number;
  baseMagCapacity: number;
  reserveAmmo: number;
  maxReserve: number;
  fireDelay: number; // ms
  baseFireDelay: number; // ms
  pellets: number;
  spread: number; // radians
  hudSpreadPx: number;
  shakeClass: string;
  kickClass: string;
  baseDmg: number;
  unupgradedDmg: number;
  autoFire: boolean;
  adsFov: number;
  reloadDuration: number; // seconds
  reloadEmptyDuration: number; // seconds
  moveSpeedMult: number;
  recoilKick: number;
  pitchKick: number;
  upgrades: WeaponUpgrades;
}

export interface BestRecord {
  bestWave: number;
  bestKills: number;
}

export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export type ZombieArchetype =
  | 'runner'
  | 'walker_survivor'
  | 'walker_yaku'
  | 'walker_shambler'
  | 'crawler';

export interface HitboxExtents {
  halfX: number;
  halfY: number;
  halfZ: number;
  centerY: number;
  headMinY: number;
  headMinZ?: number;
}

export interface ZombieEntity {
  id: number;
  root: THREE.Group;
  visual: THREE.Group;
  mixer: THREE.AnimationMixer;
  walkAction: THREE.AnimationAction | null;
  idleAction: THREE.AnimationAction | null;
  attackAction: THREE.AnimationAction | null;
  baseTimeScale: number;
  hitbox: THREE.Mesh;
  hitboxExtents: HitboxExtents;
  hp: number;
  maxHp: number;
  speed: number;
  stopDistance: number;
  attackRange: number;
  attackCooldown: number;
  hitFlashTimer: number;
  staggerVel: THREE.Vector3;
  staggerTimer: number;
  collapseDir: number;
  collapseAxis: 'x' | 'z';
  isDead: boolean;
  isBoss: boolean;
  killedByWolf?: boolean;
  deathTimer: number;
  archetype: ZombieArchetype;
  variant: 'walker' | 'screamer';
  groanTimer: number;
  walkPhase: number;
  lodAnimAccum?: number;
  avoidSign?: number;
  avoidTimer?: number;
  poolKey?: ZombieArchetype;
  isBossSlot?: boolean;
  bossLight?: THREE.PointLight | null;
  materials: Array<THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial>;
  baseEmissives: THREE.Color[];
}

export interface PickupEntity {
  root: THREE.Group;
  type: 'ammo' | 'medkit';
  position: THREE.Vector3;
  life: number;
  healAmount?: number;
  supplySlotIndex?: number;
}

export interface Tracer3D {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

export interface ShellCasing3D {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  life: number;
  bounces: number;
}

export interface SparkParticle3D {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
}

export type DireWolfAnimState = 'idle' | 'walk' | 'run' | 'bite';
export type WolfUpgradeKey = 'biteDamage' | 'maxHealth' | 'agilityFerocity';
export type WolfUpgrades = Record<WolfUpgradeKey, number>;

export interface DireWolfCompanion {
  root: THREE.Group;
  visual: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: {
    idle: THREE.AnimationAction | null;
    walk: THREE.AnimationAction | null;
    run: THREE.AnimationAction | null;
    bite: THREE.AnimationAction | null;
  };
  currentAction: THREE.AnimationAction | null;
  currentState: DireWolfAnimState;
  halfLength: number;
  biteAnimDuration: number;
  biteWindowTimer: number;
  pendingBiteImpactTimer: number;
  pendingBiteTargetId: number | null;
  pendingBiteDamage: number;
  lungeOffset: number;
  maxHp: number;
  currentHp: number;
  isDowned: boolean;
  biteDamage: number;
  runSpeed: number;
  walkSpeed: number;
  attackDelay: number;
  attackCooldown: number;
  hitFlashTimer: number;
  targetZombieId: number | null;
  alertCooldown: number;
  statusLabel: string;
  upgrades: WolfUpgrades;
  materials: Array<THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial>;
  baseEmissives: THREE.Color[];
}



