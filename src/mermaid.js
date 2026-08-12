// Mermaid is a couple of megabytes, so it is pulled in on demand the first time
// a note actually contains a diagram instead of riding along in the main bundle.
let loading = null;
let sequence = 0;

const cache = new Map();
const CACHE_LIMIT = 50;

// Mirrors the :root tokens in styles.css so diagrams sit on the same light
// surface as the code cards next to them.
const themeVariables = {
  background: '#fbfcfd',
  mainBkg: '#ffffff',
  primaryColor: '#ffffff',
  primaryTextColor: '#1f2733',
  primaryBorderColor: '#c8d2e0',
  secondaryColor: '#f1f4f9',
  secondaryTextColor: '#1f2733',
  secondaryBorderColor: '#d7dfea',
  tertiaryColor: '#f4f6f8',
  tertiaryTextColor: '#1f2733',
  tertiaryBorderColor: '#e3e8ef',
  lineColor: '#58637a',
  textColor: '#172033',
  noteBkgColor: '#f1f4f9',
  noteTextColor: '#1f2733',
  noteBorderColor: '#e3e8ef',
  fontSize: '14px'
};

function loadMermaid() {
  if (!loading) {
    loading = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // Notes hold arbitrary text: strict mode sanitises labels and ignores
        // `click` directives that would otherwise run scripts or open URLs.
        securityLevel: 'strict',
        theme: 'base',
        themeVariables,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      });
      return mermaid;
    });
  }
  return loading;
}

// Resolves to SVG markup, or rejects with the diagram's syntax error.
export async function renderMermaid(text) {
  const source = text.trim();
  const cached = cache.get(source);
  if (cached) return cached;

  const mermaid = await loadMermaid();
  // Parse first: a failed render leaves mermaid's own error diagram behind in
  // the document, while a failed parse simply throws.
  await mermaid.parse(source);

  const id = `webmd-mermaid-${sequence++}`;
  const { svg } = await mermaid.render(id, source);
  remember(source, svg);
  return svg;
}

function remember(source, svg) {
  cache.set(source, svg);
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}
