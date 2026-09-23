export const INKS = [
  { name: 'Cyan nocturne', color: '#181922', pigments: ['#61518b', '#49b9c6', '#edf0d5'] },
  { name: 'Sulfur halo', color: '#39343e', pigments: ['#e6ca73', '#aac68d', '#5b566f'] },
  { name: 'Copper patina', color: '#262a28', pigments: ['#ae7f88', '#58bba6', '#454244'] },
  { name: 'Carbon black', color: '#282925', pigments: ['#f16dad', '#5d7eae', '#d5c36d'] },
  { name: 'Midnight blue', color: '#222b52', pigments: ['#ae79d0', '#2589c4', '#6265ac'] },
  { name: 'Burnt umber', color: '#684235', pigments: ['#d9778e', '#d69e54', '#8a7358'] },
  { name: 'Aubergine', color: '#58364e', pigments: ['#d66dab', '#7972b8', '#ad6794'] },
  { name: 'Persimmon', color: '#d77837', pigments: ['#e890c5', '#f0bb45', '#f07751'] },
  { name: 'Forest green', color: '#3c5142', pigments: ['#a1af70', '#5b9b9f', '#929767'] },
  ...[
    { name: 'Prism', pigments: ['#ff3864', '#1888ff', '#ffbd2e'] },
    { name: 'Lagoon', pigments: ['#0a2a8a', '#ff4ca5', '#31d9c3'] },
    { name: 'Electric bloom', pigments: ['#6320ee', '#f72585', '#4cc9f0'] },
    { name: 'Ember', pigments: ['#101010', '#2f68ff', '#ff5d20'] },
    { name: 'Botanical', pigments: ['#00543d', '#ee7b30', '#992f73'] },
  ].map(ink=>({...ink,color:mixedInk(ink.pigments.map(color=>({color})))})),
];

export const MAX_PIGMENTS = 6;
export const DEFAULT_DROP_RADIUS = 1;

export function makePigments(colors) {
  return colors.slice(0, MAX_PIGMENTS).map((color, i) => ({ color, mobility: [1.02,.65,.36,.27,.19,.12][i], spread: [.18,.42,.34][i%3], opacity: [.76,.60,.58][i%3], saturation: 1, direction: 0 }));
}

