import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightCodeBlock } from '../src/highlight.js';

test('highlights Python fenced code', () => {
  const html = highlightCodeBlock(
    'python',
    'def hello(name):\n    return f"<{name}>"\n'
  );

  assert.match(html, /tok-keyword/);
  assert.match(html, /tok-function/);
  assert.match(html, /&lt;/);
  assert.match(html, /&gt;/);
  assert.doesNotMatch(html, /f"</);
});

test('highlights C and C++ fenced code aliases', () => {
  const c = highlightCodeBlock('c', 'int main(void) { return 0; }\n');
  const cpp = highlightCodeBlock('c++', 'std::string name = "ok";\n');

  assert.match(c, /tok-keyword/);
  assert.match(c, /tok-number/);
  assert.match(cpp, /tok-string/);
});

test('escapes unsupported code fences', () => {
  assert.equal(
    highlightCodeBlock('txt', '<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
});
