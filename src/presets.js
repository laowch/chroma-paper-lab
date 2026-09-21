export const INKS = [
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

export function variationSeeds(seed) {
  return Array.from({length:10},(_,i)=>1000+((seed-1000+(i+1)*7919)%9000+9000)%9000);
}

export function initialState() {
  return {
    shape: 'ring', size: 760, stroke: 23, ink: INKS[0].color, inkIndex: 0,
    pigments: makePigments(INKS[0].pigments), mode: 'radial', direction: 90,
    amount: .92, separation: .90, fiber: .58, grain: .34, retention: .96,
    progress: .88, seed: 2847, layers: [true,true,true], drops: [],
    dropPosition: { x: .5, y: .5 }, dropPlacement: 'center', showDropMarkers: true,
    text: 'a', keepSource: true, paths: [], imported: null, importName: '', importScale: 1,
    randomness: 1, speed: 1, sourceRandomness: 0,
    marks: [], offset: { x: 0, y: 0 }, generated: false,
  };
}

export const PRESETS = [
  { name: 'Quiet bloom', subtitle: 'Carbon · radial', shape: 'ring', inkIndex: 0, seed: 2847, mode: 'radial', size: 760, stroke: 23, amount: .92, className: 'bloom' },
  { name: 'Blue hour', subtitle: 'Midnight · drifting', shape: 'dot', inkIndex: 1, seed: 7341, mode: 'directional', size: 950, stroke: 80, amount: 1.15, className: 'blue' },
  { name: 'Soft signal', subtitle: 'Persimmon · radial', shape: 'dot', inkIndex: 4, seed: 4713, mode: 'radial', size: 640, stroke: 30, amount: .82, className: 'signal' },
  { name: 'Passing through', subtitle: 'Carbon · drifting', shape: 'ring', inkIndex: 0, seed: 9542, mode: 'directional', size: 700, stroke: 32, amount: 1.10, className: 'passing' },
  { name: 'A small gesture', subtitle: 'Aubergine · radial', shape: 'line', inkIndex: 3, seed: 1982, mode: 'radial', size: 700, stroke: 28, amount: .56, className: 'gesture' },
  { name: 'Open-ended', subtitle: 'Forest · radial', shape: 'arc', inkIndex: 5, seed: 6782, mode: 'radial', size: 850, stroke: 22, amount: .65, className: 'open' },
];
