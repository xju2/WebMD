export function parseUnifiedDiff(diff = '') {
  const files = [];
  let file;
  let hunk;
  let oldNumber = 0;
  let newNumber = 0;
  const lines = diff.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = { title: parseDiffTitle(line), hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }

    if (!file) {
      file = { title: 'Changes', hunks: [] };
      files.push(file);
    }

    const header = line.match(
      /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)$/
    );
    if (header) {
      oldNumber = Number(header[2]);
      newNumber = Number(header[3]);
      hunk = { header: header[1], summary: header[4].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (
      !hunk ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }

    hunk.lines.push(parseDiffLine(line, oldNumber, newNumber));
    if (line.startsWith(' ')) {
      oldNumber += 1;
      newNumber += 1;
    } else if (line.startsWith('-')) {
      oldNumber += 1;
    } else if (line.startsWith('+')) {
      newNumber += 1;
    }
  }

  return files.filter((item) => item.hunks.length);
}

function parseDiffLine(line, oldNumber, newNumber) {
  if (line.startsWith('+')) {
    return { kind: 'added', oldNumber: '', newNumber, text: line.slice(1) };
  }
  if (line.startsWith('-')) {
    return { kind: 'removed', oldNumber, newNumber: '', text: line.slice(1) };
  }
  if (line.startsWith('\\')) {
    return { kind: 'note', oldNumber: '', newNumber: '', text: line };
  }
  return {
    kind: 'context',
    oldNumber,
    newNumber,
    text: line.startsWith(' ') ? line.slice(1) : line
  };
}

function parseDiffTitle(line) {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return line.replace(/^diff --git\s+/, '');
  return match[1] === match[2] ? match[2] : `${match[1]} -> ${match[2]}`;
}
