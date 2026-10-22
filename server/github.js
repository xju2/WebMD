const cache = new Map();
// No segment may be only dots: `../x` would climb out of /repos/ in the API URL.
const NAME = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;

export function isGithubRepoName(value) {
  return typeof value === 'string' && NAME.test(value);
}

/**
 * The one-line description GitHub shows under a repository's name, or '' when
 * it has none or GitHub would not say. Failures are cached too, so a rate
 * limit (60 an hour without a token) is not hammered, until the server restarts.
 */
export async function fetchGithubDescription(name, { fetchImpl = fetch } = {}) {
  if (cache.has(name)) return cache.get(name);
  let description = '';
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${name}`, {
      headers: { accept: 'application/vnd.github+json' }
    });
    if (response.ok) {
      const repo = await response.json();
      if (typeof repo?.description === 'string') {
        description = repo.description.replace(/\s+/g, ' ').trim();
      }
    }
  } catch {
    // Offline: same as no description.
  }
  cache.set(name, description);
  return description;
}

export function resetGithubCache() {
  cache.clear();
}
