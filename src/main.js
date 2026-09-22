import './style.css';
import { icon } from './icons.js';
import { ChromatographyRenderer } from './renderer.js';
import { initialState, INKS, PRESETS, makePigments, MAX_PIGMENTS, hexToHsl, hslToHex, mixedInk, variationSeeds } from './presets.js';
import { canvasToPrintPng, downloadBlob, supportsVideoExport, recordCanvasVideo, PNG_SIZE, PNG_DPI } from './export.js';
import { prepareImportedImage } from './import.js';
import { paintMask, createSeededMarks, scrubState, seekBloom, MAX_DROPS, DROP_PLACEMENTS, resolveDropPosition, addWaterDrop, removeWaterDrops } from './artwork.js';
import { serializeExperiment, parseExperiment, MAX_EXPERIMENT_BYTES } from './experiment.js';

let state = initialState();
let tool = 'water';
let inputMode = 'draw';
let playing = false;
let animationMode = 'bloom';
let hasBloomed = false;
let bloomTarget = null;
let zoom = 100;
let selectedPreset = PRESETS.findIndex(preset=>preset.name==='Quiet bloom');
let rendering = false;
let elapsed = 0;
let previousTime = 0;
let toastTimer;
let gesture = null;
let brushShape = 'ring';
let animationFrame = 0;
let exportController = null;
let busy = false;
let restoring = false;
let variations = [];
let hslEditing = null;
const undoStack = [];
const redoStack = [];
const thumbnails = [];
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const shapeLabels = { dot: 'Dot', line: 'Line', circle: 'Circle', ring: 'Ring', arc: 'Arc', polygon: 'Organic', freehand: 'Draw', text: 'Text' };
const maskCanvas = document.createElement('canvas');
maskCanvas.width = maskCanvas.height = 768;
// Keep original canvas imports and decoded PNG restores on the same rasterization path.
const maskContext = maskCanvas.getContext('2d', { willReadFrequently: false });
let importedImage = null;

function rangeControl(label, key, min, max, step, unit = '', endpoints = '') {
  return `<div class="control"><label class="control-label" for="control-${key}"><span>${label}</span><output data-value="${key}" data-unit="${unit}"></output></label><input id="control-${key}" type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}" />${endpoints ? `<div class="param-end-labels"><span>${endpoints.split('|')[0]}</span><span>${endpoints.split('|')[1]}</span></div>` : ''}</div>`;
}

function componentMarkup(i) {
  const name=`Pigment ${i+1}`;
  return `<details class="component"><summary><span class="component-dot" data-component-dot="${i}"></span><span class="component-name">${name}</span><span class="mobility-caption" data-mobility="${i}"></span>${icon('chevron',12)}</summary><div class="component-controls"><label class="color-control">Pigment color <input type="color" data-param="pigments.${i}.color" aria-label="${name} color" /></label><label class="hex-control">HEX <input data-hex="${i}" aria-label="${name} hex" maxlength="7" spellcheck="false" pattern="#[0-9a-fA-F]{6}" /></label>${['h','s','l'].map((key,j)=>`<label class="hsl-control">${['Hue','Color saturation','Lightness'][j]}<input type="range" data-hsl="${key}" data-component="${i}" min="0" max="${j===0?360:100}" step="1" aria-label="${name} ${['hue','color saturation','lightness'][j]}" /></label>`).join('')}${rangeControl('Mobility',`pigments.${i}.mobility`,.05,1.5,.01)}${rangeControl('Spread',`pigments.${i}.spread`,.05,1,.01)}${rangeControl('Opacity',`pigments.${i}.opacity`,0,1,.01)}${rangeControl('Saturation',`pigments.${i}.saturation`,0,1.5,.01)}${rangeControl('Direction offset',`pigments.${i}.direction`,-180,180,1,'°')}</div></details>`;
}

