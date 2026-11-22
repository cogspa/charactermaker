import { PartAssetCache, assembleCharacter, prepareSinglePart, normalizeTweak } from './assembler.js';
import { StudioViewer, CardRenderer } from './viewer.js';

const PAGE_SIZE = 24;

const SLOT_LABELS = {
  heads: 'Head',
  bodies: 'Body',
  legs: 'Legs',
};

const SLOT_TO_FIT = {
  heads: 'head',
  bodies: 'body',
  legs: 'legs',
};

const state = {
  parts: { heads: [], bodies: [], legs: [] },
  config: { partTweaks: {}, favorites: [] },
  combos: [],
  filteredCombos: [],
  visibleCount: PAGE_SIZE,
  activeComboId: null,
  activeSelection: { headId: null, bodyId: null, legsId: null },
  viewMode: 'character', // 'character' | 'part'
  soloPartId: null,
  partCategoryFilter: 'all', // 'all' | 'heads' | 'bodies' | 'legs'
  fitSlot: 'head',
  explode: false,
  autoRotate: true,
  backdrop: 'studio',
  filters: { headId: '', bodyId: '', legsId: '', favoritesOnly: false },
  thumbnails: new Map(), // comboId -> { url, signature }
  partThumbnails: new Map(), // partId -> { url, signature }
};

const assetCache = new PartAssetCache();
const studioViewer = new StudioViewer(document.getElementById('studioCanvas'));
const cardRenderer = new CardRenderer(460);

const els = {
  watchStatus: document.getElementById('watchStatus'),
  watchLabel: document.getElementById('watchLabel'),
  catalogSummary: document.getElementById('catalogSummary'),
  stageFrame: document.getElementById('stageFrame'),
  stageLoading: document.getElementById('stageLoading'),
  loadingTitle: document.getElementById('loadingTitle'),
  loadingProgress: document.getElementById('loadingProgress'),
  loadingDetail: document.getElementById('loadingDetail'),
  activeCharacterTitle: document.getElementById('activeCharacterTitle'),
  activeComboMeta: document.getElementById('activeComboMeta'),
  backToFullBtn: document.getElementById('backToFullBtn'),
  favoriteActiveBtn: document.getElementById('favoriteActiveBtn'),
  snapshotBtn: document.getElementById('snapshotBtn'),
  autoRotateBtn: document.getElementById('autoRotateBtn'),
  explodeBtn: document.getElementById('explodeBtn'),
  resetViewBtn: document.getElementById('resetViewBtn'),
  prevCharBtn: document.getElementById('prevCharBtn'),
  shuffleCharBtn: document.getElementById('shuffleCharBtn'),
  nextCharBtn: document.getElementById('nextCharBtn'),
  selectHead: document.getElementById('selectHead'),
  selectBody: document.getElementById('selectBody'),
  selectLegs: document.getElementById('selectLegs'),
  countHeads: document.getElementById('countHeads'),
  countBodies: document.getElementById('countBodies'),
  countLegs: document.getElementById('countLegs'),
  fitPartName: document.getElementById('fitPartName'),
  tweakScale: document.getElementById('tweakScale'),
  tweakScaleOut: document.getElementById('tweakScaleOut'),
  tweakOffsetY: document.getElementById('tweakOffsetY'),
  tweakOffsetYOut: document.getElementById('tweakOffsetYOut'),
  tweakOffsetZ: document.getElementById('tweakOffsetZ'),
  tweakOffsetZOut: document.getElementById('tweakOffsetZOut'),
  tweakRotY: document.getElementById('tweakRotY'),
  tweakRotYOut: document.getElementById('tweakRotYOut'),
  resetFitBtn: document.getElementById('resetFitBtn'),
  saveFitBtn: document.getElementById('saveFitBtn'),
  filterHead: document.getElementById('filterHead'),
  filterBody: document.getElementById('filterBody'),
  filterLegs: document.getElementById('filterLegs'),
  filterFavorites: document.getElementById('filterFavorites'),
  characterGrid: document.getElementById('characterGrid'),
  paginationRow: document.getElementById('paginationRow'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  gallerySubtitle: document.getElementById('gallerySubtitle'),
  partsGrid: document.getElementById('partsGrid'),
  partsSubtitle: document.getElementById('partsSubtitle'),
  tabCountAll: document.getElementById('tabCountAll'),
  tabCountHeads: document.getElementById('tabCountHeads'),
  tabCountBodies: document.getElementById('tabCountBodies'),
  tabCountLegs: document.getElementById('tabCountLegs'),
  refreshPartsBtn: document.getElementById('refreshPartsBtn'),
  openUploadBtn: document.getElementById('openUploadBtn'),
  uploadDialog: document.getElementById('uploadDialog'),
  uploadForm: document.getElementById('uploadForm'),
  closeUploadBtn: document.getElementById('closeUploadBtn'),
  cancelUploadBtn: document.getElementById('cancelUploadBtn'),
  submitUploadBtn: document.getElementById('submitUploadBtn'),
  dropzone: document.getElementById('dropzone'),
  dropzoneLabel: document.getElementById('dropzoneLabel'),
  dropzoneMeta: document.getElementById('dropzoneMeta'),
  glbFileInput: document.getElementById('glbFileInput'),
  uploadProgressWrap: document.getElementById('uploadProgressWrap'),
  uploadProgress: document.getElementById('uploadProgress'),
  uploadStatusText: document.getElementById('uploadStatusText'),
  uploadError: document.getElementById('uploadError'),
  toastRegion: document.getElementById('toastRegion'),
};

function showToast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  els.toastRegion.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4500);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function getAllParts() {
  return [...state.parts.heads, ...state.parts.bodies, ...state.parts.legs];
}

