import { describe, expect, it } from 'vitest';
import {
  MACRO_INPUT_MAX_LEN,
  defaultMacroValues,
  macroPlaceholders,
  renderMacroPrompt,
} from '../macroPrompt';
import type { MacroInput } from '../../../preload/api';

const stream: MacroInput = { name: 'stream', label: 'Stream', default: 'education-veggies' };

describe('renderMacroPrompt', () => {
  it('renders the default and an override', () => {
    expect(renderMacroPrompt('stream={{stream}}', [stream], {})).toEqual({
      ok: true,
      prompt: 'stream=education-veggies',
    });
    expect(renderMacroPrompt('stream={{ stream }}', [stream], { stream: 'sports' })).toEqual({
      ok: true,
      prompt: 'stream=sports',
    });
  });

  it('blocks a missing required input', () => {
    const r = renderMacroPrompt('x={{topic}}', [{ name: 'topic', label: 'Topic', required: true }], {});
    expect(r).toEqual({ ok: false, error: '"Topic" is required' });
  });

  it('blocks an over-long value', () => {
    const r = renderMacroPrompt('{{stream}}', [stream], { stream: 'a'.repeat(MACRO_INPUT_MAX_LEN + 1) });
    expect(r).toEqual({ ok: false, error: '"Stream" is longer than 500 characters' });
  });

  it('sanitizes newlines, tabs and control characters', () => {
    const r = renderMacroPrompt('{{stream}}', [stream], { stream: '  a\r\nb\tc\u0000d\u007fe  ' });
    expect(r).toEqual({ ok: true, prompt: 'a b cde' });
  });

  it('never re-expands placeholders or replacement patterns', () => {
    const inputs: MacroInput[] = [
      { name: 'a', label: 'A' },
      { name: 'other', label: 'Other', default: 'LEAK' },
    ];
    const r = renderMacroPrompt('{{a}}|{{other}}', inputs, { a: '{{other}} $& $1' });
    expect(r).toEqual({ ok: true, prompt: '{{other}} $& $1|LEAK' });
  });

  it('blocks a value not in options', () => {
    const r = renderMacroPrompt('{{s}}', [{ name: 's', label: 'S', options: ['a', 'b'] }], { s: 'c' });
    expect(r).toEqual({ ok: false, error: '"S" must be one of: a, b' });
  });

  it('blocks an undeclared placeholder', () => {
    expect(renderMacroPrompt('{{stream}} {{x}}', [stream], {})).toEqual({
      ok: false,
      error: 'prompt uses undeclared input {{x}}',
    });
  });

  it('blocks a rendered prompt over 8000 chars', () => {
    const r = renderMacroPrompt('a'.repeat(8000) + '{{stream}}', [stream], {});
    expect(r.ok).toBe(false);
  });

  it('blocks an undeclared placeholder when there are no inputs', () => {
    const err = { ok: false, error: 'prompt uses undeclared input {{x}}' };
    expect(renderMacroPrompt('keep {{x}}', [], {})).toEqual(err);
    expect(renderMacroPrompt('keep {{x}}', undefined, {})).toEqual(err);
  });

  it('passes a placeholder-free prompt through when there are no inputs', () => {
    expect(renderMacroPrompt('keep $& literal', undefined, {})).toEqual({ ok: true, prompt: 'keep $& literal' });
  });

  it('reads values by own property only', () => {
    const r = renderMacroPrompt('{{constructor}}', [{ name: 'constructor', label: 'C', default: 'd' }], {});
    expect(r).toEqual({ ok: true, prompt: 'd' });
  });
});

describe('defaultMacroValues / macroPlaceholders', () => {
  it('maps defaults, empty when absent', () => {
    expect(defaultMacroValues([stream, { name: 'b', label: 'B' }])).toEqual({
      stream: 'education-veggies',
      b: '',
    });
    expect(defaultMacroValues(undefined)).toEqual({});
  });

  it('lists distinct placeholders in order', () => {
    expect(macroPlaceholders('{{a}} {{ b }} {{a}} {{Bad}}')).toEqual(['a', 'b']);
  });
});
