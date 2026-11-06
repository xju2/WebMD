import { jiraTicket } from '../src/editor.js';
import { WorkspaceError } from './workspace.js';

const KNOWN_JIRA_URLS = { cern: 'https://its.cern.ch/jira' };
const FIELDS = ['summary', 'status', 'assignee', 'duedate', 'priority'];
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;

/**
 * Jira installations with a token, as `[{ name, base, token }]`, from
 * `JIRA_<NAME>_TOKEN` and, for one not in `KNOWN_JIRA_URLS`, `JIRA_<NAME>_URL`.
 * Like the Indico tokens, each is bound to one base URL and goes nowhere else.
 */
export function jiraSites(env = process.env) {
  const names = new Map();
  for (const [key, value] of Object.entries(env || {})) {
    const match = /^JIRA_([A-Z0-9]+)_(TOKEN|URL)$/.exec(key);
    if (!match) continue;
    const entry = names.get(match[1].toLowerCase()) || {};
    entry[match[2] === 'TOKEN' ? 'token' : 'url'] = String(value ?? '').trim();
    names.set(match[1].toLowerCase(), entry);
  }
  const sites = [];
  for (const [name, entry] of names) {
    const base = trustedBase(entry.url || KNOWN_JIRA_URLS[name] || '');
    if (base && entry.token) sites.push({ name, base, token: entry.token });
  }
  return sites;
}

function trustedBase(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return '';
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function siteFor(url, sites) {
  return sites.find((site) => url.startsWith(`${site.base}/browse/`));
}

/** `{ key, url, summary, status, done, assignee, due, priority }`. */
function ticketFrom(issue, site) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    url: `${site.base}/browse/${issue.key}`,
    summary: String(fields.summary || '')
      .replace(/\s+/g, ' ')
      .trim(),
    status: fields.status?.name || '',
    done: fields.status?.statusCategory?.key === 'done',
    assignee: fields.assignee?.displayName || '',
    due: fields.duedate || '',
    priority: fields.priority?.name || '',
    ...(fields.description !== undefined
      ? {
          description: clip(fields.description, DESCRIPTION_CHARS),
          // The newest few; an old thread is mostly settled history.
          comments: (fields.comment?.comments || [])
            .slice(-COMMENTS)
            .map((comment) => ({
              author: comment.author?.displayName || '',
              created: String(comment.created || '').slice(0, 10),
              body: clip(comment.body, COMMENT_CHARS)
            }))
        }
      : {})
  };
}

const DESCRIPTION_CHARS = 2000;
const COMMENTS = 3;
const COMMENT_CHARS = 800;
// Tickets read into one AI prompt, so a link-heavy note cannot crowd out the note.
export const MAX_AI_TICKETS = 10;

function clip(text, limit) {
  const value = String(text || '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Tickets as plain text for an AI prompt. */
export function ticketsForAi(tickets) {
  return tickets
    .map((ticket) =>
      [
        `${ticket.key}: ${ticket.summary}`,
        `Status: ${ticket.status} · Assignee: ${ticket.assignee || 'unassigned'} · Priority: ${ticket.priority || 'none'}${ticket.due ? ` · Due: ${ticket.due}` : ''}`,
        ticket.description ? `Description:\n${ticket.description}` : '',
        ...(ticket.comments || []).map(
          (comment) =>
            `Comment by ${comment.author || 'someone'} on ${comment.created}:\n${comment.body}`
        )
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

async function search(site, jql, fetchImpl, maxResults = 100, fields = FIELDS) {
  let response;
  try {
    response = await fetchImpl(`${site.base}/rest/api/2/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${site.token}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      // An unknown or hidden key is dropped from the answer instead of failing it.
      body: JSON.stringify({
        jql,
        fields,
        maxResults,
        validateQuery: false
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw new WorkspaceError(502, `Could not reach Jira at ${site.base}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new WorkspaceError(
      502,
      `Jira refused JIRA_${site.name.toUpperCase()}_TOKEN; check it in ~/.webmd.conf.`
    );
  }
  if (!response.ok) {
    throw new WorkspaceError(502, `Jira answered ${response.status}.`);
  }
  const body = await response.json();
  return (body.issues || []).map((issue) => ticketFrom(issue, site));
}

/**
 * Looks up ticket links, cached for ten minutes per ticket. Answers
 * `{ [url]: ticket }` keyed by the canonical `…/browse/KEY` link; a link to a
 * Jira without a token, or a ticket Jira does not show, is left out.
 */
export function createJiraClient({
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const sites = jiraSites(env);
  const cache = new Map();

  async function tickets(urls = []) {
    const found = {};
    const wanted = new Map();
    for (const raw of urls) {
      const ticket = jiraTicket(raw);
      const site = ticket && siteFor(ticket.url, sites);
      if (!site) continue;
      const cached = cache.get(ticket.url);
      if (cached && Date.now() - cached.at < CACHE_MS) {
        if (cached.ticket) found[ticket.url] = cached.ticket;
        continue;
      }
      if (!wanted.has(site)) wanted.set(site, new Map());
      wanted.get(site).set(ticket.key, ticket.url);
    }
    for (const [site, keys] of wanted) {
      const answered = await search(
        site,
        `key in (${[...keys.keys()].join(',')})`,
        fetchImpl
      );
      const at = Date.now();
      for (const url of keys.values()) cache.set(url, { at, ticket: null });
      for (const ticket of answered) {
        cache.set(ticket.url, { at, ticket });
        found[ticket.url] = ticket;
      }
    }
    return found;
  }

  /** Unresolved tickets assigned to you, on every Jira with a token. */
  async function mine() {
    const lists = await Promise.all(
      sites.map((site) =>
        search(
          site,
          'assignee = currentUser() AND resolution = Unresolved ORDER BY duedate ASC, priority DESC',
          fetchImpl,
          200
        )
      )
    );
    return lists.flat();
  }

  /**
   * The tickets a text links to, with description and latest comments, for
   * an AI prompt. Not cached: it runs once per question asked.
   */
  async function details(urls = []) {
    const bySite = new Map();
    for (const raw of urls) {
      const ticket = jiraTicket(raw);
      const site = ticket && siteFor(ticket.url, sites);
      if (!site) continue;
      if (!bySite.has(site)) bySite.set(site, new Set());
      bySite.get(site).add(ticket.key);
    }
    const lists = await Promise.all(
      [...bySite].map(([site, keys]) =>
        search(
          site,
          `key in (${[...keys].join(',')})`,
          fetchImpl,
          MAX_AI_TICKETS,
          [...FIELDS, 'description', 'comment']
        )
      )
    );
    return lists.flat();
  }

  return { configured: sites.length > 0, tickets, mine, details };
}