function findPartById(id) {
  if (!id) return null;
  return getAllParts().find((p) => p.id === id) || null;
}

function findPart(slotKey, id) {
  return state.parts[slotKey].find((p) => p.id === id) || null;
}

function comboIdOf(head, body, legs) {
  return `${head?.id || '_'}|${body?.id || '_'}|${legs?.id || '_'}`;
}

function comboTitleOf(head, body, legs) {
  const short = (p) =>
    p.name
      .replace(/\b(Head|Torso|Body|Legs)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || p.name;

  const pieces = [head, body, legs].filter(Boolean).map(short);
  if (pieces.length === 0) return 'Empty Character';
  if (pieces.length === 1) return pieces[0];
  if (pieces.length === 2) return `${pieces[0]} · ${pieces[1]}`;
  return `${pieces[0]} in ${pieces[1]}`;
}

function tweakSignatureForCombo(combo) {
  const parts = [combo.head, combo.body, combo.legs].filter(Boolean);
  return parts
    .map((p) => {
      const t = normalizeTweak(state.config.partTweaks[p.id]);
      return `${p.url}:${t.scale}:${t.offsetY}:${t.offsetZ}:${t.rotYDeg}`;
    })
    .join('|');
}

function tweakSignatureForPart(part) {
  const t = normalizeTweak(state.config.partTweaks[part.id]);
  return `${part.url}:${t.rotYDeg}`;
}

function buildCombos() {
  const heads = state.parts.heads.length ? state.parts.heads : [null];
  const bodies = state.parts.bodies.length ? state.parts.bodies : [null];
  const legsList = state.parts.legs.length ? state.parts.legs : [null];

  if (!state.parts.heads.length && !state.parts.bodies.length && !state.parts.legs.length) {
    state.combos = [];
    return;
  }

  const list = [];
  for (const head of heads) {
    for (const body of bodies) {
      for (const legs of legsList) {
        const id = comboIdOf(head, body, legs);
        list.push({
          id,
          title: comboTitleOf(head, body, legs),
          head,
          body,
          legs,
        });
      }
    }
  }
  state.combos = list;
}

function isFavorite(comboId) {
  return state.config.favorites.includes(comboId);
}

function isPartEquipped(part) {
  if (part.slot === 'heads') return state.activeSelection.headId === part.id;
  if (part.slot === 'bodies') return state.activeSelection.bodyId === part.id;
  if (part.slot === 'legs') return state.activeSelection.legsId === part.id;
  return false;
}

function applyFilters() {
  const { headId, bodyId, legsId, favoritesOnly } = state.filters;
  state.filteredCombos = state.combos.filter((c) => {
    if (headId && c.head?.id !== headId) return false;
    if (bodyId && c.body?.id !== bodyId) return false;
    if (legsId && c.legs?.id !== legsId) return false;
    if (favoritesOnly && !isFavorite(c.id)) return false;
    return true;
  });
}

function syncSummaryBar() {
  const h = state.parts.heads.length;
  const b = state.parts.bodies.length;
  const l = state.parts.legs.length;
  const totalParts = h + b + l;
  const totalCombos = state.combos.length;
  const plural = (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;
  els.catalogSummary.textContent = `${plural(h, 'Head')} · ${plural(b, 'Body', 'Bodies')} · ${plural(l, 'Legs', 'Legs')} → ${plural(totalCombos, 'Full Character')}`;

  els.countHeads.textContent = String(h);
  els.countBodies.textContent = String(b);
  els.countLegs.textContent = String(l);

  els.tabCountAll.textContent = String(totalParts);
  els.tabCountHeads.textContent = String(h);
  els.tabCountBodies.textContent = String(b);
  els.tabCountLegs.textContent = String(l);
}

function populateSelect(selectEl, items, selectedId, placeholderLabel) {
  selectEl.textContent = '';
  if (placeholderLabel !== undefined) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholderLabel;
    selectEl.appendChild(opt);
  }
  if (items.length === 0 && placeholderLabel === undefined) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No .glb files yet';
    selectEl.appendChild(opt);
    selectEl.disabled = true;
    return;
  }
  selectEl.disabled = false;
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name;
    selectEl.appendChild(opt);
  }
  if (selectedId && items.some((i) => i.id === selectedId)) {
    selectEl.value = selectedId;
  }
}

function renderSlotControls() {
  populateSelect(els.selectHead, state.parts.heads, state.activeSelection.headId);
  populateSelect(els.selectBody, state.parts.bodies, state.activeSelection.bodyId);
  populateSelect(els.selectLegs, state.parts.legs, state.activeSelection.legsId);

  populateSelect(els.filterHead, state.parts.heads, state.filters.headId, 'All Heads');
  populateSelect(els.filterBody, state.parts.bodies, state.filters.bodyId, 'All Bodies');
  populateSelect(els.filterLegs, state.parts.legs, state.filters.legsId, 'All Legs');
}

function getActiveCombo() {
  const head = findPart('heads', state.activeSelection.headId);
  const body = findPart('bodies', state.activeSelection.bodyId);
  const legs = findPart('legs', state.activeSelection.legsId);
  const id = comboIdOf(head, body, legs);
  return state.combos.find((c) => c.id === id) || { id, title: comboTitleOf(head, body, legs), head, body, legs };
}

