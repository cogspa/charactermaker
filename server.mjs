import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const CONFIG_FILE = path.join(__dirname, 'gallery-config.json');

const SLOT_DIRS = {
  heads: path.join(__dirname, 'Heads'),
  bodies: path.join(__dirname, 'Bodies'),
  legs: path.join(__dirname, 'Legs'),
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
};

function prettifyName(filename) {
  let base = filename.replace(/\.(glb|gltf)$/i, '');
  // Strip common Meshy AI prefixes/suffixes and timestamps while keeping descriptive words
  base = base
    .replace(/^Meshy_AI_/i, '')
    .replace(/_(image-to-3d|text-to-3d)(-texture)?$/i, '')
    .replace(/_\d{8,14}$/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) {
    base = filename.replace(/\.(glb|gltf)$/i, '');
  }
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

async function ensureSlotDirs() {
  for (const dir of Object.values(SLOT_DIRS)) {
    await fsp.mkdir(dir, { recursive: true });
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

async function writeConfig(next) {
  const safe = {
    partTweaks: next?.partTweaks && typeof next.partTweaks === 'object' ? next.partTweaks : {},
    favorites: Array.isArray(next?.favorites) ? next.favorites : [],
  };
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  return safe;
}

async function scanSlot(slotKey) {
  const dir = SLOT_DIRS[slotKey];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;
    if (!/\.(glb|gltf)$/i.test(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(fullPath);
      if (stat.size === 0) continue;
      items.push({
        id: `${slotKey}/${entry.name}`,
        slot: slotKey,
        filename: entry.name,
        name: prettifyName(entry.name),
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        url: `/models/${slotKey}/${encodeURIComponent(entry.name)}?v=${Math.round(stat.mtimeMs)}`,
      });
    } catch {
      // Ignore transient files being copied
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return items;
}

async function getCatalogPayload() {
  await ensureSlotDirs();
  const [heads, bodies, legs, config] = await Promise.all([
    scanSlot('heads'),
    scanSlot('bodies'),
    scanSlot('legs'),
    readConfig(),
  ]);
  return {
    parts: { heads, bodies, legs },
    config,
    updatedAt: Date.now(),
  };
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveFile(req, res, filePath, { cacheControl = 'no-cache' } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
    const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
    const start = startStr ? Number.parseInt(startStr, 10) : 0;
    const end = endStr ? Math.min(Number.parseInt(endStr, 10), stat.size - 1) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ETag: etag,
      'Cache-Control': cacheControl,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

// SSE clients for live folder watching
const sseClients = new Set();
let broadcastTimer = null;

function scheduleCatalogBroadcast() {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    if (sseClients.size === 0) return;
    try {
      const payload = await getCatalogPayload();
      const message = `event: catalog\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of sseClients) {
        client.write(message);
      }
    } catch (err) {
      console.error('Failed to broadcast catalog update:', err);
    }
  }, 450);
}

function startWatchers() {
  for (const [slotKey, dir] of Object.entries(SLOT_DIRS)) {
    try {
      fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename && (filename.startsWith('.') || filename.endsWith('.tmp'))) return;
        scheduleCatalogBroadcast();
      });
    } catch (err) {
      console.warn(`Unable to watch ${slotKey} directory (${dir}):`, err.message);
    }
  }
}

function resolveSafePath(baseDir, relativeSegments) {
  const target = path.resolve(baseDir, ...relativeSegments);
  const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (target !== baseDir && !target.startsWith(normalizedBase)) {
    return null;
  }
  return target;
}

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB

async function handleUpload(req, res, urlObj) {
  const slotParam = (urlObj.searchParams.get('slot') || '').toLowerCase();
  const rawName = urlObj.searchParams.get('filename') || '';

  if (!Object.hasOwn(SLOT_DIRS, slotParam)) {
    sendJson(res, 400, { error: 'Invalid slot. Expected heads, bodies, or legs.' });
    return;
  }

  const baseName = path.basename(rawName).replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  if (!baseName || !/\.glb$/i.test(baseName)) {
    sendJson(res, 400, { error: 'Only .glb files are supported for upload.' });
    return;
  }

  const targetDir = SLOT_DIRS[slotParam];
  await fsp.mkdir(targetDir, { recursive: true });

  // Avoid silently overwriting an existing file by suffixing if needed
  let finalName = baseName;
  let finalPath = path.join(targetDir, finalName);
  let counter = 2;
  while (fs.existsSync(finalPath)) {
    finalName = baseName.replace(/\.glb$/i, `_${counter}.glb`);
    finalPath = path.join(targetDir, finalName);
    counter += 1;
  }

  const tempPath = `${finalPath}.${Date.now()}.tmp`;
  const writeStream = fs.createWriteStream(tempPath);

  let totalBytes = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      writeStream.destroy();
      fsp.unlink(tempPath).catch(() => {});
      sendJson(res, 413, { error: 'File exceeds 250 MB upload limit.' });
      req.destroy();
    }
  });

  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    if (aborted) return;
    try {
      // Quick magic header validation ('glTF' = 0x46546C67)
      const fh = await fsp.open(tempPath, 'r');
      const header = Buffer.alloc(4);
      await fh.read(header, 0, 4, 0);
      await fh.close();
      if (header.toString('ascii') !== 'glTF') {
        await fsp.unlink(tempPath).catch(() => {});
        sendJson(res, 400, { error: 'File is not a valid binary GLB (missing glTF header).' });
        return;
      }

      await fsp.rename(tempPath, finalPath);
      const catalog = await getCatalogPayload();
      scheduleCatalogBroadcast();
      sendJson(res, 201, {
        uploaded: {
          slot: slotParam,
          filename: finalName,
          id: `${slotParam}/${finalName}`,
          name: prettifyName(finalName),
        },
        catalog,
      });
    } catch (err) {
      await fsp.unlink(tempPath).catch(() => {});
      sendJson(res, 500, { error: err.message || 'Failed to save uploaded GLB.' });
    }
  });

  writeStream.on('error', async (err) => {
    if (aborted) return;
    aborted = true;
    await fsp.unlink(tempPath).catch(() => {});
    sendJson(res, 500, { error: err.message || 'Upload stream failed.' });
  });
}

async function handleConfigSave(req, res) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      sendJson(res, 413, { error: 'Config payload too large.' });
      return;
    }
    body += chunk.toString('utf8');
  }
  try {
    const parsed = JSON.parse(body);
    const saved = await writeConfig(parsed);
    sendJson(res, 200, { config: saved });
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  try {
    if (req.method === 'GET' && pathname === '/api/parts') {
      const payload = await getCatalogPayload();
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);

      const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
      }, 25000);

      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      await handleUpload(req, res, urlObj);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      await handleConfigSave(req, res);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/models/')) {
      const rest = pathname.slice('/models/'.length).split('/').filter(Boolean);
      if (rest.length !== 2) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const [slotKey, filename] = rest;
      if (!Object.hasOwn(SLOT_DIRS, slotKey)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const safeFile = resolveSafePath(SLOT_DIRS[slotKey], [path.basename(filename)]);
      if (!safeFile) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      await serveFile(req, res, safeFile, { cacheControl: 'public, max-age=3600' });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/vendor/three/')) {
      const rel = pathname.slice('/vendor/three/'.length);
      const safeFile = resolveSafePath(THREE_DIR, rel.split('/').filter(Boolean));
      if (!safeFile) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      await serveFile(req, res, safeFile, { cacheControl: 'public, max-age=86400' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const safeFile = resolveSafePath(PUBLIC_DIR, relPath.split('/').filter(Boolean));
      if (!safeFile) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      await serveFile(req, res, safeFile, { cacheControl: 'no-cache' });
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal server error');
    }
  }
});

await ensureSlotDirs();
startWatchers();

server.listen(PORT, HOST, () => {
  console.log(`Character Parts Gallery running at http://${HOST}:${PORT}`);
  console.log(`Watching folders: Heads/, Bodies/, Legs/`);
});
