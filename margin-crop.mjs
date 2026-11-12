// Conservative display-only margin estimation. It deliberately prefers a
// remaining margin over cropping uncertain content. No OCR or PDF rewriting.
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const empty = () => ({left:0,top:0,right:0,bottom:0,footerExcluded:false});

export function detectPageMargins(pixels, width, height, {excludeFooter = false} = {}) {
  if (![width,height].every(n => Number.isInteger(n) && n > 0) || width * height > 2_000_000 || pixels?.length !== width * height * 4) {
    throw new RangeError('Unsupported margin preview size.');
  }
  if (width < 40 || height < 40) return empty();
  const histogram = new Uint32Array(256);
  for (let i=0;i<pixels.length;i+=4) histogram[Math.round(.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2])]++;
  let paper = 255, sum = 0;
  for (let value=0;value<256;value++) { sum += histogram[value]; if (sum >= width*height*.9) { paper=value; break; } }
  // Dark/photographic pages have no reliably identifiable white paper margin.
  if (paper < 185) return empty();
  const threshold = clamp(paper - 18, 170, 237);
  const mask = new Uint8Array(width*height), columns = new Uint32Array(width);
  for (let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=(y*width+x)*4, r=pixels[i], g=pixels[i+1], b=pixels[i+2];
    const luma=.2126*r+.7152*g+.0722*b, chroma=Math.max(r,g,b)-Math.min(r,g,b);
    if (luma < threshold || chroma > 18 && Math.min(r,g,b) < 240) { mask[y*width+x]=1; if(chroma<=18) columns[x]++; }
  }
  // A hairline scanner edge can span nearly the entire scan height. Ignore
  // only dense strips attached to the physical edge, never a side label.
  const edgeLimit = Math.max(1,Math.floor(width*.018));
  let leftEdge=0,rightEdge=width-1;
  while(leftEdge<edgeLimit && columns[leftEdge] >= height*.92) leftEdge++;
  while(rightEdge>=width-edgeLimit && columns[rightEdge] >= height*.92) rightEdge--;
  if(leftEdge===edgeLimit && columns[leftEdge] >= height*.92) leftEdge=0;
  if(rightEdge===width-edgeLimit-1 && columns[rightEdge] >= height*.92) rightEdge=width-1;

  const queue = new Uint32Array(width*height), components=[];
  for(let y=0;y<height;y++) for(let x=leftEdge;x<=rightEdge;x++) {
    const initial=y*width+x;
    if(mask[initial]!==1) continue;
    let head=0,tail=1,minX=x,maxX=x,minY=y,maxY=y,colorInk=0;
    queue[0]=initial; mask[initial]=2;
    while(head<tail) {
      const point=queue[head++], py=Math.floor(point/width), px=point-py*width;
      const offset=point*4;
      if(Math.max(pixels[offset],pixels[offset+1],pixels[offset+2])-Math.min(pixels[offset],pixels[offset+1],pixels[offset+2])>18) colorInk++;
      minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
        const nx=px+dx,ny=py+dy;
        if(nx<leftEdge || nx>rightEdge || ny<0 || ny>=height) continue;
        const next=ny*width+nx;
        if(mask[next]===1) {mask[next]=2;queue[tail++]=next;}
      }
    }
    // Omit only isolated one/two-pixel scan dust. The safety inset below
    // keeps punctuation adjacent to text even if its thumbnail is this small.
    if(tail>=3) {
      const boxWidth=maxX-minX+1,boxHeight=maxY-minY+1;
      const nearLeft=minX<=Math.max(2,width*.004),nearRight=maxX>=width-1-Math.max(2,width*.004);
      const nearTop=minY<=Math.max(2,height*.004),nearBottom=maxY>=height-1-Math.max(2,height*.004);
      const dense=tail/(boxWidth*boxHeight)>.35;
      // Scanned books often contain an exposed black scanner edge or a curved
      // paper corner. These disconnected fragments otherwise pin the bounds
      // to the page edge, or masquerade as a final footer band. Restrict their
      // removal to a very narrow edge zone; a side heading/label extending into
      // the page, or an edge-to-edge illustration, remains part of the content.
      const horizontalEdge=(nearTop && maxY<height*.025 || nearBottom && minY>height*.975) &&
        (dense || boxWidth>width*.2 && boxHeight<height*.012);
      const neutral=colorInk<=tail*.05;
      const verticalEdge=neutral && (nearLeft && maxX<width*.04 || nearRight && minX>width*.96) && boxHeight>height*.15;
      // A curved page edge is often just inside the canvas, and becomes a
      // broken thin grey line rather than touching its physical boundary.
      // Only achromatic fragments less than 1.2% wide in the outer 4% qualify.
      const spineFragment=neutral && boxWidth<=width*.012 && boxHeight>=3 &&
        (maxX<width*.04 || minX>width*.96);
      const corner=(nearLeft && maxX<width*.06 || nearRight && minX>width*.94) &&
        (nearTop && maxY<height*.05 || nearBottom && minY>height*.90);
      if(!horizontalEdge && !verticalEdge && !spineFragment && !corner) components.push({minX,maxX,minY,maxY,area:tail});
    }
  }
  if(!components.length) return empty();
  const totalInk=components.reduce((n,c)=>n+c.area,0);
  // A few marks on an otherwise blank page are not enough to infer a layout.
  if(totalInk < Math.max(12,width*height*.0001)) return empty();

  const rows = new Uint8Array(height);
  for(const c of components) for(let y=c.minY;y<=c.maxY;y++) rows[y]=1;
  const bands=[]; const joinGap=Math.max(1,Math.round(height*.003));
  for(let y=0;y<height;y++) if(rows[y]) {
    const start=y; let end=y;
    while(y+1<height) {
      let next=y+1;while(next<height && !rows[next] && next-y<=joinGap+1) next++;
      if(next>=height || !rows[next] || next-y>joinGap+1) break;
      y=next;end=y;
    }
    bands.push({start,end});
  }
  let lastContentRow=height-1,footerExcluded=false;
  if(excludeFooter && bands.length>=2) {
    const last=bands.at(-1),previous=bands.at(-2);
    const footer=components.filter(c=>c.minY>=last.start);
    const minX=Math.min(...footer.map(c=>c.minX)),maxX=Math.max(...footer.map(c=>c.maxX));
    const bandHeight=last.end-last.start+1,gap=last.start-previous.end-1;
    const footerInk=footer.reduce((n,c)=>n+c.area,0);
    // Page numbers/PART footers are short, near the bottom, and separated by
    // visible whitespace. A full-width line, dense table or nearby body line
    // is kept even when the user enables footer exclusion.
    if(last.start >= height*.84 && bandHeight<=height*.032 &&
       maxX-minX+1 <= width*.56 && gap >= Math.max(height*.035,bandHeight*1.8) &&
       previous.end-bands[0].start >= height*.12 && footerInk < totalInk*.16) {
      lastContentRow=previous.end;footerExcluded=true;
    }
  }
  const retained=components.filter(c=>c.minY<=lastContentRow);
  const minX=Math.min(...retained.map(c=>c.minX)),maxX=Math.max(...retained.map(c=>c.maxX));
  const minY=Math.min(...retained.map(c=>c.minY)),maxY=Math.max(...retained.map(c=>Math.min(c.maxY,lastContentRow)));
  const padX=Math.max(3,width*.012),padY=Math.max(3,height*.009);
  return resolveMargins({left:Math.max(0,minX-padX)/width,top:Math.max(0,minY-padY)/height,
    right:Math.max(0,width-1-maxX-padX)/width,bottom:Math.max(0,height-1-maxY-padY)/height,footerExcluded});
}

// Additional trim values are percentage points; negative values restore more
// of the page. They are bounded independently of the automatic estimate.
export function resolveMargins(detected = {}, {amount=100,trimLeft=0,trimTop=0,trimRight=0,trimBottom=0} = {}) {
  const finite=(value,fallback=0)=>Number.isFinite(Number(value)) ? Number(value) : fallback;
  const fraction=clamp(finite(amount,100),0,100)/100;
  const values={};
  for(const [side,extra,limit] of [['left',trimLeft,.25],['top',trimTop,.4],['right',trimRight,.25],['bottom',trimBottom,.4]]) {
    values[side]=clamp(clamp(finite(detected[side]),0,limit)*fraction+clamp(finite(extra),-15,15)/100,0,limit);
  }
  for(const [first,second,maximum] of [['left','right',.4],['top','bottom',.6]]) {
    const total=values[first]+values[second];
    if(total>maximum) {values[first]*=maximum/total;values[second]*=maximum/total;}
  }
  return {...values,footerExcluded:!!detected.footerExcluded && fraction>0};
}