$('#app').innerHTML = `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="roughen"><feTurbulence type="fractalNoise" baseFrequency=".14" numOctaves="3" seed="4" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5"/></filter></svg>
  <header class="header">
    <a class="brand" href="${import.meta.env.BASE_URL}" aria-label="Chroma home"><span class="brand-mark"></span><div class="brand-copy"><div class="wordmark">chroma</div><div class="brand-tag">A PLAYGROUND FOR PIGMENT</div></div></a>
    <nav class="nav" aria-label="Main navigation"><button class="active" data-nav="playground">Playground</button><button data-nav="library">Library</button><button data-nav="about">About the process ${icon('arrow',11)}</button></nav>
    <div class="header-actions"><span class="header-note">A little pigment. Infinite possibilities.</span><button class="icon-button header-help" data-action="help" aria-label="How to use Chroma" title="How to use Chroma">${icon('help')}</button><button class="primary export-button" data-action="export">${icon('download',15)} Export <span class="separator"></span>${icon('chevron',12)}</button></div>
  </header>
  <main class="page">
    <section class="intro"><div><h1>Let color <em>find its way.</em></h1><p>Make a mark. Add water. Discover what unfolds.</p></div><div class="experiment-info"><span class="study">EXPERIMENT NO. <span id="study-number">001</span></span><span class="vertical-divider"></span><span><i class="status-dot"></i><span id="experiment-status" aria-live="polite">A moment of possibility</span></span></div></section>
    <div class="workspace">
      <aside class="panel source-panel" aria-label="Shape and ink controls">
        <section class="panel-section"><div class="section-heading"><span><span class="number">01</span> The starting point</span></div>
          <div class="segmented" aria-label="Shape source"><button data-input-mode="draw" class="active">${icon('draw',12)} Create</button><button data-input-mode="import">${icon('upload',12)} Import</button></div>
          <div id="create-controls"><div class="shape-grid">${Object.entries(shapeLabels).map(([shape,label])=>`<button class="shape-button ${state.shape===shape?'active':''}" data-shape="${shape}" aria-label="${label} shape" aria-pressed="${state.shape===shape}" title="${label}">${icon(shape==='freehand'?'draw':shape,22)}<span>${label}</span></button>`).join('')}</div>
          <div class="text-field" id="text-controls" hidden><label for="text-input">A letter, a word, a symbol</label><input id="text-input" maxlength="16" value="a" aria-label="Text or symbol" /></div><p class="draw-hint" id="draw-hint" hidden>Draw directly on the paper. Each stroke becomes a pigment sample.</p></div>
          <div id="import-controls" hidden><div class="upload-zone" id="upload-zone" role="button" tabindex="0" aria-label="Import an SVG or bitmap">${icon('upload',24)}<strong>Bring your own mark</strong><p>Drop an SVG, PNG, JPG or WebP<br/>or click to browse · up to 10 MB</p></div><div id="import-name" class="import-name"></div><label class="checkbox-control"><input id="keep-source" type="checkbox" checked /> Preserve source colors</label></div>
          ${rangeControl('Size','size',150,1600,10,'px')}${rangeControl('Stroke weight','stroke',5,160,1,'px')}<div id="import-scale-control" hidden>${rangeControl('Import scale','importScale',.25,2,.01,'%')}</div><div class="action-grid"><button class="secondary" data-tool="stamp">${icon('plus',12)} Draw shapes</button><button class="secondary" data-action="clear">Clear paper</button><button class="secondary wide" data-action="compose">${icon('shuffle',12)} Generate composition</button></div>
        </section>
        <section class="panel-section"><div class="section-heading"><span><span class="number">02</span> A drop of ink</span>${icon('drop',13)}</div><div class="ink-swatches" role="group" aria-label="Ink palettes">${INKS.map((ink,i)=>`<button class="ink-swatch ${i===state.inkIndex?'active':''}" data-ink="${i}" aria-label="${ink.name}: ${ink.pigments.join(', ')}" aria-pressed="${i===state.inkIndex}" title="${ink.name} · ${ink.pigments.join(' / ')}"><span class="ink-preview" aria-hidden="true">${ink.pigments.map(color=>`<span style="background:${color}"></span>`).join('')}</span><span class="ink-swatch-name">${ink.name}</span></button>`).join('')}</div><div class="ink-caption"><span id="ink-name">Carbon black</span><span id="ink-hex">#282925</span></div><div class="active-pigments" id="active-pigments" role="img" aria-label="Active pigment colors"></div><p class="ink-note">${icon('spark',12)}<span>One ink. A hidden world of colors.<br/>Mix between 1 and 6 pigment components.</span></p></section>
        <section class="panel-section presets-section"><div class="section-heading"><span><span class="number">03</span> A little inspiration</span></div><div class="preset-list">${PRESETS.slice(0,6).map((preset,i)=>`<button class="preset ${i===selectedPreset?'active':''}" data-preset="${i}" aria-pressed="${i===selectedPreset}"><img class="preset-art" data-thumbnail="${i}" alt="" /><div><div class="preset-name">${preset.name}</div><div class="preset-subtitle">${preset.subtitle}</div></div><span class="preset-check">${i===selectedPreset?icon('check',12):''}</span></button>`).join('')}</div><button class="all-presets" data-action="library">Explore all experiments ${icon('right',10)}</button></section>
        <div class="panel-footnote">A little less control.<br/>A little more wonder.</div>
      </aside>
      <section class="studio" aria-label="Chromatography canvas">
        <div class="studio-top"><div class="document-title">${icon('layers',14)}<span>Untitled experiment</span><span class="edited" title="Local experiment">·</span></div><div class="document-actions"><button class="secondary" data-action="save-experiment" title="Save an editable effect file">${icon('download',12)} Save effect</button><button class="secondary" data-action="load-experiment" title="Load an editable effect file">${icon('upload',12)} Load effect</button></div></div>
        <div class="stage" id="stage"><div class="toolbar" role="toolbar" aria-label="Canvas tools"><button class="icon-button" data-tool="move" aria-label="Select tool" title="Select (V)">${icon('cursor',15)}</button><button class="icon-button" data-tool="draw" aria-label="Freehand drawing tool" title="Draw (B)">${icon('draw',15)}</button><span class="toolbar-divider"></span><button class="water-tool active" data-tool="water" aria-pressed="true" title="Add water (W)">${icon('drop',14)} Add water</button><span class="toolbar-divider"></span><button class="icon-button" data-action="undo" aria-label="Undo" title="Undo (⌘Z)" disabled>${icon('undo',14)}</button><button class="icon-button" data-action="redo" aria-label="Redo" title="Redo (⌘⇧Z)" disabled>${icon('redo',14)}</button></div>
          <div class="artboard-wrap" id="artboard-wrap"><i class="paper-corner tl"></i><i class="paper-corner tr"></i><i class="paper-corner bl"></i><i class="paper-corner br"></i><div class="artboard" id="artboard" data-tool="water"><canvas id="paper" width="1100" height="1100" aria-label="Interactive paper chromatography artwork. Click to add water, or select Draw to make a mark."></canvas><div id="water-markers" class="water-markers" aria-hidden="true"></div></div></div>
        </div>
        <section class="variations-panel" id="variations-panel" hidden aria-label="Seed variations"><div class="section-heading"><span>Ten possible journeys</span><button class="icon-button" data-action="close-variations" aria-label="Close variations">${icon('close',14)}</button></div><div class="variation-grid" id="variation-grid"></div></section>
        <div class="studio-bottom"><span class="dimensions">${PNG_SIZE} <span class="dim-cross">×</span> ${PNG_SIZE} px <span class="dim-divider"></span> ${PNG_DPI} DPI <span class="dim-divider"></span> RGB</span><div class="zoom-tools"><button class="icon-button" data-action="zoom-out" aria-label="Zoom out">${icon('minus',12)}</button><output id="zoom-value">100%</output><button class="icon-button" data-action="zoom-in" aria-label="Zoom in">${icon('plus',12)}</button></div><button class="icon-button" data-action="fullscreen" aria-label="Toggle canvas fullscreen" title="Fullscreen">${icon('expand',14)}</button></div>
        <div class="workspace-hint">${icon('drop',13)}<span id="canvas-hint">Click anywhere on the paper to add a little water.</span><kbd>W</kbd></div>
      </section>
      <aside class="panel settings-panel" aria-label="Diffusion settings"><div class="settings-heading"><span>The art of diffusion</span><button class="icon-button" data-action="reset" aria-label="Reset diffusion settings" title="Reset diffusion settings">${icon('reset',14)}</button></div>
        <section class="panel-section"><div class="section-heading"><span>Flow direction</span><span class="tiny-tag">FOLLOW THE WATER</span></div><div class="segmented"><button data-flow="radial" class="active">${icon('ring',11)} Radial</button><button data-flow="directional">${icon('arrow',11)} Directional</button></div><div class="direction-controls" id="direction-controls" hidden><span class="direction-dial">${icon('arrow',14)}</span>${rangeControl('Angle','direction',0,360,1,'°')}</div>${rangeControl('Water amount','amount',.1,1.5,.01,'%')}
          <section class="water-drops" aria-labelledby="water-drops-heading"><div class="section-heading"><span id="water-drops-heading">Water drops</span><output id="drop-count" aria-label="Water drop count" aria-live="polite">0 / ${MAX_DROPS}</output></div><label class="drop-placement-label" for="drop-placement">Next drop position</label><select id="drop-placement" aria-describedby="drop-help">${DROP_PLACEMENTS.map(option=>`<option value="${option.value}">${option.label}</option>`).join('')}<option value="random">Random · 25–75%</option><option value="custom">Custom coordinates</option></select><div class="drop-coordinates">${['x','y'].map(axis=>`<label for="drop-${axis}">${axis.toUpperCase()} %<input id="drop-${axis}" data-drop-coordinate="${axis}" type="number" min="0" max="100" step="0.1" inputmode="decimal" aria-label="Next drop ${axis.toUpperCase()} percent" /></label>`).join('')}</div><button class="secondary add-drop" data-action="add-water">${icon('drop',12)} Add a drop</button><p class="drop-last" id="drop-last" aria-live="polite">Last drop: none</p><div class="action-grid"><button class="secondary" data-action="remove-last">Remove last</button><button class="secondary" data-action="clear-water">Clear water</button></div><label class="checkbox-control"><input id="show-drop-markers" type="checkbox" checked /> Show numbered markers</label><p class="drop-help" id="drop-help">Choose a position or edit X/Y, then add. Origin: top left. Random: a new point within 25–75% each time. Water-tool paper clicks add and set Custom. Only the newest 8 drops stay. Markers never export.</p></section>
          ${rangeControl('Color separation','separation',0,1,.01,'%')}${rangeControl('Paper fibers','fiber',0,1,.01,'%')}${rangeControl('Pigment granulation','grain',0,1,.01,'%')}<details class="advanced-controls"><summary>More control</summary>${rangeControl('Flow randomness','randomness',0,2,.01,'%')}${rangeControl('Travel speed','speed',0,2,.01,'%')}${rangeControl('Original density','retention',0,1,.01,'%')}${rangeControl('Source distortion','sourceRandomness',0,1,.01,'%')}</details></section>
        <section class="panel-section"><div class="section-heading"><span>Pigment components</span><span class="tiny-tag" id="pigment-count">3 COLORS</span></div><div class="component-count"><button class="icon-button" data-action="remove-pigment" aria-label="Remove pigment">${icon('minus',12)}</button><span>1–6 components</span><button class="icon-button" data-action="add-pigment" aria-label="Add pigment">${icon('plus',12)}</button></div><div id="pigment-components"></div><div class="mini-help">${icon('help',11)}<span>Different pigments travel at different speeds.<br/>Open a component to make it your own.</span></div></section>
        <section class="panel-section layers-section"><div class="section-heading"><span class="layers-heading">Layers</span><span class="tiny-tag">THE ANATOMY OF A BLOOM</span></div>${['Original mark','Separated pigments','Water diffusion'].map((label,i)=>`<div class="layer" data-layer-row="${i}"><span class="layer-thumbnail ${['original','pigment','diffusion'][i]}"></span><span>${label}</span><button class="icon-button" data-layer="${i}" aria-label="Toggle ${label.toLowerCase()}" aria-pressed="true" title="Show / hide ${label.toLowerCase()}">${icon('eye',14)}</button></div>`).join('')}</section>
        <div class="simulation-actions"><div class="timeline control"><label class="control-label" for="water-progress"><span>Water progress</span><output id="progress-value"></output></label><input id="water-progress" type="range" min="0" max="100" step="1" aria-label="Water progress" /></div><div class="action-grid"><button class="secondary wide" data-action="purify">${icon('spark',12)} Purify</button><button class="secondary wide" data-action="variations">${icon('shuffle',12)} Generate 10 variations</button></div><button class="bloom-button" data-action="play">${icon('play',14)}<span>Let it bloom</span></button><div class="simulation-meta"><span id="simulation-time">A slow, beautiful process.</span><button class="seed-button" data-action="reseed" title="Generate a new variation">${icon('shuffle',12)} Seed <span id="seed-value">2847</span></button></div></div>
      </aside>
    </div>
    <div class="render-status"><span id="render-status" role="status">WebGL 2 · Ready</span><span>PNG ${PNG_SIZE} × ${PNG_SIZE} · Video 1920 × 1920 / 25 FPS</span></div>
    <footer class="footer"><span class="footer-left">${icon('spark',12)} Inspired by paper chromatography. Shaped by a little unpredictability.</span><span class="footer-right"><span>Made for the unexpected.</span><span class="small-logo">chroma</span><span class="beta">LAB 01</span></span></footer>
  </main>
  <input id="file-input" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" hidden />
  <input id="experiment-input" type="file" accept=".json,application/json" hidden />
  <div class="toast" role="status" aria-live="polite"></div>
  <dialog class="dialog" id="library-dialog"><div class="dialog-head"><div><h2>A cabinet of curiosities.</h2><p class="dialog-intro">A few starting points. No two experiments end the same.</p></div><button class="icon-button" data-close aria-label="Close library">${icon('close')}</button></div><div class="library-grid">${PRESETS.map((preset,i)=>`<button class="library-preset" data-preset="${i}"><img data-thumbnail="${i}" alt="${preset.name} chromatography study" /><div class="preset-name">${preset.name}</div><div class="preset-subtitle">${preset.subtitle}</div></button>`).join('')}</div></dialog>
  <dialog class="dialog" id="help-dialog"><div class="dialog-head"><div><h2>A mark is only the beginning.</h2><p class="dialog-intro">A small guide to getting beautifully lost.</p></div><button class="icon-button" data-close aria-label="Close guide">${icon('close')}</button></div><div class="guide-steps"><div class="guide-step"><h3>Make your mark</h3><p>Choose Draw shapes to add marks, or draw freehand directly on the paper. Drag to set a shape’s size. Move the artwork with V, clear it, or generate a composition. Imported images are cropped to their foreground.</p></div><div class="guide-step"><h3>Meet your pigments</h3><p>Each ink contains one to six components. Edit colors using HSL or HEX, or add and remove pigments. Adjust their colors, mobility, spread, saturation, and direction independently.</p></div><div class="guide-step"><h3>Just add water</h3><p>Use Water drops beside Water amount to choose the center, an edge, a corner, or precise X/Y percentages from the top-left origin. Choosing a position does not add water until you press Add a drop. Random chooses a new point within 25–75% each time. With the water tool selected, paper clicks add at that point and set the next position to Custom. Numbered guides appear only in the water tool and never in PNGs or videos; hide them with Show numbered markers. The newest eight drops are kept. Remove last or Clear water preserves your marks, ink and base progress, and can be undone.</p></div><div class="guide-step"><h3>Keep a little wonder</h3><p>Scrub Water progress, strengthen separation with Purify, or compare ten variations. Export a ${PNG_SIZE} × ${PNG_SIZE} PNG with ${PNG_DPI} DPI metadata, on white or transparent paper, or record a five-second MP4 / WebM that ends on your current image. Save effect downloads an editable JSON file with your settings, marks and imported image; Load effect restores it later for editing or video export. Loading can be undone.</p></div></div><h3>Not a blur. A separation.</h3><p>This is a generative interpretation of paper chromatography, not a laboratory fluid solver. Component-specific transport, capillary noise, local wetting fronts, and granular deposition create irregular bands while preserving the original mark. Uploaded ink softens and releases color as water reaches it, while each pigment travels independently.</p><div class="shortcut-row"><span>W · Water</span><span>B · Draw</span><span>V · Select</span><span>Space · Play / pause</span><span>⌘ Z · Undo</span><span>⌘ ⇧ Z · Redo</span></div></dialog>
  <dialog class="dialog" id="export-dialog"><div class="dialog-head"><div><h2>A little piece of possibility.</h2><p class="dialog-intro">Take your experiment out into the world.</p></div><button class="icon-button" data-close aria-label="Close export dialog">${icon('close')}</button></div><div class="export-options"><button class="export-option" data-export="white">${icon('download',24)}<div><strong>White paper</strong><span>PNG · ${PNG_SIZE} × ${PNG_SIZE} px · ${PNG_DPI} DPI · RGB</span></div>${icon('right',16)}</button><button class="export-option" data-export="transparent">${icon('layers',24)}<div><strong>Just the pigment</strong><span>Transparent PNG · ${PNG_SIZE} × ${PNG_SIZE} px · ${PNG_DPI} DPI</span></div>${icon('right',16)}</button><button class="export-option" data-export="video">${icon('play',24)}<div><strong>A bloom in motion</strong><span>5 seconds · 1920 × 1920 px · 25 FPS · MP4 / WebM</span></div>${icon('right',16)}</button></div><p id="export-progress" role="status"></p><button class="secondary" data-action="cancel-export" hidden>Cancel recording</button><p class="export-note">Print-ready resolution, with ${PNG_DPI} DPI embedded in the file. Video ends on the current image and holds it without further diffusion. Use Save effect to keep an editable JSON file, including imported artwork. Everything stays on your device.</p></dialog>
`;