function updateRangeProgressFallback(input) {
  if (CSS.supports('accent-color', '#000')) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const val = Number(input.value || 0);
  const pct = ((val - min) / Math.max(max - min, 1e-6)) * 100;
  input.style.setProperty('--progress', `${pct}%`);
}

function getFitTargetPart() {
  if (state.viewMode === 'part') {
    const solo = findPartById(state.soloPartId);
    if (solo && SLOT_TO_FIT[solo.slot] === state.fitSlot) {
      return solo;
    }
  }
  const combo = getActiveCombo();
  return combo[state.fitSlot];
}

function syncFitInspector() {
  const part = getFitTargetPart();
  document.querySelectorAll('.fit-slot-tabs .tab-btn').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.fitSlot === state.fitSlot));
  });

  if (!part) {
    els.fitPartName.textContent = `No ${state.fitSlot} selected`;
    [els.tweakScale, els.tweakOffsetY, els.tweakOffsetZ, els.tweakRotY].forEach((i) => (i.disabled = true));
    return;
  }

  [els.tweakScale, els.tweakOffsetY, els.tweakOffsetZ, els.tweakRotY].forEach((i) => (i.disabled = false));
  els.fitPartName.textContent = part.name;
  const tweak = normalizeTweak(state.config.partTweaks[part.id]);

  els.tweakScale.value = String(tweak.scale);
  els.tweakScaleOut.textContent = `${tweak.scale.toFixed(2)}×`;

  els.tweakOffsetY.value = String(tweak.offsetY);
  els.tweakOffsetYOut.textContent = `${tweak.offsetY >= 0 ? '+' : ''}${tweak.offsetY.toFixed(2)}`;

  els.tweakOffsetZ.value = String(tweak.offsetZ);
  els.tweakOffsetZOut.textContent = `${tweak.offsetZ >= 0 ? '+' : ''}${tweak.offsetZ.toFixed(2)}`;

  els.tweakRotY.value = String(tweak.rotYDeg);
  els.tweakRotYOut.textContent = `${Math.round(tweak.rotYDeg)}°`;

  [els.tweakScale, els.tweakOffsetY, els.tweakOffsetZ, els.tweakRotY].forEach(updateRangeProgressFallback);
}

async function loadComboRecords(combo, onProgress) {
  const entries = [
    ['head', combo.head],
    ['body', combo.body],
    ['legs', combo.legs],
  ].filter(([, p]) => Boolean(p));

  const progressMap = new Map(entries.map(([k]) => [k, 0]));
  const report = () => {
    if (!onProgress || entries.length === 0) return;
    let sum = 0;
    for (const v of progressMap.values()) sum += v;
    onProgress(sum / entries.length, progressMap);
  };

  const results = await Promise.all(
    entries.map(async ([slot, part]) => {
      const rec = await assetCache.loadPart(part, (p) => {
        progressMap.set(slot, p);
        report();
      });
      return [slot, rec];
    })
  );

  const out = { headRecord: null, bodyRecord: null, legsRecord: null };
  for (const [slot, rec] of results) {
    out[`${slot}Record`] = rec;
  }
  return out;
}

let activeRenderToken = 0;

function highlightActiveCards() {
  document.querySelectorAll('#characterGrid .card').forEach((card) => {
    card.classList.toggle(
      'is-active',
      state.viewMode === 'character' && card.dataset.comboId === state.activeComboId
    );
  });
  document.querySelectorAll('#partsGrid .card').forEach((card) => {
    card.classList.toggle(
      'is-active',
      state.viewMode === 'part' && card.dataset.partId === state.soloPartId
    );
  });
}

async function renderSoloInStudio(part, { reframe = true } = {}) {
  state.viewMode = 'part';
  state.soloPartId = part.id;
  state.fitSlot = SLOT_TO_FIT[part.slot] || 'head';

  els.activeCharacterTitle.textContent = `${SLOT_LABELS[part.slot] || 'Part'}: ${part.name} (Solo)`;
  els.backToFullBtn.hidden = false;
  els.favoriteActiveBtn.hidden = true;
  els.explodeBtn.disabled = true;

  syncFitInspector();
  highlightActiveCards();

  const token = ++activeRenderToken;
  const needsDownload = !assetCache.cache.has(part.url);
  if (needsDownload) {
    els.stageLoading.hidden = false;
    els.loadingTitle.textContent = `Loading ${part.name}…`;
    els.loadingProgress.value = 5;
    els.loadingDetail.textContent = 'Streaming GLB mesh & PBR textures';
  }

  try {
    const record = await assetCache.loadPart(part, (pct) => {
      if (token !== activeRenderToken) return;
      const percent = Math.round(pct * 100);
      els.loadingProgress.value = percent;
      els.loadingDetail.textContent =
        percent < 99 ? `Downloading & parsing 3D part (${percent}%)…` : 'Preparing turntable…';
    });
    if (token !== activeRenderToken) return;

    const soloGroup = prepareSinglePart(record, state.config.partTweaks);
    studioViewer.setCharacter(soloGroup, { reframe });
    els.stageLoading.hidden = true;
    queueThumbnailRender();
  } catch (err) {
    if (token !== activeRenderToken) return;
    els.loadingTitle.textContent = 'Failed to load 3D part';
    els.loadingDetail.textContent = err?.message || 'Check that the .glb file is valid.';
    console.error(err);
  }
}

