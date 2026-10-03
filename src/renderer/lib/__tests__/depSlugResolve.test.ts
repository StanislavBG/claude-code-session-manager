import { describe, it, expect } from 'vitest'
import { bareSlug, resolveDepSlug, canonicalizeDependsOn } from '../depSlugResolve'

describe('bareSlug', () => {
  it('strips exactly one leading NN- prefix', () => {
    expect(bareSlug('1-web-export-preset-and-git')).toBe('web-export-preset-and-git')
    expect(bareSlug('42-foo')).toBe('foo')
  })

  it('leaves a bare slug unchanged', () => {
    expect(bareSlug('web-export-preset-and-git')).toBe('web-export-preset-and-git')
  })
})

describe('resolveDepSlug', () => {
  it('matches exactly when the dep is already a real slug', () => {
    expect(resolveDepSlug('1-foo', ['1-foo', '2-bar'])).toEqual(['1-foo'])
  })

  it('matches a bare dep to its prefixed candidate', () => {
    expect(resolveDepSlug('foo', ['1-foo', '2-bar'])).toEqual(['1-foo'])
  })

  it('returns empty for an unknown dep', () => {
    expect(resolveDepSlug('missing', ['1-foo', '2-bar'])).toEqual([])
  })

  it('returns every candidate when the bare name is ambiguous', () => {
    expect(resolveDepSlug('foo', ['3-foo', '9-foo'])).toEqual(['3-foo', '9-foo'])
  })
})

describe('canonicalizeDependsOn', () => {
  it('rewrites a bare dependsOn entry to its single resolved slug', () => {
    const jobs = [
      { slug: '1-foo', dependsOn: undefined },
      { slug: '2-bar', dependsOn: ['foo'] },
    ]
    const result = canonicalizeDependsOn(jobs)
    expect(result[1].dependsOn).toEqual(['1-foo'])
  })

  it('leaves an already-prefixed dep unchanged', () => {
    const jobs = [
      { slug: '1-foo', dependsOn: undefined },
      { slug: '2-bar', dependsOn: ['1-foo'] },
    ]
    const result = canonicalizeDependsOn(jobs)
    expect(result[1].dependsOn).toEqual(['1-foo'])
  })

  it('leaves an unknown dep unchanged', () => {
    const jobs = [
      { slug: '1-foo', dependsOn: undefined },
      { slug: '2-bar', dependsOn: ['nope'] },
    ]
    const result = canonicalizeDependsOn(jobs)
    expect(result[1].dependsOn).toEqual(['nope'])
  })

  it('leaves an ambiguous bare dep unchanged', () => {
    const jobs = [
      { slug: '3-foo', dependsOn: undefined },
      { slug: '9-foo', dependsOn: undefined },
      { slug: '2-bar', dependsOn: ['foo'] },
    ]
    const result = canonicalizeDependsOn(jobs)
    expect(result[2].dependsOn).toEqual(['foo'])
  })

  it('preserves null, undefined, and empty dependsOn', () => {
    const jobs = [
      { slug: '1-a', dependsOn: null },
      { slug: '2-b', dependsOn: undefined },
      { slug: '3-c', dependsOn: [] },
    ]
    const result = canonicalizeDependsOn(jobs)
    expect(result[0].dependsOn).toBeNull()
    expect(result[1].dependsOn).toBeUndefined()
    expect(result[2].dependsOn).toEqual([])
  })

  it('does not mutate the input array or job objects', () => {
    const jobs = [
      { slug: '1-foo', dependsOn: undefined },
      { slug: '2-bar', dependsOn: ['foo'] },
    ]
    const jobsCopy = jobs.map((j) => ({ ...j }))
    canonicalizeDependsOn(jobs)
    expect(jobs).toEqual(jobsCopy)
  })

  it('returns the same object identity for jobs that needed no rewrite', () => {
    const jobs = [
      { slug: '1-foo', dependsOn: undefined },
      { slug: '2-bar', dependsOn: ['1-foo'] },
      { slug: '3-baz', dependsOn: ['nope'] },
    ]
    const result = canonicalizeDependsOn(jobs)
    expect(result[0]).toBe(jobs[0])
    expect(result[1]).toBe(jobs[1])
    expect(result[2]).toBe(jobs[2])
  })

  it('returns a new array (does not mutate the input array identity requirement loosely)', () => {
    const jobs = [{ slug: '1-foo', dependsOn: ['bar'] }, { slug: '2-bar', dependsOn: undefined }]
    const result = canonicalizeDependsOn(jobs)
    expect(result[0]).not.toBe(jobs[0])
    expect(result[0].dependsOn).toEqual(['2-bar'])
  })
})
