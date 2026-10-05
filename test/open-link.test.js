import assert from 'node:assert/strict';
import test from 'node:test';
import { chromeLinkFor, onDesktopMac } from '../src/open-link.js';

const here = new URL('http://127.0.0.1:5173/');

function click(href, { target = '_blank', download = false, ...event } = {}) {
  const anchor = {
    href: new URL(href, here).href,
    target,
    hasAttribute: (name) => name === 'download' && download
  };
  return {
    button: 0,
    defaultPrevented: false,
    target: { closest: () => anchor },
    ...event
  };
}

test('sends new-tab web links elsewhere to Chrome', () => {
  assert.equal(
    chromeLinkFor(click('https://indico.cern.ch/event/1/'), here),
    'https://indico.cern.ch/event/1/'
  );
});

test('leaves the browser its own links, modified clicks, and other schemes', () => {
  assert.equal(chromeLinkFor(click('/api/meetings/attachment?x=1'), here), '');
  assert.equal(chromeLinkFor(click('https://indico.cern.ch/', { target: '' }), here), '');
  assert.equal(chromeLinkFor(click('https://indico.cern.ch/', { metaKey: true }), here), '');
  assert.equal(chromeLinkFor(click('https://indico.cern.ch/', { button: 1 }), here), '');
  assert.equal(chromeLinkFor(click('https://indico.cern.ch/', { download: true }), here), '');
  assert.equal(chromeLinkFor(click('zoommtg://zoom.us/join?confno=1'), here), '');
  assert.equal(
    chromeLinkFor(click('https://indico.cern.ch/', { defaultPrevented: true }), here),
    ''
  );
});

test('only a desktop Mac asks the server', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0';
  assert.equal(onDesktopMac({ userAgent: mac, maxTouchPoints: 0 }), true);
  assert.equal(onDesktopMac({ userAgent: mac, maxTouchPoints: 5 }), false);
  assert.equal(
    onDesktopMac({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', maxTouchPoints: 5 }),
    false
  );
});
