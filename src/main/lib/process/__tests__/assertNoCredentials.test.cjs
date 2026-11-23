import { describe, it, expect } from 'vitest';

const {
  assertNoCredentials, stripCredentials, cleanChildEnv, CREDENTIAL_EXCEPTIONS,
} = require('../cleanEnv.cjs');

describe('assertNoCredentials', () => {
  it('refuses a secret key, naming each key but never its value', () => {
    const env = { PATH: '/bin', GITHUB_TOKEN: 'ghp_supersecret', ANTHROPIC_API_KEY: 'sk-ant-xyz' };
    let err;
    try { assertNoCredentials(env, { site: 'scheduler-job' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('credentials_in_env');
    expect(err.message).toContain('GITHUB_TOKEN');
    expect(err.message).toContain('ANTHROPIC_API_KEY');
    expect(err.message).not.toContain('ghp_supersecret');
    expect(err.message).not.toContain('sk-ant-xyz');
    expect(err.keys).toEqual(['GITHUB_TOKEN', 'ANTHROPIC_API_KEY']);
  });

  it('passes a clean env at every checked site', () => {
    const env = { PATH: '/bin', HOME: '/home/x', SM_PROC_ROLE: 'job' };
    for (const site of ['scheduler-job', 'task', 'chat', 'chat-agent']) {
      expect(() => assertNoCredentials(env, { site })).not.toThrow();
    }
  });

  it('passes cleanChildEnv output even when process.env carries secrets', () => {
    const prev = process.env.SOME_SERVICE_TOKEN;
    process.env.SOME_SERVICE_TOKEN = 'leak';
    try {
      expect(() => assertNoCredentials(cleanChildEnv({ PATH: '/bin' }), { site: 'scheduler-job' })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SOME_SERVICE_TOKEN; else process.env.SOME_SERVICE_TOKEN = prev;
    }
  });

  it('lets an exception site pass even with a secret key', () => {
    const env = { PATH: '/bin', GITHUB_TOKEN: 'x' };
    expect(() => assertNoCredentials(env, { site: 'runClaudeP' })).not.toThrow();
    expect(() => assertNoCredentials(env, { site: 'docEdit' })).not.toThrow();
  });

  it('refuses an unknown site name, even with a clean env', () => {
    for (const opts of [{ site: 'mystery' }, { site: '' }, {}, undefined]) {
      let err;
      try { assertNoCredentials({ PATH: '/bin' }, opts); } catch (e) { err = e; }
      expect(err && err.code).toBe('credential_site_unknown');
    }
  });

  it('CREDENTIAL_EXCEPTIONS is frozen and names exactly runClaudeP + docEdit with a reason', () => {
    expect(Object.isFrozen(CREDENTIAL_EXCEPTIONS)).toBe(true);
    expect(CREDENTIAL_EXCEPTIONS.map((e) => e.site).sort()).toEqual(['docEdit', 'runClaudeP']);
    for (const e of CREDENTIAL_EXCEPTIONS) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(typeof e.reason).toBe('string');
      expect(e.reason.length).toBeGreaterThan(10);
    }
    expect(() => { /** @type {any} */ (CREDENTIAL_EXCEPTIONS).push({ site: 'x', reason: 'y' }); }).toThrow();
  });

  it('stripCredentials removes only secret-shaped keys', () => {
    expect(stripCredentials({ PATH: '/bin', FOO_SECRET: 's', NPM_TOKEN: 't' })).toEqual({ PATH: '/bin' });
  });
});