let renderer;
try {
  renderer = new ChromatographyRenderer($('#paper'));
} catch (error) {
  $('#artboard').innerHTML = '<div class="error-panel"></div>';
  $('.error-panel').textContent = error.message;
  $$('[data-action="play"], [data-action="export"]').forEach(button => button.disabled = true);
}

function getParam(key) { return key.split('.').reduce((obj,k) => obj[k],state); }
function setParam(key,value) {
  if(key==='size') {
    const scale=value/state.size;
    for(const mark of state.marks) {
      for(const coordinate of ['x','y','endX','endY'])mark[coordinate]=.5+(mark[coordinate]-.5)*scale;
      mark.radius*=scale;mark.size*=scale;
      for(const point of mark.points){point.x=.5+(point.x-.5)*scale;point.y=.5+(point.y-.5)*scale;}
    }
  }
  if(key==='stroke')for(const mark of state.marks)mark.stroke*=value/state.stroke;
  if((key==='size'||key==='stroke')&&state.marks.length)state.generated=false;
  const keys=key.split('.');
  const last=keys.pop();
  const target=keys.reduce((obj,k) => obj[k],state);
  target[last]=value;
}
function formatValue(value,unit) {
  if(unit === '%') return `<strong>${Math.round(value*100)}</strong> %`;
  if(unit === 'px') return `<strong>${Math.round(value)}</strong> px`;
  if(unit === '°') return `<strong>${Math.round(value)}</strong>°`;
  return `<strong>${Number(value).toFixed(2)}</strong>`;
}
function requestRender() {
  if(rendering || !renderer) return;
  rendering=true;
  requestAnimationFrame(() => { renderer.render(state); rendering=false; });
}
function sync() {
  const components=$('#pigment-components');
  if(components.children.length!==state.pigments.length) {
    const opened=[...components.children].map(node=>node.open);
    components.innerHTML=state.pigments.map((_,i)=>componentMarkup(i)).join('');
    [...components.children].forEach((node,i)=>node.open=opened[i]||false);
  }
  $('#pigment-count').textContent=`${state.pigments.length} COLORS`;
  $('[data-action="remove-pigment"]').disabled=state.pigments.length<=1;
  $('[data-action="add-pigment"]').disabled=state.pigments.length>=MAX_PIGMENTS;
  $$('[data-hex]').forEach(input=>{
    if(input!==document.activeElement) {input.value=state.pigments[Number(input.dataset.hex)].color;input.setCustomValidity('');}
  });
  $$('[data-hsl]').forEach(input=>{
    const i=Number(input.dataset.component);
    const hsl=hslEditing?.index===i ? hslEditing.value : hexToHsl(state.pigments[i].color);
    input.value=hsl[input.dataset.hsl];
  });
  $$('[data-param]').forEach(input => {
    const value=getParam(input.dataset.param);
    input.value=value;
    if(input.type==='range') input.style.setProperty('--fill',`${(value-input.min)/(input.max-input.min)*100}%`);
  });
  $$('[data-value]').forEach(output=>output.innerHTML=formatValue(getParam(output.dataset.value),output.dataset.unit));
  $$('[data-shape]').forEach(button=>{ const active=button.dataset.shape===brushShape; button.classList.toggle('active',active); button.setAttribute('aria-pressed',active); });
  $$('[data-tool]').forEach(button=>{ const active=button.dataset.tool===tool; button.classList.toggle('active',active); button.setAttribute('aria-pressed',active); });
  $$('[data-input-mode]').forEach(button=>button.classList.toggle('active',button.dataset.inputMode===inputMode));
  $$('[data-flow]').forEach(button=>button.classList.toggle('active',button.dataset.flow===state.mode));
  $$('[data-ink]').forEach(button=>{const active=Number(button.dataset.ink)===state.inkIndex;button.classList.toggle('active',active);button.setAttribute('aria-pressed',active);});
  $$('[data-layer]').forEach(button=>{const visible=state.layers[Number(button.dataset.layer)];button.innerHTML=icon(visible?'eye':'hidden',14);button.setAttribute('aria-pressed',visible);button.closest('.layer').classList.toggle('is-hidden',!visible);});
  $$('[data-component-dot]').forEach(dot=>dot.style.setProperty('--pigment',state.pigments[Number(dot.dataset.componentDot)].color));
  $$('[data-mobility]').forEach(label=>label.textContent=`${state.pigments[Number(label.dataset.mobility)].mobility.toFixed(2)} mobility`);
  const names = INKS[state.inkIndex]?.name==='Carbon black' ? ['Rose','Slate blue','Warm ochre'] : [];
  $$('.component-name').forEach((label,i)=>label.textContent=names[i]||`Pigment ${i+1}`);
  $('#text-controls').hidden=brushShape!=='text' && state.shape!=='text';
  $('#text-input').value=state.text;
  $('#draw-hint').hidden=state.shape!=='freehand';
  $('#create-controls').hidden=inputMode!=='draw';
  $('#import-controls').hidden=inputMode!=='import';
  $('#direction-controls').hidden=state.mode!=='directional';
  $('.direction-dial').style.setProperty('--direction',`${state.direction+45}deg`);
  $('#keep-source').checked=state.keepSource;
  $('#control-stroke').disabled=!['line','ring','arc','freehand'].includes(brushShape);
  $('#import-scale-control').hidden=state.shape!=='import';
  $('#control-importScale').disabled=state.shape!=='import';
  $('#import-name').textContent=state.importName;
  $('#ink-name').textContent=state.inkIndex<0?'Custom ink':INKS[state.inkIndex].name;
  $('#ink-hex').textContent=state.ink.toUpperCase();
  $('#active-pigments').setAttribute('aria-label',`Active pigments: ${state.pigments.map(p=>p.color).join(', ')}`);
  $('#active-pigments').replaceChildren(...state.pigments.map(pigment=>{
    const chip=document.createElement('span');chip.style.background=pigment.color;chip.title=pigment.color;return chip;
  }));
  syncWaterControls();
  $('#seed-value').textContent=state.seed;
  $('#artboard').dataset.tool=tool;
  $('#canvas-hint').textContent={water:'Click anywhere on the paper to add a little water.',draw:'Draw freely. Every stroke stays on the paper.',stamp:`Click or drag to add a ${shapeLabels[brushShape].toLowerCase()}. Existing marks stay.`,move:'Drag to move the artwork across the paper.'}[tool];
  $('.workspace-hint kbd').textContent={water:'W',draw:'B',move:'V',stamp:'S'}[tool];
  updateTimeline();
  updatePlayButton();
  $$('[data-action="undo"]').forEach(button=>button.disabled=!undoStack.length);
  $$('[data-action="redo"]').forEach(button=>button.disabled=!redoStack.length);
  $$('[data-preset]').forEach(button=>{const active=Number(button.dataset.preset)===selectedPreset;button.classList.toggle('active',active);button.setAttribute('aria-pressed',active);const check=button.querySelector('.preset-check');if(check)check.innerHTML=active?icon('check',12):'';});
  $('#study-number').textContent=String((selectedPreset<0?0:selectedPreset)+1).padStart(3,'0');
  requestRender();
}
function syncWaterControls() {
  $('#drop-placement').value=state.dropPlacement;
  $$('[data-drop-coordinate]').forEach(input=>{
    if(input!==document.activeElement)input.value=Number((state.dropPosition[input.dataset.dropCoordinate]*100).toFixed(1));
  });
  $('#show-drop-markers').checked=state.showDropMarkers;
  $('#drop-count').textContent=`${state.drops.length} / ${MAX_DROPS}`;
  if(!state.drops.length)$$('.water-ring').forEach(ripple=>ripple.remove());
  const last=state.drops.at(-1);
  $('#drop-last').textContent=last ? `Last drop: X ${(last.x*100).toFixed(1)}% · Y ${(last.y*100).toFixed(1)}%` : 'Last drop: none';
  $('[data-action="remove-last"]').disabled=!state.drops.length;
  $('[data-action="clear-water"]').disabled=!state.drops.length;
  const markers=$('#water-markers');
  if(!markers)return;
  markers.hidden=tool!=='water'||!state.showDropMarkers;
  markers.replaceChildren(...state.drops.map((drop,index)=>{
    const marker=document.createElement('span');marker.className='water-marker';marker.textContent=String(index+1);
    marker.style.left=`clamp(10px, ${drop.x*100}%, calc(100% - 10px))`;
    marker.style.top=`clamp(10px, ${drop.y*100}%, calc(100% - 10px))`;
    return marker;
  }));
}
function snapshot() {
  return {state:structuredClone(state),tool,brushShape,inputMode,selectedPreset,elapsed,hasBloomed,animationMode};
}
function record() {
  if(busy || restoring)return;
  undoStack.push(snapshot());
  if(undoStack.length>30) undoStack.shift();
  redoStack.length=0;
}
function change(fn) { if(busy || restoring)return;record();if(bloomTarget){stopAnimation();bloomTarget=null;}fn();sync(); }
function status(message) { $('#render-status').textContent=message; }
function setBusy(value) {
  busy=value;
  $('.workspace').inert=value;
  $$('.header button').forEach(button=>button.disabled=value||!renderer);
  $$('[data-export]').forEach(button=>button.disabled=value||!renderer||(button.dataset.export==='video'&&!supportsVideoExport()));
}
function customInk() {state.inkIndex=-1;state.ink=mixedInk(state.pigments);selectedPreset=-1;}
function toast(message) {
  clearTimeout(toastTimer);
  $('.toast').textContent=message;
  $('.toast').classList.add('visible');
  toastTimer=setTimeout(()=>$('.toast').classList.remove('visible'),3500);
}
function setTool(next) {
  if(busy || restoring)return;
  tool=next;
  if(next==='draw') {brushShape='freehand';inputMode='draw';}
  if(next==='stamp') inputMode='draw';
  sync();
}

