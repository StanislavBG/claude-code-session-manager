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

  describe('trailing punctuation trim', () => {
    it('strips bold markers', () => {
      expect(extractUrls('**https://a.io/x/**')).toEqual(['https://a.io/x/'])
    })

    it('strips backticks', () => {
      expect(extractUrls('`https://a.io/x`')).toEqual(['https://a.io/x'])
    })

    it('strips a sentence-ending period', () => {
      expect(extractUrls('see https://a.io/x.')).toEqual(['https://a.io/x'])
    })

    it('strips italic underscores', () => {
      expect(extractUrls('_https://a.io_')).toEqual(['https://a.io'])
    })

    it('strips mixed trailing punctuation repeatedly', () => {
      expect(extractUrls('(https://a.io/x.),')).toEqual(['https://a.io/x'])
      expect(extractUrls('"https://a.io/x"!?')).toEqual(['https://a.io/x'])
      expect(extractUrls('[https://a.io/x];')).toEqual(['https://a.io/x'])
    })

    it('keeps a balanced trailing paren', () => {
      expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
        'https://en.wikipedia.org/wiki/Foo_(bar)',
      ])
    })

    it('strips an unbalanced trailing paren', () => {
      expect(extractUrls('(see https://a.io/x)')).toEqual(['https://a.io/x'])
    })

    it('dedups on the trimmed URL', () => {
      expect(extractUrls('**https://a.io/x** and https://a.io/x.')).toEqual(['https://a.io/x'])
    })

    it('caps at 3 after trimming', () => {
      const text = ['1', '2', '3', '4'].map((n) => `**https://a.io/${n}**`).join(' ')
      expect(extractUrls(text)).toEqual([
        'https://a.io/1',
        'https://a.io/2',
        'https://a.io/3',
      ])
    })

    it('still extracts markdown [label](url) links', () => {
      expect(extractUrls('[docs](https://a.io/x)')).toEqual(['https://a.io/x'])
    })

    it('drops a bare scheme with nothing after it', () => {
      expect(extractUrls('https://')).toEqual([])
      expect(extractUrls('**https://**')).toEqual([])
    })
  })
})