async function activateSelection({ reframe = true } = {}) {
  state.viewMode = 'character';
  state.soloPartId = null;

  const combo = getActiveCombo();
  state.activeComboId = combo.id;

  els.activeCharacterTitle.textContent = combo.title;
  els.backToFullBtn.hidden = true;
  els.favoriteActiveBtn.hidden = false;
  els.explodeBtn.disabled = false;

  const comboIndex = state.combos.findIndex((c) => c.id === combo.id);
  els.activeComboMeta.textContent =
    state.combos.length > 0
      ? `Character ${comboIndex >= 0 ? comboIndex + 1 : 1} of ${state.combos.length} assembled`
      : 'Add .glb files to Heads/, Bodies/, or Legs/ to assemble characters';

  const fav = isFavorite(combo.id);
  els.favoriteActiveBtn.setAttribute('aria-pressed', String(fav));
  els.favoriteActiveBtn.innerHTML = `<span aria-hidden="true">${fav ? '★' : '☆'}</span> ${fav ? 'Favorited' : 'Favorite'}`;

  renderSlotControls();
  renderPartsGallery();
  syncFitInspector();
  highlightActiveCards();

  const token = ++activeRenderToken;

  if (!combo.head && !combo.body && !combo.legs) {
    els.stageLoading.hidden = true;
    studioViewer.setCharacter(null);
    return;
  }

  const needsDownload = [combo.head, combo.body, combo.legs]
    .filter(Boolean)
    .some((p) => !assetCache.cache.has(p.url));

  if (needsDownload) {
    els.stageLoading.hidden = false;
    els.loadingTitle.textContent = `Loading ${combo.title}…`;
    els.loadingProgress.value = 5;
    els.loadingDetail.textContent = 'Streaming GLB meshes & PBR textures';
  }

  try {
    const records = await loadComboRecords(combo, (pct) => {
      if (token !== activeRenderToken) return;
      const percent = Math.round(pct * 100);
      els.loadingProgress.value = percent;
      els.loadingDetail.textContent =
        percent < 99 ? `Downloading & parsing 3D parts (${percent}%)…` : 'Assembling full character…';
    });

    if (token !== activeRenderToken) return;

    const character = assembleCharacter({
      ...records,
      partTweaks: state.config.partTweaks,
      explode: state.explode,
    });
    studioViewer.setCharacter(character, { reframe });
    els.stageLoading.hidden = true;

    queueThumbnailRender();
  } catch (err) {
    if (token !== activeRenderToken) return;
    els.loadingTitle.textContent = 'Failed to load 3D model';
    els.loadingDetail.textContent = err?.message || 'Check that the .glb file is valid.';
    console.error(err);
  }
}

// Queue offscreen rendering of BOTH Full Character thumbnails AND Individual Part thumbnails
let thumbQueueRunning = false;
let thumbQueuePending = false;

async function queueThumbnailRender() {
  if (thumbQueueRunning) {
    thumbQueuePending = true;
    return;
  }
  thumbQueueRunning = true;

  try {
    do {
      thumbQueuePending = false;

      // 1. Full character cards
      const charCards = Array.from(document.querySelectorAll('#characterGrid .card'));
      for (const card of charCards) {
        const comboId = card.dataset.comboId;
        const combo = state.combos.find((c) => c.id === comboId);
        if (!combo) continue;

        const sig = tweakSignatureForCombo(combo);
        const cached = state.thumbnails.get(comboId);
        const img = card.querySelector('.media > img');
        if (!img) continue;

        if (cached && cached.signature === sig) {
          if (img.src !== cached.url) img.src = cached.url;
          continue;
        }

        const records = await loadComboRecords(combo);
        const character = assembleCharacter({
          ...records,
          partTweaks: state.config.partTweaks,
          explode: false,
        });
        const dataUrl = cardRenderer.renderCharacter(character, 0.42, 0.14);
        state.thumbnails.set(comboId, { url: dataUrl, signature: sig });
        img.src = dataUrl;
        await new Promise((r) => setTimeout(r, 16));
      }

      // 2. Individual part cards
      const partCards = Array.from(document.querySelectorAll('#partsGrid .card'));
      for (const card of partCards) {
        const partId = card.dataset.partId;
        const part = findPartById(partId);
        if (!part) continue;

        const sig = tweakSignatureForPart(part);
        const cached = state.partThumbnails.get(partId);
        const img = card.querySelector('.media > img');
        if (!img) continue;

        if (cached && cached.signature === sig) {
          if (img.src !== cached.url) img.src = cached.url;
          continue;
        }

        const record = await assetCache.loadPart(part);
        const soloGroup = prepareSinglePart(record, state.config.partTweaks);
        const dataUrl = cardRenderer.renderCharacter(soloGroup, 0.42, 0.14);
        state.partThumbnails.set(partId, { url: dataUrl, signature: sig });
        img.src = dataUrl;
        await new Promise((r) => setTimeout(r, 16));
      }
    } while (thumbQueuePending);
  } catch (err) {
    console.error('Thumbnail render error:', err);
  } finally {
    thumbQueueRunning = false;
  }
}

/**
 * Enable direct 360° drag-to-rotate on any gallery card (Full Character OR Individual Part).
 */
