import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, simplify, quantize, meshopt, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.join(__dirname, 'dist');
const CACHE_DIR = path.join(__dirname, '.cache', 'glb-opt');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const CONFIG_FILE = path.join(__dirname, 'gallery-config.json');

const SLOT_DIRS = {
  heads: path.join(__dirname, 'Heads'),
  bodies: path.join(__dirname, 'Bodies'),
  legs: path.join(__dirname, 'Legs'),
};

const THREE_FILES = [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/environments/RoomEnvironment.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/libs/meshopt_decoder.module.js',
];

const TARGET_TRIANGLES = 55000;
const MAX_TEXTURE_SIZE = 1024;

function prettifyName(filename) {
  let base = filename.replace(/\.(glb|gltf)$/i, '');
  base = base
    .replace(/^Meshy_AI_/i, '')
    .replace(/_(image-to-3d|text-to-3d)(-texture)?$/i, '')
    .replace(/_\d{8,14}$/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = filename.replace(/\.(glb|gltf)$/i, '');
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

function countTriangles(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) {
        tris += idx.getCount() / 3;
      } else {
        const pos = prim.getAttribute('POSITION');
        if (pos) tris += pos.getCount() / 3;
      }
    }
  }
  return Math.round(tris);
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      partTweaks: parsed.partTweaks && typeof parsed.partTweaks === 'object' ? parsed.partTweaks : {},
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    };
  } catch {
    return { partTweaks: {}, favorites: [] };
  }
}

async function optimizeGlb(io, srcPath, destPath, cacheKey) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const cachedPath = path.join(CACHE_DIR, `${cacheKey}.glb`);
  if (fs.existsSync(cachedPath)) {
    await fsp.copyFile(cachedPath, destPath);
    const stat = await fsp.stat(destPath);
    return { outSize: stat.size, fromCache: true };
  }

  const doc = await io.read(srcPath);
  const trisBefore = countTriangles(doc);
  const ratio = trisBefore > TARGET_TRIANGLES ? Math.max(0.015, TARGET_TRIANGLES / trisBefore) : 1.0;

  const transforms = [dedup()];
  if (ratio < 0.98) {
    transforms.push(
      weld({ tolerance: 0.0001 }),
      simplify({
        simplifier: MeshoptSimplifier,
        ratio,
        error: 0.0025,
        lockBorder: false,
      })
    );
  }

  transforms.push(
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE],
      quality: 82,
    }),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' })
  );

  await doc.transform(...transforms);
  await io.write(cachedPath, doc);
  await fsp.copyFile(cachedPath, destPath);

  const stat = await fsp.stat(destPath);
  const trisAfter = countTriangles(doc);
  return { outSize: stat.size, trisBefore, trisAfter, fromCache: false };
}

async function main() {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });

  console.log('Cleaning dist/...');
  await fsp.rm(DIST_DIR, { recursive: true, force: true });
  await fsp.mkdir(DIST_DIR, { recursive: true });

  console.log('Copying public/ and Three.js vendor modules...');
  await copyDir(PUBLIC_DIR, DIST_DIR);

  for (const rel of THREE_FILES) {
    const src = path.join(THREE_DIR, rel);
    const dest = path.join(DIST_DIR, 'vendor', 'three', rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }

  const parts = { heads: [], bodies: [], legs: [] };
  let totalRaw = 0;
  let totalOpt = 0;

  for (const [slotKey, dir] of Object.entries(SLOT_DIRS)) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const glbFiles = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && /\.glb$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => prettifyName(a).localeCompare(prettifyName(b), undefined, { numeric: true }));

    for (const filename of glbFiles) {
      const srcPath = path.join(dir, filename);
      const stat = await fsp.stat(srcPath);
      if (stat.size === 0) continue;

      const destPath = path.join(DIST_DIR, 'models', slotKey, filename);
      const cacheKey = `${slotKey}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}_${stat.size}_${Math.round(stat.mtimeMs)}`;
      const t0 = Date.now();
      const result = await optimizeGlb(io, srcPath, destPath, cacheKey);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);

      totalRaw += stat.size;
      totalOpt += result.outSize;

      const rawMB = (stat.size / 1048576).toFixed(1);
      const optMB = (result.outSize / 1048576).toFixed(2);
      const note = result.fromCache
        ? 'cached'
        : `${result.trisBefore?.toLocaleString()} -> ${result.trisAfter?.toLocaleString()} tris, ${dt}s`;
      console.log(`  [${slotKey}] ${filename}: ${rawMB} MB -> ${optMB} MB (${note})`);

      parts[slotKey].push({
        id: `${slotKey}/${filename}`,
        slot: slotKey,
        filename,
        name: prettifyName(filename),
        size: result.outSize,
        originalSize: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        url: `/models/${slotKey}/${encodeURIComponent(filename)}?v=${Math.round(stat.mtimeMs)}`,
      });
    }
  }

  const config = await readConfig();
  const manifest = {
    parts,
    config,
    hosted: true,
    updatedAt: Date.now(),
  };

  await fsp.writeFile(
    path.join(DIST_DIR, 'parts-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );

  console.log(
    `\nBuild complete! Optimized ${(totalRaw / 1048576).toFixed(1)} MB -> ${(totalOpt / 1048576).toFixed(1)} MB in dist/`
  );
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
