import { LocalFlow } from './local-flow.js';

const vertexSource = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;

const fieldSource = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 fragColor;
uniform vec2 resolution;
uniform float seed, size, stroke, amount, separation, fiber, grain, progress, direction, retention;
uniform float randomness, speed, sourceRandomness, dropRadius;
uniform vec2 sourceOffset;
uniform int shape, mode, dropCount, pigmentCount;
uniform bool hasMarks;
uniform vec3 ink, layers;
uniform vec4 pigments[6];
uniform vec4 settings[6];
uniform vec3 drops[8];
uniform sampler2D maskTexture, sourceTexture;
uniform bool keepSource, transparent;
const float PI = 3.14159265359;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33 + seed * .003);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  return noise(p) * .54 + noise(p * 2.03 + 17.3) * .27 + noise(p * 4.07 + 43.1) * .13 + noise(p * 8.1) * .06;
}
vec2 readMask(vec2 p) {
  vec2 t = clamp(p, .0001, .9999) * 768. - .5;
  ivec2 i = ivec2(floor(t));
  vec2 f = fract(t);
  ivec2 mx = ivec2(767);
  vec2 value = mix(mix(texelFetch(maskTexture, clamp(i, ivec2(0), mx), 0).rg, texelFetch(maskTexture, clamp(i + ivec2(1,0), ivec2(0), mx), 0).rg, f.x), mix(texelFetch(maskTexture, clamp(i + ivec2(0,1), ivec2(0), mx), 0).rg, texelFetch(maskTexture, clamp(i + ivec2(1,1), ivec2(0), mx), 0).rg, f.x), f.y);
  float exterior = length(p-clamp(p,0.,1.));
  return exterior>0. ? vec2(max(value.r,0.)+exterior,0.) : value;
}
vec4 readSource(vec2 p) {
  if(any(lessThan(p,vec2(0.))) || any(greaterThan(p,vec2(1.)))) return vec4(0.);
  return texture(sourceTexture,vec2(p.x,1.-p.y));
}
vec4 wetSource(vec2 p, float radius) {
  vec4 sampleColor=readSource(p);
  float total=1.;
  for(int i=0;i<16;i++) {
    float r=sqrt((float(i)+.5)/16.);
    float angle=float(i)*2.39996323;
    float weight=exp(-r*r*2.);
    sampleColor+=readSource(p+vec2(cos(angle),sin(angle))*r*radius)*weight;
    total+=weight;
  }
  return sampleColor/total;
}
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p-a, ba=b-a;
  return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));
}
float baseSdf(vec2 p) {
  vec2 q = p - .5 - sourceOffset;
  float r = size / 6000.;
  float w = stroke / 6000.;
  if(shape == 0) return length(q) - r * .28;
  if(shape == 1) return segment(q, vec2(-r*.74, r*.74), vec2(r*.74, -r*.74)) - w;
  if(shape == 2) return length(q) - r;
  if(shape == 3) return abs(length(q) - r) - w;
  if(shape == 4) {
    float a = atan(q.y, q.x);
    if(abs(a) < .72) return min(length(q - r*vec2(cos(.72), sin(.72))), length(q - r*vec2(cos(.72), -sin(.72)))) - w;
    return abs(length(q) - r) - w;
  }
  if(shape == 5) {
    float a = atan(q.y, q.x);
    float sector = 2. * PI / 5.;
    return cos(floor(.5 + a/sector)*sector-a)*length(q) - r*(.76 + .10*sin(a*3.+.5));
  }
  return readMask(p).r;
}
vec2 sourcePosition(vec2 p) {
  vec2 local=p-sourceOffset;
  return p + (vec2(noise(local*45.+seed),noise(local*45.+seed+53.))-.5)*.025*sourceRandomness;
}
bool baseDominates(vec2 p) {
  vec2 s=sourcePosition(p);
  return !hasMarks || baseSdf(s)<=readMask(s).r;
}
float sdf(vec2 p) {
  vec2 s=sourcePosition(p);
  float d=baseSdf(s);
  return hasMarks ? min(d,readMask(s).r) : d;
}
float transportDistance(vec2 p) {
  if(shape == 3 && baseDominates(p)) return length(sourcePosition(p)-.5-sourceOffset) - size / 6000. - stroke / 6000.;
  return sdf(p);
}
vec3 deposit(vec3 color, vec3 pigment, float density) {
  return color * exp(-max(vec3(.025), 1.-pigment) * density * 1.8);
}
vec2 paperWarp(vec2 p) {
  return vec2(fbm(p*32.+seed*.07), fbm(p*32.+vec2(37,71)+seed*.07))-.5;
}
float paperPores(vec2 p) {
  vec2 grid=p*320.;
  vec2 cell=floor(grid);
  float filaments=0.;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
    vec2 index=cell+vec2(float(x),float(y));
    vec2 center=index+vec2(hash(index+seed),hash(index+seed+17.));
    float angle=hash(index+seed+43.)*PI;
    vec2 axis=vec2(cos(angle),sin(angle));
    float halfLength=.25+hash(index+seed+71.)*.55;
    float distance=segment(grid,center-axis*halfLength,center+axis*halfLength);
    filaments+=exp(-distance*distance/ .012)*.30;
  }
  return clamp(.22+filaments+noise(p*540.+seed)*.27,0.,1.);
}
vec2 sourceNormal(vec2 p) {
  if((shape==0 || shape==2 || shape==3) && baseDominates(p) && sourceRandomness==0.) return normalize(p-.5-sourceOffset+vec2(.00001));
  float e=.001;
  return normalize(vec2(sdf(p+vec2(e,0))-sdf(p-vec2(e,0)), sdf(p+vec2(0,e))-sdf(p-vec2(0,e)))+vec2(.00001));
}
float elution(float distance, float center, float width) {
  float shoulder = distance < center ? 1.35 : .72;
  float z = abs(distance-center)/max(.0004,width*shoulder);
  return exp(-pow(z,1.65));
}
`;

const fragmentSource = fieldSource + `void main() {
  vec2 p = vec2(uv.x, 1.-uv.y);
  vec2 q = sourcePosition(p)-.5-sourceOffset;
  float originalD = sdf(p);
  vec2 normal = sourceNormal(p);
  vec2 sourcePoint = p - normal*max(transportDistance(p),0.);
  vec2 warp = paperWarp(p);
  float pores = paperPores(p);
  float permeability = .82 + fbm(sourcePoint*34.+seed*.13)*.36;
  float channels = noise((sourcePoint+warp*.018)*185.+seed)-.5;
  float fiberDisplacement = (pores-.5)*.003 + channels*.004;
  float irregular = (fbm((p+warp*.01)*43.+seed)-.5)*.014*randomness;
  float moisture = 0.;
  vec2 waterFlow = vec2(0);
  for(int i=0; i<8; i++) {
    if(i >= dropCount) break;
    vec2 v = p-drops[i].xy;
    float age = drops[i].z;
    float reach = sqrt(max(0.,age))*.10*dropRadius;
    float wetDistance = length(v)/permeability - fiberDisplacement*fiber;
    float wet = (1.-smoothstep(reach*.38,max(.001,reach),wetDistance))*min(age*.25,1.);
    moisture += wet;
    waterFlow += normalize(v+vec2(.0001))*wet*.032;
  }
  float t = clamp(progress+moisture*.18,0.,1.5);
  float transport = amount*.162*t*speed;
  float particles = hash(floor(p*3000.)+seed);
  float clusters = noise(p*620.+seed*3.);
  float grainContrast = grain*sqrt(min(1.,resolution.x/3000.));
  float deposition = 1. + grainContrast*((particles-.5)*.52+(clusters-.5)*.42);
  float alphaSum = 0.;
  vec3 color = vec3(1.);
  float opacitySum=0.;
  for(int i=0; i<6; i++) {
    if(i>=pigmentCount) break;
    vec4 pig = pigments[i];
    vec4 cfg = settings[i];
    opacitySum+=cfg.y;
    float mobility = pig.a;
    float spread = cfg.x;
    float opacity = cfg.y;
    float saturation = cfg.z;
    float angleOffset = cfg.w;
    vec2 componentAxis = vec2(cos(direction+angleOffset),sin(direction+angleOffset));
    float stall = .97 + .03*sin(t*9.+mobility*13.+seed);
    float retardation = mix(.52,mobility,separation);
    float distanceMoved = transport*retardation*stall*permeability;
    vec2 drift = componentAxis*distanceMoved*(mode==1 ? 1.65 : abs(angleOffset)/PI*.8);
    float variation = (irregular+fiberDisplacement*fiber)*min(t*3.,1.);
    variation *= .45+mobility*.65;
    vec2 sampleP = p-drift-waterFlow*mobility;
    float d = transportDistance(sampleP)-variation;
    float width = max(.001,transport*(.062+spread*.21));
    float localSpread = 1. + fiber*(pores-.5)*.32;
    width *= localSpread;
    float density;
    float dilute;
    if(mode==0) {
      density = elution(d,distanceMoved,width);
      dilute = elution(d,distanceMoved*.88,width*2.4)*.10;
      if(shape==8 && keepSource) {
        float trailEnd=max(.0004,distanceMoved-width*1.35);
        float trail=(1.-smoothstep(0.,trailEnd,max(d,0.)))*(1.-readSource(sourcePosition(p)).a);
        density=max(density,trail*.5);
      }
      float deposits = .78 + noise(sourcePoint*89.+p*33.+float(i)*19.)*.40;
      density *= deposits;
    } else {
      density=0.;
      dilute=0.;
      float total=0.;
      for(int j=0;j<13;j++) {
        float fraction=.04+float(j)*.105;
        float weight=exp(-pow(abs(fraction-.88)/.39,2.));
        vec2 origin=p-drift*fraction-waterFlow*mobility;
        float sourceD=max(sdf(origin)-variation,0.);
        density+=exp(-pow(sourceD/(width*.90),1.65))*weight;
        dilute+=exp(-pow(sourceD/(width*1.6),1.4))*weight*.09;
        total+=weight;
      }
      density/=total*.62;
      dilute/=total;
    }
    float paperAffinity = .92 + (pores-.5)*fiber*.16;
    float depletion = 1./(1.+max(0.,transport-.06)*2.5);
    float concentration = opacity*deposition*paperAffinity*depletion*smoothstep(.005,.065,t);
    density*=concentration;
    dilute*=concentration;
    if(shape==3 && mode==0 && baseDominates(sampleP)) {
      float exterior=smoothstep(-.002,.003,length(q)-size/6000.+stroke/6000.);
      density*=exterior;
      dilute*=exterior;
    }
    float luminance=dot(pig.rgb,vec3(.299,.587,.114));
    vec3 pigmentColor=mix(vec3(luminance),pig.rgb,saturation);
    color=deposit(color,pigmentColor,density*layers.y);
    alphaSum+=density*layers.y;
    float fringe=dilute*layers.z;
    color=deposit(color,mix(pigmentColor,vec3(1),.12),fringe);
    alphaSum+=fringe;
  }
  float edge=(noise(p*380.+seed)-.5)*.00065+(noise(p*83.+seed)-.5)*.0012;
  float aa=max(1.25/resolution.x,.0012);
  float original=1.-smoothstep(-aa,aa,originalD+edge);
  vec3 inkColor=ink;
  vec3 carrierColor=ink;
  float sourceCoverage=1.;
  if(shape==8) {
    float soak=amount*t;
    float radius=soak*.023;
    vec2 drift=waterFlow*.2+vec2(cos(direction),sin(direction))*transport*(mode==1 ? .10 : 0.);
    vec2 soakedP=p-drift+warp*radius*fiber*.5;
    vec4 source=wetSource(sourcePosition(soakedP),radius);
    original=source.a/(1.+soak*.52);
    original*=1.+min(soak,1.)*(pores-.5)*fiber*.65;
    vec2 anchor=sourcePosition(soakedP);
    // Project in mask space: distorted world-space distances cannot locate source colors reliably.
    for(int j=0;j<3;j++) {
      float distance=readMask(anchor).r;
      if(distance<=0.) break;
      vec2 gradient=vec2(readMask(anchor+vec2(.001,0)).r-readMask(anchor-vec2(.001,0)).r,
        readMask(anchor+vec2(0,.001)).r-readMask(anchor-vec2(0,.001)).r);
      anchor-=normalize(gradient+vec2(.00001))*(distance+.001);
    }
    vec4 carried=wetSource(anchor,max(.001,radius*.35));
    sourceCoverage=carried.a;
    if(keepSource) {
      if(source.a>.00001) inkColor=source.rgb/source.a;
      if(carried.a>.00001) carrierColor=carried.rgb/carried.a;
      vec2 retainedPosition=sourcePosition(p);
      vec4 retained=readSource(retainedPosition);
      float edgeWidth=8./768.;
      if(t>0. && layers.y>0. && retained.a>.00001 && originalD>-edgeWidth) {
        vec2 gradient=vec2(readMask(retainedPosition+vec2(.001,0)).r-readMask(retainedPosition-vec2(.001,0)).r,
          readMask(retainedPosition+vec2(0,.001)).r-readMask(retainedPosition-vec2(0,.001)).r);
        vec4 interior=readSource(retainedPosition-normalize(gradient+vec2(.00001))*(originalD+edgeWidth));
        if(interior.a>=retained.a) {
          vec3 edgeColor=retained.rgb/retained.a, interiorColor=interior.rgb/interior.a;
          vec3 toWhite=vec3(1.)-interiorColor;
          float matte=clamp(dot(edgeColor-interiorColor,toWhite)/max(.00001,dot(toWhite,toWhite)),0.,1.);
          float error=length(edgeColor-mix(interiorColor,vec3(1.),matte));
          // Remove white-matte contamination only at wet edges, without changing source coverage.
          float clean=smoothstep(0.,.025,t)*smoothstep(.002,.015,matte)*(1.-smoothstep(.025,.06,error));
          retained.rgb=mix(retained.rgb,interiorColor*retained.a,clean);
        }
      }
      // Only excess wet coverage extends the source, without diluting or doubling its native alpha.
      float bleed=max(0.,original-retained.a);
      original=retained.a+bleed;
      if(original>.00001) inkColor=(retained.rgb+inkColor*bleed)/original;
    }
  } else if(shape>=6) {
    original*=readMask(sourcePosition(p)).g;
  }
  float carrierD=transportDistance(p-waterFlow*.2);
  if(mode==1) carrierD=sdf(p);
  float carrier=exp(-(shape==8 ? abs(carrierD) : max(carrierD,0.))/max(.0003,transport*.125));
  if(mode==0 && shape!=8) carrier*=smoothstep(-.002,.001,carrierD);
  float solubleInk=opacitySum/(float(pigmentCount)*1.94/3.);
  carrier*=.36*solubleInk*min(t*4.,1.)*deposition*layers.y*sourceCoverage;
  color=deposit(color,carrierColor,carrier);
  alphaSum+=carrier;
  float inkGrain=1.-grainContrast*(.018+particles*.025);
  original*=layers.x*retention;
  color=mix(color,inkColor*inkGrain,original);
  alphaSum=max(alphaSum,original*3.);
  float alpha=transparent ? clamp(1.-exp(-alphaSum*2.),0.,1.) : 1.;
  if(transparent && alpha>.0001) color=clamp((color-(1.-alpha))/alpha,0.,1.);
  fragColor=vec4(color,alpha);
}
`;

export const SHAPES = ['dot', 'line', 'circle', 'ring', 'arc', 'polygon', 'text', 'freehand', 'import', 'composition'];

export function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(error);
  }
  return shader;
}

export class ChromatographyRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('This experiment needs WebGL 2. Please enable hardware acceleration or use a recent browser.');
    this.gl = gl;
    this.supportsLocalFlow = !!gl.getExtension('EXT_color_buffer_float');
    this.maskRevision = 0;
    this.program = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    gl.useProgram(this.program);
    const buffer = this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const pos = this.position = gl.getAttribLocation(this.program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = {};
    this.mask = this.createTexture(0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 768, 768, 0, gl.RG, gl.FLOAT, new Float32Array(768 * 768 * 2).fill(1));
    this.source = this.createTexture(1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
    gl.uniform1i(this.location('maskTexture'), 0);
    gl.uniform1i(this.location('sourceTexture'), 1);
  }

  createTexture(unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  location(name) {
    if (!(name in this.uniforms)) this.uniforms[name] = this.gl.getUniformLocation(this.program, name);
    return this.uniforms[name];
  }

  setMask(canvas, sourceCanvas = canvas, alphaOnly = false) {
    const gl = this.gl;
    const n = 768;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, n, n);
    const inside = new Float32Array(n*n);
    const outside = new Float32Array(n*n);
    const alphas = new Float32Array(n*n);
    for (let i=0; i<n*n; i++) {
      const luminance = Math.min(data[i*4], data[i*4+1], data[i*4+2]) / 255;
      alphas[i] = data[i*4+3] / 255 * (alphaOnly ? 1 : 1-luminance);
      inside[i] = alphas[i] > .04 ? 0 : n;
      outside[i] = alphas[i] > .04 ? n : 0;
    }
    distanceTransform(inside, n);
    distanceTransform(outside, n);
    const field = new Float32Array(n*n*2);
    for (let i=0; i<n*n; i++) {
      field[i*2] = (inside[i]-outside[i]) / n;
      field[i*2+1] = Math.min(1, alphas[i]*1.6);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,n,n,0,gl.RG,gl.FLOAT,field);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,this.source);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
    // Premultiplied filtering keeps transparent pixels from bleeding black into wet ink.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,sourceCanvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    this.maskRevision++;
  }

  render(state, resolution = 1100, transparent = false) {
    const gl = this.gl;
    if(this.canvas.width !== resolution) this.canvas.width = this.canvas.height = resolution;
    if(state.localFlow) {
      if(!this.supportsLocalFlow) throw new Error('Local pigment flow needs renderable half-float textures.');
      this.localFlow ??= new LocalFlow(gl, fieldSource, SHAPES);
      this.localFlow.render(state, this, resolution, transparent);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,resolution,resolution);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.mask);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.source);
    const scalar = { seed:state.seed, size:state.size, stroke:state.stroke, amount:state.amount, separation:state.separation, fiber:state.fiber, grain:state.grain, progress:state.progress, direction:state.direction*Math.PI/180, retention:state.retention, randomness:state.randomness, speed:state.speed, sourceRandomness:state.sourceRandomness, dropRadius:state.dropRadius };
    Object.entries(scalar).forEach(([k,v]) => gl.uniform1f(this.location(k),v));
    gl.uniform2f(this.location('resolution'),resolution,resolution);
    gl.uniform1i(this.location('shape'),SHAPES.indexOf(state.shape));
    gl.uniform1i(this.location('mode'),state.mode==='directional' ? 1 : 0);
    gl.uniform1i(this.location('keepSource'),state.keepSource ? 1 : 0);
    gl.uniform1i(this.location('transparent'),transparent ? 1 : 0);
    gl.uniform3fv(this.location('ink'),hexToRgb(state.ink));
    gl.uniform3fv(this.location('layers'),state.layers.map(Number));
    gl.uniform2f(this.location('sourceOffset'),state.offset.x,state.offset.y);
    gl.uniform1i(this.location('hasMarks'),state.marks.length ? 1 : 0);
    gl.uniform1i(this.location('pigmentCount'),state.pigments.length);
    const pigmentData = new Float32Array(24), settingsData = new Float32Array(24);
    state.pigments.forEach((pig,i) => {
      pigmentData.set([...hexToRgb(pig.color),pig.mobility],i*4);
      settingsData.set([pig.spread,pig.opacity,pig.saturation,pig.direction*Math.PI/180],i*4);
    });
    gl.uniform4fv(this.location('pigments[0]'),pigmentData);
    gl.uniform4fv(this.location('settings[0]'),settingsData);
    const drops = state.drops.slice(-8);
    gl.uniform1i(this.location('dropCount'),drops.length);
    const dropData = new Float32Array(24);
    drops.forEach((drop,i) => dropData.set([drop.x,drop.y,drop.age],i*3));
    gl.uniform3fv(this.location('drops[0]'),dropData);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }

  dispose() {
    this.localFlow?.dispose();
    this.gl.deleteTexture(this.mask);
    this.gl.deleteTexture(this.source);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export function distanceTransform(field, size) {
  const diagonal = Math.SQRT2;
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const i=y*size+x;
    let d=field[i];
    if(x>0) d=Math.min(d,field[i-1]+1);
    if(y>0) d=Math.min(d,field[i-size]+1);
    if(x>0&&y>0) d=Math.min(d,field[i-size-1]+diagonal);
    if(x<size-1&&y>0) d=Math.min(d,field[i-size+1]+diagonal);
    field[i]=d;
  }
  for(let y=size-1;y>=0;y--) for(let x=size-1;x>=0;x--) {
    const i=y*size+x;
    let d=field[i];
    if(x<size-1) d=Math.min(d,field[i+1]+1);
    if(y<size-1) d=Math.min(d,field[i+size]+1);
    if(x<size-1&&y<size-1) d=Math.min(d,field[i+size+1]+diagonal);
    if(x>0&&y<size-1) d=Math.min(d,field[i+size-1]+diagonal);
    field[i]=d;
  }
  return field;
}
