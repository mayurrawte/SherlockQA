const path = require('path');
const fs = require('fs');
const { extractChangedSymbols, extractSymbolsRegex } = require('./context');

const fx = (name) => {
  const p = path.join(__dirname, '__fixtures__', name);
  return { p, src: fs.readFileSync(p, 'utf8') };
};

describe('extractChangedSymbols (tree-sitter)', () => {
  test('python: changed line inside a function yields that function', async () => {
    const { p, src } = fx('sample.py');
    const syms = await extractChangedSymbols(p, src, [{ start: 2, end: 2 }]);
    expect(syms.map(s => s.name)).toContain('rate_for');
  });

  test('python: changed line inside a method yields method and class', async () => {
    const { p, src } = fx('sample.py');
    const names = (await extractChangedSymbols(p, src, [{ start: 9, end: 9 }])).map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['total', 'Quote']));
  });

  test('python: decorated def is found', async () => {
    const { p, src } = fx('sample.py');
    const names = (await extractChangedSymbols(p, src, [{ start: 15, end: 15 }])).map(s => s.name);
    expect(names).toContain('lookup');
  });

  test('js: function, arrow-const and class method are found', async () => {
    const { p, src } = fx('sample.js');
    expect((await extractChangedSymbols(p, src, [{ start: 2, end: 2 }])).map(s => s.name)).toContain('calc');
    expect((await extractChangedSymbols(p, src, [{ start: 5, end: 5 }])).map(s => s.name)).toContain('fmt');
    expect((await extractChangedSymbols(p, src, [{ start: 8, end: 9 }])).map(s => s.name)).toEqual(expect.arrayContaining(['open', 'Box']));
  });

  test('ts: exported function found', async () => {
    const { p, src } = fx('sample.ts');
    expect((await extractChangedSymbols(p, src, [{ start: 6, end: 6 }])).map(s => s.name)).toContain('parseOpts');
  });

  test('changed lines outside any definition yield no symbols', async () => {
    const { p, src } = fx('sample.py');
    expect(await extractChangedSymbols(p, src, [{ start: 4, end: 4 }])).toEqual([]);
  });

  test('unsupported extension falls back to regex extractor', async () => {
    const { p, src } = fx('sample.rs');
    const syms = await extractChangedSymbols(p, src, [{ start: 1, end: 1 }]);
    expect(syms.map(s => s.name)).toContain('main');
  });
});

describe('extractSymbolsRegex fallback', () => {
  test('finds def/function/class/func/fn on changed lines', () => {
    const src = 'fn main() {\n}\nclass Foo:\n';
    const syms = extractSymbolsRegex('x.rs', src, [{ start: 1, end: 3 }]);
    expect(syms.map(s => s.name)).toEqual(expect.arrayContaining(['main', 'Foo']));
  });
});
