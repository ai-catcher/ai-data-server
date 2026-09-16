import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker/worker.js';

test('scheduled dispatch includes Cloudflare trigger metadata', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  try {
    await worker.scheduled(
      {
        cron: '8,23,38,53 * * * *',
        scheduledTime: Date.parse('2026-09-08T10:08:00.000Z'),
      },
      { GITHUB_AI_DATA_SERVER: 'test-token' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.github.com/repos/ai-catcher/ai-data-server/actions/workflows/update-data.yml/dispatches',
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    ref: 'main',
    inputs: {
      source: 'cloudflare',
      cron: '8,23,38,53 * * * *',
      scheduled_time: '2026-09-08T10:08:00.000Z',
      force: 'false',
    },
  });
});

test('scheduled rejects when the Worker secret is missing', async () => {
  await assert.rejects(
    worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, {}),
    /Missing GITHUB_AI_DATA_SERVER secret/,
  );
});

test('scheduled rejects when GitHub does not accept the dispatch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 403 });

  try {
    await assert.rejects(
      worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.now() },
        { GITHUB_AI_DATA_SERVER: 'test-token' },
      ),
      /HTTP 403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
