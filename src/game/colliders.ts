import * as THREE from 'three';

export interface AabbCollider {
  kind: 'aabb';
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export interface ObbCollider {
  kind: 'obb';
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  rotY: number;
  cosY: number;
  sinY: number;
  boundingRadius: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export interface CircleCollider {
  kind: 'circle';
  cx: number;
  cz: number;
  radius: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export interface CapsuleCollider {
  kind: 'capsule';
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export type Collider = AabbCollider | ObbCollider | CircleCollider | CapsuleCollider;

export interface TorsoBounds {
  width: number;
  depth: number;
  height: number;
  centerX: number;
  centerZ: number;
}

export interface MeshPartBounds extends TorsoBounds {
  minY: number;
  maxY: number;
}

const _invRootMat = new THREE.Matrix4();
const _vertA = new THREE.Vector3();
const _vertB = new THREE.Vector3();
const _vertC = new THREE.Vector3();
const _fallbackBox = new THREE.Box3();
const _fallbackSize = new THREE.Vector3();
const _fallbackCenter = new THREE.Vector3();

function markOccupiedSegment(
  occ: Uint8Array,
  cellMinY: Float32Array,
  cellMaxY: Float32Array,
  cols: number,
  rows: number,
  originX: number,
  originZ: number,
  invCell: number,
  cellSize: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  minY: number,
  maxY: number,
): void {
  if ((ay < minY && by < minY) || (ay > maxY && by > maxY)) return;

  // Clip 3D segment [a, b] vertically to [minY, maxY]
  let t0 = 0;
  let t1 = 1;
  const dy = by - ay;
  if (Math.abs(dy) > 1e-6) {
    const ta = (minY - ay) / dy;
    const tb = (maxY - ay) / dy;
    const tLo = Math.min(ta, tb);
    const tHi = Math.max(ta, tb);
    if (tLo > t0) t0 = tLo;
    if (tHi < t1) t1 = tHi;
    if (t0 > t1) return;
  }

  const sx0 = ax + (bx - ax) * t0;
  const sy0 = ay + dy * t0;
  const sz0 = az + (bz - az) * t0;
  const sx1 = ax + (bx - ax) * t1;
  const sy1 = ay + dy * t1;
  const sz1 = az + (bz - az) * t1;

  const segLen = Math.hypot(sx1 - sx0, sz1 - sz0);
  const steps = Math.max(1, Math.min(64, Math.ceil(segLen / (cellSize * 0.45))));

  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const x = sx0 + (sx1 - sx0) * f;
    const y = sy0 + (sy1 - sy0) * f;
    const z = sz0 + (sz1 - sz0) * f;
    const gx = Math.floor((x - originX) * invCell);
    const gz = Math.floor((z - originZ) * invCell);
    if (gx < 1 || gx >= cols - 1 || gz < 1 || gz >= rows - 1) continue;
    const idx = gz * cols + gx;
    occ[idx] = 1;
    if (y < cellMinY[idx]) cellMinY[idx] = y;
    if (y > cellMaxY[idx]) cellMaxY[idx] = y;
  }
}

/**
 * Extracts tight, mesh-accurate solid sub-part bounding boxes in `root`'s local space
 * via 2D torso-slice triangle rasterization, outside flood-fill, and maximal-rectangle merging.
 * Eliminates default Box3 bloat on L-shapes, tapered roadblocks, open doors, and vehicles.
 */
export function computeMeshPartBounds(
  root: THREE.Object3D,
  minY = 0.14,
  maxY = 1.75,
): MeshPartBounds[] {
  root.updateMatrixWorld(true);
  _invRootMat.copy(root.matrixWorld).invert();

  interface SolidMeshInfo {
    mesh: THREE.Mesh;
    matToRoot: THREE.Matrix4;
    effectiveMinY: number;
  }

  const validMeshes: SolidMeshInfo[] = [];
  let globalMinX = Infinity;
  let globalMaxX = -Infinity;
  let globalMinZ = Infinity;
  let globalMaxZ = -Infinity;
  let overallMeshMaxY = 0.35;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || mesh.userData.isRaycastProxy) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;

    const firstMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (firstMat && firstMat.visible === false) return;

    const posAttr = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count === 0) return;

    const matToRoot = new THREE.Matrix4().multiplyMatrices(_invRootMat, mesh.matrixWorld);
    const count = posAttr.count;
    const step = count > 8000 ? Math.ceil(count / 4000) : 1;

    let mMinY = Infinity;
    let mMaxY = -Infinity;
    let mMinX = Infinity;
    let mMaxX = -Infinity;
    let mMinZ = Infinity;
    let mMaxZ = -Infinity;
    let tMinX = Infinity;
    let tMaxX = -Infinity;
    let tMinZ = Infinity;
    let tMaxZ = -Infinity;
    let tHits = 0;

    for (let i = 0; i < count; i += step) {
      _vertA.fromBufferAttribute(posAttr, i).applyMatrix4(matToRoot);
      if (_vertA.y < mMinY) mMinY = _vertA.y;
      if (_vertA.y > mMaxY) mMaxY = _vertA.y;
      if (_vertA.x < mMinX) mMinX = _vertA.x;
      if (_vertA.x > mMaxX) mMaxX = _vertA.x;
      if (_vertA.z < mMinZ) mMinZ = _vertA.z;
      if (_vertA.z > mMaxZ) mMaxZ = _vertA.z;

      if (_vertA.y >= minY && _vertA.y <= maxY) {
        if (_vertA.x < tMinX) tMinX = _vertA.x;
        if (_vertA.x > tMaxX) tMaxX = _vertA.x;
        if (_vertA.z < tMinZ) tMinZ = _vertA.z;
        if (_vertA.z > tMaxZ) tMaxZ = _vertA.z;
        tHits++;
      }
    }

    const spanX = mMaxX - mMinX;
    const spanZ = mMaxZ - mMinZ;
    const spanY = mMaxY - mMinY;

    // Filter out flat ground/shadow planes, overhead-only parts, and tiny decorative details
    if (mMaxY < 0.08) return;
    if (spanY < 0.05 && Math.max(spanX, spanZ) > 0.45) return;
    if (mMinY > maxY) return;
    if (spanX < 0.14 && spanZ < 0.14) return;
    if (spanX < 0.06 || spanZ < 0.06) return;

    const effectiveMinY = tHits >= 3 ? minY : mMaxY >= 0.16 ? 0.05 : minY;
    const useMinX = tHits >= 3 ? tMinX : mMinX;
    const useMaxX = tHits >= 3 ? tMaxX : mMaxX;
    const useMinZ = tHits >= 3 ? tMinZ : mMinZ;
    const useMaxZ = tHits >= 3 ? tMaxZ : mMaxZ;

    if (useMinX < globalMinX) globalMinX = useMinX;
    if (useMaxX > globalMaxX) globalMaxX = useMaxX;
    if (useMinZ < globalMinZ) globalMinZ = useMinZ;
    if (useMaxZ > globalMaxZ) globalMaxZ = useMaxZ;
    if (mMaxY > overallMeshMaxY) overallMeshMaxY = mMaxY;

    validMeshes.push({ mesh, matToRoot, effectiveMinY });
  });

  if (
    validMeshes.length === 0 ||
    !Number.isFinite(globalMinX) ||
    globalMaxX <= globalMinX ||
    globalMaxZ <= globalMinZ
  ) {
    _fallbackBox.setFromObject(root);
    _fallbackBox.getSize(_fallbackSize);
    _fallbackBox.getCenter(_fallbackCenter);
    const localCenter = _fallbackCenter.applyMatrix4(_invRootMat);
    return [
      {
        width: Math.max(0.25, _fallbackSize.x),
        depth: Math.max(0.25, _fallbackSize.z),
        height: Math.max(0.35, _fallbackSize.y),
        minY: Math.max(0, _fallbackBox.min.y),
        maxY: Math.max(0.35, _fallbackBox.max.y),
        centerX: localCenter.x,
        centerZ: localCenter.z,
      },
    ];
  }

  const spanX = globalMaxX - globalMinX;
  const spanZ = globalMaxZ - globalMinZ;
  const cellSize = Math.max(0.15, Math.min(0.24, Math.max(spanX, spanZ) / 36));
  const invCell = 1 / cellSize;
  const cols = Math.max(4, Math.ceil(spanX * invCell) + 2);
  const rows = Math.max(4, Math.ceil(spanZ * invCell) + 2);
  const originX = globalMinX - cellSize;
  const originZ = globalMinZ - cellSize;
  const totalCells = cols * rows;

  const occ = new Uint8Array(totalCells);
  const cellMinY = new Float32Array(totalCells);
  const cellMaxY = new Float32Array(totalCells);
  cellMinY.fill(Infinity);
  cellMaxY.fill(-Infinity);

  // Rasterize every mesh triangle overlapping torso height onto the 2D XZ grid
  for (const info of validMeshes) {
    const geom = info.mesh.geometry;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const index = geom.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
    const m = info.matToRoot;
    const eMinY = info.effectiveMinY;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      _vertA.fromBufferAttribute(posAttr, i0).applyMatrix4(m);
      _vertB.fromBufferAttribute(posAttr, i1).applyMatrix4(m);
      _vertC.fromBufferAttribute(posAttr, i2).applyMatrix4(m);

      const tMinY = Math.min(_vertA.y, _vertB.y, _vertC.y);
      const tMaxY = Math.max(_vertA.y, _vertB.y, _vertC.y);
      if (tMaxY < eMinY || tMinY > maxY) continue;

      markOccupiedSegment(
        occ, cellMinY, cellMaxY, cols, rows, originX, originZ, invCell, cellSize,
        _vertA.x, _vertA.y, _vertA.z, _vertB.x, _vertB.y, _vertB.z, eMinY, maxY,
      );
      markOccupiedSegment(
        occ, cellMinY, cellMaxY, cols, rows, originX, originZ, invCell, cellSize,
        _vertB.x, _vertB.y, _vertB.z, _vertC.x, _vertC.y, _vertC.z, eMinY, maxY,
      );
      markOccupiedSegment(
        occ, cellMinY, cellMaxY, cols, rows, originX, originZ, invCell, cellSize,
        _vertC.x, _vertC.y, _vertC.z, _vertA.x, _vertA.y, _vertA.z, eMinY, maxY,
      );

      // Fill horizontal/sloped triangle interiors
      const area2 =
        (_vertB.x - _vertA.x) * (_vertC.z - _vertA.z) -
        (_vertB.z - _vertA.z) * (_vertC.x - _vertA.x);
      if (Math.abs(area2) > 1e-4) {
        const invArea2 = 1 / area2;
        const gMinX = Math.max(1, Math.floor((Math.min(_vertA.x, _vertB.x, _vertC.x) - originX) * invCell));
        const gMaxX = Math.min(cols - 2, Math.floor((Math.max(_vertA.x, _vertB.x, _vertC.x) - originX) * invCell));
        const gMinZ = Math.max(1, Math.floor((Math.min(_vertA.z, _vertB.z, _vertC.z) - originZ) * invCell));
        const gMaxZ = Math.min(rows - 2, Math.floor((Math.max(_vertA.z, _vertB.z, _vertC.z) - originZ) * invCell));

        for (let gz = gMinZ; gz <= gMaxZ; gz++) {
          const cz = originZ + (gz + 0.5) * cellSize;
          for (let gx = gMinX; gx <= gMaxX; gx++) {
            const cx = originX + (gx + 0.5) * cellSize;
            const w0 = ((_vertB.x - cx) * (_vertC.z - cz) - (_vertB.z - cz) * (_vertC.x - cx)) * invArea2;
            const w1 = ((_vertC.x - cx) * (_vertA.z - cz) - (_vertC.z - cz) * (_vertA.x - cx)) * invArea2;
            const w2 = 1 - w0 - w1;
            if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) {
              const py = w0 * _vertA.y + w1 * _vertB.y + w2 * _vertC.y;
              if (py >= 0.04 && py <= maxY) {
                const idx = gz * cols + gx;
                occ[idx] = 1;
                if (py < cellMinY[idx]) cellMinY[idx] = py;
                if (py > cellMaxY[idx]) cellMaxY[idx] = py;
              }
            }
          }
        }
      }
    }
  }

  // 4-connected BFS from outer border (0,0) to distinguish true exterior space from closed interior hull
  const outside = new Uint8Array(totalCells);
  const queue = new Int32Array(totalCells);
  let qHead = 0;
  let qTail = 0;
  outside[0] = 1;
  queue[qTail++] = 0;

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % cols;
    const cz = (cur - cx) / cols;

    if (cx > 0) {
      const n = cur - 1;
      if (!outside[n] && !occ[n]) {
        outside[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (cx < cols - 1) {
      const n = cur + 1;
      if (!outside[n] && !occ[n]) {
        outside[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (cz > 0) {
      const n = cur - cols;
      if (!outside[n] && !occ[n]) {
        outside[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (cz < rows - 1) {
      const n = cur + cols;
      if (!outside[n] && !occ[n]) {
        outside[n] = 1;
        queue[qTail++] = n;
      }
    }
  }

  // Fill enclosed hull cells while leaving open exterior bays/cutouts walkable
  for (let i = 0; i < totalCells; i++) {
    if (!occ[i] && !outside[i]) {
      occ[i] = 1;
      cellMinY[i] = 0;
      cellMaxY[i] = overallMeshMaxY;
    }
  }

  // Remove isolated single-cell speckles (e.g., stray mirror tip) with 0 occupied neighbors
  for (let gz = 1; gz < rows - 1; gz++) {
    for (let gx = 1; gx < cols - 1; gx++) {
      const idx = gz * cols + gx;
      if (!occ[idx]) continue;
      let neighbors = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (occ[(gz + dz) * cols + (gx + dx)]) neighbors++;
        }
      }
      if (neighbors === 0) {
        occ[idx] = 0;
      }
    }
  }

  // Greedy maximal-rectangle decomposition over occupied cells
  interface RawBox {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minY: number;
    maxY: number;
  }

  const visited = new Uint8Array(totalCells);
  const rawParts: RawBox[] = [];

  for (let gz = 1; gz < rows - 1; gz++) {
    for (let gx = 1; gx < cols - 1; gx++) {
      const startIdx = gz * cols + gx;
      if (!occ[startIdx] || visited[startIdx]) continue;

      let w = 1;
      while (gx + w < cols - 1 && occ[gz * cols + gx + w] && !visited[gz * cols + gx + w]) {
        w++;
      }

      let h = 1;
      while (gz + h < rows - 1) {
        let fullRow = true;
        for (let ix = 0; ix < w; ix++) {
          const checkIdx = (gz + h) * cols + gx + ix;
          if (!occ[checkIdx] || visited[checkIdx]) {
            fullRow = false;
            break;
          }
        }
        if (!fullRow) break;
        h++;
      }

      let partMaxY = 0.35;
      for (let iz = 0; iz < h; iz++) {
        for (let ix = 0; ix < w; ix++) {
          const idx = (gz + iz) * cols + gx + ix;
          visited[idx] = 1;
          const cyMax = cellMaxY[idx];
          if (Number.isFinite(cyMax) && cyMax > partMaxY) {
            partMaxY = cyMax;
          }
        }
      }

      const bMinX = Math.max(globalMinX, originX + gx * cellSize);
      const bMaxX = Math.min(globalMaxX, originX + (gx + w) * cellSize);
      const bMinZ = Math.max(globalMinZ, originZ + gz * cellSize);
      const bMaxZ = Math.min(globalMaxZ, originZ + (gz + h) * cellSize);
      if (bMaxX - bMinX < 0.12 || bMaxZ - bMinZ < 0.12) continue;

      rawParts.push({
        minX: bMinX,
        maxX: bMaxX,
        minZ: bMinZ,
        maxZ: bMaxZ,
        minY: 0,
        maxY: Math.max(0.35, Math.max(partMaxY, overallMeshMaxY)),
      });
    }
  }

  if (rawParts.length === 0) {
    return [
      {
        width: Math.max(0.25, spanX),
        depth: Math.max(0.25, spanZ),
        height: Math.max(0.35, overallMeshMaxY),
        minY: 0,
        maxY: Math.max(0.35, overallMeshMaxY),
        centerX: (globalMinX + globalMaxX) * 0.5,
        centerZ: (globalMinZ + globalMaxZ) * 0.5,
      },
    ];
  }

  // Consolidate adjacent aligned rectangles ONLY when union introduces <= 12% empty area
  let merged = true;
  while (merged && rawParts.length > 1) {
    merged = false;
    for (let i = 0; i < rawParts.length && !merged; i++) {
      const a = rawParts[i];
      const areaA = (a.maxX - a.minX) * (a.maxZ - a.minZ);
      for (let j = i + 1; j < rawParts.length; j++) {
        const b = rawParts[j];
        const gapX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
        const gapZ = Math.max(0, Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ));
        if (gapX > 0.12 || gapZ > 0.12) continue;

        const uMinX = Math.min(a.minX, b.minX);
        const uMaxX = Math.max(a.maxX, b.maxX);
        const uMinZ = Math.min(a.minZ, b.minZ);
        const uMaxZ = Math.max(a.maxZ, b.maxZ);
        const unionArea = (uMaxX - uMinX) * (uMaxZ - uMinZ);
        const areaB = (b.maxX - b.minX) * (b.maxZ - b.minZ);

        if (unionArea <= (areaA + areaB) * 1.12) {
          a.minX = uMinX;
          a.maxX = uMaxX;
          a.minZ = uMinZ;
          a.maxZ = uMaxZ;
          a.minY = Math.min(a.minY, b.minY);
          a.maxY = Math.max(a.maxY, b.maxY);
          rawParts.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }

  return rawParts.map((p) => ({
    width: p.maxX - p.minX,
    depth: p.maxZ - p.minZ,
    height: Math.max(0.3, p.maxY - p.minY),
    minY: p.minY,
    maxY: p.maxY,
    centerX: (p.minX + p.maxX) * 0.5,
    centerZ: (p.minZ + p.maxZ) * 0.5,
  }));
}

/**
 * Computes tight torso-height solid geometry bounds in `root`'s local coordinate space,
 * ignoring ground shadow planes, high antennas/lightbars, mirrors, and raycast proxies.
 */
export function computeTorsoBounds(
  root: THREE.Object3D,
  minY = 0.16,
  maxY = 1.75,
): TorsoBounds {
  const parts = computeMeshPartBounds(root, minY, maxY);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxH = 0.35;

  for (const part of parts) {
    const halfW = part.width * 0.5;
    const halfD = part.depth * 0.5;
    if (part.centerX - halfW < minX) minX = part.centerX - halfW;
    if (part.centerX + halfW > maxX) maxX = part.centerX + halfW;
    if (part.centerZ - halfD < minZ) minZ = part.centerZ - halfD;
    if (part.centerZ + halfD > maxZ) maxZ = part.centerZ + halfD;
    if (part.maxY > maxH) maxH = part.maxY;
  }

  return {
    width: Math.max(0.2, maxX - minX),
    depth: Math.max(0.2, maxZ - minZ),
    height: Math.max(0.35, maxH),
    centerX: (minX + maxX) * 0.5,
    centerZ: (minZ + maxZ) * 0.5,
  };
}

export function makeAabbCollider(
  cx: number,
  cz: number,
  width: number,
  depth: number,
  height: number,
): AabbCollider {
  return {
    kind: 'aabb',
    minX: cx - width * 0.5,
    maxX: cx + width * 0.5,
    minZ: cz - depth * 0.5,
    maxZ: cz + depth * 0.5,
    height,
  };
}

export function makeObbCollider(
  cx: number,
  cz: number,
  width: number,
  depth: number,
  rotY: number,
  height: number,
  localOffsetX = 0,
  localOffsetZ = 0,
): ObbCollider {
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const worldCx = cx + localOffsetX * cosY + localOffsetZ * sinY;
  const worldCz = cz - localOffsetX * sinY + localOffsetZ * cosY;
  const halfW = Math.max(0.05, width * 0.5);
  const halfD = Math.max(0.05, depth * 0.5);
  const absCos = Math.abs(cosY);
  const absSin = Math.abs(sinY);
  const extX = halfW * absCos + halfD * absSin;
  const extZ = halfW * absSin + halfD * absCos;
  return {
    kind: 'obb',
    cx: worldCx,
    cz: worldCz,
    halfW,
    halfD,
    rotY,
    cosY,
    sinY,
    boundingRadius: Math.hypot(halfW, halfD),
    minX: worldCx - extX,
    maxX: worldCx + extX,
    minZ: worldCz - extZ,
    maxZ: worldCz + extZ,
    height,
  };
}

export function makeCircleCollider(
  cx: number,
  cz: number,
  radius: number,
  height: number,
): CircleCollider {
  const r = Math.max(0.05, radius);
  return {
    kind: 'circle',
    cx,
    cz,
    radius: r,
    minX: cx - r,
    maxX: cx + r,
    minZ: cz - r,
    maxZ: cz + r,
    height,
  };
}

export function makeCapsuleCollider(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius: number,
  height: number,
): CapsuleCollider {
  const r = Math.max(0.08, radius);
  return {
    kind: 'capsule',
    ax,
    az,
    bx,
    bz,
    radius: r,
    minX: Math.min(ax, bx) - r,
    maxX: Math.max(ax, bx) + r,
    minZ: Math.min(az, bz) - r,
    maxZ: Math.max(az, bz) + r,
    height,
  };
}

/**
 * Creates a rotated 2D capsule aligned along the longer horizontal dimension (`width` vs `depth`),
 * giving vehicles and tapered roadblocks smooth rounded corners with zero corner snagging.
 */
export function makeOrientedCapsuleCollider(
  cx: number,
  cz: number,
  width: number,
  depth: number,
  rotY: number,
  height: number,
  localOffsetX = 0,
  localOffsetZ = 0,
): CapsuleCollider {
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const worldCx = cx + localOffsetX * cosY + localOffsetZ * sinY;
  const worldCz = cz - localOffsetX * sinY + localOffsetZ * cosY;

  const w = Math.max(0.2, width);
  const d = Math.max(0.2, depth);

  if (d >= w) {
    const r = w * 0.5;
    const halfSeg = Math.max(0, d * 0.5 - r);
    const dx = halfSeg * sinY;
    const dz = halfSeg * cosY;
    return makeCapsuleCollider(worldCx - dx, worldCz - dz, worldCx + dx, worldCz + dz, r, height);
  } else {
    const r = d * 0.5;
    const halfSeg = Math.max(0, w * 0.5 - r);
    const dx = halfSeg * cosY;
    const dz = -halfSeg * sinY;
    return makeCapsuleCollider(worldCx - dx, worldCz - dz, worldCx + dx, worldCz + dz, r, height);
  }
}

const GRID_HALF_EXTENT = 36;
const STATIC_CELL_SIZE = 4.0;
const STATIC_GRID_COLS = Math.ceil((GRID_HALF_EXTENT * 2) / STATIC_CELL_SIZE);
const STATIC_INV_CELL = 1 / STATIC_CELL_SIZE;

/**
 * Uniform 2D spatial hash grid for static arena colliders.
 * Rebuilt only when arena / async vehicles / props finish loading; zero allocations per query.
 */
export class StaticColliderGrid {
  private readonly cells: number[][];
  private seenStamp: Uint32Array;
  private stampCounter = 1;
  private readonly candidateBuffer: number[] = [];
  private indexedCount = 0;

  constructor() {
    const total = STATIC_GRID_COLS * STATIC_GRID_COLS;
    this.cells = new Array(total);
    for (let i = 0; i < total; i++) {
      this.cells[i] = [];
    }
    this.seenStamp = new Uint32Array(128);
  }

  public get size(): number {
    return this.indexedCount;
  }

  public rebuild(colliders: readonly Collider[]): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i].length = 0;
    }
    if (this.seenStamp.length < colliders.length) {
      this.seenStamp = new Uint32Array(Math.max(128, colliders.length * 2));
    } else {
      this.seenStamp.fill(0);
    }
    this.stampCounter = 1;
    this.indexedCount = colliders.length;

    const maxCell = STATIC_GRID_COLS - 1;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      let gx0 = Math.floor((c.minX + GRID_HALF_EXTENT) * STATIC_INV_CELL);
      let gx1 = Math.floor((c.maxX + GRID_HALF_EXTENT) * STATIC_INV_CELL);
      let gz0 = Math.floor((c.minZ + GRID_HALF_EXTENT) * STATIC_INV_CELL);
      let gz1 = Math.floor((c.maxZ + GRID_HALF_EXTENT) * STATIC_INV_CELL);

      if (gx0 < 0) gx0 = 0;
      if (gx1 > maxCell) gx1 = maxCell;
      if (gz0 < 0) gz0 = 0;
      if (gz1 > maxCell) gz1 = maxCell;

      for (let gz = gz0; gz <= gz1; gz++) {
        const rowOffset = gz * STATIC_GRID_COLS;
        for (let gx = gx0; gx <= gx1; gx++) {
          this.cells[rowOffset + gx].push(i);
        }
      }
    }
  }

  public queryCandidates(x: number, z: number, padRadius: number): readonly number[] {
    this.candidateBuffer.length = 0;
    if (this.indexedCount === 0) return this.candidateBuffer;

    let stamp = ++this.stampCounter;
    if (stamp >= 0xfffffff0) {
      this.seenStamp.fill(0);
      this.stampCounter = 1;
      stamp = 1;
    }

    const maxCell = STATIC_GRID_COLS - 1;
    let gx0 = Math.floor((x - padRadius + GRID_HALF_EXTENT) * STATIC_INV_CELL);
    let gx1 = Math.floor((x + padRadius + GRID_HALF_EXTENT) * STATIC_INV_CELL);
    let gz0 = Math.floor((z - padRadius + GRID_HALF_EXTENT) * STATIC_INV_CELL);
    let gz1 = Math.floor((z + padRadius + GRID_HALF_EXTENT) * STATIC_INV_CELL);

    if (gx0 < 0) gx0 = 0;
    if (gx1 > maxCell) gx1 = maxCell;
    if (gz0 < 0) gz0 = 0;
    if (gz1 > maxCell) gz1 = maxCell;

    for (let gz = gz0; gz <= gz1; gz++) {
      const rowOffset = gz * STATIC_GRID_COLS;
      for (let gx = gx0; gx <= gx1; gx++) {
        const bucket = this.cells[rowOffset + gx];
        for (let b = 0; b < bucket.length; b++) {
          const idx = bucket[b];
          if (this.seenStamp[idx] !== stamp) {
            this.seenStamp[idx] = stamp;
            this.candidateBuffer.push(idx);
          }
        }
      }
    }

    return this.candidateBuffer;
  }
}

function pushCircleOutOfCollider(
  pos: THREE.Vector3,
  radius: number,
  rSq: number,
  c: Collider,
  stepScale: number,
): boolean {
  const px = pos.x;
  const pz = pos.z;

  // Universal tight AABB broadphase reject across all collider shapes
  if (
    px < c.minX - radius ||
    px > c.maxX + radius ||
    pz < c.minZ - radius ||
    pz > c.maxZ + radius
  ) {
    return false;
  }

  if (c.kind === 'capsule') {
    const abx = c.bx - c.ax;
    const abz = c.bz - c.az;
    const abLenSq = abx * abx + abz * abz;
    let t = 0;
    if (abLenSq > 1e-8) {
      t = ((px - c.ax) * abx + (pz - c.az) * abz) / abLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }

    const closestX = c.ax + abx * t;
    const closestZ = c.az + abz * t;
    const dx = px - closestX;
    const dz = pz - closestZ;
    const minSep = c.radius + radius;
    const distSq = dx * dx + dz * dz;

    if (distSq < minSep * minSep) {
      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = (minSep - dist) * stepScale;
        pos.x += (dx / dist) * push;
        pos.z += (dz / dist) * push;
      } else if (abLenSq > 1e-8) {
        const invLen = 1 / Math.sqrt(abLenSq);
        pos.x += -abz * invLen * minSep * stepScale;
        pos.z += abx * invLen * minSep * stepScale;
      } else {
        pos.z += minSep * stepScale;
      }
      return true;
    }
    return false;
  }

  if (c.kind === 'obb') {
    const dx = px - c.cx;
    const dz = pz - c.cz;
    const maxRange = c.boundingRadius + radius;
    if (dx * dx + dz * dz > maxRange * maxRange) {
      return false;
    }

    // World delta -> local OBB frame (inverse of Three.js rotation.y)
    const lx = dx * c.cosY - dz * c.sinY;
    const lz = dx * c.sinY + dz * c.cosY;

    const clx = lx < -c.halfW ? -c.halfW : lx > c.halfW ? c.halfW : lx;
    const clz = lz < -c.halfD ? -c.halfD : lz > c.halfD ? c.halfD : lz;

    const dlx = lx - clx;
    const dlz = lz - clz;
    const distSq = dlx * dlx + dlz * dlz;

    if (distSq < rSq) {
      let pushLx = 0;
      let pushLz = 0;
      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = (radius - dist) * stepScale;
        pushLx = (dlx / dist) * push;
        pushLz = (dlz / dist) * push;
      } else {
        const penX = c.halfW - Math.abs(lx);
        const penZ = c.halfD - Math.abs(lz);
        if (penX < penZ) {
          pushLx = (lx >= 0 ? 1 : -1) * (penX + radius) * stepScale;
        } else {
          pushLz = (lz >= 0 ? 1 : -1) * (penZ + radius) * stepScale;
        }
      }

      pos.x += pushLx * c.cosY + pushLz * c.sinY;
      pos.z += -pushLx * c.sinY + pushLz * c.cosY;
      return true;
    }
    return false;
  }

  if (c.kind === 'circle') {
    const dx = px - c.cx;
    const dz = pz - c.cz;
    const minSep = c.radius + radius;
    const distSq = dx * dx + dz * dz;
    if (distSq < minSep * minSep) {
      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = (minSep - dist) * stepScale;
        pos.x += (dx / dist) * push;
        pos.z += (dz / dist) * push;
      } else {
        pos.z += minSep * stepScale;
      }
      return true;
    }
    return false;
  }

  const closestX = px < c.minX ? c.minX : px > c.maxX ? c.maxX : px;
  const closestZ = pz < c.minZ ? c.minZ : pz > c.maxZ ? c.maxZ : pz;
  const dx = px - closestX;
  const dz = pz - closestZ;
  const distSq = dx * dx + dz * dz;

  if (distSq < rSq) {
    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      const push = (radius - dist) * stepScale;
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    } else {
      const penLeft = Math.abs(px - c.minX);
      const penRight = Math.abs(c.maxX - px);
      const penTop = Math.abs(pz - c.minZ);
      const penBottom = Math.abs(c.maxZ - pz);
      const minPen = Math.min(penLeft, penRight, penTop, penBottom);
      if (minPen === penLeft) pos.x = c.minX - radius;
      else if (minPen === penRight) pos.x = c.maxX + radius;
      else if (minPen === penTop) pos.z = c.minZ - radius;
      else pos.z = c.maxZ + radius;
    }
    return true;
  }
  return false;
}

