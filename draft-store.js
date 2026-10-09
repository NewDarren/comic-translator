// Store only the editable translation layer. Images and account settings stay out.
const DEFAULT_KEY = 'comic-reader-drafts-v1';
const MAX_PIXELS = 30_000_000;
const RECT_EPSILON = 1e-6;
const CHAPTER_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|naver-\d{1,12}-\d{1,12})$/i;
const KINDS = new Set(['automatic', 'manual', 'manual_sample']);
const TARGETS = new Set(['简体中文', '繁體中文']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

// An unexpected getter on an input object must not run while a draft is saved.
function own(value, key) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
}

function array(value) {
  if (!Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Array.prototype;
}

function string(value, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  return typeof value === 'string' && value.length <= 5000 ? value : null;
}

function rectangle(value, dimensions) {
  if (!record(value)) return null;
  const result = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = own(value, key);
    if (typeof number !== 'number' || !Number.isFinite(number) || number > MAX_PIXELS || number < 0) return null;
    if ((key === 'width' || key === 'height') && number === 0) return null;
    result[key] = number;
  }
  if (result.width * result.height > MAX_PIXELS || result.x + result.width > MAX_PIXELS || result.y + result.height > MAX_PIXELS) return null;
  if (dimensions && (result.x + result.width > dimensions.width + RECT_EPSILON || result.y + result.height > dimensions.height + RECT_EPSILON)) return null;
  return result;
}

function region(value, dimensions) {
  if (!record(value)) return null;
  const original = string(own(value, 'original'));
  const translation = string(own(value, 'translation'));
  const note = string(own(value, 'note'), '');
  const erase = rectangle(own(value, 'erase'), dimensions);
  const box = rectangle(own(value, 'box'), dimensions);
  const background = own(value, 'background');
  const foreground = own(value, 'foreground');
  const confidence = own(value, 'confidence') ?? 'low';
  const fontSize = own(value, 'font_size') ?? 0;
  const enabled = own(value, 'enabled') ?? true;
  if (original === null || translation === null || note === null || !erase || !box) return null;
  if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background) || typeof foreground !== 'string' || !/^#[0-9a-f]{6}$/i.test(foreground)) return null;
  if (!CONFIDENCE.has(confidence) || typeof enabled !== 'boolean' || typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize < 0 || fontSize > 200) return null;
  return {original, translation, erase, box, background, foreground, font_size: fontSize, enabled, confidence, note};
}

function state(value) {
  if (!record(value) || own(value, 'translated') !== true) return null;
  const regions = own(value, 'regions');
  const context = string(own(value, 'context'), '');
  const kind = own(value, 'kind') ?? 'automatic';
  const target = own(value, 'target');
  const width = own(value, 'width');
  const height = own(value, 'height');
  if (!array(regions) || regions.length > 100 || context === null || !KINDS.has(kind) || (target !== undefined && !TARGETS.has(target))) return null;
  let dimensions;
  if (width !== undefined || height !== undefined) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) return null;
    dimensions = {width, height};
  }
  const sanitized = [];
  for (let index = 0; index < regions.length; index++) {
    const valid = region(own(regions, String(index)), dimensions);
    // Dropping one malformed bubble would label an incomplete page as translated.
    if (!valid) return null;
    sanitized.push(valid);
  }
  const result = {regions: sanitized, translated: true, kind, context};
  if (dimensions) Object.assign(result, dimensions);
  if (target !== undefined) result.target = target;
  return result;
}

function pageNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 500;
}

function bytes(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  // UTF-8 size without converting text through an executable or DOM API.
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return count;
}

function quotaFailure(error) {
  try {
    return error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22 || error?.code === 1014;
  } catch { return false; }
}

/**
 * load returns a fresh Map<number, translatedState> without writing to storage.
 * save merges valid translated pages and returns savedPages for this incoming Map.
 * It also updates the chapter's eviction order.
 * Failed writes leave the previously saved value intact. clear removes one or all.
 */