function attachCardDragRotate(mediaEl, imgEl, buildGroupAsync) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let azimuth = 0.42;
  let elevation = 0.14;
  let dragGroup = null;
  let rafPending = false;

  const paintFrame = () => {
    rafPending = false;
    if (!dragGroup) return;
    imgEl.src = cardRenderer.renderCharacter(dragGroup, azimuth, elevation);
  };

  mediaEl.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    mediaEl.setPointerCapture(e.pointerId);

    try {
      const built = await buildGroupAsync();
      if (!dragging) return;
      dragGroup = built;
    } catch {
      dragging = false;
    }
  });

  mediaEl.addEventListener('pointermove', (e) => {
    if (!dragging || !dragGroup) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    startX = e.clientX;
    startY = e.clientY;

    azimuth -= dx * 0.014;
    elevation = Math.max(-0.45, Math.min(0.95, elevation + dy * 0.009));

    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(paintFrame);
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    dragGroup = null;
    if (mediaEl.hasPointerCapture(e.pointerId)) {
      mediaEl.releasePointerCapture(e.pointerId);
    }
  };

  mediaEl.addEventListener('pointerup', endDrag);
  mediaEl.addEventListener('pointercancel', endDrag);
}

function renderGallery() {
  applyFilters();
  els.characterGrid.textContent = '';

  const totalFiltered = state.filteredCombos.length;
  els.gallerySubtitle.textContent =
    totalFiltered === state.combos.length
      ? `${totalFiltered} full ${totalFiltered === 1 ? 'character' : 'characters'} assembled. Drag directly on any card to rotate 360°, or open in the 3D Studio.`
      : `Showing ${totalFiltered} of ${state.combos.length} assembled full characters.`;

  if (totalFiltered === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent =
      state.combos.length === 0
        ? 'No 3D character parts found yet. Drop .glb files into Heads/, Bodies/, or Legs/ or click "+ Add Part (.glb)".'
        : 'No full characters match the current filters.';
    els.characterGrid.appendChild(empty);
    els.paginationRow.hidden = true;
    return;
  }

  const slice = state.filteredCombos.slice(0, state.visibleCount);

  for (const combo of slice) {
    const article = document.createElement('article');
    article.className = 'card';
    article.dataset.comboId = combo.id;
    if (state.viewMode === 'character' && combo.id === state.activeComboId) {
      article.classList.add('is-active');
    }

    // Region 1: Media
    const media = document.createElement('div');
    media.className = 'media';

    const img = document.createElement('img');
    img.alt = `3D full character: ${combo.title}`;
    const cachedThumb = state.thumbnails.get(combo.id);
    if (cachedThumb && cachedThumb.signature === tweakSignatureForCombo(combo)) {
      img.src = cachedThumb.url;
    }

    const hint = document.createElement('span');
    hint.className = 'card-spin-hint';
    hint.textContent = '↻ Drag to rotate';

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'card-fav-btn';
    const fav = isFavorite(combo.id);
    favBtn.setAttribute('aria-pressed', String(fav));
    favBtn.setAttribute('aria-label', fav ? `Remove ${combo.title} from favorites` : `Favorite ${combo.title}`);
    favBtn.textContent = fav ? '★' : '☆';
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(combo.id);
    });

    media.append(img, hint, favBtn);
    attachCardDragRotate(media, img, async () => {
      const records = await loadComboRecords(combo);
      return assembleCharacter({
        ...records,
        partTweaks: state.config.partTweaks,
        explode: false,
      });
    });

    // Region 2: Header
    const heading = document.createElement('h3');
    heading.textContent = combo.title;

    // Region 3: Content
    const partsUl = document.createElement('ul');
    partsUl.className = 'card-parts';
    const slotEntries = [
      ['Head', combo.head],
      ['Body', combo.body],
      ['Legs', combo.legs],
    ];
    for (const [label, part] of slotEntries) {
      const li = document.createElement('li');
      li.className = 'part-chip';
      const strong = document.createElement('strong');
      strong.textContent = `${label}: `;
      li.append(strong, document.createTextNode(part ? part.name : 'None'));
      partsUl.appendChild(li);
    }

    // Region 4: Footer
    const footer = document.createElement('footer');
    const inspectBtn = document.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'btn btn-primary';
    inspectBtn.textContent = 'View in 3D Studio';
    inspectBtn.addEventListener('click', () => {
      state.activeSelection = {
        headId: combo.head?.id || null,
        bodyId: combo.body?.id || null,
        legsId: combo.legs?.id || null,
      };
      activateSelection({ reframe: true });
      els.stageFrame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    footer.appendChild(inspectBtn);

    article.append(media, heading, partsUl, footer);
    els.characterGrid.appendChild(article);
  }

  els.paginationRow.hidden = state.visibleCount >= totalFiltered;
  queueThumbnailRender();
}