const PERIMETER_CURB_INSET = 0.24;

/**
 * Resolves circle vs AABB, rotated OBB, Capsule, and Circle colliders in-place with zero heap allocations.
 * Uses optional StaticColliderGrid broadphase and 4 damped relaxation passes to prevent corner wedging/jitter.
 */
export function resolveCircleColliders(
  pos: THREE.Vector3,
  radius: number,
  colliders: readonly Collider[],
  arenaHalfSize: number,
  grid?: StaticColliderGrid,
): void {
  const limit = arenaHalfSize - PERIMETER_CURB_INSET - radius;
  const rSq = radius * radius;
  const passes = 4;

  const useGrid = Boolean(grid && grid.size === colliders.length);
  const candidates = useGrid ? grid!.queryCandidates(pos.x, pos.z, radius + 0.65) : null;

  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    const stepScale = pass >= 2 ? 0.68 : 1.0;

    if (candidates) {
      for (let k = 0; k < candidates.length; k++) {
        if (pushCircleOutOfCollider(pos, radius, rSq, colliders[candidates[k]], stepScale)) {
          moved = true;
        }
      }
    } else {
      for (let i = 0; i < colliders.length; i++) {
        if (pushCircleOutOfCollider(pos, radius, rSq, colliders[i], stepScale)) {
          moved = true;
        }
      }
    }

    if (pos.x < -limit) {
      pos.x = -limit;
      moved = true;
    } else if (pos.x > limit) {
      pos.x = limit;
      moved = true;
    }
    if (pos.z < -limit) {
      pos.z = -limit;
      moved = true;
    } else if (pos.z > limit) {
      pos.z = limit;
      moved = true;
    }

    if (!moved) break;
  }
}