function updateMask(target=renderer, sample=state, image=importedImage) {
  paintMask(maskContext,sample,image);
  target?.setMask(maskCanvas,maskCanvas,sample.shape==='import');
}

function applyPreset(index) {
  change(()=>{
    stopAnimation();
    const preset=PRESETS[index];
    state={...initialState(),...Object.fromEntries(Object.entries(preset).filter(([key])=>!['name','subtitle','className'].includes(key)))};
    state.ink=INKS[preset.inkIndex].color;
    state.pigments=makePigments(INKS[preset.inkIndex].pigments);
    selectedPreset=index;
    tool='water';brushShape=state.shape;inputMode='draw';hasBloomed=false;elapsed=0;hslEditing=null;
    importedImage=null;
    updateMask();
    $('#experiment-status').textContent='A moment of possibility';
    $('#simulation-time').textContent='A slow, beautiful process.';
    $('#import-name').textContent='';
  });
  closeDialogs();
}

function openDialog(id) {
  closeDialogs();
  $(id).showModal();
}
function closeDialogs() { $$('dialog[open]').forEach(dialog=>dialog.close()); }

async function restore(saved) {
  stopAnimation();restoring=true;$('.workspace').inert=true;
  try {
    let image=null;
    if(saved.state.imported) {
      image=new Image();image.src=saved.state.imported;await image.decode();
    }
    state=structuredClone(saved.state);importedImage=image;bloomTarget=null;
    ({tool,brushShape,inputMode,selectedPreset,elapsed,hasBloomed,animationMode}=saved);
    hslEditing=null;gesture=null;
    $$('.water-ring').forEach(ripple=>ripple.remove());
    updateMask();sync();
    $('#simulation-time').textContent='Timeline · paused';
  } finally {restoring=false;$('.workspace').inert=busy;}
}
async function travelHistory(from,to) {
  if(!from.length||busy||restoring)return;
  const current=snapshot(),next=from.pop();
  try {await restore(next);to.push(current);sync();}
  catch(error){from.push(next);toast(`Could not restore this experiment: ${error.message}`);}
}
function undo() {return travelHistory(undoStack,redoStack);}
function redo() {return travelHistory(redoStack,undoStack);}

