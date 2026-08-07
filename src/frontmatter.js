export function parseFrontmatter(source = '') {
  const text = source.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---'
  );
  if (lines[0]?.trim() !== '---' || end === -1) {
    return { attributes: {}, body: text };
  }

  const attributes = {};
  const metadataLines = lines.slice(1, end);

  for (let index = 0; index < metadataLines.length; index += 1) {
    const entry = metadataLines[index].match(/^([a-zA-Z][\w-]*):[ \t]*(.*)$/);
    if (!entry) continue;

    const [, field, rawValue] = entry;
    if (rawValue.trim()) {
      const value = parseValue(rawValue);
      const hasValue = Array.isArray(value) ? value.length : Boolean(value);
      if (hasValue) attributes[field] = value;
      continue;
    }

    const list = readBlockList(metadataLines, index + 1);
    if (list.length) attributes[field] = list;
  }

  return { attributes, body: lines.slice(end + 1).join('\n') };
}

export function parseMetadataQuery(query = '') {
  const match = query
    .trim()
    .match(/^(type|title|description|resource|tags|timestamp)\s*:\s*(.+)$/i);
  return match
    ? {
        field: match[1].toLowerCase(),
        value: unquote(match[2].trim()).toLowerCase()
      }
    : null;
}

function readBlockList(lines, start) {
  const values = [];
  for (let index = start; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s+-\s+(.+)$/);
    if (!item) break;
    const value = parseScalar(item[1]);
    if (value) values.push(value);
  }
  return values;
}

function parseValue(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed
        .slice(1, -1)
        .split(',')
        .map(parseScalar)
        .filter(Boolean)
    : parseScalar(trimmed);
}

function parseScalar(value) {
  return unquote(value.replace(/\s+#.*$/, '').trim());
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
