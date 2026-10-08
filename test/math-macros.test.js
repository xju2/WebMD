import assert from 'node:assert/strict';
import test from 'node:test';
import katex from 'katex';
import { renderMarkdown } from '../src/markdown.js';
import { withMathMacros } from '../src/math-macros.js';

function draw(node) {
  return katex.renderToString(node.text, {
    throwOnError: false,
    displayMode: node.type === 'mathBlock',
    globalGroup: true,
    macros: { ...node.macros }
  });
}

test('a macro defined once renders anywhere in the note', () => {
  const blocks = withMathMacros(
    renderMarkdown(`Used early: $\\bnoise$.

$\\newcommand{\\bnoise}{B_\\text{noise}}$

> [!note]
> Nested: $\\bnoise + 1$

$$
\\frac{S}{\\sqrt{\\bnoise}}
$$
`)
  );

  const early = blocks[0].children[1];
  const definition = blocks[1].children[0];
  const nested = blocks[2].children[0].children[1];
  const display = blocks[3];

  for (const node of [early, nested, display]) {
    assert.doesNotMatch(draw(node), /katex-error/);
    assert.match(draw(node), /noise/);
  }
  assert.doesNotMatch(draw(definition), /katex-error/);
  assert.match(
    draw(definition),
    /<span class="katex-html" aria-hidden="true"><\/span>/
  );
});

test('macros stay within their note and code', () => {
  const [code, text] = withMathMacros(
    renderMarkdown('```\n$\\newcommand{\\x}{y}$\n```\n\n$\\x$')
  );
  assert.equal(code.type, 'code');
  assert.match(draw(text.children[0]), /#cc0000/);
  assert.deepEqual(
    withMathMacros(renderMarkdown('$a$'))[0].children[0].macros,
    {}
  );
});
