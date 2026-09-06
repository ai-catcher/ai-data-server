const GITHUB_API_URL =
  'https://api.github.com/repos/ai-catcher/ai-data-server/actions/workflows/update-data.yml/dispatches';
const GITHUB_API_VERSION = '2022-11-28';

export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerGitHubWorkflow(env));
  },
};

async function triggerGitHubWorkflow(env) {
  const token = String(env.GITHUB_AI_DATA_SERVER || '').trim();

  if (!token) {
    console.error('Missing GITHUB_AI_DATA_SERVER secret');
    return;
  }

  try {
    const response = await fetch(GITHUB_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'ai-data-scheduler-cloudflare-worker',
      },
      body: JSON.stringify({ ref: 'main' }),
    });

    if (!response.ok) {
      console.error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
      return;
    }

    console.log('GitHub workflow dispatch accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`GitHub workflow dispatch request failed: ${message}`);
  }
}