function updatePlayButton() {
  $('[data-action="play"]').innerHTML=`${icon(playing?'pause':'play',14)}<span>${playing?'Pause the moment':hasBloomed?'Let it bloom again':'Let it bloom'}</span>`;
  $('#experiment-status').textContent=playing?'Pigments finding their way':hasBloomed?'A moment, held in color':'A moment of possibility';
}
function updateTimeline() {
  const value=Math.round(state.progress/1.22*100);
  $('#water-progress').value=value;
  $('#water-progress').style.setProperty('--fill',`${value}%`);
  $('#progress-value').textContent=`${value}%`;
}
function startAnimation(mode = animationMode) {
  if(!renderer||busy||restoring)return;
  animationMode=mode;
  if(playing) return;
  playing=true;
  previousTime=0;
  updatePlayButton();status('WebGL 2 · Diffusing');
  animationFrame=requestAnimationFrame(tick);
}
function stopAnimation() { playing=false;cancelAnimationFrame(animationFrame);updatePlayButton();if(!busy)status('WebGL 2 · Paused'); }
function tick(time) {
  if(!playing) return;
  if(!previousTime) previousTime=time;
  const dt=Math.min((time-previousTime)/1000,.05);
  previousTime=time;
  elapsed+=dt;
  let complete;
  if(animationMode==='bloom') {
    seekBloom(state,bloomTarget,elapsed/5);
    complete=elapsed>=5;
    $('#simulation-time').textContent=elapsed>=4.5?'Final image · held':`${elapsed.toFixed(1)} s · Following the water`;
  } else {
    const rhythm=Math.sin(elapsed*.83+state.seed)>.83 ? .045 : .65+Math.pow(Math.max(0,Math.sin(elapsed*1.17)),6)*1.8;
    state.drops.forEach(drop=>drop.age=Math.min(22,drop.age+dt*rhythm));
    complete=state.drops.every(drop=>drop.age>=22);
    $('#simulation-time').textContent=`${elapsed.toFixed(1)} s · ${rhythm<.1?'Settling into the fibers':'Following the water'}`;
  }
  requestRender();updateTimeline();
  if(complete) {stopAnimation();bloomTarget=null;return;}
  animationFrame=requestAnimationFrame(tick);
}
function togglePlay() {
  if(busy||restoring||!renderer)return;
  if(playing) {stopAnimation();return;}
  record();
  if(!bloomTarget) {bloomTarget=structuredClone(state);seekBloom(state,bloomTarget,0);elapsed=0;}
  hasBloomed=true;
  startAnimation('bloom');
  sync();
}

