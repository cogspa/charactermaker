import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Loads GLB parts once, caches parsed scenes & geometric attachment metrics,
 * and assembles full characters (Legs + Body + Head) cleanly on y = 0.
 */
export class PartAssetCache {
  constructor() {
    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.cache = new Map(); // partUrl -> Promise<PartRecord>
  }

  /**
   * Load a part GLB (or return cached promise) and compute silhouette anchor metrics.
   */
  loadPart(part, onProgress) {
    if (!part?.url) return Promise.resolve(null);

    if (this.cache.has(part.url)) {
      if (onProgress) onProgress(1);
      return this.cache.get(part.url);
    }

    const promise = new Promise((resolve, reject) => {
      this.loader.load(
        part.url,
        (gltf) => {
          const root = gltf.scene || gltf.scenes[0];
          root.updateMatrixWorld(true);

          // Enable shadows and ensure materials render cleanly under studio lighting
          root.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              if (obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const mat of mats) {
                  mat.needsUpdate = true;
                }
              }
            }
          });

          const metrics = analyzePartGeometry(root);
          if (onProgress) onProgress(1);
          resolve({ part, root, metrics });
        },
        (evt) => {
          if (onProgress && evt.total > 0) {
            onProgress(Math.min(0.99, evt.loaded / evt.total));
          }
        },
        (err) => {
          this.cache.delete(part.url);
          reject(err);
        }
      );
    });

    this.cache.set(part.url, promise);
    return promise;
  }

  /**
   * Evict stale URLs no longer in the catalog so removed parts free memory.
   */
  prune(validUrls) {
    for (const [url, promise] of this.cache.entries()) {
      if (!validUrls.has(url)) {
        this.cache.delete(url);
        promise.then((record) => {
          if (!record?.root) return;
          record.root.traverse((obj) => {
            if (obj.isMesh) {
              obj.geometry?.dispose();
              const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              for (const mat of mats) {
                if (!mat) continue;
                for (const key of Object.keys(mat)) {
                  const val = mat[key];
                  if (val && val.isTexture) val.dispose();
                }
                mat.dispose();
              }
            }
          });
        }).catch(() => {});
      }
    }
  }
}

/**
 * Compute bounding box plus centerline/top/bottom attachment anchors by sampling vertices.
 * Using centerline bounds ignores dangling sleeves/hands or wide feet when computing seams!
 */
export function analyzePartGeometry(root) {
  root.updateMatrixWorld(true);
  const fullBox = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  fullBox.getSize(size);
  fullBox.getCenter(center);

  const halfW = Math.max(size.x * 0.5, 1e-4);
  const height = Math.max(size.y, 1e-4);
  const topCutoff = fullBox.max.y - height * 0.14;
  const botCutoff = fullBox.min.y + height * 0.14;

  let centerMinY = Infinity;
  let centerMaxY = -Infinity;
  let topMinZ = Infinity, topMaxZ = -Infinity, topMinX = Infinity, topMaxX = -Infinity;
  let botMinZ = Infinity, botMaxZ = -Infinity, botMinX = Infinity, botMaxX = -Infinity;

  const v = new THREE.Vector3();
  const centerSample = [];

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const pos = obj.geometry.attributes.position;
    const count = pos.count;
    const step = Math.max(1, Math.floor(count / 25000));
    const matWorld = obj.matrixWorld;

    for (let i = 0; i < count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matWorld);

      if (Math.abs(v.x - center.x) <= halfW * 0.28) {
        if (v.y < centerMinY) centerMinY = v.y;
        if (v.y > centerMaxY) centerMaxY = v.y;
        centerSample.push(v.y, v.z);
      }

      if (v.y >= topCutoff) {
        if (v.z < topMinZ) topMinZ = v.z;
        if (v.z > topMaxZ) topMaxZ = v.z;
        if (v.x < topMinX) topMinX = v.x;
        if (v.x > topMaxX) topMaxX = v.x;
      }

      if (v.y <= botCutoff) {
        if (v.z < botMinZ) botMinZ = v.z;
        if (v.z > botMaxZ) botMaxZ = v.z;
        if (v.x < botMinX) botMinX = v.x;
        if (v.x > botMaxX) botMaxX = v.x;
      }
    }
  });

  if (!Number.isFinite(centerMinY)) centerMinY = fullBox.min.y;
  if (!Number.isFinite(centerMaxY)) centerMaxY = fullBox.max.y;

  // Compute Z center specifically near the centerline bottom (e.g., sweater hem rather than forward hands)
  let cBotMinZ = Infinity;
  let cBotMaxZ = -Infinity;
  const cBotCutoff = centerMinY + Math.max(centerMaxY - centerMinY, 1e-4) * 0.18;
  for (let i = 0; i < centerSample.length; i += 2) {
    const sy = centerSample[i];
    const sz = centerSample[i + 1];
    if (sy <= cBotCutoff) {
      if (sz < cBotMinZ) cBotMinZ = sz;
      if (sz > cBotMaxZ) cBotMaxZ = sz;
    }
  }

  const topCenterZ = Number.isFinite(topMinZ) ? (topMinZ + topMaxZ) * 0.5 : center.z;
  const topCenterX = Number.isFinite(topMinX) ? (topMinX + topMaxX) * 0.5 : center.x;
  const topWidth = Number.isFinite(topMinX) ? topMaxX - topMinX : size.x;

  const botCenterZ = Number.isFinite(cBotMinZ)
    ? (cBotMinZ + cBotMaxZ) * 0.5
    : Number.isFinite(botMinZ)
      ? (botMinZ + botMaxZ) * 0.5
      : center.z;
  const botCenterX = Number.isFinite(botMinX) ? (botMinX + botMaxX) * 0.5 : center.x;

  return {
    fullBox,
    size,
    center,
    centerMinY,
    centerMaxY,
    centerHeight: Math.max(centerMaxY - centerMinY, 1e-4),
    topCenterX,
    topCenterZ,
    topWidth,
    botCenterX,
    botCenterZ,
  };
}

