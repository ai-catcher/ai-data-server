const GITHUB_API_URL =
  'https://api.github.com/repos/ai-catcher/ai-data-server/actions/workflows/update-data.yml/dispatches';
const GITHUB_API_VERSION = '2022-11-28';

export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env) {
    await triggerGitHubWorkflow(env, {
      cron: String(controller.cron || ''),
      scheduledTime: formatScheduledTime(controller.scheduledTime),
    });
  },
};

function formatScheduledTime(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function triggerGitHubWorkflow(env, trigger) {
  const token = String(env.GITHUB_AI_DATA_SERVER || '').trim();

  if (!token) {
    throw new Error('Missing GITHUB_AI_DATA_SERVER secret');
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
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          source: 'cloudflare',
          cron: trigger.cron,
          scheduled_time: trigger.scheduledTime,
          force: 'false',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
    }

    console.log(
      `GitHub workflow dispatch accepted: cron=${trigger.cron || 'unknown'} scheduled_time=${trigger.scheduledTime}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub workflow dispatch request failed: ${message}`);
  }
}
