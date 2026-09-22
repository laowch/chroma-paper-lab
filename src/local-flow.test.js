import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_STEPS, flowTimeline, flowKey } from './local-flow.js';
import { seekBloom } from './artwork.js';
import { initialState } from './presets.js';

function makeState(overrides = {}) {
  return { ...initialState(), progress: 0, ...overrides };
}

function keyFor(state, revision = 7) {
  return flowKey(state, flowTimeline(state), revision);
}

function keyState() {
  return makeState({
    progress: .305,
    drops: [{ x: .25, y: .4, age: 11 }, { x: .75, y: .6, age: 5.5 }],
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('flowTimeline: zero progress without drops needs no steps or base injection', () => {
  assert.deepEqual(flowTimeline(makeState()), { steps: 0, starts: [], baseStart: -1 });
});

test('flowTimeline: age-zero drops do not advance an otherwise empty timeline', () => {
  const state = makeState({ drops: [{ x: .2, y: .3, age: 0 }, { x: .8, y: .7, age: 0 }] });
  assert.deepEqual(flowTimeline(state), { steps: 0, starts: [0, 0], baseStart: -1 });
});

test('flowTimeline: maximum progress and drop age independently reach 132 steps', () => {
  assert.equal(FLOW_STEPS, 132);
  assert.deepEqual(flowTimeline(makeState({ progress: 1.22 })), {
    steps: 132, starts: [], baseStart: 0,
  });
  assert.deepEqual(flowTimeline(makeState({ drops: [{ x: .5, y: .5, age: 22 }] })), {
    steps: 132, starts: [0], baseStart: -1,
  });
  assert.deepEqual(flowTimeline(makeState({ progress: 1.22, drops: [{ x: .5, y: .5, age: 22 }] })), {
    steps: 132, starts: [0], baseStart: 0,
  });
});

test('flowTimeline: unequal drop ages have separate starts in input order', () => {
  const state = makeState({
    drops: [{ x: .2, y: .3, age: 5.5 }, { x: .5, y: .5, age: 22 }, { x: .8, y: .7, age: 11 }],
  });
  assert.deepEqual(flowTimeline(state), { steps: 132, starts: [99, 0, 66], baseStart: -1 });
});

test('flowTimeline: a new age-zero drop has no elapsed injection in an existing bloom', () => {
  const state = makeState({
    progress: .61,
    drops: [{ x: .25, y: .5, age: 22 }, { x: .75, y: .5, age: 0 }],
  });
  const timeline = flowTimeline(state);
  assert.deepEqual(timeline, { steps: 132, starts: [0, 132], baseStart: 66 });
  // Reconstruction runs step indices [0, steps), so the new drop has not fired yet.
  assert.equal(timeline.steps - timeline.starts[1], 0);
});

test('flowTimeline: base progress starts relative to the oldest drop', () => {
  const state = makeState({ progress: .61, drops: [{ x: .5, y: .5, age: 22 }] });
  assert.deepEqual(flowTimeline(state), { steps: 132, starts: [0], baseStart: 66 });
});

test('flowTimeline: base progress can lead the drop timeline', () => {
  const state = makeState({ progress: 1.22, drops: [{ x: .5, y: .5, age: 11 }] });
  assert.deepEqual(flowTimeline(state), { steps: 132, starts: [66], baseStart: 0 });
});

test('flowTimeline: substep drop ages round to the nearest simulation step', () => {
  const state = makeState({ drops: [{ x: .2, y: .3, age: .08 }, { x: .8, y: .7, age: .09 }] });
  assert.deepEqual(flowTimeline(state), { steps: 1, starts: [1, 0], baseStart: -1 });
});

test('flowTimeline: proportional seekBloom reaches and holds the exact target endpoint', () => {
  const target = makeState({
    progress: .61,
    drops: [{ x: .25, y: .5, age: 22 }, { x: .5, y: .5, age: 11 }, { x: .75, y: .5, age: 0 }],
  });
  const state = structuredClone(target);
  seekBloom(state, target, 0);
  assert.deepEqual(flowTimeline(state), { steps: 0, starts: [0, 0, 0], baseStart: -1 });

  seekBloom(state, target, .45);
  assert.deepEqual(flowTimeline(state), { steps: 66, starts: [0, 33, 66], baseStart: 33 });

  for (const fraction of [.9, .95, 1]) {
    seekBloom(state, target, fraction);
    assert.deepEqual(flowTimeline(state), { steps: 132, starts: [0, 66, 132], baseStart: 66 });
    assert.equal(keyFor(state), keyFor(target));
    assert.deepEqual(state, target);
  }
});

test('flowTimeline: seeking backward reconstructs the earlier timeline and can replay', () => {
  const target = makeState({ progress: .61, drops: [{ x: .5, y: .5, age: 22 }] });
  const state = structuredClone(target);
  const endpoint = flowTimeline(state);
  const endpointKey = keyFor(state);

  seekBloom(state, target, .45);
  const rewound = flowTimeline(state);
  assert.deepEqual(rewound, { steps: 66, starts: [0], baseStart: 33 });
  assert.ok(rewound.steps < endpoint.steps);
  assert.notEqual(keyFor(state), endpointKey);

  seekBloom(state, target, .9);
  assert.deepEqual(flowTimeline(state), endpoint);
  assert.equal(keyFor(state), endpointKey);
});

test('flowKey: equal drop-age advancement with zero progress preserves the reconstruction key', () => {
  const state = keyState();
  state.progress = 0;
  const before = flowTimeline(state);
  const key = keyFor(state);
  state.drops.forEach(drop => { drop.age += 2; });
  const after = flowTimeline(state);

  assert.deepEqual(before, { steps: 66, starts: [0, 33], baseStart: -1 });
  assert.deepEqual(after, { steps: 78, starts: [0, 33], baseStart: -1 });
  assert.equal(keyFor(state), key);

  // Rewind is detectable via steps even when the reconstruction key stays equal.
  state.drops.forEach(drop => { drop.age -= 2; });
  assert.ok(flowTimeline(state).steps < after.steps);
  assert.deepEqual(flowTimeline(state), before);
  assert.equal(keyFor(state), key);
});

test('flowKey: identical state values and mask revisions are deterministic', () => {
  const state = keyState();
  assert.equal(keyFor(structuredClone(state)), keyFor(state));
});

test('flowKey: changing the geometry mask revision invalidates reconstruction', () => {
  const state = keyState();
  assert.notEqual(keyFor(state, 8), keyFor(state, 7));
});

const invalidatingChanges = [
  ['shape', state => { state.shape = 'line'; }],
  ['size', state => { state.size += 10; }],
  ['stroke', state => { state.stroke += 1; }],
  ['offset.x', state => { state.offset.x += .1; }],
  ['offset.y', state => { state.offset.y += .1; }],
  ['sourceRandomness', state => { state.sourceRandomness += .1; }],
  ['seed', state => { state.seed += 1; }],
  ['mode', state => { state.mode = 'directional'; }],
  ['direction', state => { state.direction += 10; }],
  ['amount', state => { state.amount += .1; }],
  ['separation', state => { state.separation -= .1; }],
  ['speed', state => { state.speed += .1; }],
  ['fiber', state => { state.fiber += .1; }],
  ['grain', state => { state.grain += .1; }],
  ['randomness', state => { state.randomness -= .1; }],
  ['dropRadius', state => { state.dropRadius += .1; }],
  ['base start', state => { state.progress = .61; }],
  ['base injection disabled', state => { state.progress = 0; }],
  ['relative drop start', state => { state.drops[1].age += 1; }],
  ['drop addition', state => { state.drops.push({ x: .5, y: .5, age: 0 }); }],
  ['drop removal', state => { state.drops.pop(); }],
  ['drop order', state => { state.drops.reverse(); }],
  ['pigment addition', state => { state.pigments.push({ ...state.pigments[0] }); }],
  ['pigment removal', state => { state.pigments.pop(); }],
  ['pigment order', state => { state.pigments.reverse(); }],
];

for (let index = 0; index < keyState().pigments.length; index++) {
  for (const field of ['mobility', 'spread', 'direction']) {
    invalidatingChanges.push([`pigments[${index}].${field}`, state => { state.pigments[index][field] += .1; }]);
  }
}
for (let index = 0; index < keyState().drops.length; index++) {
  for (const field of ['x', 'y']) {
    invalidatingChanges.push([`drops[${index}].${field}`, state => { state.drops[index][field] += .1; }]);
  }
}

for (const [name, change] of invalidatingChanges) {
  test(`flowKey: changing ${name} invalidates reconstruction`, () => {
    const state = keyState();
    const before = keyFor(state);
    change(state);
    assert.notEqual(keyFor(state), before);
  });
}

const displayChanges = [
  ['ink color', state => { state.ink = '#123456'; }],
  ['retention', state => { state.retention = .2; }],
  ['keepSource', state => { state.keepSource = false; }],
];
for (let index = 0; index < keyState().pigments.length; index++) {
  for (const [field, value] of [['color', '#123456'], ['opacity', .2], ['saturation', .3]]) {
    displayChanges.push([`pigments[${index}].${field}`, state => { state.pigments[index][field] = value; }]);
  }
}
for (let index = 0; index < 3; index++) {
  displayChanges.push([`layers[${index}]`, state => { state.layers[index] = false; }]);
}

for (const [name, change] of displayChanges) {
  test(`flowKey: display-only ${name} does not invalidate reconstruction`, () => {
    const state = keyState();
    const before = keyFor(state);
    change(state);
    assert.equal(keyFor(state), before);
  });
}

test('flowTimeline and flowKey do not mutate state or the supplied timeline', () => {
  const state = keyState();
  const snapshot = structuredClone(state);
  deepFreeze(state);
  const timeline = flowTimeline(state);
  assert.deepEqual(state, snapshot);

  const timelineSnapshot = structuredClone(timeline);
  deepFreeze(timeline);
  const key = flowKey(state, timeline, 7);
  assert.equal(key, flowKey(state, timeline, 7));
  assert.deepEqual(flowTimeline(state), timelineSnapshot);
  assert.deepEqual(state, snapshot);
  assert.deepEqual(timeline, timelineSnapshot);
});
