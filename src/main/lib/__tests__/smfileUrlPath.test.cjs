'use strict';

// vitest globals (describe/it/expect)

const os = require('node:os');
const path = require('node:path');
const { smfileUrlToPath } = require('../smfileHeaders.cjs');
const { assertInsideHome } = require('../insideHome.cjs');

describe('smfileUrlToPath', () => {
  it('maps a win32 drive path to a backslash path', () => {
    expect(smfileUrlToPath('/C%3A/Users/me/x.png', 'win32')).toBe('C:\\Users\\me\\x.png');
  });
  it('keeps a lower-case drive letter', () => {
    expect(smfileUrlToPath('/c%3A/Users/me/x.png', 'win32')).toBe('c:\\Users\\me\\x.png');
  });
  it('decodes encoded spaces', () => {
    expect(smfileUrlToPath('/C%3A/Users/me/my%20site/a%20b.html', 'win32')).toBe(
      'C:\\Users\\me\\my site\\a b.html',
    );
  });
  it('resolves relative assets next to the document', () => {
    expect(smfileUrlToPath('/C%3A/Users/me/site/chart.js', 'win32')).toBe('C:\\Users\\me\\site\\chart.js');
  });
  it('tolerates the legacy backslash-encoded shape', () => {
    expect(smfileUrlToPath('/C%3A%5CUsers%5Cme%5Cx.png', 'win32')).toBe('C:\\Users\\me\\x.png');
  });
  it('leaves posix input unchanged', () => {
    expect(smfileUrlToPath('/home/me/my%20site/x.png', 'linux')).toBe('/home/me/my site/x.png');
  });
  it('defaults to process.platform', () => {
    if (process.platform !== 'win32') {
      expect(smfileUrlToPath('/home/me/x.png')).toBe('/home/me/x.png');
    }
  });
  it("'..' traversal is still rejected by assertInsideHome", () => {
    if (process.platform === 'win32') return;
    const p = smfileUrlToPath(encodeURI(path.join(os.homedir(), '..', '..', 'etc', 'passwd')), process.platform);
    expect(() => assertInsideHome(p)).toThrow();
  });
});
