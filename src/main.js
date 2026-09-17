import './style.css';
import { icon } from './icons.js';
import { ChromatographyRenderer } from './renderer.js';
import { initialState, INKS, PRESETS, makePigments } from './presets.js';
import { canvasToPrintPng, downloadBlob } from './export.js';

let state = initialState();
let tool = 'water';
let inputMode = 'draw';
let playing = false;
let animationMode = 'bloom';
let hasBloomed = false;
let zoom = 100;
let selectedPreset = 0;
let rendering = false;
let elapsed = 0;
let previousTime = 0;
let toastTimer;
let drawing = false;
let currentPath;
const undoStack = [];
const redoStack = [];
const thumbnails = [];
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const shapeLabels = { dot: 'Dot', line: 'Line', circle: 'Circle', ring: 'Ring', arc: 'Arc', polygon: 'Organic', freehand: 'Draw', text: 'Text' };
const maskCanvas = document.createElement('canvas');
maskCanvas.width = maskCanvas.height = 768;
const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
let importedImage = null;

function rangeControl(label, key, min, max, step, unit = '', endpoints = '') {
  return `<div class="control"><label class="control-label" for="control-${key}"><span>${label}</span><output data-value="${key}" data-unit="${unit}"></output></label><input id="control-${key}" type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}" />${endpoints ? `<div class="param-end-labels"><span>${endpoints.split('|')[0]}</span><span>${endpoints.split('|')[1]}</span></div>` : ''}</div>`;
}

function componentMarkup(i, name) {
  return `<details class="component"><summary><span class="component-dot" data-component-dot="${i}"></span><span class="component-name">${name}</span><span class="mobility-caption" data-mobility="${i}"></span>${icon('chevron',12)}</summary><div class="component-controls"><label class="color-control">Pigment color <input type="color" data-param="pigments.${i}.color" aria-label="${name} color" /></label>${rangeControl('Mobility',`pigments.${i}.mobility`,.05,1.5,.01)}${rangeControl('Spread',`pigments.${i}.spread`,.05,1,.01)}${rangeControl('Opacity',`pigments.${i}.opacity`,0,1,.01)}${rangeControl('Saturation',`pigments.${i}.saturation`,0,1.5,.01)}${rangeControl('Direction offset',`pigments.${i}.direction`,-180,180,1,'°')}</div></details>`;
}

