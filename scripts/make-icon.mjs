// Renders resources/icons/icon.svg to the PNG sizes electron-builder and the tray use.
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'resources', 'icons')
const svg = readFileSync(join(dir, 'icon.svg'))
await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(join(dir, 'icon.png'))
await sharp(svg, { density: 96 }).resize(32, 32).png().toFile(join(dir, 'tray.png'))
await sharp(svg, { density: 96 }).resize(256, 256).png().toFile(join(dir, 'icon-256.png'))
console.log('icons written to', dir)
