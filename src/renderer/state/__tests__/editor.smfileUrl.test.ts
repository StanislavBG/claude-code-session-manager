import { describe, it, expect } from 'vitest'
import { smfileUrl } from '../editor'

describe('smfileUrl', () => {
  it('converts a win32 backslash path', () => {
    expect(smfileUrl('C:\\Users\\me\\x.png')).toBe('smfile://local/C%3A/Users/me/x.png')
  })
  it('encodes spaces per segment', () => {
    expect(smfileUrl('C:\\Users\\me\\my site\\a.html')).toBe('smfile://local/C%3A/Users/me/my%20site/a.html')
  })
  it('keeps posix paths', () => {
    expect(smfileUrl('/home/me/x.png')).toBe('smfile://local/home/me/x.png')
  })
})
