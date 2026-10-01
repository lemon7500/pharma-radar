import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Pharma Radar</title><rect width="64" height="64" rx="12" fill="#183047"/><g transform="translate(6 6) scale(1.625)" fill="none" stroke="#EEECE5"><path d="M7 25V7h8c7 0 10 9 4 13h-9M21 5l5 5-5 5" stroke-width="2" stroke-linejoin="round"/><path d="M18 24c6-5 8-1 8-1-2 7-7 6-8 1Z" stroke="#ABC4A3" stroke-width="1.5"/></g></svg>`;
await writeFile('industry/brand/logo.svg',svg+'\n');
for(const [file,size] of [['icon.png',512],['icon-192.png',192],['apple-icon.png',180]]) await sharp(Buffer.from(svg)).resize(size,size).png().toFile('industry/brand/'+file);
const png=await sharp(Buffer.from(svg)).resize(32,32).png().toBuffer();const head=Buffer.alloc(22);head.writeUInt16LE(1,2);head.writeUInt16LE(1,4);head[6]=32;head[7]=32;head.writeUInt16LE(1,10);head.writeUInt16LE(32,12);head.writeUInt32LE(png.length,14);head.writeUInt32LE(22,18);await writeFile('industry/brand/favicon.ico',Buffer.concat([head,png]));
console.log('Pharma Radar icons generated');

// Keep the downloadable legacy nameplate assets consistent with the English brand.
const {readFileSync,writeFileSync}=await import('node:fs');
const {default:opentype}=await import('opentype.js');
const bytes=readFileSync('assets/og-fonts/noto-sans-sc-700.ttf');
const font=opentype.parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const boxes={};
for(const [name,label] of [['daily','DAILY'],['weekly','WEEKLY'],['monthly','MONTHLY'],['archive','ARCHIVE']]) {
 const a='Pharma Radar',size=96;const offset=font.getAdvanceWidth(a,size)+32;
 const width=Math.ceil(offset+font.getAdvanceWidth(label,36)+16);
 boxes[name]=`0 0 ${width} 135`;
 writeFileSync(`industry/brand/nameplates/${name}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxes[name]}"><title>Pharma Radar ${label}</title><path id="accent" d="${font.getPath(a,8,104,size).toPathData(2)}"/><path id="ink" d="${font.getPath(label,offset,104,36).toPathData(2)}"/></svg>\n`);
}
writeFileSync('industry/brand/nameplates/index.json',JSON.stringify(boxes,null,2)+'\n');
