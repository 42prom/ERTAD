import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const tokens = JSON.parse(readFileSync(new URL('../../design/tokens.json', import.meta.url)));
const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
for (const family of ['web', 'mobile']) for (const mode of ['light', 'dark']) {
  test(`${family}/${mode}: readable semantic text and actions`, () => {
    const palette = tokens[family][mode];
    for (const surface of ['background', 'surface', 'elevated']) {
      for (const text of ['text', 'muted', 'success', 'danger']) {
        assert.ok(contrast(palette[text], palette[surface]) >= 4.5, `${text}/${surface}`);
      }
    }
    assert.ok(contrast(palette.primary, palette.onPrimary) >= 4.5, 'primary label');
    assert.ok(contrast(palette.focus, palette.surface) >= 3, 'focus indicator');
  });
}
