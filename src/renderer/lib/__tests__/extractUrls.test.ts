import { describe, it, expect } from 'vitest'
import { extractUrls } from '../extractUrls'

describe('extractUrls', () => {
  it('returns [] for text with no URL', () => {
    expect(extractUrls('no links here')).toEqual([])
    expect(extractUrls('')).toEqual([])
  })

  it('extracts a bare URL', () => {
    expect(extractUrls('see https://example.com/path for details')).toEqual([
      'https://example.com/path',
    ])
  })

  it('extracts the URL from a markdown link', () => {
    expect(extractUrls('check [the docs](https://example.com/docs) out')).toEqual([
      'https://example.com/docs',
    ])
  })

  it('dedups a URL that appears twice in the same text', () => {
    expect(
      extractUrls('go to https://example.com/a then again https://example.com/a')
    ).toEqual(['https://example.com/a'])
  })

  it('caps at 3 URLs when more than 3 are present', () => {
    const text = [
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
      'https://example.com/5',
    ].join(' ')
    expect(extractUrls(text)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])
  })
})