/**
 * Shallow-clone a Three.js hierarchy while sharing BufferGeometry & Material GPU buffers.
 */
function clonePartMesh(sourceRoot) {
  return sourceRoot.clone(true);
}

/**
 * Default per-part transform tweaks.
 */
export function normalizeTweak(raw) {
  return {
    scale: Number.isFinite(raw?.scale) ? raw.scale : 1,
    offsetY: Number.isFinite(raw?.offsetY) ? raw.offsetY : 0,
    offsetZ: Number.isFinite(raw?.offsetZ) ? raw.offsetZ : 0,
    rotYDeg: Number.isFinite(raw?.rotYDeg) ? raw.rotYDeg : 0,
  };
}

/**
 * Assemble a full 3D character Group from loaded Head, Body, and Legs records.
 * Stacks Legs on y = 0, seats Body hem onto Legs hips, and seats Head onto Body neck.
 */
export function assembleCharacter({ headRecord, bodyRecord, legsRecord, partTweaks = {}, explode = false }) {
  const character = new THREE.Group();
  character.name = 'AssembledCharacter';

  const explodeGap = explode ? 0.36 : 0;

  // Compute balanced baseline proportions across the three slots
  // Body is the reference scale (height ~1.9). Legs & Head adapt slightly if wildly mismatched.
  let legsBaseScale = 1.0;
  let bodyBaseScale = 1.0;
  let headBaseScale = 1.0;

  if (bodyRecord) {
    // Normalize body height to ~1.75 units for consistent studio framing
    bodyBaseScale = 1.75 / Math.max(bodyRecord.metrics.size.y, 0.25);
  }

  if (legsRecord && bodyRecord) {
    // Keep legs proportional to body torso height (target legs height ~52%–70% of body centerline height)
    const bodyCoreH = bodyRecord.metrics.centerHeight * bodyBaseScale;
    const rawLegsH = legsRecord.metrics.size.y;
    const targetLegsH = Math.min(Math.max(rawLegsH, bodyCoreH * 0.58), bodyCoreH * 0.92);
    legsBaseScale = targetLegsH / Math.max(rawLegsH, 0.2);
  } else if (legsRecord) {
    legsBaseScale = 1.0 / Math.max(legsRecord.metrics.size.y, 0.25);
  }

  if (headRecord && bodyRecord) {
    // Stylized vinyl-toy head: cap max head width relative to body width so it sits nicely
    const bodyW = bodyRecord.metrics.size.x * bodyBaseScale;
    const rawHeadW = headRecord.metrics.size.x;
    const targetHeadW = Math.min(rawHeadW, bodyW * 0.88);
    headBaseScale = targetHeadW / Math.max(rawHeadW, 0.2);
  } else if (headRecord) {
    headBaseScale = 1.1 / Math.max(headRecord.metrics.size.y, 0.25);
  }

  let cursorY = 0;
  let anchorZ = 0;

  // 1. LEGS (grounded at y = 0)
  if (legsRecord) {
    const tweak = normalizeTweak(partTweaks[legsRecord.part.id]);
    const scale = legsBaseScale * tweak.scale;
    const m = legsRecord.metrics;

    const slotGroup = new THREE.Group();
    slotGroup.name = 'Slot_Legs';
    const mesh = clonePartMesh(legsRecord.root);
    // Center X on geometry center, ground min.y at 0, center Z around hip Z
    mesh.position.set(-m.center.x, -m.fullBox.min.y, -m.topCenterZ);
    slotGroup.add(mesh);

    slotGroup.scale.setScalar(scale);
    slotGroup.rotation.y = THREE.MathUtils.degToRad(tweak.rotYDeg);
    slotGroup.position.set(0, tweak.offsetY, tweak.offsetZ);
    character.add(slotGroup);

    const legsTopY = (m.centerMaxY - m.fullBox.min.y) * scale + tweak.offsetY;
    cursorY = legsTopY;
    anchorZ = tweak.offsetZ;
  }

  // 2. BODY (torso hem seated cleanly onto legs top)
  if (bodyRecord) {
    const tweak = normalizeTweak(partTweaks[bodyRecord.part.id]);
    const scale = bodyBaseScale * tweak.scale;
    const m = bodyRecord.metrics;

    const slotGroup = new THREE.Group();
    slotGroup.name = 'Slot_Body';
    const mesh = clonePartMesh(bodyRecord.root);
    // Align body centerline bottom (sweater hem) to y = 0 in local space
    mesh.position.set(-m.center.x, -m.centerMinY, -m.botCenterZ);
    slotGroup.add(mesh);

    // Overlap slightly into the top of the legs so there's zero floating seam
    const hipOverlap = legsRecord ? Math.min(0.1, m.centerHeight * scale * 0.08) : 0;
    const bodyBaseY = legsRecord ? cursorY - hipOverlap + explodeGap : 0;

    slotGroup.scale.setScalar(scale);
    slotGroup.rotation.y = THREE.MathUtils.degToRad(tweak.rotYDeg);
    slotGroup.position.set(0, bodyBaseY + tweak.offsetY, anchorZ + tweak.offsetZ);
    character.add(slotGroup);

    // Advance cursor to the top of the body's neck
    cursorY = bodyBaseY + (m.centerMaxY - m.centerMinY) * scale + tweak.offsetY;
    anchorZ = anchorZ + (m.topCenterZ - m.botCenterZ) * scale + tweak.offsetZ;
  }

  // 3. HEAD (seated cleanly onto body neck)
  if (headRecord) {
    const tweak = normalizeTweak(partTweaks[headRecord.part.id]);
    const scale = headBaseScale * tweak.scale;
    const m = headRecord.metrics;

    const slotGroup = new THREE.Group();
    slotGroup.name = 'Slot_Head';
    const mesh = clonePartMesh(headRecord.root);
    mesh.position.set(-m.center.x, -m.centerMinY, -m.botCenterZ);
    slotGroup.add(mesh);

    // Seat head slightly over the neck collar for a clean seamless join
    const neckOverlap = bodyRecord ? Math.min(0.14, m.centerHeight * scale * 0.14) : 0;
    const headBaseY = (bodyRecord || legsRecord) ? cursorY - neckOverlap + explodeGap : 0;

    slotGroup.scale.setScalar(scale);
    slotGroup.rotation.y = THREE.MathUtils.degToRad(tweak.rotYDeg);
    slotGroup.position.set(0, headBaseY + tweak.offsetY, anchorZ + tweak.offsetZ);
    character.add(slotGroup);
  }

  // Re-ground entire character so lowest point touches y = 0 cleanly
  character.updateMatrixWorld(true);
  const assembledBox = new THREE.Box3().setFromObject(character);
  if (!assembledBox.isEmpty()) {
    const center = new THREE.Vector3();
    assembledBox.getCenter(center);
    character.position.x -= center.x;
    character.position.z -= center.z;
    character.position.y -= assembledBox.min.y;
    character.updateMatrixWorld(true);
  }

  return character;
}

/**
 * Prepare a single standalone part Group centered on X/Z and grounded cleanly on y = 0
 * for solo inspection in the 3D Studio and Individual Parts Gallery.
 */
export function prepareSinglePart(partRecord, partTweaks = {}) {
  const group = new THREE.Group();
  group.name = `Solo_${partRecord.part.slot}`;

  const tweak = normalizeTweak(partTweaks[partRecord.part.id]);
  const m = partRecord.metrics;

  const maxDim = Math.max(m.size.x, m.size.y, m.size.z, 0.25);
  const normScale = 1.9 / maxDim;

  const slotGroup = new THREE.Group();
  const mesh = clonePartMesh(partRecord.root);
  mesh.position.set(-m.center.x, -m.fullBox.min.y, -m.center.z);
  slotGroup.add(mesh);

  slotGroup.scale.setScalar(normScale);
  slotGroup.rotation.y = THREE.MathUtils.degToRad(tweak.rotYDeg);
  group.add(slotGroup);

  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    group.position.x -= center.x;
    group.position.z -= center.z;
    group.position.y -= box.min.y;
    group.updateMatrixWorld(true);
  }

  return group;
}
