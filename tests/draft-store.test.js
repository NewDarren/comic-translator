import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftStore} from '../draft-store.js';

const KEY = 'comic-reader-drafts-v1';
const CHAPTER = 'd423f62c-f81d-4c68-a72e-0a9b20f1f5d0';
const OTHER = 'af079f99-28ff-41d9-9031-cd316aaf6ec7';
const NAVER = 'naver-701535-70';
function memoryStorage({limit = Infinity} = {}) {
  const values = new Map();
  return {
    values, limit, writes: 0, removes: 0,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      this.writes++;
      if (new TextEncoder().encode(value).length > this.limit) {
        const error = new Error('Simulated browser quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(key, value);
    },
    removeItem(key) { this.removes++; values.delete(key); }
  };
}
function draft(overrides = {}) {
  return {
    translated: true, kind: 'automatic', context: '朋友之间的问候', width: 600, height: 900, target: '简体中文',
    regions: [{
      id: 1, original: 'Hello!', translation: '你好！',
      erase: {x: 30, y: 40, width: 90, height: 70},
      box: {x: 25, y: 35, width: 100, height: 80},
      background: '#ffffff', foreground: '#202020', font_size: 0,
      enabled: true, confidence: 'high', note: ''
    }], ...overrides
  };
}
function savePage(store, chapter = CHAPTER, value = draft(), page = 1) {
  return store.save(chapter, new Map([[page, value]]));
}

test('reload restores translated pages and edits without retaining image or account state', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  const value = draft();
  value.api_key = 'secret-key'; value.model = 'secret-model'; value.glossary = 'secret-glossary';
  value.error = 'secret-error'; value.image = {src: 'secret-image'}; value.image.loop = value.image;
  value.regions[0].api_key = 'secret-region-key';
  assert.deepEqual(store.save(CHAPTER, new Map([[1, value], [2, {translated: false, regions: []}]])), {saved: true, savedPages: [1]});
  assert.ok(!/secret-|"image"|"id":1|"error"|"model"|"glossary"/.test(storage.getItem(KEY)));
  const loaded = createDraftStore(storage).load(CHAPTER);
  assert.deepEqual([...loaded.keys()], [1]);
  assert.equal(loaded.get(1).regions[0].translation, '你好！');
  assert.equal(loaded.get(1).width, 600);
  assert.equal(loaded.get(1).target, '简体中文');
  loaded.get(1).regions[0].translation = '早安！';
  assert.equal(store.load(CHAPTER).get(1).regions[0].translation, '你好！');
  assert.equal(store.save(CHAPTER, loaded).saved, true);
  assert.equal(createDraftStore(storage).load(CHAPTER).get(1).regions[0].translation, '早安！');
  assert.equal(savePage(store, CHAPTER, draft(), 3).saved, true);
  assert.deepEqual([...store.load(CHAPTER).keys()], [1, 3]);
});

test('white-listing does not invoke input getters or accept objects with custom prototypes', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  let calls = 0;
  const value = draft();
  Object.defineProperty(value, 'api_key', {get() { calls++; throw Error('must not run'); }});
  Object.defineProperty(value, 'image', {get() { calls++; throw Error('must not run'); }});
  Object.defineProperty(value, 'toJSON', {get() { calls++; throw Error('must not run'); }});
  assert.equal(savePage(store, CHAPTER, value).saved, true);
  assert.equal(calls, 0);
  const unsafe = Object.assign(Object.create({translation: 'inherited'}), draft());
  assert.equal(savePage(store, OTHER, unsafe).saved, false);
  assert.equal(store.load(OTHER).size, 0);
  const accessor = draft();
  Object.defineProperty(accessor, 'context', {get() { calls++; return 'unsafe'; }});
  assert.equal(savePage(store, OTHER, accessor).saved, true);
  assert.equal(store.load(OTHER).get(1).context, '');
  assert.equal(calls, 0);
  const customIteration = draft();
  customIteration.regions[Symbol.iterator] = () => { calls++; throw Error('must not run'); };
  const map = new Map([[2, customIteration]]);
  map[Symbol.iterator] = () => { calls++; throw Error('must not run'); };
  assert.equal(store.save(OTHER, map).saved, true);
  assert.equal(calls, 0);
  const regionAccessor = draft();
  Object.defineProperty(regionAccessor.regions, '0', {get() { calls++; return draft().regions[0]; }});
  assert.equal(savePage(store, NAVER, regionAccessor).saved, false);
  assert.equal(calls, 0);
});

