// Rendert het LLMelt-bronicoon naar de PNG/ICO-formaten die Electron gebruikt.
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('public/icon-source.png');
const sourceMetadata = await sharp(source).metadata();
const sourceWidth = sourceMetadata.width || 1254;
const sourceHeight = sourceMetadata.height || 1254;
const cornerRadius = Math.round(Math.min(sourceWidth, sourceHeight) * 0.185);
const overscanScale = 1.02;
const overscanWidth = Math.ceil(sourceWidth * overscanScale);
const overscanHeight = Math.ceil(sourceHeight * overscanScale);
const cleanSource = await sharp(source)
  .resize(overscanWidth, overscanHeight)
  .extract({
    left: Math.floor((overscanWidth - sourceWidth) / 2),
    top: Math.floor((overscanHeight - sourceHeight) / 2),
    width: sourceWidth,
    height: sourceHeight,
  })
  .png()
  .toBuffer();
const alphaMask = Buffer.from(`
  <svg width="${sourceWidth}" height="${sourceHeight}" viewBox="0 0 ${sourceWidth} ${sourceHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="${sourceWidth - 2}" height="${sourceHeight - 2}" rx="${cornerRadius}" fill="#fff"/>
  </svg>
`);

// De aangeleverde bron heeft zwarte, geanti-aliasde hoeken in plaats van alpha.
// Een minimale overscan legt echte gradientpixels onder onze nieuwe zachte maskerrand
// en voorkomt daardoor een donkere halo in de Windows-ICO.
const master = await sharp(cleanSource)
  .composite([{ input: alphaMask, blend: 'dest-in' }])
  .png()
  .toBuffer();

// Hoofd-PNG (voor window/tray + electron-builder exe-conversie).
await sharp(master).resize(512, 512).png().toFile('public/icon.png');

// ICO uit meerdere PNG-groottes (scherp op elke schermgrootte).
const sizes = [256, 128, 64, 48, 32, 16];
const buffers = await Promise.all(sizes.map((size) => sharp(master).resize(size, size).png().toBuffer()));
const ico = pngBuffersToIco(buffers, sizes);
writeFileSync('public/icon.ico', ico);

console.log('Klaar: public/icon.png (512) + public/icon.ico (', sizes.join('/'), ')');

function pngBuffersToIco(images, imageSizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    const size = imageSizes[index];
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });

  return Buffer.concat([header, directory, ...images]);
}
