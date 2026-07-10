import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { RcaError } from './errors.mjs';

/**
 * Percent-encode each path segment but keep the separators. encodeURIComponent()
 * on the whole path turned "RCA Inbox/note.md" into "RCA%20Inbox%2Fnote.md", which
 * the API reads as one flat filename, and turned the root "/" into "%2F". A
 * leading "/" is redundant (paths are vault-relative) and would yield "/vault//".
 */
function encodeVaultPath(path) {
  const relative = String(path).replace(/^\/+/, '');
  if (relative === '') return '';
  return relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function createObsidianClient({
  apiKey,
  host = '127.0.0.1',
  port = 27124,
  protocol = 'https',
}) {
  if (!apiKey) {
    throw new RcaError('INTERNAL', { message: 'Obsidian API key is required' });
  }

  const requester = protocol === 'https' ? request : httpRequest;

  function apiRequest(
    method,
    path,
    { body, contentType = 'text/markdown', query, headers: extraHeaders, timeoutMs = 15000 } = {},
  ) {
    return new Promise((resolve, reject) => {
      const queryString = query
        ? '?' +
          Object.entries(query)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&')
        : '';

      const options = {
        hostname: host,
        port,
        path: path + queryString,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...extraHeaders,
        },
        rejectUnauthorized: false,
      };

      if (body != null) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        options.headers['Content-Type'] =
          typeof body === 'string' ? contentType : 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = requester(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(
              new RcaError('INTERNAL', {
                message: `Obsidian API ${method} ${path} returned ${res.statusCode}: ${raw.slice(0, 200)}`,
              }),
            );
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : null);
          } catch {
            resolve(raw);
          }
        });
      });

      // req.on('error') only fires on connection failures. A peer that accepts the
      // socket and never replies would otherwise hang the CLI and MCP tool forever.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`no response within ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(
          new RcaError('INTERNAL', {
            message: `Obsidian API connection failed: ${err.message}. Is Obsidian running with Local REST API plugin?`,
          }),
        );
      });

      if (body != null) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  return {
    async searchVault(query) {
      return apiRequest('POST', '/search/simple/', { query: { query } });
    },

    async readNote(path) {
      return apiRequest('GET', `/vault/${encodeVaultPath(path)}`);
    },

    async createNote(path, content) {
      return apiRequest('PUT', `/vault/${encodeVaultPath(path)}`, {
        body: content,
        contentType: 'text/markdown',
      });
    },

    async patchNote(path, content, { heading, prepend = false } = {}) {
      // These headers were built and then discarded: apiRequest had no headers
      // parameter, so the API rejected every PATCH with 400 MissingOperation.
      const headers = { Operation: prepend ? 'prepend' : 'append' };
      if (heading) {
        headers['Target-Type'] = 'heading';
        headers['Target'] = heading;
      }

      return apiRequest('PATCH', `/vault/${encodeVaultPath(path)}`, {
        body: content,
        contentType: 'text/markdown',
        headers,
      });
    },

    async appendNote(path, content) {
      return apiRequest('POST', `/vault/${encodeVaultPath(path)}`, {
        body: content,
        contentType: 'text/markdown',
      });
    },

    async deleteNote(path) {
      return apiRequest('DELETE', `/vault/${encodeVaultPath(path)}`);
    },

    async listFolder(folderPath = '/') {
      return apiRequest('GET', `/vault/${encodeVaultPath(folderPath)}`);
    },

    async listVaultRoot() {
      return apiRequest('GET', '/vault/');
    },

    async getStatus() {
      return apiRequest('GET', '/');
    },

    async openNote(path) {
      return apiRequest('POST', `/open/${encodeVaultPath(path)}`);
    },
  };
}