function position(event) {
  const rect=$('#paper').getBoundingClientRect();
  return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
}
function addWater(p) {
  if(busy||restoring||!renderer)return;
  bloomTarget=null;
  if(p)state.dropPlacement='custom';
  state=addWaterDrop(state,p);
  const point=state.dropPosition, ripple=document.createElement('span');
  ripple.className='water-ring';ripple.style.left=`${point.x*100}%`;ripple.style.top=`${point.y*100}%`;
  $('#artboard').append(ripple);setTimeout(()=>ripple.remove(),1900);
  hasBloomed=true;startAnimation('water');
}
function removeWater(lastOnly = false) {
  if(busy||restoring||!state.drops.length)return;
  change(()=>{
    stopAnimation();state=removeWaterDrops(state,lastOnly?1:state.drops.length);
    $$('.water-ring').forEach(ripple=>ripple.remove());
  });
}
$('#artboard').addEventListener('pointerdown',event=>{
  if(!renderer||busy||restoring||event.button!==0||gesture)return;
  event.preventDefault();
  const p=position(event);
  record();
  if(tool==='water') {addWater(p);sync();return;}
  stopAnimation();bloomTarget=null;selectedPreset=-1;
  $('#artboard').setPointerCapture(event.pointerId);
  if(tool==='move') {
    gesture={id:event.pointerId,start:p,offset:{...state.offset},type:'move'};
  } else {
    const type=tool==='draw'?'freehand':brushShape;
    const local={x:p.x-state.offset.x,y:p.y-state.offset.y};
    const mark={type,...local,endX:local.x,endY:local.y,radius:state.size/6000*(type==='dot'?.28:1),stroke:state.stroke,size:state.size,text:state.text,points:[local]};
    state.marks.push(mark);state.generated=false;
    gesture={id:event.pointerId,mark,type:'mark'};
    updateMask();
  }
  sync();
});
$('#artboard').addEventListener('pointermove',event=>{
  if(!gesture||event.pointerId!==gesture.id)return;
  const p=position(event);
  if(gesture.type==='move') {
    state.offset={x:Math.max(-.8,Math.min(.8,gesture.offset.x+p.x-gesture.start.x)),y:Math.max(-.8,Math.min(.8,gesture.offset.y+p.y-gesture.start.y))};
  } else {
    const local={x:p.x-state.offset.x,y:p.y-state.offset.y}, mark=gesture.mark;
    if(mark.type==='freehand')mark.points.push(local);
    else if(mark.type!=='text') {
      mark.endX=local.x;mark.endY=local.y;
      mark.radius=Math.max(.001,Math.hypot(local.x-mark.x,local.y-mark.y));
    }
  }
  updateMask();
  requestRender();
});
function endDrawing(event) {
  if(!gesture||event.pointerId!==gesture.id)return;
  gesture=null;updateMask();sync();
}
$('#artboard').addEventListener('pointerup',endDrawing);
$('#artboard').addEventListener('pointercancel',endDrawing);
$('#artboard').addEventListener('lostpointercapture',endDrawing);

$$('[data-shape]').forEach(button=>button.addEventListener('click',()=>change(()=>{
  brushShape=button.dataset.shape;selectedPreset=-1;inputMode='draw';
  if(!['stamp','draw'].includes(tool)&&!state.marks.length&&state.shape!=='composition') {
    state.shape=brushShape;state.drops=[];state.paths=[];state.offset={x:0,y:0};
  }
  tool=brushShape==='freehand'?'draw':'stamp';
  updateMask();
})));
$$('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
$$('[data-input-mode]').forEach(button=>button.addEventListener('click',()=>{inputMode=button.dataset.inputMode;sync();}));
$$('[data-ink]').forEach(button=>button.addEventListener('click',()=>change(()=>{
  const index=Number(button.dataset.ink);state.inkIndex=index;state.ink=INKS[index].color;state.pigments=makePigments(INKS[index].pigments);selectedPreset=-1;hslEditing=null;
})));
$$('[data-flow]').forEach(button=>button.addEventListener('click',()=>change(()=>{state.mode=button.dataset.flow;selectedPreset=-1;})));
$('#drop-placement').addEventListener('change',event=>change(()=>{
  state.dropPlacement=event.target.value;
  if(state.dropPlacement!=='random')state.dropPosition=resolveDropPosition(state.dropPlacement,state.dropPosition);
}));
$$('[data-drop-coordinate]').forEach(input=>input.addEventListener('change',()=>{
  if(busy||restoring)return;
  const axis=input.dataset.dropCoordinate, value=input.valueAsNumber;
  if(!Number.isFinite(value)){input.value=Number((state.dropPosition[axis]*100).toFixed(1));return;}
  change(()=>{
    state.dropPlacement='custom';
    state.dropPosition=resolveDropPosition('custom',{...state.dropPosition,[axis]:Math.round(value*10)/1000});
    input.value=Number((state.dropPosition[axis]*100).toFixed(1));
  });
}));
$('#show-drop-markers').addEventListener('change',event=>change(()=>state.showDropMarkers=event.target.checked));
const editable='[data-param], [data-hsl], [data-hex], #water-progress';
$('#app').addEventListener('pointerdown',event=>{if(event.target.matches('input[type="range"]'))record();});
$('#app').addEventListener('keydown',event=>{
  if(event.target.matches(editable)&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))record();
  if(event.target.matches('[data-hex]')&&event.key==='Enter') {event.preventDefault();commitHex(event.target);}
});
$('#app').addEventListener('focusin',event=>{if(event.target.matches('[data-hex], input[type="color"]'))record();});
$('#app').addEventListener('change',event=>{if(event.target.matches('[data-hex]'))commitHex(event.target);});
function commitHex(input) {
  const value=input.value.trim();
  if(!/^#[0-9a-f]{6}$/i.test(value)) {
    input.setCustomValidity('Enter a six-digit HEX color, such as #f16dad.');input.reportValidity();return;
  }
  input.setCustomValidity('');hslEditing=null;
  if(bloomTarget){stopAnimation();bloomTarget=null;}
  state.pigments[Number(input.dataset.hex)].color=value.toLowerCase();customInk();sync();
}
$('#app').addEventListener('input',event=>{
  if(busy||restoring)return;
  const input=event.target;
  if(input.matches('[data-hex]')) {input.setCustomValidity('');return;}
  if(input.matches(editable)&&bloomTarget){stopAnimation();bloomTarget=null;}
  if(input.matches('[data-hsl]')) {
    const index=Number(input.dataset.component);
    if(hslEditing?.index!==index)hslEditing={index,value:hexToHsl(state.pigments[index].color)};
    hslEditing.value[input.dataset.hsl]=Number(input.value);
    state.pigments[index].color=hslToHex(hslEditing.value);customInk();sync();return;
  }
  if(input.id==='water-progress') {
    stopAnimation();scrubState(state,Number(input.value)/100);hasBloomed=true;animationMode='bloom';elapsed=state.progress/.042;
    $('#simulation-time').textContent='Timeline · paused';sync();return;
  }
  if(!input.matches('[data-param]'))return;
  setParam(input.dataset.param,input.type==='color'?input.value:Number(input.value));
  if(input.type==='color') {hslEditing=null;customInk();}
  selectedPreset=-1;
  if(['size','stroke','importScale'].includes(input.dataset.param))updateMask();
  sync();
});
$$('[data-layer]').forEach(button=>button.addEventListener('click',()=>change(()=>{const i=Number(button.dataset.layer);state.layers[i]=!state.layers[i];})));
$$('[data-preset]').forEach(button=>button.addEventListener('click',()=>applyPreset(Number(button.dataset.preset))));
$('#text-input').addEventListener('focus',record);
$('#text-input').addEventListener('input',event=>{state.text=event.target.value;updateMask();requestRender();});
$('#keep-source').addEventListener('change',event=>change(()=>state.keepSource=event.target.checked));
$$('[data-close]').forEach(button=>button.addEventListener('click',closeDialogs));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
$$('[data-nav]').forEach(button=>button.addEventListener('click',()=>{
  if(button.dataset.nav==='library')openDialog('#library-dialog');
  else if(button.dataset.nav==='about')openDialog('#help-dialog');
  else {closeDialogs();$('.workspace').scrollIntoView({behavior:'smooth',block:'nearest'});}
}));

