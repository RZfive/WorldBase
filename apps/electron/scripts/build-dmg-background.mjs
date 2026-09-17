// Rasterize build/dmg-background.svg to 1x/2x PNG for the DMG background.
// electron-builder's dmgbuild needs a real bitmap (SVG is not reliably readable),
// and tiffutil combines base + @2x into a Retina TIFF.
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../build/dmg-background.svg", import.meta.url));
await sharp(svg, { density: 72 }).png().toFile("build/dmg-background.png");
await sharp(svg, { density: 144 }).resize(1320, 800).png().toFile("build/dmg-background@2x.png");
console.log("dmg backgrounds written");