test('malformed JSON and schemas are safely ignored, including prototype pollution attempts', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  for (const raw of ['{', 'null', '[]', '{"version":2,"chapters":[]}', '{"version":1,"chapters":{}}']) {
    storage.values.set(KEY, raw);
    assert.equal(store.load(CHAPTER).size, 0);
  }
  const value = JSON.parse(JSON.stringify(draft()));
  Object.defineProperty(value, '__proto__', {value: {polluted: true}, enumerable: true});
  storage.values.set(KEY, JSON.stringify({version: 1, chapters: [{id: '__proto__', pages: [[1, value]]}, {id: CHAPTER, pages: [[1, value]]}]}));
  assert.equal(store.load('__proto__').size, 0);
  assert.equal(store.load(CHAPTER).size, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(savePage(store, '__proto__').saved, false);
  assert.equal(savePage(store, 'naver-701535-70-extra').saved, false);
  assert.equal(savePage(store, NAVER).saved, true);
  assert.equal(store.load(NAVER).size, 1);
});

test('a malformed region rejects its entire page while numeric pages and empty valid translations survive', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  const invalid = [
    region => {region.erase.x = -1;},
    region => {region.box.width = 0;},
    region => {region.erase.x = '30';},
    region => {region.box.height = Infinity;},
    region => {region.box.width = 10000; region.box.height = 10000;},
    region => {region.erase.x = 599;},
    region => {region.background = 'url(javascript:evil)';},
    region => {region.confidence = 'certain';},
    region => {region.enabled = 'true';},
    region => {region.font_size = 201;},
    region => {region.translation = '译'.repeat(5001);}
  ];
  invalid.forEach((mutate, index) => {
    const value = draft();
    mutate(value.regions[0]);
    value.regions.push(draft().regions[0]);
    assert.equal(savePage(store, NAVER, value, index + 1).saved, false);
  });
  const empty = draft({regions: [], kind: 'manual_sample'});
  const states = new Map([['1', draft()], [0, draft()], [501, draft()], [2, empty]]);
  assert.equal(store.save(NAVER, states).saved, true);
  assert.deepEqual([...store.load(NAVER).keys()], [2]);
  assert.equal(store.load(NAVER).get(2).kind, 'manual_sample');
  assert.deepEqual(store.load(NAVER).get(2).regions, []);
});

test('metadata and schema collection limits are enforced without truncating translations', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  for (const value of [
    draft({width: 0}), draft({width: 30000, height: 30000}), draft({height: undefined}),
    draft({context: '文'.repeat(5001)}), draft({target: 'unknown'}), draft({kind: 'unknown'}),
    draft({regions: Array.from({length: 101}, () => draft().regions[0])})
  ]) assert.equal(savePage(store, CHAPTER, value).saved, false);
  const valid = draft({width: undefined, height: undefined, target: undefined});
  assert.equal(savePage(store, CHAPTER, valid, 500).saved, true);
  assert.equal(store.load(CHAPTER).get(500).width, undefined);
  storage.values.set(KEY, JSON.stringify({version: 1, chapters: [{id: CHAPTER, pages: Array.from({length: 501}, () => [1, draft()])}]}));
  assert.equal(store.load(CHAPTER).size, 0);
});

test('savedPages identifies only valid incoming pages, excluding rejected pages and previously stored pages', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  assert.deepEqual(savePage(store, CHAPTER, draft(), 5), {saved: true, savedPages: [5]});
  const result = store.save(CHAPTER, new Map([
    [4, draft()],
    [2, draft({context: '文'.repeat(5001)})],
    [1, draft({regions: []})],
    [3, {translated: false, regions: []}]
  ]));
  assert.deepEqual(result, {saved: true, savedPages: [1, 4]});
  assert.deepEqual([...store.load(CHAPTER).keys()], [1, 4, 5]);
});