export function hexToHsl(hex) {
  const [r,g,b] = [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min, l=(max+min)/2;
  const h=d===0 ? 0 : max===r ? ((g-b)/d+6)%6 : max===g ? (b-r)/d+2 : (r-g)/d+4;
  return { h:h*60, s:d===0 ? 0 : Math.min(100,d/(1-Math.abs(2*l-1))*100), l:l*100 };
}

export function hslToHex({h,s,l}) {
  s/=100; l/=100;
  const a=s*Math.min(l,1-l);
  return '#'+[0,8,4].map(n=>{
    const k=(n+h/30)%12;
    return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');
  }).join('');
}

export function mixedInk(pigments) {
  return '#'+[1,3,5].map(channel=>Math.round(pigments.reduce((sum,p)=>sum+parseInt(p.color.slice(channel,channel+2),16),0)/pigments.length*.64).toString(16).padStart(2,'0')).join('');
}

export function updateCustomInk(state) {
  state.inkIndex=-1;
  if(!state.keepSource || state.shape==='import')state.ink=mixedInk(state.pigments);
}

export function variationSeeds(seed) {
  return Array.from({length:10},(_,i)=>1000+((seed-1000+(i+1)*7919)%9000+9000)%9000);
}

export function initialState() {
  const inkIndex=INKS.findIndex(ink=>ink.name==='Carbon black');
  return {
    shape: 'ring', size: 760, stroke: 23, ink: INKS[inkIndex].color, inkIndex,
    pigments: makePigments(INKS[inkIndex].pigments), mode: 'radial', direction: 90,
    localFlow: false,
    amount: .92, separation: .90, fiber: .58, grain: .34, retention: .96,
    progress: .88, seed: 2847, layers: [true,true,true], drops: [], dropRadius: DEFAULT_DROP_RADIUS,
    dropPosition: { x: .5, y: .5 }, dropPlacement: 'center', showDropMarkers: true,
    text: 'a', keepSource: true, paths: [], imported: null, importName: '', importScale: 1,
    randomness: 1, speed: 1, sourceRandomness: 0,
    marks: [], offset: { x: 0, y: 0 }, generated: false,
  };
}

export const PRESETS = [
  { name: 'Cyan eclipse', subtitle: 'Cyan nocturne · violet / ice', shape: 'circle', ink: 'Cyan nocturne', seed: 8162, mode: 'radial', size: 420, stroke: 23, amount: 1.4, separation: .76, fiber: .36, grain: .4, randomness: .35, progress: 1.06 },
  { name: 'Sulfur halo', subtitle: 'Sulfur halo · gold / sage', shape: 'polygon', ink: 'Sulfur halo', seed: 1979, mode: 'radial', size: 1120, stroke: 23, amount: 1.12, separation: .68, fiber: .32, grain: .46, randomness: .25, progress: .96 },
  { name: 'Patina trace', subtitle: 'Copper patina · mint / ash', shape: 'line', ink: 'Copper patina', seed: 3751, mode: 'radial', size: 1120, stroke: 120, amount: 1.08, separation: .82, fiber: .48, grain: .5, randomness: .45, progress: .98 },
  { name: 'Quiet bloom', subtitle: 'Carbon · radial', shape: 'ring', ink: 'Carbon black', seed: 2847, mode: 'radial', size: 760, stroke: 23, amount: .92, className: 'bloom' },
  { name: 'Blue hour', subtitle: 'Midnight · drifting', shape: 'dot', ink: 'Midnight blue', seed: 7341, mode: 'directional', size: 950, stroke: 80, amount: 1.15, className: 'blue' },
  { name: 'Soft signal', subtitle: 'Persimmon · radial', shape: 'dot', ink: 'Persimmon', seed: 4713, mode: 'radial', size: 640, stroke: 30, amount: .82, className: 'signal' },
  { name: 'Passing through', subtitle: 'Carbon · drifting', shape: 'ring', ink: 'Carbon black', seed: 9542, mode: 'directional', size: 700, stroke: 32, amount: 1.10, className: 'passing' },
  { name: 'A small gesture', subtitle: 'Aubergine · radial', shape: 'line', ink: 'Aubergine', seed: 1982, mode: 'radial', size: 700, stroke: 28, amount: .56, className: 'gesture' },
  { name: 'Open-ended', subtitle: 'Forest · radial', shape: 'arc', ink: 'Forest green', seed: 6782, mode: 'radial', size: 850, stroke: 22, amount: .65, className: 'open' },
  {
    name: 'Cloud tides', subtitle: 'Local flow · cream / rose / violet', shape: 'composition', ink: 'Carbon black',
    localFlow: true, seed: 8162, mode: 'directional', direction: 270, size: 760, stroke: 90,
    amount: .8, separation: .85, fiber: .7, grain: .62, randomness: 1.35, speed: .4,
    retention: .035, progress: 0, dropRadius: 1.05, showDropMarkers: false,
    marks: [{ type: 'line', x: .22, y: .49, endX: .82, endY: .49, stroke: 90, radius: 0, size: 760, points: [] }],
    drops: [{ x: .28, y: .475, age: 16 }, { x: .50, y: .482, age: 13 }, { x: .67, y: .477, age: 14 }, { x: .78, y: .483, age: 9 }],
    pigments: [
      { color: '#fff3c7', mobility: 1.1, spread: .7, opacity: .28, saturation: 1, direction: 0 },
      { color: '#f277b0', mobility: .65, spread: .45, opacity: .13, saturation: 1, direction: 0 },
      { color: '#6457cc', mobility: .25, spread: .3, opacity: .12, saturation: 1, direction: 0 },
    ],
  },
].map(({ink,...preset})=>({...preset,inkIndex:INKS.findIndex(palette=>palette.name===ink)}));

export function presetState(preset) {
  const settings=structuredClone(Object.fromEntries(Object.entries(preset).filter(([key])=>!['name','subtitle','className'].includes(key))));
  return {...initialState(),...settings,ink:INKS[preset.inkIndex].color,
    inkIndex:preset.pigments ? -1 : preset.inkIndex,
    pigments:settings.pigments ?? makePigments(INKS[preset.inkIndex].pigments)};
}
