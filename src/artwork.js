export function createSeededMarks(seed) {
  let value=seed>>>0;
  const random=()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};
  const types=['dot','ring','arc','line','freehand'];
  return Array.from({length:5+Math.floor(random()*5)},()=>{
    const type=types[Math.floor(random()*types.length)];
    const x=.2+random()*.6, y=.2+random()*.6, radius=.035+random()*.09;
    return {type,x,y,radius,endX:x+(random()-.5)*.25,endY:y+(random()-.5)*.25,stroke:12+random()*36,size:radius*6000,
      points:Array.from({length:16},(_,i)=>({x:x+i/15*.14,y:y+Math.sin(i/15*Math.PI*2)*radius*.6}))};
  });
}

export function drawMark(ctx, mark, side) {
  const x=mark.x*side, y=mark.y*side, r=mark.radius*side;
  ctx.lineWidth=mark.stroke/3000*side;
  ctx.beginPath();
  if(mark.type==='line') {
    ctx.moveTo(x,y);ctx.lineTo(mark.endX*side,mark.endY*side);
    if(mark.x===mark.endX && mark.y===mark.endY)ctx.lineTo(x+.01,y+.01);
    ctx.stroke();
  } else if(mark.type==='freehand') {
    mark.points.forEach((p,i)=>i ? ctx.lineTo(p.x*side,p.y*side) : ctx.moveTo(p.x*side,p.y*side));
    if(mark.points.length===1)ctx.lineTo(mark.points[0].x*side+.01,mark.points[0].y*side+.01);
    ctx.stroke();
  } else if(mark.type==='text') {
    ctx.font=`${mark.size/3000*side}px Georgia, serif`;
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(mark.text,x,y,side*.9);
  } else if(mark.type==='polygon') {
    for(let i=0;i<5;i++) {
      const angle=i*Math.PI*2/5-.5, scale=i%2 ? .8 : 1;
      const px=x+Math.cos(angle)*r*scale, py=y+Math.sin(angle)*r*scale;
      if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py);
    }
    ctx.closePath();ctx.fill();
  } else {
    ctx.arc(x,y,Math.max(r,.0001),mark.type==='arc' ? .72 : 0,mark.type==='arc' ? Math.PI*2-.72 : Math.PI*2);
    if(mark.type==='dot'||mark.type==='circle')ctx.fill();else ctx.stroke();
  }
}

export function paintMask(ctx, state, image) {
  const side=ctx.canvas.width;
  ctx.clearRect(0,0,side,side);
  ctx.fillStyle=ctx.strokeStyle='#000';ctx.lineCap=ctx.lineJoin='round';
  const translated=state.offset.x!==0||state.offset.y!==0;
  if(translated){ctx.save();ctx.translate(state.offset.x*side,state.offset.y*side);}
  if(state.shape==='text') {
    drawMark(ctx,{type:'text',x:.5,y:.5,size:state.size,stroke:state.stroke,text:state.text},side);
  } else if(state.shape==='freehand') {
    const scale=state.size/900;
    for(const path of state.paths)drawMark(ctx,{type:'freehand',stroke:state.stroke,points:path.map(p=>({x:(p.x-.5)*scale+.5,y:(p.y-.5)*scale+.5}))},side);
  } else if(state.shape==='import' && image) {
    const scale=state.size/3000*side*state.importScale/Math.max(image.width,image.height);
    const width=image.width*scale,height=image.height*scale;
    ctx.drawImage(image,(side-width)/2,(side-height)/2,width,height);
  }
  state.marks.forEach(mark=>drawMark(ctx,mark,side));
  if(translated)ctx.restore();
}

export function scrubState(state, fraction) {
  state.progress=fraction*1.22;
  state.drops.forEach(drop=>drop.age=fraction*22);
}