test('image-edge validation tolerates pixel-conversion rounding but rejects actual out-of-bounds rectangles', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  const value = draft({width: 690});
  // These numbers are produced by converting x=0.5, width=999.5 from 0..1000.
  value.regions[0].erase = {x: 0.5 / 1000 * 690, y: 40, width: 999.5 / 1000 * 690, height: 70};
  assert.ok(value.regions[0].erase.x + value.regions[0].erase.width > value.width);
  assert.deepEqual(savePage(store, CHAPTER, value), {saved: true, savedPages: [1]});
  assert.deepEqual(store.load(CHAPTER).get(1).regions[0].erase, value.regions[0].erase);
  const invalid = draft({width: 690});
  invalid.regions[0].erase = {...value.regions[0].erase, width: value.regions[0].erase.width + 0.00001};
  assert.equal(savePage(store, CHAPTER, invalid, 2).saved, false);
  assert.deepEqual([...store.load(CHAPTER).keys()], [1]);
});

test('saving an existing chapter updates eviction order and keeps only the configured chapter count', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage, {maxChapters: 2});
  assert.equal(savePage(store, CHAPTER).saved, true);
  assert.equal(savePage(store, OTHER).saved, true);
  assert.equal(savePage(store, CHAPTER, draft(), 2).saved, true);
  assert.equal(savePage(store, NAVER).saved, true);
  assert.equal(store.load(OTHER).size, 0);
  assert.deepEqual([...store.load(CHAPTER).keys()], [1, 2]);
  assert.equal(store.load(NAVER).size, 1);
});

test('byte limit counts UTF-8 and preserves an existing saved chapter when a replacement cannot fit', () => {
  const storage = memoryStorage();
  const reference = memoryStorage();
  savePage(createDraftStore(reference));
  const limit = new TextEncoder().encode(reference.getItem(KEY)).length;
  const store = createDraftStore(storage, {maxBytes: limit});
  assert.equal(savePage(store).saved, true);
  const previous = storage.getItem(KEY);
  const oversized = draft({context: '华文'.repeat(1000)});
  assert.equal(savePage(store, CHAPTER, oversized).saved, false);
  assert.equal(storage.getItem(KEY), previous);
  assert.equal(store.load(CHAPTER).get(1).context, '朋友之间的问候');
  assert.equal(savePage(store, NAVER).saved, true);
  assert.equal(store.load(CHAPTER).size, 0);
  assert.equal(store.load(NAVER).size, 1);
  assert.ok(new TextEncoder().encode(storage.getItem(KEY)).length <= limit);
});

test('quota retry evicts only old chapters in an atomic write and never removes storage first', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  savePage(store, CHAPTER);
  storage.limit = new TextEncoder().encode(storage.getItem(KEY)).length + 20;
  assert.equal(savePage(store, NAVER).saved, true);
  assert.equal(storage.writes, 3);
  assert.equal(storage.removes, 0);
  assert.equal(store.load(CHAPTER).size, 0);
  assert.equal(store.load(NAVER).size, 1);
  const previous = storage.getItem(KEY);
  storage.limit = 1;
  const failure = savePage(store, NAVER, draft({context: '修改后的对白'}));
  assert.equal(failure.saved, false);
  assert.ok(failure.error);
  assert.equal(storage.getItem(KEY), previous);
  assert.equal(storage.removes, 0);
});

test('unavailable or blocked storage returns sanitized errors while reading and clearing remain safe', () => {
  for (const storage of [null, {}, {
    getItem() { throw Object.assign(new Error('secret-token in error'), {name: 'SecurityError'}); },
    setItem() { throw Error('must not run'); }
  }]) {
    const store = createDraftStore(storage);
    assert.equal(store.load(CHAPTER).size, 0);
    const result = savePage(store);
    assert.equal(result.saved, false);
    assert.ok(result.error);
    assert.ok(!result.error.includes('secret-token'));
    assert.doesNotThrow(() => store.clear());
  }
  const storage = memoryStorage();
  savePage(createDraftStore(storage));
  const previous = storage.getItem(KEY);
  storage.setItem = () => { throw new Error('secret backend details'); };
  const result = savePage(createDraftStore(storage), OTHER);
  assert.equal(result.saved, false);
  assert.ok(!result.error.includes('secret backend details'));
  assert.equal(storage.getItem(KEY), previous);
});

test('clear removes only the requested chapter or the draft key, leaving other local settings intact', () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  storage.values.set('unrelated-setting', 'keep');
  savePage(store, CHAPTER); savePage(store, NAVER);
  store.clear(CHAPTER);
  assert.equal(store.load(CHAPTER).size, 0);
  assert.equal(store.load(NAVER).size, 1);
  store.clear('__proto__');
  assert.equal(store.load(NAVER).size, 1);
  store.clear();
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem('unrelated-setting'), 'keep');
});