const actions={
  help:()=>openDialog('#help-dialog'),library:()=>openDialog('#library-dialog'),export:()=>openDialog('#export-dialog'),
  undo,redo,play:togglePlay,
  'save-experiment':saveExperiment,
  'load-experiment':()=>$('#experiment-input').click(),
  reset:()=>change(()=>{
    const defaults=initialState();
    for(const key of ['amount','separation','fiber','grain','mode','direction','retention','layers','progress','drops','dropPosition','dropPlacement','showDropMarkers','randomness','speed','sourceRandomness'])state[key]=defaults[key];
    state.pigments=makePigments(state.pigments.map(p=>p.color));hslEditing=null;
    stopAnimation();hasBloomed=false;elapsed=0;updatePlayButton();toast('Diffusion reset. A fresh possibility.');
  }),
  reseed:()=>change(()=>{state.seed=1000+Math.floor(Math.random()*9000);if(state.generated)state.marks=createSeededMarks(state.seed);selectedPreset=-1;updateMask();toast('Same ink. A different journey.');}),
  clear:()=>change(()=>{
    stopAnimation();state.shape='composition';state.marks=[];state.paths=[];state.drops=[];state.imported=null;state.importName='';state.offset={x:0,y:0};state.generated=false;state.progress=0;
    state.dropPosition={x:.5,y:.5};state.dropPlacement='center';state.showDropMarkers=true;
    importedImage=null;inputMode='draw';tool='stamp';selectedPreset=-1;hasBloomed=false;elapsed=0;updateMask();toast('A clean sheet. Undo brings your marks back.');
  }),
  compose:()=>change(()=>{
    stopAnimation();state.seed=1000+Math.floor(Math.random()*9000);state.shape='composition';state.marks=createSeededMarks(state.seed);state.paths=[];state.drops=[];state.imported=null;state.importName='';state.offset={x:0,y:0};state.generated=true;state.progress=.88;
    importedImage=null;inputMode='draw';tool='water';selectedPreset=-1;hasBloomed=false;elapsed=0;updateMask();
  }),
  'add-water':()=>change(()=>addWater()),
  'remove-last':()=>removeWater(true),
  'clear-water':()=>removeWater(),
  purify:()=>change(()=>{state.separation=Math.max(.9,state.separation);state.speed=Math.max(1.35,state.speed);state.grain=Math.max(.62,state.grain);selectedPreset=-1;addWater();toast('Stronger separation. Let the pigments travel.');}),
  'add-pigment':()=>{
    if(state.pigments.length>=MAX_PIGMENTS)return;
    change(()=>{
      const hsl=hexToHsl(state.pigments.at(-1).color);hsl.h=(hsl.h+57)%360;hsl.s=Math.max(35,hsl.s);hsl.l=Math.min(75,Math.max(35,hsl.l));
      const colors=[...state.pigments.map(p=>p.color),hslToHex(hsl)];state.pigments.push(makePigments(colors).at(-1));hslEditing=null;customInk();
    });
  },
  'remove-pigment':()=>{if(state.pigments.length>1)change(()=>{state.pigments.pop();hslEditing=null;customInk();});},
  variations:generateVariations,
  'close-variations':()=>{$('#variations-panel').hidden=true;},
  'cancel-export':()=>exportController?.abort(),
  'zoom-in':()=>setZoom(Math.min(150,zoom+10)),
  'zoom-out':()=>setZoom(Math.max(50,zoom-10)),
  fullscreen:async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('#stage').requestFullscreen();}catch{toast('Fullscreen is not available in this browser.');}},
};
$$('[data-action]').forEach(button=>button.addEventListener('click',()=>actions[button.dataset.action]?.()));
function setZoom(value) {zoom=value;$('#zoom-value').textContent=`${zoom}%`;$('#artboard-wrap').style.transform=`scale(${zoom/100})`;}

document.addEventListener('keydown',event=>{
  if(busy||restoring||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)||$('dialog[open]'))return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if(event.metaKey||event.ctrlKey||event.altKey)return;
  if(event.key===' '){event.preventDefault();togglePlay();}
  const tools={w:'water',b:'draw',v:'move',s:'stamp'};
  if(tools[event.key.toLowerCase()])setTool(tools[event.key.toLowerCase()]);
});

function saveExperiment() {
  if(busy||restoring||!renderer)return;
  stopAnimation();bloomTarget=null;
  try {
    const data=serializeExperiment(snapshot());
    downloadBlob(new Blob([data],{type:'application/json'}),`chroma-${state.seed}.chroma.json`);
    toast('Effect saved. Load this JSON file to keep editing later.');
  } catch(error) {toast(`Could not save this effect: ${error.message}`);}
}
async function loadExperiment(file) {
  if(!file||busy||restoring||!renderer)return;
  if(file.size>MAX_EXPERIMENT_BYTES){toast('Please choose an effect file smaller than 32 MB.');return;}
  const wasPlaying=playing;
  stopAnimation();setBusy(true);status('Loading effect…');
  const previous=snapshot();
  let loaded=false;
  try {
    const saved=parseExperiment(await file.text());
    await restore(saved);
    undoStack.push(previous);if(undoStack.length>30)undoStack.shift();redoStack.length=0;
    $('#variations-panel').hidden=true;variations=[];
    sync();loaded=true;status('Effect loaded · Ready');
    toast('Effect loaded. Keep editing, export a video, or Undo to go back.');
  } catch(error) {toast(`Could not load this effect: ${error.message}`);status('Effect not loaded');}
  finally {setBusy(false);if(!loaded&&wasPlaying)startAnimation();}
}
$('#experiment-input').addEventListener('change',event=>{loadExperiment(event.target.files[0]);event.target.value='';});