export function createDraftStore(storage, {key = DEFAULT_KEY, maxChapters = 5, maxBytes = 4_000_000} = {}) {
  key = typeof key === 'string' && key.length > 0 && key.length <= 200 ? key : DEFAULT_KEY;
  maxChapters = Number.isInteger(maxChapters) && maxChapters > 0 && maxChapters <= 50 ? maxChapters : 5;
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_PIXELS ? maxBytes : 4_000_000;
  const validID = id => typeof id === 'string' && CHAPTER_ID.test(id);
  const available = () => {
    try { return !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'; }
    catch { return false; }
  };
  const serialize = chapters => JSON.stringify({version: 1, chapters});
  const unavailable = {saved: false, error: '本地译稿存储不可用，当前译稿仍保留在本次阅读中。'};

  function read() {
    if (!available()) return {chapters: [], unavailable: true};
    let raw;
    try { raw = storage.getItem(key); }
    catch { return {chapters: [], unavailable: true}; }
    if (raw === null || raw === undefined) return {chapters: []};
    if (typeof raw !== 'string' || bytes(raw) > maxBytes) return {chapters: []};
    try {
      const parsed = JSON.parse(raw);
      if (!record(parsed) || own(parsed, 'version') !== 1) return {chapters: []};
      const chapters = own(parsed, 'chapters');
      if (!Array.isArray(chapters) || chapters.length > 50) return {chapters: []};
      const sanitized = [];
      for (const item of chapters) {
        if (!record(item)) continue;
        const id = own(item, 'id');
        const pages = own(item, 'pages');
        if (!validID(id) || !Array.isArray(pages) || pages.length > 500) continue;
        const validPages = new Map();
        for (const pair of pages) {
          if (!Array.isArray(pair) || pair.length !== 2 || !pageNumber(pair[0])) continue;
          const valid = state(pair[1]);
          if (valid) validPages.set(pair[0], valid);
        }
        if (!validPages.size) continue;
        const duplicate = sanitized.findIndex(chapter => chapter.id === id);
        if (duplicate >= 0) sanitized.splice(duplicate, 1);
        sanitized.push({id, pages: [...validPages]});
      }
      return {chapters: sanitized.slice(-maxChapters)};
    } catch { return {chapters: []}; }
  }

  function load(id) {
    if (!validID(id)) return new Map();
    return new Map(read().chapters.find(chapter => chapter.id === id)?.pages ?? []);
  }

  function save(id, states) {
    if (!validID(id) || !(states instanceof Map)) return {saved: false, error: '译稿章节或页面格式无效。'};
    const stored = read();
    if (stored.unavailable) return {...unavailable};
    const incoming = new Map();
    try {
      for (const [number, value] of Map.prototype.entries.call(states)) {
        if (!pageNumber(number)) continue;
        const valid = state(value);
        if (valid) incoming.set(number, valid);
      }
    } catch { return {saved: false, error: '译稿页面格式无效。'}; }
    if (!incoming.size) return {saved: false};
    const pages = new Map(stored.chapters.find(chapter => chapter.id === id)?.pages ?? []);
    for (const [number, value] of incoming) pages.set(number, value);
    const chapters = stored.chapters.filter(chapter => chapter.id !== id);
    chapters.push({id, pages: [...pages].sort((a, b) => a[0] - b[0])});
    let serialized = serialize(chapters);
    while (chapters.length > 1 && (chapters.length > maxChapters || bytes(serialized) > maxBytes)) {
      chapters.shift();
      serialized = serialize(chapters);
    }
    if (bytes(serialized) > maxBytes) return {saved: false, error: '本章译稿超过本地存储限制，原有译稿已保留。'};
    while (true) {
      try {
        storage.setItem(key, serialized);
        return {saved: true, savedPages: [...incoming.keys()].sort((a, b) => a - b)};
      } catch (error) {
        if (!quotaFailure(error) || chapters.length <= 1) return {saved: false, error: '本地译稿保存失败，原有译稿已保留。'};
        // setItem is atomic: evict only in the next candidate, never before saving.
        chapters.shift();
        serialized = serialize(chapters);
      }
    }
  }

  function clear(id) {
    if (!available()) return;
    try {
      if (id === undefined) {
        if (typeof storage.removeItem === 'function') storage.removeItem(key);
        return;
      }
      if (!validID(id)) return;
      const stored = read();
      if (stored.unavailable) return;
      const chapters = stored.chapters.filter(chapter => chapter.id !== id);
      if (chapters.length === stored.chapters.length) return;
      if (!chapters.length && typeof storage.removeItem === 'function') storage.removeItem(key);
      else storage.setItem(key, serialize(chapters));
    } catch { /* Clearing a cache must not interrupt reading. */ }
  }

  return {load, save, clear};
}
