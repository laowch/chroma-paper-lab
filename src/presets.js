export const INKS = [
  { name: 'Carbon black', color: '#282925', pigments: ['#f16dad', '#5d7eae', '#d5c36d'] },
  { name: 'Midnight blue', color: '#222b52', pigments: ['#ae79d0', '#2589c4', '#6265ac'] },
  { name: 'Burnt umber', color: '#684235', pigments: ['#d9778e', '#d69e54', '#8a7358'] },
  { name: 'Aubergine', color: '#58364e', pigments: ['#d66dab', '#7972b8', '#ad6794'] },
  { name: 'Persimmon', color: '#d77837', pigments: ['#e890c5', '#f0bb45', '#f07751'] },
  { name: 'Forest green', color: '#3c5142', pigments: ['#a1af70', '#5b9b9f', '#929767'] },
];

export function makePigments(colors) {
  return colors.map((color, i) => ({ color, mobility: [1.02,.65,.36][i], spread: [.18,.42,.34][i], opacity: [.76,.60,.58][i], saturation: 1, direction: 0 }));
}

export function initialState() {
  return {
    shape: 'ring', size: 760, stroke: 23, ink: INKS[0].color, inkIndex: 0,
    pigments: makePigments(INKS[0].pigments), mode: 'radial', direction: 90,
    amount: .92, separation: .90, fiber: .58, grain: .34, retention: .96,
    progress: .88, seed: 2847, layers: [true,true,true], drops: [],
    text: 'a', keepSource: true, paths: [], imported: null,
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