/**
 * Swept sub-stepping movement resolver that prevents high-velocity actors (sprinting,
 * Dire Wolf lunges, shotgun/wolf knockback) from tunneling through thin barriers or walls.
 */
export function resolveCircleMovement(
  pos: THREE.Vector3,
  prevX: number,
  prevZ: number,
  radius: number,
  colliders: readonly Collider[],
  arenaHalfSize: number,
  grid?: StaticColliderGrid,
): void {
  const dx = pos.x - prevX;
  const dz = pos.z - prevZ;
  const dist = Math.hypot(dx, dz);
  const maxStep = Math.max(0.08, radius * 0.45);

  if (dist <= maxStep) {
    resolveCircleColliders(pos, radius, colliders, arenaHalfSize, grid);
    return;
  }

  const steps = Math.min(4, Math.ceil(dist / maxStep));
  const stepDx = dx / steps;
  const stepDz = dz / steps;
  let curX = prevX;
  let curZ = prevZ;

  for (let s = 0; s < steps; s++) {
    pos.x = curX + stepDx;
    pos.z = curZ + stepDz;
    resolveCircleColliders(pos, radius, colliders, arenaHalfSize, grid);
    curX = pos.x;
    curZ = pos.z;
  }
}

function segmentIntersectsAabb2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-8) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const invDx = 1 / dx;
    let t1 = (minX - ax) * invDx;
    let t2 = (maxX - ax) * invDx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }

  if (Math.abs(dz) < 1e-8) {
    if (az < minZ || az > maxZ) return false;
  } else {
    const invDz = 1 / dz;
    let t1 = (minZ - az) * invDz;
    let t2 = (maxZ - az) * invDz;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }

  return tMax >= tMin && tMax >= 0 && tMin <= 1;
}

