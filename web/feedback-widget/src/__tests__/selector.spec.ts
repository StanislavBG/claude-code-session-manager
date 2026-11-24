import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_ID } from '../host';
import { describeElement, isAutoId, isHashedClass, uniqueSelector } from '../selector';

// jsdom has no layout: every rect is 0×0. Give every element a 100×40 box unless a test
// overrides it, so describeElement's 4×4 floor can be exercised deliberately.
const realRect = Element.prototype.getBoundingClientRect;
function setRect(el: Element, w: number, h: number) {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} }) as DOMRect;
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON() {} } as DOMRect;
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  document.body.innerHTML = '';
});

function $(sel: string): Element {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`fixture missing: ${sel}`);
  return el;
}

function expectUnique(el: Element): string {
  const sel = uniqueSelector(el);
  const hits = document.querySelectorAll(sel);
  expect(hits.length).toBe(1);
  expect(hits[0]).toBe(el);
  return sel;
}

describe('isAutoId / isHashedClass', () => {
  it('flags ids with a 4+ digit run', () => {
    expect(isAutoId('ember1234')).toBe(true);
    expect(isAutoId('row-20261123')).toBe(true);
    expect(isAutoId('step123')).toBe(false);
    expect(isAutoId('checkout')).toBe(false);
  });
  it('flags css-*, sc-* and mixed 5+ alphanumeric runs', () => {
    expect(isHashedClass('css-1x2y3z')).toBe(true);
    expect(isHashedClass('sc-bdVaJa')).toBe(true);
    expect(isHashedClass('Button_root__a8f3k')).toBe(true);
    expect(isHashedClass('x7k2q9')).toBe(true);
    expect(isHashedClass('book')).toBe(false);
    expect(isHashedClass('stay-card')).toBe(false);
    expect(isHashedClass('primary')).toBe(false);
    expect(isHashedClass('h2')).toBe(false);
  });
});

describe('uniqueSelector', () => {
  it('rule 1: uses #id when unique and not auto-generated', () => {
    document.body.innerHTML = '<main><button id="checkout" class="btn">Pay</button></main>';
    expect(expectUnique($('#checkout'))).toBe('#checkout');
  });

  it('rule 1: escapes ids that are not plain identifiers', () => {
    document.body.innerHTML = '<div id="a:b.c">x</div>';
    const el = document.getElementById('a:b.c')!;
    expect(expectUnique(el)).toBe('#a\\:b\\.c');
  });

  it('rule 1: skips an auto-generated id (4+ digit run)', () => {
    document.body.innerHTML = '<div><span id="ember1234" class="price">$9</span></div>';
    const sel = expectUnique($('span'));
    expect(sel).not.toContain('#');
    expect(sel).toBe('span.price');
  });

  it('rule 1: skips a duplicated id', () => {
    document.body.innerHTML =
      '<div><a id="dup" class="one">1</a></div><section><a id="dup" class="two">2</a></section>';
    const el = $('a.two');
    const sel = expectUnique(el);
    expect(sel).not.toContain('#dup');
  });

  it('rule 2: data-testid, then data-test, then data-cy', () => {
    document.body.innerHTML = `
      <button data-testid="save" data-test="t" data-cy="c" class="b">a</button>
      <button data-test="cancel" data-cy="c2" class="b">b</button>
      <button data-cy="close" class="b">c</button>`;
    expect(expectUnique($('[data-testid]'))).toBe('[data-testid="save"]');
    expect(expectUnique($('[data-test="cancel"]'))).toBe('[data-test="cancel"]');
    expect(expectUnique($('[data-cy="close"]'))).toBe('[data-cy="close"]');
  });

  it('rule 2: id wins over data-testid; a non-unique test attr falls through', () => {
    document.body.innerHTML = `
      <button id="go" data-testid="go-btn">go</button>
      <ul><li data-testid="row" class="first">1</li><li data-testid="row" class="second">2</li></ul>`;
    expect(expectUnique($('#go'))).toBe('#go');
    const sel = expectUnique($('li.second'));
    expect(sel).not.toContain('data-testid');
  });

  it('rule 2: escapes quotes in attribute values', () => {
    document.body.innerHTML = '<i data-testid=\'say "hi"\'>x</i>';
    expectUnique($('i'));
  });

  it('rule 3: tag.class1.class2 when already unique', () => {
    document.body.innerHTML = '<nav><a class="link active">A</a><a class="link">B</a></nav>';
    expect(expectUnique($('a.active'))).toBe('a.link.active');
  });

  it('rule 3: skips hashed classes', () => {
    document.body.innerHTML = '<div><p class="css-1x2y3z sc-bdVaJa note x7k2q9">hi</p></div>';
    expect(expectUnique($('p'))).toBe('p.note');
  });

  it('rule 3: adds :nth-of-type(k) among same-tag siblings', () => {
    document.body.innerHTML = '<ul><li class="item">1</li><li class="item">2</li><li class="item">3</li></ul>';
    expect(expectUnique($('li:nth-of-type(2)'))).toBe('li.item:nth-of-type(2)');
  });

  it('rule 3: walks up ancestors until unique (handoff example shape)', () => {
    document.body.innerHTML = `
      <main><section>
        <article class="stay-card"><div class="actions"><button class="book">Book</button></div></article>
        <article class="stay-card"><div class="actions"><button class="book">Book</button></div></article>
      </section></main>`;
    const target = document.querySelectorAll('button.book')[0];
    const sel = expectUnique(target);
    expect(sel).toBe('article.stay-card:nth-of-type(1) > div.actions > button.book');
  });

  it('rule 3: walks at most 4 ancestors, then falls back to a full unique path', () => {
    // Two identical 6-deep chains: 4 ancestors up is still ambiguous.
    const chain = '<div><div><div><div><div><span>x</span></div></div></div></div></div>';
    document.body.innerHTML = `<section>${chain}</section><section>${chain}</section>`;
    const target = document.querySelectorAll('span')[1];
    const sel = expectUnique(target);
    expect(sel.startsWith('html > body')).toBe(true);
  });

  it('rule 3: within 4 ancestors the selector has at most 5 segments', () => {
    const chain = '<div><div><div><span>x</span></div></div></div>';
    document.body.innerHTML = `<section>${chain}</section><section>${chain}</section>`;
    const target = document.querySelectorAll('span')[1];
    const sel = expectUnique(target);
    expect(sel.split(' > ').length).toBeLessThanOrEqual(5);
    expect(sel.startsWith('section:nth-of-type(2)')).toBe(true);
  });

  it('every element of a mixed fixture resolves to exactly one node', () => {
    document.body.innerHTML = `
      <header id="top"><nav class="nav"><a class="link">a</a><a class="link">b</a><a class="link css-abc12">c</a></nav></header>
      <main><section class="grid">
        <article class="card"><h2 class="title">One</h2><p>t</p><p>u</p><button data-cy="buy">Buy</button></article>
        <article class="card"><h2 class="title">Two</h2><p>t</p><p>u</p><button class="sc-xyz">Buy</button></article>
        <article class="card" id="card9999"><h2 class="title">Three</h2><p>t</p></article>
      </section></main>
      <footer><span>1</span><span>2</span></footer>`;
    for (const el of Array.from(document.body.querySelectorAll('*'))) expectUnique(el);
  });
});

