// Opt-in, read-only check against a real Indico with your own token. It is
// never part of `npm test`: it needs the network and a real token.
//
//   INDICO_SMOKE_SOURCE=https://indico.cern.ch/category/1234/ npm run smoke:indico
//
// The token comes from the environment or ~/.webmd.conf, exactly as the
// server reads it, and is never printed: the output names the variable and
// says whether it is set, and reports what Indico returned. Only GET requests
// to /export/ are made.
import os from 'node:os';
import path from 'node:path';
import { indicoSites, tokenForOrigin, indicoTokenName } from '../server/indico.js';
import {
  fetchMeeting,
  listMeetings,
  parseMeetingSource
} from '../server/meetings.js';

try {
  process.loadEnvFile(path.join(os.homedir(), '.webmd.conf'));
} catch {
  // No config file is fine; the environment may carry the token.
}

const target = process.env.INDICO_SMOKE_SOURCE;
if (!target) {
  console.error(
    'Set INDICO_SMOKE_SOURCE to an Indico category or event link to check.'
  );
  process.exit(2);
}

const sites = indicoSites(process.env);
const source = { ...parseMeetingSource(target, sites), label: 'smoke', enabled: true };
const variable = indicoTokenName(source.origin, sites);
const token = tokenForOrigin(source.origin, sites);
console.log(`Source: ${source.url}`);
console.log(`Token: ${variable} is ${token ? 'set' : 'not set'} for ${source.origin}`);

const listing = await listMeetings([source], {
  sites,
  refresh: true,
  days: Number(process.env.INDICO_SMOKE_DAYS || 14)
});
const [status] = listing.statuses;
console.log(
  `Listing: ${status.state}${status.kind ? ` (${status.kind})` : ''}, ${listing.meetings.length} upcoming meetings`
);
if (status.message) console.log(`Message: ${status.message}`);

const secretSafe = (text) =>
  token && String(text).includes(token) ? '[redacted]' : text;
for (const meeting of listing.meetings.slice(0, 5)) {
  console.log(
    `  ${meeting.start.date} ${meeting.start.time} ${meeting.timezone}  ${secretSafe(meeting.title)}${meeting.protected ? '  [protected]' : ''}`
  );
}

const first = listing.meetings[0];
if (first) {
  try {
    const detail = await fetchMeeting(first.origin, first.eventId, {
      sites,
      refresh: true
    });
    console.log(
      `Agenda of the first: ${detail.agenda.length} timetabled contributions, ${detail.unscheduled} unscheduled`
    );
  } catch (error) {
    console.log(`Agenda of the first failed: ${error.kind || 'error'}: ${error.message}`);
  }
}

process.exit(status.state === 'error' ? 1 : 0);
