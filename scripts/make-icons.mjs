// Renders the app icons from public/favicon.svg (the logo) into public/icons/.
// usage: npm run icons   (run again whenever favicon.svg changes)
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BG = "#0b4338"; // the logo's own background colour
const src = readFileSync("public/favicon.svg", "utf8");
const inner = src.replace(/^<\?xml[^>]*>\s*/, "").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// The logo at `scale` of the canvas; `square` fills the canvas behind it (iOS rounds the corners itself,
// and Android's maskable icons are cropped to a circle or squircle that must stay inside the logo's rings).
const frame = (size, scale, square) => {
  const w = size * scale;
  const o = (size - w) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${
    square ? `<rect width="${size}" height="${size}" fill="${BG}"/>` : ""
  }<svg x="${o}" y="${o}" width="${w}" height="${w}" viewBox="0 0 40 40">${inner}</svg></svg>`;
};

// Android shows a small single-colour mark on notifications: the rings alone, white on transparent.
const mono = inner.replace(/<rect[^>]*\/>/, "").replace(/stroke="#e4f0ee"/, 'stroke="#ffffff"');
const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 40 40">${mono}</svg>`;

const icons = [
  ["icon-192.png", frame(192, 1, false)],
  ["icon-512.png", frame(512, 1, false)],
  ["maskable-512.png", frame(512, 0.72, true)],
  ["apple-touch-icon-180.png", frame(180, 1, true)],
  ["badge-96.png", badge],
];
mkdirSync("public/icons", { recursive: true });
for (const [name, svg] of icons) {
  const png = new Resvg(svg).render().asPng();
  writeFileSync(join("public/icons", name), png);
  console.log(`wrote public/icons/${name} (${png.length} bytes)`);
}
