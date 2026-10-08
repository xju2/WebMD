import katex from 'katex';

const DEFINITION =
  /\\(?:newcommand|renewcommand|providecommand|def|gdef|let)(?![A-Za-z])/;

/**
 * Gives every formula in a rendered note the note's TeX macros, so
 * `$\newcommand{\bnoise}{B_\text{noise}}$` once lets any `$\bnoise$` render,
 * above the definition as well as below it. Each formula is still drawn on its
 * own, so the macros ride on its node: a definition gets the table as it stood
 * before it (repeating `\newcommand` against its own result is an error), and
 * every other formula the finished one.
 */
export function withMathMacros(blocks) {
  const formulas = [];
  collectFormulas(blocks, formulas);

  const macros = {};
  for (const node of formulas) {
    if (!DEFINITION.test(node.text)) continue;
    node.macros = { ...macros };
    katex.renderToString(node.text, {
      throwOnError: false,
      displayMode: node.type === 'mathBlock',
      globalGroup: true,
      macros
    });
  }
  for (const node of formulas) node.macros ??= macros;
  return blocks;
}

// Walks the block tree in document order; segments sit under several field
// names (children, items, rows, cells, summary...), so every value is visited.
function collectFormulas(value, formulas) {
  if (Array.isArray(value)) {
    for (const item of value) collectFormulas(item, formulas);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'math' || value.type === 'mathBlock') {
    formulas.push(value);
    return;
  }
  for (const child of Object.values(value)) collectFormulas(child, formulas);
}
