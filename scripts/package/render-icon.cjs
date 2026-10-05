// Renders build/icon.svg -> build/icon.png (1024x1024) for electron-builder.
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const buildDir = path.join(__dirname, '..', '..', 'build')

async function main() {
  const svg = fs.readFileSync(path.join(buildDir, 'icon.svg'))
  await sharp(svg, { density: 300 })
    .resize(1024, 1024)
    .png()
    .toFile(path.join(buildDir, 'icon.png'))
}

main().catch((err) => {
  console.error(`render-icon failed: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