$('#app').innerHTML = `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="roughen"><feTurbulence type="fractalNoise" baseFrequency=".14" numOctaves="3" seed="4" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5"/></filter></svg>
  <header class="header">
    <a class="brand" href="/" aria-label="Chroma home"><span class="brand-mark"></span><div class="brand-copy"><div class="wordmark">chroma</div><div class="brand-tag">A PLAYGROUND FOR PIGMENT</div></div></a>
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
          ${rangeControl('Size','size',150,1600,10,'px')}${rangeControl('Stroke weight','stroke',5,160,1,'px')}
        </section>
        <section class="panel-section"><div class="section-heading"><span><span class="number">02</span> A drop of ink</span>${icon('drop',13)}</div><div class="ink-swatches">${INKS.map((ink,i)=>`<button class="ink-swatch ${i===0?'active':''}" style="--swatch:${ink.color}" data-ink="${i}" aria-label="${ink.name}" aria-pressed="${i===0}" title="${ink.name}"></button>`).join('')}</div><div class="ink-caption"><span id="ink-name">Carbon black</span><span id="ink-hex">#282925</span></div><p class="ink-note">${icon('spark',12)}<span>One ink. A hidden world of colors.<br/>Each ink holds 3 pigment components.</span></p></section>
        <section class="panel-section presets-section"><div class="section-heading"><span><span class="number">03</span> A little inspiration</span></div><div class="preset-list">${PRESETS.slice(0,3).map((preset,i)=>`<button class="preset ${i===0?'active':''}" data-preset="${i}"><img class="preset-art" data-thumbnail="${i}" alt="" /><div><div class="preset-name">${preset.name}</div><div class="preset-subtitle">${preset.subtitle}</div></div><span class="preset-check">${i===0?icon('check',12):''}</span></button>`).join('')}</div><button class="all-presets" data-action="library">Explore all experiments ${icon('right',10)}</button></section>
        <div class="panel-footnote">A little less control.<br/>A little more wonder.</div>
      </aside>
      <section class="studio" aria-label="Chromatography canvas">
        <div class="studio-top"><div class="document-title">${icon('layers',14)}<span>Untitled experiment</span><span class="edited" title="Local experiment">·</span></div><span class="paper-badge">THE PAPER IS YOURS</span></div>
        <div class="stage" id="stage"><div class="toolbar" role="toolbar" aria-label="Canvas tools"><button class="icon-button" data-tool="move" aria-label="Select tool" title="Select (V)">${icon('cursor',15)}</button><button class="icon-button" data-tool="draw" aria-label="Freehand drawing tool" title="Draw (B)">${icon('draw',15)}</button><span class="toolbar-divider"></span><button class="water-tool active" data-tool="water" aria-pressed="true" title="Add water (W)">${icon('drop',14)} Add water</button><span class="toolbar-divider"></span><button class="icon-button" data-action="undo" aria-label="Undo" title="Undo (⌘Z)" disabled>${icon('undo',14)}</button><button class="icon-button" data-action="redo" aria-label="Redo" title="Redo (⌘⇧Z)" disabled>${icon('redo',14)}</button></div>
          <div class="artboard-wrap" id="artboard-wrap"><i class="paper-corner tl"></i><i class="paper-corner tr"></i><i class="paper-corner bl"></i><i class="paper-corner br"></i><div class="artboard" id="artboard" data-tool="water"><canvas id="paper" width="1100" height="1100" aria-label="Interactive paper chromatography artwork. Click to add water, or select Draw to make a mark."></canvas></div></div>
        </div>
        <div class="studio-bottom"><span class="dimensions">3000 <span class="dim-cross">×</span> 3000 px <span class="dim-divider"></span> 300 DPI <span class="dim-divider"></span> RGB</span><div class="zoom-tools"><button class="icon-button" data-action="zoom-out" aria-label="Zoom out">${icon('minus',12)}</button><output id="zoom-value">100%</output><button class="icon-button" data-action="zoom-in" aria-label="Zoom in">${icon('plus',12)}</button></div><button class="icon-button" data-action="fullscreen" aria-label="Toggle canvas fullscreen" title="Fullscreen">${icon('expand',14)}</button></div>
        <div class="workspace-hint">${icon('drop',13)}<span id="canvas-hint">Click anywhere on the paper to add a little water.</span><kbd>W</kbd></div>
      </section>
      <aside class="panel settings-panel" aria-label="Diffusion settings"><div class="settings-heading"><span>The art of diffusion</span><button class="icon-button" data-action="reset" aria-label="Reset diffusion settings" title="Reset diffusion settings">${icon('reset',14)}</button></div>
        <section class="panel-section"><div class="section-heading"><span>Flow direction</span><span class="tiny-tag">FOLLOW THE WATER</span></div><div class="segmented"><button data-flow="radial" class="active">${icon('ring',11)} Radial</button><button data-flow="directional">${icon('arrow',11)} Directional</button></div><div class="direction-controls" id="direction-controls" hidden><span class="direction-dial">${icon('arrow',14)}</span>${rangeControl('Angle','direction',0,360,1,'°')}</div>${rangeControl('Water amount','amount',.1,1.5,.01,'%')}${rangeControl('Color separation','separation',0,1,.01,'%')}${rangeControl('Paper fibers','fiber',0,1,.01,'%')}${rangeControl('Pigment granulation','grain',0,1,.01,'%')}</section>
        <section class="panel-section"><div class="section-heading"><span>Pigment components</span><span class="tiny-tag">3 COLORS</span></div>${componentMarkup(0,'Rose')}${componentMarkup(1,'Slate blue')}${componentMarkup(2,'Warm ochre')}<div class="mini-help">${icon('help',11)}<span>Different pigments travel at different speeds.<br/>Open a component to make it your own.</span></div></section>
        <section class="panel-section layers-section"><div class="section-heading"><span class="layers-heading">Layers</span><span class="tiny-tag">THE ANATOMY OF A BLOOM</span></div>${['Original mark','Separated pigments','Water diffusion'].map((label,i)=>`<div class="layer" data-layer-row="${i}"><span class="layer-thumbnail ${['original','pigment','diffusion'][i]}"></span><span>${label}</span><button class="icon-button" data-layer="${i}" aria-label="Toggle ${label.toLowerCase()}" aria-pressed="true" title="Show / hide ${label.toLowerCase()}">${icon('eye',14)}</button></div>`).join('')}</section>
        <div class="simulation-actions"><button class="bloom-button" data-action="play">${icon('play',14)}<span>Let it bloom</span></button><div class="simulation-meta"><span id="simulation-time">A slow, beautiful process.</span><button class="seed-button" data-action="reseed" title="Generate a new variation">${icon('shuffle',12)} Seed <span id="seed-value">2847</span></button></div></div>
      </aside>
    </div>
    <footer class="footer"><span class="footer-left">${icon('spark',12)} Inspired by paper chromatography. Shaped by a little unpredictability.</span><span class="footer-right"><span>Made for the unexpected.</span><span class="small-logo">chroma</span><span class="beta">LAB 01</span></span></footer>
  </main>
  <input id="file-input" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" hidden />
  <div class="toast" role="status" aria-live="polite"></div>
  <dialog class="dialog" id="library-dialog"><div class="dialog-head"><div><h2>A cabinet of curiosities.</h2><p class="dialog-intro">A few starting points. No two experiments end the same.</p></div><button class="icon-button" data-close aria-label="Close library">${icon('close')}</button></div><div class="library-grid">${PRESETS.map((preset,i)=>`<button class="library-preset" data-preset="${i}"><img data-thumbnail="${i}" alt="${preset.name} chromatography study" /><div class="preset-name">${preset.name}</div><div class="preset-subtitle">${preset.subtitle}</div></button>`).join('')}</div></dialog>
  <dialog class="dialog" id="help-dialog"><div class="dialog-head"><div><h2>A mark is only the beginning.</h2><p class="dialog-intro">A small guide to getting beautifully lost.</p></div><button class="icon-button" data-close aria-label="Close guide">${icon('close')}</button></div><div class="guide-steps"><div class="guide-step"><h3>Make your mark</h3><p>Choose a shape, draw on the paper, type a symbol, or import an SVG or bitmap. One sample, endless possibilities.</p></div><div class="guide-step"><h3>Meet your pigments</h3><p>Each ink contains three components. Adjust their colors, mobility, spread, saturation, and direction independently.</p></div><div class="guide-step"><h3>Just add water</h3><p>With Add water selected, click the paper. The wetting front moves out from your click, carrying pigments along uneven fibers. Click near your mark to see separation sooner.</p></div><div class="guide-step"><h3>Keep a little wonder</h3><p>Pause at the moment you love. Export a 3000 × 3000 PNG with 300 DPI metadata, on pure white or with a transparent background.</p></div></div><h3>Not a blur. A separation.</h3><p>This is a generative interpretation of paper chromatography, not a laboratory fluid solver. Component-specific transport, capillary noise, local wetting fronts, and granular deposition create irregular bands while preserving the original mark. No Gaussian blur or paper-texture overlay is used.</p><div class="shortcut-row"><span>W · Water</span><span>B · Draw</span><span>V · Select</span><span>Space · Play / pause</span><span>⌘ Z · Undo</span><span>⌘ ⇧ Z · Redo</span></div></dialog>
  <dialog class="dialog" id="export-dialog"><div class="dialog-head"><div><h2>A little piece of possibility.</h2><p class="dialog-intro">Take your experiment out into the world.</p></div><button class="icon-button" data-close aria-label="Close export dialog">${icon('close')}</button></div><div class="export-options"><button class="export-option" data-export="white">${icon('download',24)}<div><strong>White paper</strong><span>PNG · 3000 × 3000 px · 300 DPI · RGB</span></div>${icon('right',16)}</button><button class="export-option" data-export="transparent">${icon('layers',24)}<div><strong>Just the pigment</strong><span>Transparent PNG · 3000 × 3000 px · 300 DPI</span></div>${icon('right',16)}</button></div><p class="export-note">Print-ready resolution, with 300 DPI embedded in the file. Perfect for combining individual studies in Photoshop. Your artwork stays on your device.</p></dialog>
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
  $$('[data-param]').forEach(input => {
    const value=getParam(input.dataset.param);
    input.value=value;
    if(input.type==='range') input.style.setProperty('--fill',`${(value-input.min)/(input.max-input.min)*100}%`);
  });
  $$('[data-value]').forEach(output=>output.innerHTML=formatValue(getParam(output.dataset.value),output.dataset.unit));
  $$('[data-shape]').forEach(button=>{ const active=button.dataset.shape===state.shape; button.classList.toggle('active',active); button.setAttribute('aria-pressed',active); });
  $$('[data-tool]').forEach(button=>{ const active=button.dataset.tool===tool; button.classList.toggle('active',active); button.setAttribute('aria-pressed',active); });
  $$('[data-input-mode]').forEach(button=>button.classList.toggle('active',button.dataset.inputMode===inputMode));
  $$('[data-flow]').forEach(button=>button.classList.toggle('active',button.dataset.flow===state.mode));
  $$('[data-ink]').forEach(button=>{const active=Number(button.dataset.ink)===state.inkIndex;button.classList.toggle('active',active);button.setAttribute('aria-pressed',active);});
  $$('[data-layer]').forEach(button=>{const visible=state.layers[Number(button.dataset.layer)];button.innerHTML=icon(visible?'eye':'hidden',14);button.setAttribute('aria-pressed',visible);button.closest('.layer').classList.toggle('is-hidden',!visible);});
  $$('[data-component-dot]').forEach(dot=>dot.style.setProperty('--pigment',state.pigments[Number(dot.dataset.componentDot)].color));
  $$('[data-mobility]').forEach(label=>label.textContent=`${state.pigments[Number(label.dataset.mobility)].mobility.toFixed(2)} mobility`);
  const names = state.inkIndex===0 ? ['Rose','Slate blue','Warm ochre'] : ['Pigment 01','Pigment 02','Pigment 03'];
  $$('.component-name').forEach((label,i)=>label.textContent=names[i]);
  $('#text-controls').hidden=state.shape!=='text';
  $('#text-input').value=state.text;
  $('#draw-hint').hidden=state.shape!=='freehand';
  $('#create-controls').hidden=inputMode!=='draw';
  $('#import-controls').hidden=inputMode!=='import';
  $('#direction-controls').hidden=state.mode!=='directional';
  $('.direction-dial').style.setProperty('--direction',`${state.direction+45}deg`);
  $('#keep-source').checked=state.keepSource;
  $('#control-stroke').disabled=!['line','ring','arc','freehand'].includes(state.shape);
  $('#ink-name').textContent=INKS[state.inkIndex].name;
  $('#ink-hex').textContent=state.ink.toUpperCase();
  $('#seed-value').textContent=state.seed;
  $('#artboard').dataset.tool=tool;
  $('#canvas-hint').textContent=tool==='water'?'Click anywhere on the paper to add a little water.':tool==='draw'?'Make a mark on the paper. Let the pigments do the rest.':'Explore your experiment. Choose water or draw to make a mark.';
  $('.workspace-hint kbd').textContent={water:'W',draw:'B',move:'V'}[tool];
  $$('[data-action="undo"]').forEach(button=>button.disabled=!undoStack.length);
  $$('[data-action="redo"]').forEach(button=>button.disabled=!redoStack.length);
  $$('.preset').forEach(button=>{const active=Number(button.dataset.preset)===selectedPreset;button.classList.toggle('active',active);button.querySelector('.preset-check').innerHTML=active?icon('check',12):'';});
  requestRender();
}
function record() {
  undoStack.push(structuredClone(state));
  if(undoStack.length>30) undoStack.shift();
  redoStack.length=0;
}
function change(fn) { record();fn();sync(); }
function toast(message) {
  clearTimeout(toastTimer);
  $('.toast').textContent=message;
  $('.toast').classList.add('visible');
  toastTimer=setTimeout(()=>$('.toast').classList.remove('visible'),3500);
}
function setTool(next) {
  tool=next;
  if(next==='draw' && state.shape!=='freehand') {
    change(()=>{state.shape='freehand';state.paths=[];inputMode='draw';state.stroke=Math.max(35,state.stroke);selectedPreset=-1;updateMask();});
  }
  sync();
}

function updateMask() {
  maskContext.clearRect(0,0,768,768);
  maskContext.fillStyle='#000';
  maskContext.strokeStyle='#000';
  maskContext.lineCap='round';
  maskContext.lineJoin='round';
  if(state.shape==='text') {
    const fontSize=state.size/3000*768;
    maskContext.font=`${fontSize}px Georgia, serif`;
    maskContext.textAlign='center';
    maskContext.textBaseline='middle';
    maskContext.fillText(state.text,384,384,630);
  } else if(state.shape==='freehand') {
    maskContext.lineWidth=state.stroke/3000*768;
    for(const path of state.paths) {
      maskContext.beginPath();
      const scale=state.size/900;
      path.forEach((p,i)=>{
        const x=((p.x-.5)*scale+.5)*768,y=((p.y-.5)*scale+.5)*768;
        if(i===0)maskContext.moveTo(x,y);else maskContext.lineTo(x,y);
      });
      if(path.length===1) maskContext.lineTo(((path[0].x-.5)*scale+.5)*768+.01,((path[0].y-.5)*scale+.5)*768+.01);
      maskContext.stroke();
    }
  } else if(state.shape==='import' && importedImage) {
    const scale=(state.size/3000*768)/Math.max(importedImage.width,importedImage.height);
    const width=importedImage.width*scale,height=importedImage.height*scale;
    maskContext.drawImage(importedImage,(768-width)/2,(768-height)/2,width,height);
  }
  if(renderer) renderer.setMask(maskCanvas);
}

function applyPreset(index) {
  change(()=>{
    stopAnimation();
    const preset=PRESETS[index];
    state={...initialState(),...Object.fromEntries(Object.entries(preset).filter(([key])=>!['name','subtitle','className'].includes(key)))};
    state.ink=INKS[preset.inkIndex].color;
    state.pigments=makePigments(INKS[preset.inkIndex].pigments);
    selectedPreset=index;
    tool='water';inputMode='draw';hasBloomed=false;
    $('#study-number').textContent=String(index+1).padStart(3,'0');
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

async function restore(snapshot) {
  stopAnimation();
  state=snapshot;
  inputMode=state.shape==='import'?'import':'draw';
  if(state.imported) {
    const img=new Image();
    img.src=state.imported;
    await img.decode();
    importedImage=img;
  }
  updateMask();
  sync();
}
function undo() {
  if(!undoStack.length) return;
  redoStack.push(structuredClone(state));
  restore(undoStack.pop());
}
function redo() {
  if(!redoStack.length) return;
  undoStack.push(structuredClone(state));
  restore(redoStack.pop());
}

function updatePlayButton() {
  $('[data-action="play"]').innerHTML=`${icon(playing?'pause':'play',14)}<span>${playing?'Pause the moment':hasBloomed?'Let it bloom again':'Let it bloom'}</span>`;
  $('#experiment-status').textContent=playing?'Pigments finding their way':hasBloomed?'A moment, held in color':'A moment of possibility';
}
function startAnimation(mode = animationMode) {
  animationMode=mode;
  if(playing) return;
  playing=true;
  previousTime=0;
  updatePlayButton();
  requestAnimationFrame(tick);
}
function stopAnimation() { playing=false;updatePlayButton(); }
function tick(time) {
  if(!playing) return;
  if(!previousTime) previousTime=time;
  const dt=Math.min((time-previousTime)/1000,.05);
  previousTime=time;
  elapsed+=dt;
  const rhythm=Math.sin(elapsed*.83+state.seed)>.83 ? .045 : .65+Math.pow(Math.max(0,Math.sin(elapsed*1.17)),6)*1.8;
  if(animationMode==='bloom')state.progress=Math.min(1.22,state.progress+dt*.042*rhythm);
  state.drops.forEach(drop=>drop.age=Math.min(22,drop.age+dt*rhythm));
  $('#simulation-time').textContent=`${elapsed.toFixed(1)} s · ${rhythm<.1?'Settling into the fibers':'Following the water'}`;
  requestRender();
  if((animationMode==='water'||state.progress>=1.22) && state.drops.every(drop=>drop.age>=18)) {stopAnimation();return;}
  requestAnimationFrame(tick);
}
function togglePlay() {
  if(playing) {stopAnimation();return;}
  record();
  if(!hasBloomed || state.progress>=1.2) {state.progress=.02;state.drops=[];elapsed=0;}
  hasBloomed=true;
  startAnimation('bloom');
  sync();
}

function position(event) {
  const rect=$('#paper').getBoundingClientRect();
  return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
}
$('#artboard').addEventListener('pointerdown',event=>{
  if(!renderer || event.button!==0) return;
  const p=position(event);
  if(tool==='water') {
    record();
    if(state.drops.length===8) state.drops.shift();
    state.drops.push({...p,age:0});
    const ripple=document.createElement('span');
    ripple.className='water-ring';ripple.style.left=`${p.x*100}%`;ripple.style.top=`${p.y*100}%`;
    $('#artboard').append(ripple);setTimeout(()=>ripple.remove(),1900);
    hasBloomed=true;startAnimation('water');sync();
  } else if(tool==='draw') {
    record();drawing=true;currentPath=[drawingPosition(p)];state.paths.push(currentPath);
    $('#artboard').setPointerCapture(event.pointerId);
    updateMask();sync();
  }
});
function drawingPosition(p) {
  const scale=state.size/900;
  return {x:(p.x-.5)/scale+.5,y:(p.y-.5)/scale+.5};
}
$('#artboard').addEventListener('pointermove',event=>{
  if(!drawing) return;
  currentPath.push(drawingPosition(position(event)));
  updateMask();requestRender();
});
function endDrawing() {if(!drawing)return;drawing=false;currentPath=null;updateMask();sync();}
$('#artboard').addEventListener('pointerup',endDrawing);
$('#artboard').addEventListener('pointercancel',endDrawing);
$('#artboard').addEventListener('lostpointercapture',endDrawing);

$$('[data-shape]').forEach(button=>button.addEventListener('click',()=>change(()=>{
  state.shape=button.dataset.shape;selectedPreset=-1;state.drops=[];
  tool=state.shape==='freehand'?'draw':'water';
  if(state.shape==='freehand'){state.paths=[];state.stroke=Math.max(35,state.stroke);}
  if(['text','freehand'].includes(state.shape))updateMask();
})));
$$('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
$$('[data-input-mode]').forEach(button=>button.addEventListener('click',()=>{inputMode=button.dataset.inputMode;sync();}));
$$('[data-ink]').forEach(button=>button.addEventListener('click',()=>change(()=>{
  const index=Number(button.dataset.ink);state.inkIndex=index;state.ink=INKS[index].color;state.pigments=makePigments(INKS[index].pigments);selectedPreset=-1;
})));
$$('[data-flow]').forEach(button=>button.addEventListener('click',()=>change(()=>{state.mode=button.dataset.flow;selectedPreset=-1;})));
$$('[data-param]').forEach(input=>{
  input.addEventListener('pointerdown',record);
  input.addEventListener('keydown',event=>{if(event.key.startsWith('Arrow'))record();});
  input.addEventListener('input',()=>{
    setParam(input.dataset.param,input.type==='color'?input.value:Number(input.value));
    selectedPreset=-1;
    if(['size','stroke'].includes(input.dataset.param)&&['text','freehand','import'].includes(state.shape))updateMask();
    sync();
  });
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
  reset:()=>change(()=>{
    const defaults=initialState();
    for(const key of ['amount','separation','fiber','grain','mode','direction','retention','layers','progress','drops'])state[key]=defaults[key];
    state.pigments=makePigments(INKS[state.inkIndex].pigments);
    stopAnimation();hasBloomed=false;elapsed=0;updatePlayButton();toast('Diffusion reset. A fresh possibility.');
  }),
  reseed:()=>change(()=>{state.seed=1000+Math.floor(Math.random()*9000);selectedPreset=-1;toast('Same ink. A different journey.');}),
  'zoom-in':()=>setZoom(Math.min(150,zoom+10)),
  'zoom-out':()=>setZoom(Math.max(50,zoom-10)),
  fullscreen:async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('#stage').requestFullscreen();}catch{toast('Fullscreen is not available in this browser.');}},
};
$$('[data-action]').forEach(button=>button.addEventListener('click',()=>actions[button.dataset.action]?.()));
function setZoom(value) {zoom=value;$('#zoom-value').textContent=`${zoom}%`;$('#artboard-wrap').style.transform=`scale(${zoom/100})`;}

document.addEventListener('keydown',event=>{
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)||$('dialog[open]'))return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if(event.metaKey||event.ctrlKey||event.altKey)return;
  if(event.key===' '){event.preventDefault();togglePlay();}
  const tools={w:'water',b:'draw',v:'move'};
  if(tools[event.key.toLowerCase()])setTool(tools[event.key.toLowerCase()]);
});

async function importFile(file) {
  if(!file)return;
  if(file.size>10*1024*1024){toast('Please choose an image smaller than 10 MB.');return;}
  if(!/\.(svg|png|jpe?g|webp)$/i.test(file.name)){toast('Choose an SVG, PNG, JPG, or WebP image.');return;}
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
    const normalized=document.createElement('canvas');
    const ratio=Math.min(1,1400/Math.max(img.width,img.height));
    normalized.width=Math.max(1,Math.round(img.width*ratio));normalized.height=Math.max(1,Math.round(img.height*ratio));
    normalized.getContext('2d').drawImage(img,0,0,normalized.width,normalized.height);
    const data=normalized.toDataURL('image/png');
    const normalizedImage=new Image();normalizedImage.src=data;await normalizedImage.decode();
    change(()=>{importedImage=normalizedImage;state.imported=data;state.shape='import';state.size=1250;state.keepSource=true;selectedPreset=-1;inputMode='import';tool='water';state.drops=[];updateMask();});
    $('#import-name').textContent=file.name;
    toast('Your mark is on the paper. Add a little water.');
  }catch(error){toast(error.message||'This image could not be imported. Please try another file.');}
}
$('#upload-zone').addEventListener('click',()=>$('#file-input').click());
$('#upload-zone').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('#file-input').click();}});
$('#file-input').addEventListener('change',event=>{importFile(event.target.files[0]);event.target.value='';});
$('#upload-zone').addEventListener('dragover',event=>{event.preventDefault();$('#upload-zone').classList.add('dragover');});
$('#upload-zone').addEventListener('dragleave',()=>$('#upload-zone').classList.remove('dragover'));
$('#upload-zone').addEventListener('drop',event=>{event.preventDefault();$('#upload-zone').classList.remove('dragover');importFile(event.dataTransfer.files[0]);});
$('#artboard').addEventListener('dragover',event=>event.preventDefault());
$('#artboard').addEventListener('drop',event=>{event.preventDefault();importFile(event.dataTransfer.files[0]);});

$$('[data-export]').forEach(button=>button.addEventListener('click',async()=>{
  const wasPlaying=playing;
  stopAnimation();
  const transparent=button.dataset.export==='transparent';
  $$('[data-export]').forEach(b=>b.disabled=true);
  toast('Preparing your 3000 × 3000 print-ready experiment…');
  try {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    renderer.render(state,3000,transparent);
    const blob=await canvasToPrintPng($('#paper'),{dpi:300});
    downloadBlob(blob,`chroma-${state.shape}-${state.seed}${transparent?'-transparent':''}-300dpi.png`);
    closeDialogs();toast('Exported. A little wonder, ready for the world.');
  }catch(error){toast(`Export failed: ${error.message}`);}
  finally{renderer.render(state);$$('[data-export]').forEach(b=>b.disabled=false);if(wasPlaying)startAnimation();}
}));

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
  preview.gl.getExtension('WEBGL_lose_context')?.loseContext();
}

sync();
requestAnimationFrame(makeThumbnails);