function pointToSegmentDistSq2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const abLenSq = abx * abx + abz * abz;
  if (abLenSq <= 1e-8) {
    const dx = px - ax;
    const dz = pz - az;
    return dx * dx + dz * dz;
  }
  let t = ((px - ax) * abx + (pz - az) * abz) / abLenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}

function segmentToSegmentDistSq2D(
  p1x: number,
  p1z: number,
  q1x: number,
  q1z: number,
  p2x: number,
  p2z: number,
  q2x: number,
  q2z: number,
): number {
  const d1x = q1x - p1x;
  const d1z = q1z - p1z;
  const d2x = q2x - p2x;
  const d2z = q2z - p2z;
  const rx = p1x - p2x;
  const rz = p1z - p2z;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;

  let s = 0;
  let t = 0;
  if (a <= 1e-8 && e <= 1e-8) {
    return rx * rx + rz * rz;
  }
  if (a <= 1e-8) {
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-8) {
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const c1x = p1x + d1x * s;
  const c1z = p1z + d1z * s;
  const c2x = p2x + d2x * t;
  const c2z = p2z + d2z * t;
  const dx = c1x - c2x;
  const dz = c1z - c2z;
  return dx * dx + dz * dz;
}

function segmentIntersectsCollider2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  c: Collider,
  pad = 0.04,
): boolean {
  const segMinX = ax < bx ? ax : bx;
  const segMaxX = ax > bx ? ax : bx;
  const segMinZ = az < bz ? az : bz;
  const segMaxZ = az > bz ? az : bz;
  if (
    segMaxX < c.minX - pad ||
    segMinX > c.maxX + pad ||
    segMaxZ < c.minZ - pad ||
    segMinZ > c.maxZ + pad
  ) {
    return false;
  }

  if (c.kind === 'aabb') {
    return segmentIntersectsAabb2D(
      ax,
      az,
      bx,
      bz,
      c.minX - pad,
      c.maxX + pad,
      c.minZ - pad,
      c.maxZ + pad,
    );
  }

  if (c.kind === 'obb') {
    const adx = ax - c.cx;
    const adz = az - c.cz;
    const bdx = bx - c.cx;
    const bdz = bz - c.cz;
    const lax = adx * c.cosY - adz * c.sinY;
    const laz = adx * c.sinY + adz * c.cosY;
    const lbx = bdx * c.cosY - bdz * c.sinY;
    const lbz = bdx * c.sinY + bdz * c.cosY;
    return segmentIntersectsAabb2D(
      lax,
      laz,
      lbx,
      lbz,
      -c.halfW - pad,
      c.halfW + pad,
      -c.halfD - pad,
      c.halfD + pad,
    );
  }

  if (c.kind === 'circle') {
    const r = c.radius + pad;
    return pointToSegmentDistSq2D(c.cx, c.cz, ax, az, bx, bz) <= r * r;
  }

  const r = c.radius + pad;
  return segmentToSegmentDistSq2D(ax, az, bx, bz, c.ax, c.az, c.bx, c.bz) <= r * r;
}

