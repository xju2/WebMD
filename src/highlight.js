import { cppLanguage } from '@codemirror/lang-cpp';
import { jsonLanguage } from '@codemirror/lang-json';
import { pythonLanguage } from '@codemirror/lang-python';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight';

const shellLanguage = StreamLanguage.define(shell);

const languages = new Map([
  ['py', pythonLanguage],
  ['python', pythonLanguage],
  ['c', cppLanguage],
  ['cc', cppLanguage],
  ['cpp', cppLanguage],
  ['c++', cppLanguage],
  ['cxx', cppLanguage],
  ['h', cppLanguage],
  ['hpp', cppLanguage],
  ['hxx', cppLanguage],
  ['bash', shellLanguage],
  ['sh', shellLanguage],
  ['shell', shellLanguage],
  ['zsh', shellLanguage],
  ['console', shellLanguage],
  ['json', jsonLanguage],
  ['yaml', yamlLanguage],
  ['yml', yamlLanguage]
]);

const labels = new Map([
  ['py', 'Python'],
  ['python', 'Python'],
  ['c', 'C'],
  ['cc', 'C++'],
  ['cpp', 'C++'],
  ['c++', 'C++'],
  ['cxx', 'C++'],
  ['h', 'C header'],
  ['hpp', 'C++ header'],
  ['hxx', 'C++ header'],
  ['bash', 'Bash'],
  ['sh', 'Shell'],
  ['shell', 'Shell'],
  ['zsh', 'Zsh'],
  ['console', 'Shell'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['yml', 'YAML']
]);

const baseTags = [
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword
    ],
    class: 'tok-keyword'
  },
  { tag: [tags.string, tags.docString, tags.character], class: 'tok-string' },
  { tag: [tags.number, tags.integer, tags.float], class: 'tok-number' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    class: 'tok-comment'
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'tok-function'
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.macroName],
    class: 'tok-type'
  },
  { tag: [tags.bool, tags.atom, tags.null, tags.self], class: 'tok-constant' },
  {
    tag: [tags.propertyName, tags.definition(tags.propertyName)],
    class: 'tok-property'
  },
  { tag: tags.operator, class: 'tok-operator' },
  { tag: tags.punctuation, class: 'tok-punctuation' }
];

const highlighter = tagHighlighter(baseTags);

// The shell mode tags command names and `$vars` alike as plain variable names,
// so give them the function color here rather than staining every identifier in
// the languages that tag ordinary variables the same way.
const shellHighlighter = tagHighlighter([
  ...baseTags,
  { tag: tags.variableName, class: 'tok-function' }
]);

// Each source line becomes its own block-level span so the preview can hang-
// indent wrapped lines; a single `pre` text flow only indents its first line.
export function highlightCodeBlock(lang = '', code = '') {
  const language = languages.get(lang.trim().toLowerCase());
  if (!language) return wrapLines(code.split('\n').map(escapeHtml));

  // highlightCode never puts a newline through the text callback: it reports
  // every line break separately, which is where we start the next line span.
  const lines = [''];
  highlightCode(
    code,
    language.parser.parse(code),
    language === shellLanguage ? shellHighlighter : highlighter,
    (text, classes) => {
      const escaped = escapeHtml(text);
      lines[lines.length - 1] += classes
        ? `<span class="${classes}">${escaped}</span>`
        : escaped;
    },
    () => {
      lines.push('');
    }
  );
  return wrapLines(lines);
}

export function languageLabel(lang = '') {
  const key = lang.trim().toLowerCase();
  return labels.get(key) ?? key;
}

function wrapLines(lines) {
  return lines.map((line) => `<span class="code-line">${line}</span>`).join('');
}

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]
  );
}
