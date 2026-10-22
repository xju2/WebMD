import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchGithubDescription,
  isGithubRepoName,
  resetGithubCache
} from '../server/github.js';

test.beforeEach(() => resetGithubCache());

test('reads the description once and tidies it', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ description: '  A\n fast  tool ' })
    };
  };
  assert.equal(
    await fetchGithubDescription('a/b', { fetchImpl }),
    'A fast tool'
  );
  await fetchGithubDescription('a/b', { fetchImpl });
  assert.equal(calls, 1);
});

test('a rate limit or outage is an empty description, remembered', async () => {
  const limited = async () => ({ ok: false });
  assert.equal(await fetchGithubDescription('a/b', { fetchImpl: limited }), '');
  const down = async () => {
    throw new Error('offline');
  };
  assert.equal(await fetchGithubDescription('c/d', { fetchImpl: down }), '');
});

test('only owner/repo names pass', () => {
  assert.equal(isGithubRepoName('a/b'), true);
  assert.equal(isGithubRepoName('a/b/c'), false);
  assert.equal(isGithubRepoName('../x'), false);
});
