export const FLOW_SIZE = 384;
export const FLOW_STEPS = 132;

export function flowTimeline(state) {
  const steps = Math.round(Math.max(state.progress / 1.22, ...state.drops.map(drop => drop.age / 22)) * FLOW_STEPS);
  return {
    steps,
    starts: state.drops.map(drop => steps - Math.round(drop.age / 22 * FLOW_STEPS)),
    baseStart: state.progress > 0 ? steps - Math.round(state.progress / 1.22 * FLOW_STEPS) : -1,
  };
}

export function flowKey(state, timeline, revision) {
  return JSON.stringify([
    revision, state.shape, state.size, state.stroke, state.offset, state.sourceRandomness,
    state.seed, state.mode, state.direction, state.amount, state.separation, state.speed,
    state.fiber, state.grain, state.randomness, state.dropRadius,
    state.pigments.map(p => [p.mobility, p.spread, p.direction]),
    state.drops.map((drop, i) => [drop.x, drop.y, timeline.starts[i]]), timeline.baseStart,
  ]);
}

const vertex = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }
`;

const simulation = `#version 300 es
precision highp float;
in vec2 uv;
layout(location=0) out vec4 nextMobileA;
layout(location=1) out vec4 nextMobileB;
layout(location=2) out vec4 nextDepositA;
layout(location=3) out vec4 nextDepositB;
uniform sampler2D mobileA, mobileB, depositA, depositB, sampleSource;
uniform float seed, amount, separation, speed, fiber, grain, randomness, direction, dropRadius, stepIndex, baseStart;
uniform int mode, dropCount, pigmentCount;
uniform vec4 drops[8], components[6];
const vec2 px=vec2(1./384.);
float hash(vec2 p) {
  vec3 p3=fract(vec3(p.xyx)*.1031);
  p3+=dot(p3,p3.yzx+33.33+seed*.003);
  return fract((p3.x+p3.y)*p3.z);
}
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p) { return noise(p)*.54+noise(p*2.03+17.3)*.27+noise(p*4.07+43.1)*.13+noise(p*8.1)*.06; }
vec4 readField(sampler2D field, vec2 p) {
  if(any(lessThan(p,vec2(0))) || any(greaterThan(p,vec2(1)))) return vec4(0);
  return texture(field,p);
}
float mobileAt(vec2 p, int i) { return i<3 ? readField(mobileA,p)[i] : readField(mobileB,p)[i-3]; }
void main() {
  vec4 center=readField(mobileA,uv);
  float left=readField(mobileA,uv-vec2(px.x,0)).a, right=readField(mobileA,uv+vec2(px.x,0)).a;
  float down=readField(mobileA,uv-vec2(0,px.y)).a, up=readField(mobileA,uv+vec2(0,px.y)).a;
  float average=(left+right+down+up)*.25, front=max(max(left,right),max(down,up));
  float injection=0.; vec2 radial=vec2(0);
  float radius=.09*dropRadius;
  for(int i=0;i<8;i++) {
    if(i>=dropCount)break;
    float age=stepIndex-drops[i].z;
    if(age<0.)continue;
    vec2 delta=uv-drops[i].xy;
    float wet=exp(-dot(delta,delta)/(radius*radius))*exp(-age*.58/45.);
    injection+=wet;
    radial+=normalize(delta+vec2(.00001))*wet;
  }
  float source=texture(sampleSource,uv).a;
  float background=baseStart>=0. && stepIndex>=baseStart ? source*.6*exp(-(stepIndex-baseStart)*.013) : 0.;
  float water=max(center.a*.997,mix(average,front*.993,.64));
  water=clamp(water+(injection+background)*(.045+.075*amount/1.5),0.,1.);
  vec2 axis=vec2(cos(direction),-sin(direction)), crossAxis=vec2(-axis.y,axis.x);
  float along=dot(uv,axis), across=dot(uv,crossAxis);
  float lane=fbm(vec2(across*150.,along*10.)+seed*.019);
  float hair=noise(vec2(across*560.,along*28.)+seed*.071);
  float pulse=fbm(vec2(across*42.,along*260.)+seed*.031);
  vec2 capillary=normalize(axis+crossAxis*((lane-.5)*.78+(hair-.5)*.22)*randomness*mix(.3,1.,fiber)+axis*(pulse-.5)*.18);
  vec2 sourceFlow=normalize(texture(sampleSource,uv).rg*2.-1.+vec2(.00001));
  vec2 dryFlow=mode==0 ? normalize(sourceFlow+capillary*.18) : capillary;
  vec2 wetFlow=normalize(radial+dryFlow*.28+vec2(.00001));
  vec2 flow=normalize(mix(dryFlow,wetFlow,clamp(injection*1.7,0.,.82)));
  float releaseGrain=smoothstep(.18,.78,fbm(uv*vec2(210.,670.)+seed));
  float release=source*smoothstep(.025,.42,water)*(.009+.038*amount/1.5);
  float waterEdge=abs(water-average);
  float longFiber=noise(uv*vec2(90.,1380.)+seed*.17), shortFiber=noise(uv*vec2(760.,210.)+seed*.31);
  float catchFiber=smoothstep(.48,.88,longFiber*.62+shortFiber*.38);
  float dryZone=1.-smoothstep(.08,.72,water);
  float capillaryFront=smoothstep(.006,.12,waterEdge)*(1.-smoothstep(.24,.72,water));
  float settleRate=.00045+grain*(.0018*catchFiber+.0038*dryZone+.011*capillaryFront);
  vec4 priorA=texture(depositA,uv), priorB=texture(depositB,uv);
  float mobiles[6], settled[6];
  for(int i=0;i<6;i++) {
    mobiles[i]=0.; settled[i]=0.;
    if(i>=pigmentCount)continue;
    vec4 component=components[i];
    float a=-component.z;
    vec2 pigmentFlow=mat2(cos(a),sin(a),-sin(a),cos(a))*flow;
    float move=(.12+.76*separation)*1.5*speed*(.28+.72*water)*component.x*1.7;
    float carried=mobileAt(uv-pigmentFlow*px*move,i);
    float neighbor=(mobileAt(uv+vec2(px.x,0),i)+mobileAt(uv-vec2(px.x,0),i)+mobileAt(uv+vec2(0,px.y),i)+mobileAt(uv-vec2(0,px.y),i))*.25;
    float mobile=mix(carried,neighbor,.012+water*(.018+.034*amount/1.5)*(.4+component.y*1.6));
    mobile=mobile*.998+release*mix(.5,1.,releaseGrain)*mix(1.,.75,component.x/1.5);
    float pigmentEdge=abs(mobile-neighbor);
    float caught=min(mobile,mobile*settleRate+pigmentEdge*capillaryFront*(.014+.018*grain));
    mobiles[i]=clamp(mobile-caught,0.,1.5);
    settled[i]=min(1.35,(i<3 ? priorA[i] : priorB[i-3])*.99994+caught);
  }
  float trace=max(priorA.a*.998,clamp(water*.58+waterEdge*4.4,0.,1.));
  nextMobileA=vec4(mobiles[0],mobiles[1],mobiles[2],water);
  nextMobileB=vec4(mobiles[3],mobiles[4],mobiles[5],0);
  nextDepositA=vec4(settled[0],settled[1],settled[2],trace);
  nextDepositB=vec4(settled[3],settled[4],settled[5],0);
}
`;

const sourceMain = `
void main() {
  vec2 p=vec2(uv.x,1.-uv.y);
  float coverage=1.-smoothstep(-1./384.,1./384.,sdf(p));
  if(shape==8)coverage=readSource(sourcePosition(p)).a;
  else if(shape>=6)coverage*=readMask(sourcePosition(p)).g;
  vec2 normal=sourceNormal(p);
  fragColor=vec4(vec2(normal.x,-normal.y)*.5+.5,0,coverage);
}
`;

const displayMain = `
uniform sampler2D mobileA, mobileB, depositA, depositB;
uniform float flowPhase;
vec4 fieldAt(sampler2D field, vec2 p) {
  if(any(lessThan(p,vec2(0))) || any(greaterThan(p,vec2(1))))return vec4(0);
  return texture(field,p);
}
void main() {
  vec2 p=vec2(uv.x,1.-uv.y);
  float originalD=sdf(p);
  vec3 color=vec3(1.);
  float pigmentAlpha=0.;
  for(int i=0;i<6;i++) {
    if(i>=pigmentCount)break;
    float mobility=clamp(pigments[i].a/1.5,0.,1.);
    float travel=mix(-.006,.082,mobility)*separation*flowPhase*speed;
    vec2 axis=vec2(cos(direction+settings[i].w),-sin(direction+settings[i].w));
    vec2 point=uv-axis*travel*float(mode);
    vec4 moving=i<3 ? fieldAt(mobileA,point) : fieldAt(mobileB,point);
    vec4 caught=i<3 ? fieldAt(depositA,point) : fieldAt(depositB,point);
    float mobile=moving[i%3], settled=caught[i%3];
    float paper=.78+noise(p*vec2(860.,1760.)+seed)*.38;
    float textureGrain=mix(1.,paper*(.86+noise(point*1180.+float(i)*13.7)*.28),grain*.82);
    float band=clamp((mobile*.62+settled*1.86)*textureGrain*settings[i].y*1.6,0.,1.)*layers.y;
    float haze=mobile;
    for(int j=0;j<12;j++) {
      float angle=float(j)*2.39996323;
      float radius=sqrt((float(j)+.5)/12.)*(.012+settings[i].x*.045);
      vec2 samplePoint=point+vec2(cos(angle),sin(angle))*radius;
      vec4 sampleField=i<3 ? fieldAt(mobileA,samplePoint) : fieldAt(mobileB,samplePoint);
      haze+=sampleField[i%3];
    }
    float wash=haze/13.*.4*settings[i].y*layers.z;
    vec3 pigment= mix(vec3(dot(pigments[i].rgb,vec3(.299,.587,.114))),pigments[i].rgb,settings[i].z);
    float coverage=clamp(band*1.14+wash,0.,.96);
    color=mix(color,pigment,coverage);
    pigmentAlpha=coverage+pigmentAlpha*(1.-coverage);
  }
  float aa=max(1.25/resolution.x,.0012);
  float edge=(noise(p*380.+seed)-.5)*.00065+(noise(p*83.+seed)-.5)*.0012;
  float original=1.-smoothstep(-aa,aa,originalD+edge);
  vec3 nativeColor=ink;
  if(shape==8) {
    vec2 position=sourcePosition(p);
    vec4 retained=readSource(position);
    float wet=fieldAt(mobileA,uv).a;
    float edgeWidth=8./768.;
    if(keepSource && wet>.01 && layers.y>0. && retained.a>.00001 && originalD>-edgeWidth) {
      vec2 gradient=vec2(readMask(position+vec2(.001,0)).r-readMask(position-vec2(.001,0)).r,readMask(position+vec2(0,.001)).r-readMask(position-vec2(0,.001)).r);
      vec4 interior=readSource(position-normalize(gradient+vec2(.00001))*(originalD+edgeWidth));
      if(interior.a>=retained.a) {
        vec3 edgeColor=retained.rgb/retained.a, interiorColor=interior.rgb/interior.a, toWhite=vec3(1)-interiorColor;
        float matte=clamp(dot(edgeColor-interiorColor,toWhite)/max(.00001,dot(toWhite,toWhite)),0.,1.);
        float error=length(edgeColor-mix(interiorColor,vec3(1),matte));
        float clean=smoothstep(0.,.025,wet)*smoothstep(.002,.015,matte)*(1.-smoothstep(.025,.06,error));
        retained.rgb=mix(retained.rgb,interiorColor*retained.a,clean);
      }
    }
    original=retained.a;
    if(keepSource && retained.a>.00001)nativeColor=retained.rgb/retained.a;
  } else if(shape>=6)original*=readMask(sourcePosition(p)).g;
  original*=retention*layers.x;
  float alpha=pigmentAlpha;
  vec3 premultiplied=max(vec3(0),color-vec3(1.-alpha))*(1.-original)+nativeColor*original;
  alpha=original+alpha*(1.-original);
  fragColor=transparent ? vec4(alpha>.00001 ? premultiplied/alpha : vec3(0),alpha) : vec4(premultiplied+vec3(1.-alpha),1);
}
`;

function program(gl, source) {
  const result = gl.createProgram(), shaders = [];
  try {
    for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, source]]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, text); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(result, shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
    return { value: result, locations: {}, position: gl.getAttribLocation(result, 'position') };
  } catch (error) { gl.deleteProgram(result); throw error; }
  finally { shaders.forEach(shader => gl.deleteShader(shader)); }
}

export class LocalFlow {
  constructor(gl, fieldSource, shapes) {
    this.gl = gl; this.shapes = shapes; this.programs = []; this.targets = []; this.step = 0;
    try {
      this.init = program(gl, fieldSource + sourceMain); this.programs.push(this.init);
      this.evolve = program(gl, simulation); this.programs.push(this.evolve);
      this.display = program(gl, fieldSource + displayMain); this.programs.push(this.display);
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      this.source = this.target(1, false);
      this.fields = [this.target(4, true), this.target(4, true)];
    } catch (error) { this.dispose(); throw error; }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  }

  target(count, floating) {
    const gl = this.gl, target = { framebuffer: gl.createFramebuffer(), textures: [] };
    this.targets.push(target); gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    for (let i = 0; i < count; i++) {
      const texture = gl.createTexture(); target.textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, floating ? gl.RGBA16F : gl.RGBA8, FLOW_SIZE, FLOW_SIZE, 0, gl.RGBA, floating ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
    }
    gl.drawBuffers(target.textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Local pigment flow needs renderable half-float textures.');
    return target;
  }

  use(pass) {
    const gl = this.gl; this.pass = pass; gl.useProgram(pass.value);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(pass.position);
    gl.vertexAttribPointer(pass.position, 2, gl.FLOAT, false, 0, 0);
  }

  uniform(name, method, ...values) {
    const pass = this.pass;
    if (!(name in pass.locations)) pass.locations[name] = this.gl.getUniformLocation(pass.value, name);
    this.gl[method](pass.locations[name], ...values);
  }

  texture(name, texture, unit) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
    this.uniform(name, 'uniform1i', unit);
  }

  sourceUniforms(state, owner, resolution) {
    for (const key of ['seed', 'size', 'stroke', 'sourceRandomness']) this.uniform(key, 'uniform1f', state[key]);
    this.uniform('sourceOffset', 'uniform2f', state.offset.x, state.offset.y);
    this.uniform('resolution', 'uniform2f', resolution, resolution);
    this.uniform('shape', 'uniform1i', this.shapes.indexOf(state.shape));
    this.uniform('hasMarks', 'uniform1i', state.marks.length ? 1 : 0);
    this.texture('maskTexture', owner.mask, 0); this.texture('sourceTexture', owner.source, 1);
  }

  render(state, owner, resolution, transparent) {
    const gl = this.gl, timeline = flowTimeline(state), key = flowKey(state, timeline, owner.maskRevision);
    gl.viewport(0, 0, FLOW_SIZE, FLOW_SIZE);
    if (key !== this.key || timeline.steps < this.step) {
      this.key = key; this.step = 0; this.index = 0;
      for (const target of this.fields) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        for (let i = 0; i < 4; i++) gl.clearBufferfv(gl.COLOR, i, new Float32Array(4));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.source.framebuffer); this.use(this.init);
      this.sourceUniforms(state, owner, FLOW_SIZE); gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (this.step < timeline.steps) {
      this.use(this.evolve);
      for (const key of ['seed', 'amount', 'separation', 'speed', 'fiber', 'grain', 'randomness', 'dropRadius']) this.uniform(key, 'uniform1f', state[key]);
      this.uniform('direction', 'uniform1f', state.direction * Math.PI / 180);
      this.uniform('mode', 'uniform1i', state.mode === 'directional' ? 1 : 0);
      this.uniform('dropCount', 'uniform1i', state.drops.length);
      this.uniform('pigmentCount', 'uniform1i', state.pigments.length);
      this.uniform('baseStart', 'uniform1f', timeline.baseStart);
      const drops = new Float32Array(32), components = new Float32Array(24);
      state.drops.forEach((drop, i) => drops.set([drop.x, 1 - drop.y, timeline.starts[i], 0], i * 4));
      state.pigments.forEach((p, i) => components.set([p.mobility, p.spread, p.direction * Math.PI / 180, 0], i * 4));
      this.uniform('drops[0]', 'uniform4fv', drops); this.uniform('components[0]', 'uniform4fv', components);
      this.texture('sampleSource', this.source.textures[0], 4);
      while (this.step < timeline.steps) {
        const current = this.fields[this.index], next = this.fields[1 - this.index];
        ['mobileA','mobileB','depositA','depositB'].forEach((name, i) => this.texture(name, current.textures[i], i));
        gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
        this.uniform('stepIndex', 'uniform1f', this.step); gl.drawArrays(gl.TRIANGLES, 0, 6);
        this.step++; this.index = 1 - this.index;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, resolution, resolution); this.use(this.display);
    this.sourceUniforms(state, owner, resolution);
    ['mobileA','mobileB','depositA','depositB'].forEach((name, i) => this.texture(name, this.fields[this.index].textures[i], i + 2));
    for (const key of ['seed', 'separation', 'grain', 'retention', 'speed']) this.uniform(key, 'uniform1f', state[key]);
    this.uniform('direction', 'uniform1f', state.direction * Math.PI / 180);
    this.uniform('mode', 'uniform1i', state.mode === 'directional' ? 1 : 0);
    this.uniform('flowPhase', 'uniform1f', timeline.steps / FLOW_STEPS);
    this.uniform('transparent', 'uniform1i', transparent ? 1 : 0);
    this.uniform('keepSource', 'uniform1i', state.keepSource ? 1 : 0);
    this.uniform('layers', 'uniform3fv', state.layers.map(Number));
    this.uniform('ink', 'uniform3fv', [1,3,5].map(i => parseInt(state.ink.slice(i, i + 2), 16) / 255));
    this.uniform('pigmentCount', 'uniform1i', state.pigments.length);
    const pigments = new Float32Array(24), settings = new Float32Array(24);
    state.pigments.forEach((p, i) => {
      pigments.set([...([1,3,5].map(n => parseInt(p.color.slice(n, n + 2), 16) / 255)), p.mobility], i * 4);
      settings.set([p.spread, p.opacity, p.saturation, p.direction * Math.PI / 180], i * 4);
    });
    this.uniform('pigments[0]', 'uniform4fv', pigments); this.uniform('settings[0]', 'uniform4fv', settings);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose() {
    const gl = this.gl;
    for (const target of this.targets) {
      target.textures.forEach(texture => gl.deleteTexture(texture)); gl.deleteFramebuffer(target.framebuffer);
    }
    this.programs.forEach(pass => gl.deleteProgram(pass.value));
    if (this.buffer) gl.deleteBuffer(this.buffer);
  }
}