/**
 * Checks whether a 2D line of sight between two actors is unobstructed by solid barriers/vehicles.
 * Prevents zombies from attacking through solid barricades, containers, or vehicle hulls.
 */
export function hasStaticLineOfSight(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  colliders: readonly Collider[],
  grid?: StaticColliderGrid,
  minObstacleHeight = 0.85,
  pad = 0.04,
): boolean {
  const midX = (ax + bx) * 0.5;
  const midZ = (az + bz) * 0.5;
  const halfLen = Math.hypot(bx - ax, bz - az) * 0.5;
  const useGrid = Boolean(grid && grid.size === colliders.length);

  if (useGrid) {
    const candidates = grid!.queryCandidates(midX, midZ, halfLen + pad + 0.5);
    for (let k = 0; k < candidates.length; k++) {
      const c = colliders[candidates[k]];
      if (c.height < minObstacleHeight) continue;
      if (segmentIntersectsCollider2D(ax, az, bx, bz, c, pad)) {
        return false;
      }
    }
    return true;
  }

  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.height < minObstacleHeight) continue;
    if (segmentIntersectsCollider2D(ax, az, bx, bz, c, pad)) {
      return false;
    }
  }
  return true;
}

const _probeVec = new THREE.Vector3();

/**
 * Lightweight zero-allocation probe testing if a circle at (x, z) overlaps static obstacles
 * or leaves the arena perimeter. Used by zombies to pick unobstructed steering sides around barricades.
 */
