import { readFileSync,writeFileSync } from 'node:fs';
import sharp from 'sharp';
import opentype from 'opentype.js';
const dir='industry/brand/';
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>药研雷达</title><rect width="512" height="512" rx="112" fill="#176b75"/><g fill="none" stroke="#e8f3e5" stroke-width="14"><circle cx="256" cy="256" r="167" opacity=".35"/><path d="M256 89v59M423 256h-59M89 256h59M256 423v-59" opacity=".5"/><path d="M215 158h82M232 158v99l-67 112q-8 17 12 17h158q20 0 12-17l-67-112v-99"/><path d="M205 304h103"/></g><path d="M252 273q-74-40-72-99 75 1 93 67" fill="#badd97"/><path d="m252 273 92-91" fill="none" stroke="#badd97" stroke-width="16" stroke-linecap="round"/><circle cx="344" cy="182" r="17" fill="#badd97"/></svg>`;
writeFileSync(dir+'logo.svg',svg+'\n');
for(const [file,size] of [['icon.png',512],['icon-192.png',192],['apple-icon.png',180]]) await sharp(Buffer.from(svg)).resize(size,size).png().toFile(dir+file);
const png=await sharp(Buffer.from(svg)).resize(32,32).png().toBuffer();
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);writeFileSync(dir+'favicon.ico',Buffer.concat([header,png]));
const bytes=readFileSync('assets/og-fonts/noto-sans-sc-700.ttf');
const font=opentype.parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const boxes={};
for(const [name,a,b] of [['daily','药研','日报'],['weekly','药研','周报'],['monthly','药研','月报'],['archive','日报','合订本']]) {
  const size=220;const left=12;
  const accent=font.getPath(a,left,232,size).toPathData(2);
  const advance=font.getAdvanceWidth(a,size);
  const ink=font.getPath(b,left+advance+20,232,size).toPathData(2);
  const width=Math.ceil(left+advance+20+font.getAdvanceWidth(b,size)+12);
  boxes[name]=`0 0 ${width} 270`;
  writeFileSync(`${dir}nameplates/${name}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxes[name]}"><path id="accent" d="${accent}"/><path id="ink" d="${ink}"/></svg>\n`);
}
writeFileSync(dir+'nameplates/index.json',JSON.stringify(boxes,null,2)+'\n');
console.log('Pharma radar icons and report nameplates generated.');
