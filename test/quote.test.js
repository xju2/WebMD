import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendQuoteHistory,
  buildQuoteMessages,
  formatQuote,
  isRepeatQuote,
  parseQuote,
  quoteDayKey,
  quoteTheme,
  quoteThemes,
  QUOTE_THEMES
} from '../server/quote.js';

test('rotates the theme so consecutive days cover different ground', () => {
  const themes = [0, 1, 2, 3].map((offset) =>
    quoteTheme(new Date(2026, 7, 18 + offset))
  );

  assert.equal(new Set(themes.slice(0, 3)).size, QUOTE_THEMES.length);
  assert.equal(themes[3], themes[0]);
  // Same day, same theme, so recreating a note does not change its subject.
  assert.equal(quoteTheme(new Date(2026, 7, 18)), themes[0]);
});

test('keys a quote by the local calendar day, not UTC', () => {
  assert.equal(quoteDayKey(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
});

test('sends every used quote back as an exclusion list', () => {
  const history = [
    { date: '2026-08-17', text: 'Talk is cheap. Show me the code.', author: 'Linus Torvalds' }
  ];
  const [, user] = buildQuoteMessages({
    date: new Date(2026, 7, 18),
    theme: 'programming',
    history
  });

  assert.match(user.content, /Tuesday, 2026-08-18/);
  assert.match(user.content, /quote about programming/);
  assert.match(user.content, /Talk is cheap/);
  assert.match(user.content, /Linus Torvalds/);
  assert.doesNotMatch(user.content, /previous answer repeated/);

  const [, retry] = buildQuoteMessages({
    date: new Date(2026, 7, 18),
    theme: 'programming',
    history,
    avoidRepeat: true
  });
  assert.match(retry.content, /previous answer repeated/);
});

test('reads the JSON reply, and a plain attributed line too', () => {
  assert.deepEqual(
    parseQuote(
      '{"quote": "Simplicity is prerequisite for reliability.", "author": "Edsger W. Dijkstra", "said": "1970"}'
    ),
    {
      text: 'Simplicity is prerequisite for reliability.',
      author: 'Edsger W. Dijkstra',
      said: '1970'
    }
  );
  assert.deepEqual(
    parseQuote('```json\n{"quote": "\\"Compound interest is the eighth wonder.\\"", "author": "Anonymous."}\n```'),
    { text: 'Compound interest is the eighth wonder.', author: 'Anonymous', said: '' }
  );
  assert.deepEqual(parseQuote('“Price is what you pay.” — Warren Buffett'), {
    text: 'Price is what you pay.',
    author: 'Warren Buffett',
    said: ''
  });
  // The tail carries the date of the quote, so it must not end up in the name.
  assert.deepEqual(parseQuote('“Price is what you pay.” — Warren Buffett (2008)'), {
    text: 'Price is what you pay.',
    author: 'Warren Buffett',
    said: '2008'
  });
  assert.equal(parseQuote('   '), null);
});

test('reads the fields out of JSON that will not parse, rather than quoting the blob', () => {
  assert.deepEqual(
    parseQuote(
      '{“quote”: “The universe is comprehensible.”, “author”: “Albert Einstein”, “said”: “1936”}'
    ),
    { text: 'The universe is comprehensible.', author: 'Albert Einstein', said: '1936' }
  );
  assert.deepEqual(
    parseQuote('{"quote": "Talk is cheap.", "author": "Linus Torvalds",}'),
    { text: 'Talk is cheap.', author: 'Linus Torvalds', said: '' }
  );
  assert.equal(parseQuote('{"quote": }'), null);
});

test('dates the line by when the quote was said, not by today', () => {
  const line = formatQuote({
    text: 'Price is what you pay.',
    author: 'Warren Buffett',
    said: '2008'
  });
  assert.equal(line, '"Price is what you pay." -- Warren Buffett (2008)');
  assert.equal(line.includes('\n'), false);
  // The day the note was written is not the date the format asks for.
  assert.equal(
    formatQuote({ text: 'No name here.', date: '2026-08-25', said: '1843' }),
    '"No name here." -- Unknown (1843)'
  );
  assert.equal(
    formatQuote({ text: 'No date here.', author: 'Ada Lovelace' }),
    '"No date here." -- Ada Lovelace'
  );
  assert.equal(formatQuote(null), '');
});

test('catches a repeat however it is punctuated, and replaces a day in history', () => {
  const history = [
    { date: '2026-08-17', text: 'Price is what you pay.', author: 'Warren Buffett' }
  ];

  assert.equal(isRepeatQuote({ text: '“price is what you pay”' }, history), true);
  assert.equal(isRepeatQuote({ text: 'Value is what you get.' }, history), false);

  const next = appendQuoteHistory(history, {
    date: '2026-08-17',
    text: 'Value is what you get.',
    author: 'Warren Buffett'
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].text, 'Value is what you get.');
});

test('takes the theme rotation from the environment', () => {
  assert.deepEqual(quoteThemes({ QUOTE_THEMES: 'stoicism, music ,physics' }), [
    'stoicism',
    'music',
    'physics'
  ]);
  // A repeated theme would skew the rotation towards it, so it is dropped.
  assert.deepEqual(quoteThemes({ QUOTE_THEMES: 'life,life' }), ['life']);
  assert.deepEqual(quoteThemes({ QUOTE_THEMES: ' , ' }), QUOTE_THEMES);
  assert.deepEqual(quoteThemes({}), QUOTE_THEMES);
  assert.deepEqual(quoteThemes(), QUOTE_THEMES);

  const themes = quoteThemes({ QUOTE_THEMES: 'stoicism,music' });
  assert.equal(
    quoteTheme(new Date(2026, 7, 18), themes) ===
      quoteTheme(new Date(2026, 7, 19), themes),
    false
  );
  assert.equal(
    quoteTheme(new Date(2026, 7, 18), themes),
    quoteTheme(new Date(2026, 7, 20), themes)
  );
});