async function importFile(file) {
  if(!file||busy||restoring||!renderer)return;
  if(/\.json$/i.test(file.name)){await loadExperiment(file);return;}
  if(file.size>10*1024*1024){toast('Please choose an image smaller than 10 MB.');return;}
  if(!/\.(svg|png|jpe?g|webp)$/i.test(file.name)){toast('Choose an SVG, PNG, JPG, or WebP image.');return;}
  const wasPlaying=playing;
  stopAnimation();setBusy(true);status('Extracting the foreground…');
  let imported=false;
  try {
    if(/\.svg$/i.test(file.name)) {
      const text=await file.text();
      const doc=new DOMParser().parseFromString(text,'image/svg+xml');
      if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg')throw new Error('This SVG could not be read.');
      if(doc.querySelector('script, foreignObject, image, use[href^="http"], use[href^="//"]')||/<!DOCTYPE|<!ENTITY|@import|url\(\s*['"]?(?:https?:|\/\/)|(?:href|src)\s*=\s*['"]\s*(?:https?:|\/\/)/i.test(text))throw new Error('Please use a self-contained SVG without scripts or external resources.');
    }
    const url=URL.createObjectURL(file);
    const img=new Image();
    try{img.src=url;await img.decode();}finally{URL.revokeObjectURL(url);}
    if(img.width>16000||img.height>16000||img.width*img.height>80000000)throw new Error('Please resize this image to under 16,000 px and 80 megapixels.');
    const {source}=prepareImportedImage(img);
    const data=source.toDataURL('image/png');
    setBusy(false);
    change(()=>{
      importedImage=source;state.imported=data;state.importName=file.name;state.importScale=1;state.shape='import';state.size=1250;state.keepSource=true;state.marks=[];state.paths=[];state.offset={x:0,y:0};state.generated=false;state.progress=0;
      state.dropPlacement='center';state.dropPosition={x:.5,y:.5};
      selectedPreset=-1;inputMode='import';tool='water';state.drops=[];elapsed=0;updateMask();addWater();
    });
    imported=true;toast('Foreground extracted and cropped. A little water is finding its way.');
  }catch(error){toast(error.message||'This image could not be imported. Please try another file.');}
  finally {setBusy(false);if(!imported&&wasPlaying)startAnimation();else if(!imported)status('WebGL 2 · Ready');}
}
$('#upload-zone').addEventListener('click',()=>$('#file-input').click());
$('#upload-zone').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('#file-input').click();}});
$('#file-input').addEventListener('change',event=>{importFile(event.target.files[0]);event.target.value='';});
$('#upload-zone').addEventListener('dragover',event=>{event.preventDefault();$('#upload-zone').classList.add('dragover');});
$('#upload-zone').addEventListener('dragleave',()=>$('#upload-zone').classList.remove('dragover'));
$('#upload-zone').addEventListener('drop',event=>{event.preventDefault();$('#upload-zone').classList.remove('dragover');importFile(event.dataTransfer.files[0]);});
$('#artboard').addEventListener('dragover',event=>event.preventDefault());
$('#artboard').addEventListener('drop',event=>{event.preventDefault();importFile(event.dataTransfer.files[0]);});

$$('[data-export]').forEach(button=>button.addEventListener('click',()=>exportArtwork(button.dataset.export)));
async function exportArtwork(format) {
  if(busy||restoring||!renderer)return;
  stopAnimation();bloomTarget=null;setBusy(true);
  const sample=structuredClone(state), canvas=document.createElement('canvas');
  const video=format==='video', transparent=format==='transparent';
  let output;
  exportController=new AbortController();
  $('[data-action="cancel-export"]').hidden=!video;
  const report=message=>{$('#export-progress').textContent=message;status(message);};
  report(video?'Preparing a 5-second recording…':`Rendering ${PNG_SIZE} × ${PNG_SIZE} PNG…`);
  try {
    await new Promise(resolve=>requestAnimationFrame(resolve));
    output=new ChromatographyRenderer(canvas);updateMask(output,sample);
    if(video) {
      const frame=structuredClone(sample);
      seekBloom(frame,sample,0);output.render(frame,1920);
      const {blob,extension}=await recordCanvasVideo({canvas,signal:exportController.signal,
        renderFrame:fraction=>{seekBloom(frame,sample,fraction);output.render(frame,1920);},
        onProgress:fraction=>report(`Recording · ${Math.round(fraction*100)}% · 1920 × 1920 / 25 FPS`),
      });
      downloadBlob(blob,`chroma-${sample.seed}-5s.${extension}`);
      report(`${extension.toUpperCase()} exported · 5 seconds`);
    } else {
      output.render(sample,PNG_SIZE,transparent);
      if(output.gl.drawingBufferWidth!==PNG_SIZE||output.gl.drawingBufferHeight!==PNG_SIZE)throw new Error('This device cannot render a 4000 × 4000 image.');
      const blob=await canvasToPrintPng(canvas);
      downloadBlob(blob,`chroma-${sample.shape}-${sample.seed}${transparent?'-transparent':''}-${PNG_DPI}dpi.png`);
      report(`PNG exported · ${PNG_SIZE} × ${PNG_SIZE} · ${PNG_DPI} DPI`);
    }
    exportController=null;closeDialogs();toast('Exported. Your artwork stays on your device.');
  } catch(error) {
    const message=error.name==='AbortError'?'Recording cancelled.':`Export failed: ${error.message}`;
    report(message);toast(message);
  } finally {
    output?.dispose();exportController=null;setBusy(false);$('[data-action="cancel-export"]').hidden=true;
    $('#simulation-time').textContent='Final image · held';
  }
}
$('#export-dialog').addEventListener('close',()=>exportController?.abort());
document.addEventListener('visibilitychange',()=>{if(document.hidden)exportController?.abort();});

async function generateVariations() {
  if(busy||restoring||!renderer)return;
  const wasPlaying=playing;stopAnimation();
  const base=snapshot(), image=importedImage, results=[];
  setBusy(true);status('Generating ten variations…');
  const canvas=document.createElement('canvas');let preview;
  try {
    preview=new ChromatographyRenderer(canvas);
    for(const seed of variationSeeds(base.state.seed)) {
      const saved=structuredClone(base);saved.state.seed=seed;saved.selectedPreset=-1;
      if(saved.state.generated)saved.state.marks=createSeededMarks(seed);
      updateMask(preview,saved.state,image);preview.render(saved.state,224);
      results.push({saved,src:canvas.toDataURL('image/png')});
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    variations=results;
    $('#variation-grid').replaceChildren(...results.map(({saved,src},index)=>{
      const button=document.createElement('button');button.className='variation';button.dataset.variation=index;
      button.setAttribute('aria-label',`Use variation ${index+1}, seed ${saved.state.seed}`);
      const img=new Image();img.src=src;img.alt=`Chromatography seed ${saved.state.seed}`;
      const label=document.createElement('span');label.textContent=`Seed ${saved.state.seed}`;
      button.append(img,label);return button;
    }));
    $('#variations-panel').hidden=false;status('Ten variations ready');
  } catch(error) {toast(`Could not generate variations: ${error.message}`);status('Preview failed');}
  finally {preview?.dispose();setBusy(false);if(wasPlaying)startAnimation();}
}
$('#variation-grid').addEventListener('click',async event=>{
  const button=event.target.closest('[data-variation]');
  if(!button||busy||restoring)return;
  record();
  try {await restore(variations[Number(button.dataset.variation)].saved);toast('Variation selected. Undo restores your previous experiment.');}
  catch(error){toast(`Could not select this variation: ${error.message}`);}
});

function makeThumbnails() {
  if(!renderer)return;
  const canvas=document.createElement('canvas');
  const preview=new ChromatographyRenderer(canvas);
  PRESETS.forEach((preset,index)=>{
    const sample={...initialState(),...preset,ink:INKS[preset.inkIndex].color,pigments:makePigments(INKS[preset.inkIndex].pigments)};
    preview.render(sample,260);
    thumbnails[index]=canvas.toDataURL('image/png');
  });
  $$('[data-thumbnail]').forEach(img=>img.src=thumbnails[Number(img.dataset.thumbnail)]);
  preview.dispose();
}

sync();
setBusy(false);
if(!supportsVideoExport())$('#export-progress').textContent='Video recording is unavailable in this browser. PNG export is still available.';
if(!renderer){$('.workspace').inert=true;status('WebGL 2 unavailable');}
requestAnimationFrame(makeThumbnails);
