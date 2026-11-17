import type {
  MenuShowcaseWeaponConfig,
  MenuShowcaseWeaponKey,
  WeaponKey,
  WeaponTuningConfig,
} from './types';

// ============================================================================
// WEAPON TUNING CONSTANTS — Adjust name, url, stats, scale, pos, adsPos & rotY
// ============================================================================
export const WEAPON_CONFIGS: Record<WeaponKey, WeaponTuningConfig> = {
  // Weapon 1 (Primary): 20-round full-auto tactical pistol
  mark23: {
    id: 'mark23',
    name: 'MARK 23 TACTICAL',
    shortName: 'MARK 23',
    category: 'WEAPON 1 · PRIMARY',
    caliber: '.45 ACP TACTICAL',
    url: '/mark-23.glb',
    magSize: 20,
    fireRate: 130, // ~461 RPM
    damage: 52,
    auto: true,
    scale: 0.01,
    pos: [-0.01, -1.55, -0.22],
    adsPos: [-0.095, -1.465, -0.15],
    adsFov: 54,
    rotY: Math.PI,
    muzzleLocal: [0.09, -0.09, -0.44],
    reloadDuration: 1.45,
    reloadEmptyDuration: 1.6,
    moveSpeedMult: 1.14,
    spread: 0.0085,
    hudSpreadPx: 11,
    shakeClass: 'screen-shake-active',
    kickClass: 'crosshair-kick',
    recoilKick: 0.042,
    pitchKick: 0.009,
  },
  // Weapon 2 (Secondary): 30-round ultra-fast Kriss Vector SMG
  kriss: {
    id: 'kriss',
    name: 'KRISS VECTOR SMG',
    shortName: 'KRISS VECTOR',
    category: 'WEAPON 2 · SMG',
    caliber: '.45 ACP SUPER-V',
    url: '/kriss-vector.glb',
    magSize: 30,
    fireRate: 80, // ~750 RPM
    damage: 56,
    auto: true,
    scale: 0.01,
    pos: [-0.02, -1.53, -0.16],
    adsPos: [-0.115, -1.43, -0.09],
    adsFov: 50,
    rotY: Math.PI,
    muzzleLocal: [0.10, -0.11, -0.60],
    reloadDuration: 1.55,
    reloadEmptyDuration: 1.75,
    moveSpeedMult: 1.02,
    spread: 0.0125,
    hudSpreadPx: 15,
    shakeClass: 'heavy-screen-shake-active',
    kickClass: 'crosshair-kick',
    recoilKick: 0.034,
    pitchKick: 0.008,
  },
  // Weapon 3 (Tertiary): 30-round high-damage M4 Tactical Assault Rifle
  m4fps: {
    id: 'm4fps',
    name: 'M4 TACTICAL RIFLE',
    shortName: 'M4 RIFLE',
    category: 'WEAPON 3 · ASSAULT',
    caliber: '5.56x45MM AP',
    url: '/m4-fps-pack.glb',
    magSize: 30,
    fireRate: 110, // ~545 RPM
    damage: 70,
    auto: true,
    scale: 1.0,
    pos: [0.01, -1.52, -0.06],
    adsPos: [-0.06, -1.435, 0.01],
    adsFov: 48,
    rotY: Math.PI,
    muzzleLocal: [0.07, -0.09, -0.72],
    reloadDuration: 1.4,
    reloadEmptyDuration: 1.85,
    moveSpeedMult: 1.04,
    spread: 0.0085,
    hudSpreadPx: 12,
    shakeClass: 'heavy-screen-shake-active',
    kickClass: 'crosshair-kick',
    recoilKick: 0.028,
    pitchKick: 0.011,
  },
};

export const WEAPON_ORDER: WeaponKey[] = ['mark23', 'kriss', 'm4fps'];

// ============================================================================
// MENU SHOWCASE WEAPON ASSETS — Reserved for future main-menu 3D showcase only.
// Strictly separate from active gameplay inventory (WEAPON_CONFIGS / WEAPON_ORDER).
// ============================================================================
export const MENU_SHOWCASE_WEAPON_ASSETS: Record<
  MenuShowcaseWeaponKey,
  MenuShowcaseWeaponConfig
> = {
  coltM4a1: {
    id: 'coltM4a1',
    name: 'Colt M4A1',
    url: '/colt-m4a1.glb',
    classification: 'menu-showcase-only',
    gameplayEnabled: false,
  },
  gun: {
    id: 'gun',
    name: 'Menu Showcase Weapon',
    url: '/gun.glb',
    classification: 'menu-showcase-only',
    gameplayEnabled: false,
  },
};