export function pointBlockedByStaticColliders(
  x: number,
  z: number,
  radius: number,
  colliders: readonly Collider[],
  arenaHalfSize: number,
  grid?: StaticColliderGrid,
): boolean {
  const limit = arenaHalfSize - PERIMETER_CURB_INSET - radius;
  if (x < -limit || x > limit || z < -limit || z > limit) {
    return true;
  }
  _probeVec.set(x, 0, z);
  const rSq = radius * radius;
  const useGrid = Boolean(grid && grid.size === colliders.length);
  if (useGrid) {
    const candidates = grid!.queryCandidates(x, z, radius + 0.35);
    for (let k = 0; k < candidates.length; k++) {
      const preX = _probeVec.x;
      const preZ = _probeVec.z;
      if (pushCircleOutOfCollider(_probeVec, radius, rSq, colliders[candidates[k]], 1.0)) {
        _probeVec.set(preX, 0, preZ);
        return true;
      }
    }
    return false;
  }
  for (let i = 0; i < colliders.length; i++) {
    if (pushCircleOutOfCollider(_probeVec, radius, rSq, colliders[i], 1.0)) {
      return true;
    }
  }
  return false;
}

export interface SeparableActor {
  root: THREE.Object3D;
  isDead: boolean;
  isBoss: boolean;
}

