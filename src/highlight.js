import { cppLanguage } from '@codemirror/lang-cpp';
import { pythonLanguage } from '@codemirror/lang-python';
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight';

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
  ['hxx', cppLanguage]
]);

const highlighter = tagHighlighter([
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
  { tag: tags.operator, class: 'tok-operator' },
  { tag: tags.punctuation, class: 'tok-punctuation' }
]);

export function highlightCodeBlock(lang = '', code = '') {
  const language = languages.get(lang.trim().toLowerCase());
  if (!language) return escapeHtml(code);

  let html = '';
  highlightCode(
    code,
    language.parser.parse(code),
    highlighter,
    (text, classes) => {
      const escaped = escapeHtml(text);
      html += classes ? `<span class="${classes}">${escaped}</span>` : escaped;
    },
    () => {
      html += '\n';
    }
  );
  return html;
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