function renderPartsGallery() {
  els.partsGrid.textContent = '';

  const parts =
    state.partCategoryFilter === 'all'
      ? getAllParts()
      : state.parts[state.partCategoryFilter] || [];

  document.querySelectorAll('.part-cat-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.partCat === state.partCategoryFilter));
  });

  if (parts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const folderName =
      state.partCategoryFilter === 'all'
        ? 'Heads/, Bodies/, or Legs/'
        : `${state.partCategoryFilter[0].toUpperCase() + state.partCategoryFilter.slice(1)}/`;
    empty.textContent = `No .glb files found in ${folderName} yet. Drop files into the folder or click "+ Add Part (.glb)".`;
    els.partsGrid.appendChild(empty);
    return;
  }

  for (const part of parts) {
    const article = document.createElement('article');
    article.className = 'card';
    article.dataset.partId = part.id;
    if (state.viewMode === 'part' && state.soloPartId === part.id) {
      article.classList.add('is-active');
    }

    // Region 1: Media (live rotatable standalone part!)
    const media = document.createElement('div');
    media.className = 'media';

    const img = document.createElement('img');
    img.alt = `Standalone 3D ${SLOT_LABELS[part.slot] || 'part'}: ${part.name}`;
    const cached = state.partThumbnails.get(part.id);
    if (cached && cached.signature === tweakSignatureForPart(part)) {
      img.src = cached.url;
    }

    const slotBadge = document.createElement('span');
    slotBadge.className = 'card-slot-badge';
    slotBadge.dataset.slot = part.slot;
    slotBadge.textContent = SLOT_LABELS[part.slot] || part.slot;

    const hint = document.createElement('span');
    hint.className = 'card-spin-hint';
    hint.textContent = '↻ Drag to rotate';

    media.append(img, slotBadge, hint);

    if (isPartEquipped(part)) {
      const equippedBadge = document.createElement('span');
      equippedBadge.className = 'card-equipped-pill';
      equippedBadge.textContent = 'Equipped';
      media.appendChild(equippedBadge);
    }

    attachCardDragRotate(media, img, async () => {
      const record = await assetCache.loadPart(part);
      return prepareSinglePart(record, state.config.partTweaks);
    });

    // Region 2: Header
    const heading = document.createElement('h3');
    heading.textContent = part.name;

    // Region 3: Content (metadata chips)
    const metaUl = document.createElement('ul');
    metaUl.className = 'card-parts';

    const folderChip = document.createElement('li');
    folderChip.className = 'part-chip';
    folderChip.innerHTML = `<strong>Folder: </strong>${part.slot[0].toUpperCase() + part.slot.slice(1)}/`;

    const sizeChip = document.createElement('li');
    sizeChip.className = 'part-chip';
    sizeChip.innerHTML = `<strong>Size: </strong>${formatBytes(part.size)}`;

    metaUl.append(folderChip, sizeChip);

    // Region 4: Footer
    const footer = document.createElement('footer');

    const soloBtn = document.createElement('button');
    soloBtn.type = 'button';
    soloBtn.className = 'btn btn-primary btn-compact';
    soloBtn.textContent = 'Inspect Solo';
    soloBtn.addEventListener('click', () => {
      renderSoloInStudio(part, { reframe: true });
      els.stageFrame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    const equipBtn = document.createElement('button');
    equipBtn.type = 'button';
    equipBtn.className = 'btn btn-subtle btn-compact';
    equipBtn.textContent = isPartEquipped(part) ? 'Equipped' : 'Equip';
    equipBtn.addEventListener('click', () => {
      if (part.slot === 'heads') state.activeSelection.headId = part.id;
      if (part.slot === 'bodies') state.activeSelection.bodyId = part.id;
      if (part.slot === 'legs') state.activeSelection.legsId = part.id;
      activateSelection({ reframe: true });
      els.stageFrame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    footer.append(soloBtn, equipBtn);

    article.append(media, heading, metaUl, footer);
    els.partsGrid.appendChild(article);
  }

  queueThumbnailRender();
}

async function saveConfigToServer() {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.config),
    });
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

async function toggleFavorite(comboId) {
  const idx = state.config.favorites.indexOf(comboId);
  if (idx >= 0) {
    state.config.favorites.splice(idx, 1);
  } else {
    state.config.favorites.push(comboId);
  }
  await saveConfigToServer();
  renderGallery();
  if (comboId === state.activeComboId && state.viewMode === 'character') {
    const fav = isFavorite(comboId);
    els.favoriteActiveBtn.setAttribute('aria-pressed', String(fav));
    els.favoriteActiveBtn.innerHTML = `<span aria-hidden="true">${fav ? '★' : '☆'}</span> ${fav ? 'Favorited' : 'Favorite'}`;
  }
}

function applyCatalog(payload, { isLiveUpdate = false, focusPart = null } = {}) {
  const prevCount = state.combos.length;
  const prevIds = new Set(getAllParts().map((p) => p.id));

  state.parts = payload.parts || { heads: [], bodies: [], legs: [] };
  if (payload.config) {
    state.config = payload.config;
  }

  const validUrls = new Set(getAllParts().map((p) => p.url));
  assetCache.prune(validUrls);

  buildCombos();
  syncSummaryBar();

  if (focusPart) {
    if (focusPart.slot === 'heads') state.activeSelection.headId = focusPart.id;
    if (focusPart.slot === 'bodies') state.activeSelection.bodyId = focusPart.id;
    if (focusPart.slot === 'legs') state.activeSelection.legsId = focusPart.id;
  }

  if (!findPart('heads', state.activeSelection.headId)) {
    state.activeSelection.headId = state.parts.heads[0]?.id || null;
  }
  if (!findPart('bodies', state.activeSelection.bodyId)) {
    state.activeSelection.bodyId = state.parts.bodies[0]?.id || null;
  }
  if (!findPart('legs', state.activeSelection.legsId)) {
    state.activeSelection.legsId = state.parts.legs[0]?.id || null;
  }

  if (isLiveUpdate) {
    const allNewParts = getAllParts().filter((p) => !prevIds.has(p.id));
    if (allNewParts.length > 0) {
      const firstNew = allNewParts[0];
      if (firstNew.slot === 'heads') state.activeSelection.headId = firstNew.id;
      if (firstNew.slot === 'bodies') state.activeSelection.bodyId = firstNew.id;
      if (firstNew.slot === 'legs') state.activeSelection.legsId = firstNew.id;
      const diff = state.combos.length - prevCount;
      showToast(
        diff > 0
          ? `Added "${firstNew.name}" — ${diff} new full ${diff === 1 ? 'character' : 'characters'} assembled!`
          : `Added "${firstNew.name}" to gallery.`
      );
    } else if (state.combos.length !== prevCount) {
      showToast(`Folder updated — ${state.combos.length} full characters available.`);
    }
  }

  renderSlotControls();
  renderGallery();
  renderPartsGallery();

  if (state.viewMode === 'part') {
    const solo = findPartById(state.soloPartId);
    if (solo) {
      renderSoloInStudio(solo, { reframe: true });
      return;
    }
  }
  activateSelection({ reframe: true });
}

async function fetchCatalog() {
  const res = await fetch('/api/parts', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function connectLiveEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    els.watchStatus.classList.remove('disconnected');
    els.watchLabel.textContent = 'Live folder sync';
  });
  es.addEventListener('catalog', (evt) => {
    try {
      const payload = JSON.parse(evt.data);
      applyCatalog(payload, { isLiveUpdate: true });
    } catch (err) {
      console.error('Bad catalog event:', err);
    }
  });
  es.addEventListener('error', () => {
    els.watchStatus.classList.add('disconnected');
    els.watchLabel.textContent = 'Reconnecting…';
  });
}

