import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Keep installed app icons aligned with the existing vector brand mark.
const source = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const output = new URL('../public/icons/', import.meta.url);
const background = '#176b47';
const artwork = source.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect\b[^>]*\/>/, '');
if (!source.includes('viewBox="0 0 64 64"') || !artwork.includes('<path')) {
  throw new Error('Review the app icon generator after changing the brand SVG.');
}
const opaque = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/>${artwork}</svg>`;
// The inset keeps every part of the mark inside the maskable central safe circle.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><g transform="translate(3.84 3.84) scale(.88)">${artwork}</g></svg>`;

await mkdir(output, { recursive: true });
for (const size of [192, 512]) {
  await sharp(Buffer.from(source)).resize(size, size).png().toFile(fileURLToPath(new URL(`icon-${size}.png`, output)));
}
await sharp(Buffer.from(maskable)).resize(512, 512).removeAlpha().png().toFile(fileURLToPath(new URL('icon-maskable-512.png', output)));
await sharp(Buffer.from(opaque)).resize(180, 180).removeAlpha().png().toFile(fileURLToPath(new URL('apple-touch-icon.png', output)));

console.log('Generated HisabFlow 192px, 512px, maskable, and Apple touch icons.');