describe('describeElement', () => {
  it('returns the full record for an element', () => {
    document.body.innerHTML = `
      <main><section>
        <article class="stay-card"><div class="actions">
          <button class="book primary" role="button" aria-label="Book this stay">
             Book   now
          </button>
        </div></article>
        <article class="stay-card"><div class="actions"><button class="book">Book</button></div></article>
      </section></main>`;
    const el = document.querySelectorAll('button.book')[0];
    const d = describeElement(el)!;
    expect(d).not.toBeNull();
    expect(d.selector).toBe(uniqueSelector(el));
    expect(document.querySelectorAll(d.selector).length).toBe(1);
    expect(d.label).toBe('button.book');
    expect(d.tag).toBe('button');
    expect(d.classes).toEqual(['book', 'primary']);
    expect(d.text).toBe('Book now');
    expect(d.role).toBe('button');
    expect(d.ariaLabel).toBe('Book this stay');
    expect(d.xpath).toBe('/html/body/main/section/article[1]/div/button');
    expect('id' in d).toBe(false);
    expect(document.evaluate(d.xpath, document, null, 9, null).singleNodeValue).toBe(el);
  });

  it('includes id when present and omits role/ariaLabel when absent', () => {
    document.body.innerHTML = '<div><span id="price">$9</span></div>';
    const d = describeElement($('#price'))!;
    expect(d.id).toBe('price');
    expect(d.label).toBe('span');
    expect(d.classes).toEqual([]);
    expect('role' in d).toBe(false);
    expect('ariaLabel' in d).toBe(false);
  });

  it('label uses the first non-hashed class', () => {
    document.body.innerHTML = '<div class="css-1x2y3z panel">x</div>';
    expect(describeElement($('div'))!.label).toBe('div.panel');
  });

  it('trims and caps text at 80 characters', () => {
    const long = 'abcdefgh '.repeat(20);
    document.body.innerHTML = `<p>   ${long}   </p>`;
    const d = describeElement($('p'))!;
    expect(d.text.length).toBeLessThanOrEqual(80);
    expect(d.text.length).toBeGreaterThanOrEqual(79);
    expect(d.text).toBe(d.text.trim());
  });

  it('returns null for html, body, and the widget host (and its contents)', () => {
    document.body.innerHTML = `<div id="${HOST_ID}"><span class="inner">x</span></div>`;
    expect(describeElement(document.documentElement)).toBeNull();
    expect(describeElement(document.body)).toBeNull();
    expect(describeElement(document.getElementById(HOST_ID)!)).toBeNull();
    expect(describeElement($('span.inner'))).toBeNull();
  });

  it('returns null for elements smaller than 4×4', () => {
    document.body.innerHTML = '<i class="a">.</i><i class="b">.</i><i class="c">.</i>';
    setRect($('i.a'), 3, 40);
    setRect($('i.b'), 40, 3);
    setRect($('i.c'), 4, 4);
    expect(describeElement($('i.a'))).toBeNull();
    expect(describeElement($('i.b'))).toBeNull();
    expect(describeElement($('i.c'))).not.toBeNull();
  });
});
