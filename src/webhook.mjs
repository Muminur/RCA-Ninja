import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/**
 * Format an RCA payload for Slack incoming webhooks.
 * @param {object} rca - the RCA JSON object
 * @param {string} writtenPath - the path where the RCA was written
 * @returns {{ text: string }}
 */
export function formatSlack(rca, _writtenPath) {
  const tags = Array.isArray(rca.tags) && rca.tags.length > 0 ? rca.tags.join(', ') : '(none)';
  const text = `New RCA: ${rca.title}\nConfidence: ${rca.confidence}\nTags: ${tags}`;
  return { text };
}

/**
 * Format an RCA payload for Discord webhooks.
 * @param {object} rca - the RCA JSON object
 * @param {string} writtenPath - the path where the RCA was written
 * @returns {{ content: string }}
 */
export function formatDiscord(rca, _writtenPath) {
  const tags = Array.isArray(rca.tags) && rca.tags.length > 0 ? rca.tags.join(', ') : '(none)';
  const content = `**New RCA:** ${rca.title}\nConfidence: ${rca.confidence}\nTags: ${tags}`;
  return { content };
}

/**
 * Format an RCA payload as a generic webhook event.
 * @param {object} rca - the RCA JSON object
 * @param {string} writtenPath - the path where the RCA was written
 * @returns {{ event: string, title: string, confidence: string, tags: string[], path: string }}
 */
export function formatGeneric(rca, writtenPath) {
  return {
    event: 'rca_generated',
    title: rca.title,
    confidence: rca.confidence,
    tags: Array.isArray(rca.tags) ? rca.tags : [],
    path: writtenPath,
  };
}

/**
 * Build the request body from rca + format config.
 * @param {object} rca
 * @param {string} writtenPath
 * @param {string} format - 'slack' | 'discord' | 'generic'
 * @returns {object}
 */
function buildPayload(rca, writtenPath, format) {
  if (format === 'slack') return formatSlack(rca, writtenPath);
  if (format === 'discord') return formatDiscord(rca, writtenPath);
  return formatGeneric(rca, writtenPath);
}

/**
 * POST a webhook notification. Returns silently on any failure (non-blocking).
 * @param {object} rca - the RCA JSON object
 * @param {string} writtenPath - the path where the RCA was written
 * @param {object} cfg - the loaded config object
 * @param {{ request?: Function }} [_inject] - optional injection for testing
 * @returns {Promise<void>}
 */
export async function sendWebhook(rca, writtenPath, cfg, _inject = {}) {
  const wh = cfg && cfg.webhooks;
  if (!wh || !wh.enabled || !wh.url) return;

  const format = wh.format || 'generic';
  const payload = buildPayload(rca, writtenPath, format);
  const body = JSON.stringify(payload);

  let url;
  try {
    url = new URL(wh.url);
  } catch {
    // Invalid URL — silently skip
    return;
  }

  const isHttps = url.protocol === 'https:';
  const reqFn = _inject.request || (isHttps ? httpsRequest : httpRequest);

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = reqFn(options, (res) => {
      // Drain the response body to free the socket
      res.resume();
      res.on('end', resolve);
    });

    req.on('error', () => {
      // Network errors are silently swallowed — webhook is non-blocking
      resolve();
    });

    req.setTimeout(5000, () => {
      req.destroy();
      resolve();
    });

    req.write(body);
    req.end();
  });
}
