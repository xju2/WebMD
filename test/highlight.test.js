import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightCodeBlock, languageLabel } from '../src/highlight.js';

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
    '<span class="code-line">&lt;script&gt;alert(1)&lt;/script&gt;</span>'
  );
});

test('wraps every source line in its own span', () => {
  const highlighted = highlightCodeBlock('python', 'x = 1\n\ny = 2');
  const plain = highlightCodeBlock('txt', 'one\n\ntwo');

  assert.equal(highlighted.match(/class="code-line"/g).length, 3);
  assert.equal(plain.match(/class="code-line"/g).length, 3);
  assert.match(highlighted, /<span class="code-line"><\/span>/);
  assert.match(plain, /<span class="code-line"><\/span>/);
  assert.doesNotMatch(highlighted, /\n/);
});

test('labels fenced code languages', () => {
  assert.equal(languageLabel('py'), 'Python');
  assert.equal(languageLabel('C++'), 'C++');
  assert.equal(languageLabel('Bash'), 'bash');
  assert.equal(languageLabel(''), '');
  assert.equal(languageLabel(), '');
});
