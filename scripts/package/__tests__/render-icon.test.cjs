const path = require('node:path')
const sharp = require('sharp')

describe('build/icon.png', () => {
  it('is a 1024x1024 PNG', async () => {
    const meta = await sharp(path.join(__dirname, '..', '..', '..', 'build', 'icon.png')).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(1024)
    expect(meta.height).toBe(1024)
  })
})
