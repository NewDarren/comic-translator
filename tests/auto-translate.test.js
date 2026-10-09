import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoQueue } from '../auto-translate.js';

// Advance a virtual clock so page changes need no real debounce delays.
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++nextId;
      tasks.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer(id) { tasks.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].due;
        tasks.delete(due[0]);
        due[1].callback();
      }
      now = target;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function queueFor(clock, select, run) {
  return createAutoQueue({
    select, run, delay: 600,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

test('rapid page navigation debounces and translates only the latest page', async () => {
  const clock = fakeClock();
  let page = 1;
  const translated = [];
  const queue = queueFor(clock, () => page, async candidate => {
    translated.push(candidate);
    page = null;
  });
  queue.request();
  clock.advance(400);
  page = 2;
  queue.request();
  clock.advance(599);
  await settle();
  assert.deepEqual(translated, []);
  // The candidate must be read at execution time, even without another request.
  page = 3;
  clock.advance(1);
  await settle();
  clock.advance(0);
  await settle();
  assert.deepEqual(translated, [3]);
  queue.stop();
});

test('no candidate or missing credentials make no translation requests', async () => {
  const clock = fakeClock();
  let hasKey = false;
  let page = 5;
  const translated = [];
  const queue = queueFor(clock, () => hasKey ? page : null, async candidate => {
    translated.push(candidate);
    page = undefined;
  });
  queue.request();
  clock.advance(600);
  await settle();
  assert.deepEqual(translated, []);
  hasKey = true;
  page = undefined;
  queue.request();
  clock.advance(600);
  await settle();
  assert.deepEqual(translated, []);
  page = 5;
  queue.request();
  clock.advance(600);
  await settle();
  assert.deepEqual(translated, [5]);
  queue.stop();
});

test('page requests are serial and an in-flight translation is followed by the newest page', async () => {
  const clock = fakeClock();
  let page = 1;
  const first = deferred();
  const translated = [];
  let active = 0;
  let peak = 0;
  const queue = queueFor(clock, () => page, async candidate => {
    translated.push(candidate);
    active++;
    peak = Math.max(peak, active);
    try {
      if (candidate === 1) await first.promise;
      else page = null;
    } finally { active--; }
  });
  queue.request(0);
  clock.advance(0);
  await settle();
  assert.deepEqual(translated, [1]);
  page = 2;
  queue.request(0);
  clock.advance(0);
  page = 4;
  queue.request(0);
  clock.advance(0);
  await settle();
  assert.deepEqual(translated, [1]);
  first.resolve();
  await settle();
  clock.advance(0);
  await settle();
  assert.deepEqual(translated, [1, 4]);
  assert.equal(peak, 1);
  queue.stop();
});

test('turning auto translation off cancels a pending page', async () => {
  const clock = fakeClock();
  const translated = [];
  const queue = queueFor(clock, () => 7, async page => translated.push(page));
  queue.request();
  clock.advance(599);
  queue.stop();
  clock.advance(10000);
  await settle();
  assert.deepEqual(translated, []);
});

test('turning auto translation off lets the current call finish but does not start another page', async () => {
  const clock = fakeClock();
  const first = deferred();
  let page = 1;
  const translated = [];
  const queue = queueFor(clock, () => page, async candidate => {
    translated.push(candidate);
    if (candidate === 1) await first.promise;
    else page = null;
  });
  queue.request(0);
  clock.advance(0);
  await settle();
  page = 2;
  queue.request(0);
  queue.stop();
  first.resolve();
  await settle();
  clock.advance(10000);
  await settle();
  assert.deepEqual(translated, [1]);
  // Switching auto on again resumes translation of the current page.
  queue.request(0);
  clock.advance(0);
  await settle();
  assert.deepEqual(translated, [1, 2]);
  queue.stop();
});

test('a failed API call stops automatic retries until a new request', async () => {
  const clock = fakeClock();
  const first = deferred();
  let page = 3;
  const translated = [];
  const queue = queueFor(clock, () => page, async candidate => {
    translated.push(candidate);
    if (translated.length === 1) await first.promise;
    else page = null;
  });
  queue.request(0);
  clock.advance(0);
  await settle();
  page = 4;
  queue.request(0);
  clock.advance(0);
  first.reject(new Error('API quota exceeded'));
  await settle();
  clock.advance(10000);
  await settle();
  assert.deepEqual(translated, [3]);
  queue.request(0);
  clock.advance(0);
  await settle();
  assert.deepEqual(translated, [3, 4]);
  queue.stop();
});