function bindEvents() {
  els.backToFullBtn.addEventListener('click', () => {
    activateSelection({ reframe: true });
  });

  els.autoRotateBtn.addEventListener('click', () => {
    state.autoRotate = !state.autoRotate;
    els.autoRotateBtn.setAttribute('aria-pressed', String(state.autoRotate));
    studioViewer.setAutoRotate(state.autoRotate);
  });

  els.explodeBtn.addEventListener('click', () => {
    if (state.viewMode !== 'character') return;
    state.explode = !state.explode;
    els.explodeBtn.setAttribute('aria-pressed', String(state.explode));
    activateSelection({ reframe: false });
  });

  els.resetViewBtn.addEventListener('click', () => {
    studioViewer.setCameraPreset('three-quarter');
  });

  document.querySelectorAll('.angle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      studioViewer.setCameraPreset(btn.dataset.angle);
    });
  });

  document.querySelectorAll('.backdrop-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.backdrop = btn.dataset.backdrop;
      els.stageFrame.dataset.backdrop = state.backdrop;
      studioViewer.setBackdrop(state.backdrop);
      document.querySelectorAll('.backdrop-btn').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.backdrop === state.backdrop));
      });
    });
  });

  els.favoriteActiveBtn.addEventListener('click', () => {
    if (state.activeComboId) toggleFavorite(state.activeComboId);
  });

  els.snapshotBtn.addEventListener('click', () => {
    const label =
      state.viewMode === 'part'
        ? findPartById(state.soloPartId)?.name || 'part'
        : getActiveCombo().title;
    const link = document.createElement('a');
    link.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    link.href = studioViewer.capturePngDataUrl();
    link.click();
  });

  const stepCharacter = (delta) => {
    if (state.combos.length <= 1) return;
    const idx = Math.max(0, state.combos.findIndex((c) => c.id === state.activeComboId));
    const next = state.combos[(idx + delta + state.combos.length) % state.combos.length];
    state.activeSelection = {
      headId: next.head?.id || null,
      bodyId: next.body?.id || null,
      legsId: next.legs?.id || null,
    };
    activateSelection({ reframe: true });
  };

  els.prevCharBtn.addEventListener('click', () => stepCharacter(-1));
  els.nextCharBtn.addEventListener('click', () => stepCharacter(1));
  els.shuffleCharBtn.addEventListener('click', () => {
    if (state.combos.length === 0) return;
    const pick = state.combos[Math.floor(Math.random() * state.combos.length)];
    state.activeSelection = {
      headId: pick.head?.id || null,
      bodyId: pick.body?.id || null,
      legsId: pick.legs?.id || null,
    };
    activateSelection({ reframe: true });
  });

  els.selectHead.addEventListener('change', () => {
    state.activeSelection.headId = els.selectHead.value || null;
    activateSelection({ reframe: true });
  });
  els.selectBody.addEventListener('change', () => {
    state.activeSelection.bodyId = els.selectBody.value || null;
    activateSelection({ reframe: true });
  });
  els.selectLegs.addEventListener('change', () => {
    state.activeSelection.legsId = els.selectLegs.value || null;
    activateSelection({ reframe: true });
  });

  // Fit inspector tabs & sliders
  document.querySelectorAll('.fit-slot-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.fitSlot = btn.dataset.fitSlot;
      syncFitInspector();
    });
  });

  const onTweakInput = () => {
    const part = getFitTargetPart();
    if (!part) return;

    const next = {
      scale: Number(els.tweakScale.value),
      offsetY: Number(els.tweakOffsetY.value),
      offsetZ: Number(els.tweakOffsetZ.value),
      rotYDeg: Number(els.tweakRotY.value),
    };
    state.config.partTweaks[part.id] = next;
    syncFitInspector();

    if (state.viewMode === 'part') {
      const solo = findPartById(state.soloPartId);
      if (solo) renderSoloInStudio(solo, { reframe: false });
    } else {
      activateSelection({ reframe: false });
    }
  };

  [els.tweakScale, els.tweakOffsetY, els.tweakOffsetZ, els.tweakRotY].forEach((input) => {
    input.addEventListener('input', onTweakInput);
  });

  els.resetFitBtn.addEventListener('click', async () => {
    const part = getFitTargetPart();
    if (!part) return;
    delete state.config.partTweaks[part.id];
    syncFitInspector();
    await saveConfigToServer();
    if (state.viewMode === 'part') {
      const solo = findPartById(state.soloPartId);
      if (solo) await renderSoloInStudio(solo, { reframe: false });
    } else {
      await activateSelection({ reframe: false });
    }
    queueThumbnailRender();
    showToast(`Reset alignment for ${part.name}.`);
  });

  els.saveFitBtn.addEventListener('click', async () => {
    await saveConfigToServer();
    queueThumbnailRender();
    showToast('Saved part alignment settings.');
  });

  // Gallery filters
  const onFilterChange = () => {
    state.filters.headId = els.filterHead.value;
    state.filters.bodyId = els.filterBody.value;
    state.filters.legsId = els.filterLegs.value;
    state.filters.favoritesOnly = els.filterFavorites.checked;
    state.visibleCount = PAGE_SIZE;
    renderGallery();
  };

  [els.filterHead, els.filterBody, els.filterLegs, els.filterFavorites].forEach((el) => {
    el.addEventListener('change', onFilterChange);
  });

  els.loadMoreBtn.addEventListener('click', () => {
    state.visibleCount += PAGE_SIZE;
    renderGallery();
  });

  // Individual Parts category tabs
  document.querySelectorAll('.part-cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.partCategoryFilter = btn.dataset.partCat || 'all';
      renderPartsGallery();
    });
  });

  els.refreshPartsBtn.addEventListener('click', async () => {
    const data = await fetchCatalog();
    applyCatalog(data);
    showToast('Rescanned Heads/, Bodies/, and Legs/ folders.');
  });

  // Upload dialog
  let selectedFile = null;

  const resetUploadDialog = (slot = 'heads') => {
    selectedFile = null;
    els.glbFileInput.value = '';
    els.dropzoneLabel.innerHTML = 'Drop a <code>.glb</code> file here, or click to browse';
    els.dropzoneMeta.textContent = 'Binary glTF (.glb) up to 250 MB';
    els.submitUploadBtn.disabled = true;
    els.uploadProgressWrap.hidden = true;
    els.uploadProgress.value = 0;
    els.uploadError.hidden = true;
    els.uploadError.textContent = '';

    const radio = els.uploadForm.querySelector(`input[name="uploadSlot"][value="${slot}"]`);
    if (radio) radio.checked = true;
  };

  const setPickedFile = (file) => {
    els.uploadError.hidden = true;
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      els.uploadError.textContent = 'Please choose a binary .glb 3D model file.';
      els.uploadError.hidden = false;
      return;
    }
    selectedFile = file;
    els.dropzoneLabel.textContent = file.name;
    els.dropzoneMeta.textContent = `${formatBytes(file.size)} — ready to add`;
    els.submitUploadBtn.disabled = false;
  };

  els.openUploadBtn.addEventListener('click', () => {
    resetUploadDialog('heads');
    els.uploadDialog.showModal();
  });

  els.closeUploadBtn.addEventListener('click', () => els.uploadDialog.close());
  els.cancelUploadBtn.addEventListener('click', () => els.uploadDialog.close());

  els.glbFileInput.addEventListener('change', () => {
    setPickedFile(els.glbFileInput.files?.[0] || null);
  });

  els.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('is-dragover');
  });
  els.dropzone.addEventListener('dragleave', () => {
    els.dropzone.classList.remove('is-dragover');
  });
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('is-dragover');
    setPickedFile(e.dataTransfer?.files?.[0] || null);
  });

  els.uploadForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    const slot = els.uploadForm.querySelector('input[name="uploadSlot"]:checked')?.value || 'heads';
    const url = `/api/upload?slot=${encodeURIComponent(slot)}&filename=${encodeURIComponent(selectedFile.name)}`;

    els.submitUploadBtn.disabled = true;
    els.uploadError.hidden = true;
    els.uploadProgressWrap.hidden = false;
    els.uploadStatusText.textContent = `Saving to ${slot[0].toUpperCase() + slot.slice(1)}/…`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.round((evt.loaded / evt.total) * 100);
        els.uploadProgress.value = pct;
        els.uploadStatusText.textContent = `Uploading ${selectedFile.name} (${pct}%)…`;
      }
    });

    xhr.addEventListener('load', () => {
      try {
        const json = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) {
          els.uploadDialog.close();
          if (json.catalog) {
            applyCatalog(json.catalog, { focusPart: json.uploaded });
          }
          showToast(`Added "${json.uploaded?.name || selectedFile.name}" and assembled full characters!`);
        } else {
          els.uploadError.textContent = json.error || `Upload failed (${xhr.status}).`;
          els.uploadError.hidden = false;
          els.submitUploadBtn.disabled = false;
        }
      } catch {
        els.uploadError.textContent = `Upload failed (${xhr.status}).`;
        els.uploadError.hidden = false;
        els.submitUploadBtn.disabled = false;
      }
    });

    xhr.addEventListener('error', () => {
      els.uploadError.textContent = 'Network error while uploading file.';
      els.uploadError.hidden = false;
      els.submitUploadBtn.disabled = false;
    });

    xhr.send(selectedFile);
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if (e.key === 'r' || e.key === 'R') {
      studioViewer.setCameraPreset('three-quarter');
    } else if (e.key === ' ') {
      e.preventDefault();
      els.autoRotateBtn.click();
    } else if (e.key === 'ArrowRight') {
      stepCharacter(1);
    } else if (e.key === 'ArrowLeft') {
      stepCharacter(-1);
    }
  });
}

async function init() {
  bindEvents();
  connectLiveEvents();
  try {
    const data = await fetchCatalog();
    applyCatalog(data);
  } catch (err) {
    els.loadingTitle.textContent = 'Could not reach gallery server';
    els.loadingDetail.textContent = err?.message || 'Make sure `npm start` is running.';
    console.error(err);
  }
}

init();