const ACTOR_CELL_SIZE = 2.0;
const ACTOR_GRID_COLS = Math.ceil((GRID_HALF_EXTENT * 2) / ACTOR_CELL_SIZE);
const ACTOR_INV_CELL = 1 / ACTOR_CELL_SIZE;

/**
 * Zero-allocation flat typed-array spatial hash for dynamic actor-vs-actor separation.
 * Prevents zombie hordes from stacking onto identical coordinates and keeps close-quarters
 * combat legible while immediately re-clamping pushed actors against static environment colliders.
 */
export class ActorSeparationGrid {
  private readonly cellHead: Int32Array;
  private capacity = 128;
  private nextIdx: Int32Array;
  private movedFlag: Uint8Array;
  private bodyRad: Float32Array;
  private invMass: Float32Array;

  constructor() {
    this.cellHead = new Int32Array(ACTOR_GRID_COLS * ACTOR_GRID_COLS);
    this.nextIdx = new Int32Array(this.capacity);
    this.movedFlag = new Uint8Array(this.capacity);
    this.bodyRad = new Float32Array(this.capacity);
    this.invMass = new Float32Array(this.capacity);
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity) return;
    this.capacity = Math.max(count, this.capacity * 2);
    this.nextIdx = new Int32Array(this.capacity);
    this.movedFlag = new Uint8Array(this.capacity);
    this.bodyRad = new Float32Array(this.capacity);
    this.invMass = new Float32Array(this.capacity);
  }

  public resolveZombieCrowd(
    zombies: readonly SeparableActor[],
    playerPos: THREE.Vector3,
    playerRadius: number,
    wolfPos: THREE.Vector3 | null,
    wolfRadius: number,
    colliders: readonly Collider[],
    arenaHalfSize: number,
    grid: StaticColliderGrid,
    dt: number,
  ): void {
    const count = zombies.length;
    if (count === 0) return;

    this.ensureCapacity(count);
    this.cellHead.fill(-1);
    const maxCell = ACTOR_GRID_COLS - 1;

    for (let i = 0; i < count; i++) {
      this.movedFlag[i] = 0;
      const z = zombies[i];
      if (z.isDead) {
        this.nextIdx[i] = -1;
        continue;
      }

      this.bodyRad[i] = z.isBoss ? 0.60 : 0.36;
      this.invMass[i] = z.isBoss ? 0.25 : 1.0;

      const gx = Math.max(
        0,
        Math.min(maxCell, Math.floor((z.root.position.x + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );
      const gz = Math.max(
        0,
        Math.min(maxCell, Math.floor((z.root.position.z + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );
      const cell = gz * ACTOR_GRID_COLS + gx;
      this.nextIdx[i] = this.cellHead[cell];
      this.cellHead[cell] = i;
    }

    const softRate = Math.min(0.65, Math.max(0.18, dt * 15));

    // 1. Zombie-vs-Zombie soft separation
    for (let i = 0; i < count; i++) {
      const zi = zombies[i];
      if (zi.isDead) continue;

      const xi = zi.root.position.x;
      const ziPos = zi.root.position.z;
      const ri = this.bodyRad[i];
      const mi = this.invMass[i];

      const gx = Math.max(
        0,
        Math.min(maxCell, Math.floor((xi + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );
      const gz = Math.max(
        0,
        Math.min(maxCell, Math.floor((ziPos + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );

      const gxMin = gx > 0 ? gx - 1 : 0;
      const gxMax = gx < maxCell ? gx + 1 : maxCell;
      const gzMin = gz > 0 ? gz - 1 : 0;
      const gzMax = gz < maxCell ? gz + 1 : maxCell;

      for (let nz = gzMin; nz <= gzMax; nz++) {
        const rowOffset = nz * ACTOR_GRID_COLS;
        for (let nx = gxMin; nx <= gxMax; nx++) {
          let j = this.cellHead[rowOffset + nx];
          while (j !== -1) {
            if (j > i) {
              const zj = zombies[j];
              const dx = zi.root.position.x - zj.root.position.x;
              const dz = zi.root.position.z - zj.root.position.z;
              const minSep = ri + this.bodyRad[j];
              const distSq = dx * dx + dz * dz;

              if (distSq < minSep * minSep) {
                let ux: number;
                let uz: number;
                let overlap: number;
                if (distSq > 1e-6) {
                  const dist = Math.sqrt(distSq);
                  ux = dx / dist;
                  uz = dz / dist;
                  overlap = (minSep - dist) * softRate;
                } else {
                  const angle = (i * 2.39996 + j * 0.7) % (Math.PI * 2);
                  ux = Math.cos(angle);
                  uz = Math.sin(angle);
                  overlap = minSep * 0.45;
                }

                const mj = this.invMass[j];
                const invSum = 1 / (mi + mj);
                const pushI = overlap * (mi * invSum);
                const pushJ = overlap * (mj * invSum);

                zi.root.position.x += ux * pushI;
                zi.root.position.z += uz * pushI;
                zj.root.position.x -= ux * pushJ;
                zj.root.position.z -= uz * pushJ;
                this.movedFlag[i] = 1;
                this.movedFlag[j] = 1;
              }
            }
            j = this.nextIdx[j];
          }
        }
      }
    }

    // 2. Keep living zombies out of the player's camera volume (prevents inside-camera clipping)
    const pGxMin = Math.max(
      0,
      Math.min(maxCell, Math.floor((playerPos.x - 1.5 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
    );
    const pGxMax = Math.max(
      0,
      Math.min(maxCell, Math.floor((playerPos.x + 1.5 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
    );
    const pGzMin = Math.max(
      0,
      Math.min(maxCell, Math.floor((playerPos.z - 1.5 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
    );
    const pGzMax = Math.max(
      0,
      Math.min(maxCell, Math.floor((playerPos.z + 1.5 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
    );

    for (let nz = pGzMin; nz <= pGzMax; nz++) {
      const rowOffset = nz * ACTOR_GRID_COLS;
      for (let nx = pGxMin; nx <= pGxMax; nx++) {
        let j = this.cellHead[rowOffset + nx];
        while (j !== -1) {
          const zj = zombies[j];
          const dx = zj.root.position.x - playerPos.x;
          const dz = zj.root.position.z - playerPos.z;
          const minSep = playerRadius + this.bodyRad[j] * 0.85;
          const distSq = dx * dx + dz * dz;
          if (distSq < minSep * minSep) {
            if (distSq > 1e-6) {
              const dist = Math.sqrt(distSq);
              const push = minSep - dist;
              zj.root.position.x += (dx / dist) * push;
              zj.root.position.z += (dz / dist) * push;
            } else {
              zj.root.position.z += minSep;
            }
            this.movedFlag[j] = 1;
          }
          j = this.nextIdx[j];
        }
      }
    }

    // 3. Keep living zombies cleanly separated around active Dire Wolf companion
    if (wolfPos) {
      const wGxMin = Math.max(
        0,
        Math.min(maxCell, Math.floor((wolfPos.x - 1.4 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );
      const wGxMax = Math.max(
        0,
        Math.min(maxCell, Math.floor((wolfPos.x + 1.4 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );
      const wGzMin = Math.max(
        0,
        Math.min(maxCell, Math.floor((wolfPos.z - 1.4 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );
      const wGzMax = Math.max(
        0,
        Math.min(maxCell, Math.floor((wolfPos.z + 1.4 + GRID_HALF_EXTENT) * ACTOR_INV_CELL)),
      );

      for (let nz = wGzMin; nz <= wGzMax; nz++) {
        const rowOffset = nz * ACTOR_GRID_COLS;
        for (let nx = wGxMin; nx <= wGxMax; nx++) {
          let j = this.cellHead[rowOffset + nx];
          while (j !== -1) {
            const zj = zombies[j];
            const dx = zj.root.position.x - wolfPos.x;
            const dz = zj.root.position.z - wolfPos.z;
            const minSep = wolfRadius + this.bodyRad[j] * 0.72;
            const distSq = dx * dx + dz * dz;
            if (distSq < minSep * minSep) {
              if (distSq > 1e-6) {
                const dist = Math.sqrt(distSq);
                const push = (minSep - dist) * 0.65;
                zj.root.position.x += (dx / dist) * push;
                zj.root.position.z += (dz / dist) * push;
                this.movedFlag[j] = 1;
              }
            }
            j = this.nextIdx[j];
          }
        }
      }
    }

    // 4. Re-clamp only separated zombies against static walls/barriers/vehicles
    for (let i = 0; i < count; i++) {
      if (this.movedFlag[i]) {
        const z = zombies[i];
        resolveCircleColliders(
          z.root.position,
          z.isBoss ? 0.65 : 0.46,
          colliders,
          arenaHalfSize,
          grid,
        );
      }
    }
  }
}
