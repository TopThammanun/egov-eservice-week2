const fs=require("fs"),cp=require("child_process"),{PNG}=require("pngjs"),{GIFEncoder,quantize,applyPalette}=require("gifenc");
const R="/workspace/plans/egov-eservice/app/e2e/report",F="/opt/ms-playwright/ffmpeg-1013/ffmpeg-linux";
const p1=new Set(fs.readFileSync("/workspace/egov-brief/TEST-PLAN.md","utf8").split("\n").filter(l=>/^\| TC-[A-Z]+-\d+ .*\| P1 \|/.test(l)).map(l=>l.split(" ")[1]));
const rows=fs.readFileSync(R+"/map.tsv","utf8").trim().split("\n").map(l=>l.split("\t"));
fs.mkdirSync(R+"/gifs",{recursive:true});let n=0,miss=[...p1];
for(const [tc,vid] of rows){ if(!p1.has(tc))continue; miss=miss.filter(x=>x!==tc);
 fs.rmSync("fr",{recursive:true,force:true});fs.mkdirSync("fr");
 cp.spawnSync(F,["-loglevel","error","-y","-i",vid,"-r","2","fr/f%03d.png"]);
 let a=fs.readdirSync("fr").sort(); if(a.length>24){const k=a.length/24;a=Array.from({length:24},(_,i)=>a[Math.floor(i*k)]);}
 if(!a.length){console.log("noframes",tc);continue}
 const g=GIFEncoder();
 for(const f of a){const im=PNG.sync.read(fs.readFileSync("fr/"+f));const w=im.width>>1,h=im.height>>1,d=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const s=(y*2*im.width+x*2)*4,o=(y*w+x)*4;d[o]=im.data[s];d[o+1]=im.data[s+1];d[o+2]=im.data[s+2];d[o+3]=255}
  const pal=quantize(d,128);g.writeFrame(applyPalette(d,pal),w,h,{palette:pal,delay:500});}
 g.finish();fs.writeFileSync(R+"/gifs/"+tc+".gif",g.bytes());n++}
console.log("gifs",n,"P1 without video:",miss.join(" "));
