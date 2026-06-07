import { describe, it, expect } from 'vitest';
import { checkAllowlist } from '../src/auth';

describe('checkAllowlist', () => {
  it('returns true for an exact email match', () => {
    expect(checkAllowlist('alice@example.com', 'alice@example.com')).toBe(true);
  });

  it('returns false for a non-listed email', () => {
    expect(checkAllowlist('eve@evil.com', 'alice@example.com')).toBe(false);
  });

  it('accepts a comma-separated list and matches any entry', () => {
    const list = 'alice@example.com,bob@example.com,carol@example.com';
    expect(checkAllowlist('bob@example.com', list)).toBe(true);
    expect(checkAllowlist('carol@example.com', list)).toBe(true);
    expect(checkAllowlist('dave@example.com', list)).toBe(false);
  });

  it('trims whitespace around list entries', () => {
    expect(checkAllowlist('alice@example.com', ' alice@example.com , bob@example.com ')).toBe(true);
  });

  it('is case-insensitive (both list and input lowercased)', () => {
    expect(checkAllowlist('Alice@Example.COM', 'alice@example.com')).toBe(true);
    expect(checkAllowlist('alice@example.com', 'ALICE@EXAMPLE.COM')).toBe(true);
  });

  it('returns false for an empty allowlist', () => {
    expect(checkAllowlist('alice@example.com', '')).toBe(false);
  });

  it('returns false when allowlist contains only empty strings after split', () => {
    expect(checkAllowlist('alice@example.com', ',,')).toBe(false);
  });

  it('rejects a partial match (substring is not a member)', () => {
    expect(checkAllowlist('alice@example.com', 'lice@example.com')).toBe(false);
  });
});
