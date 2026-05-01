import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('webhook formatting', () => {
  let formatSlack, formatDiscord, formatGeneric, sendWebhook;

  it('can import webhook module', async () => {
    const mod = await import('../../src/webhook.mjs');
    formatSlack = mod.formatSlack;
    formatDiscord = mod.formatDiscord;
    formatGeneric = mod.formatGeneric;
    sendWebhook = mod.sendWebhook;
    assert.strictEqual(typeof formatSlack, 'function');
    assert.strictEqual(typeof formatDiscord, 'function');
    assert.strictEqual(typeof formatGeneric, 'function');
    assert.strictEqual(typeof sendWebhook, 'function');
  });

  describe('formatSlack', () => {
    it('produces { text: "..." } shape', () => {
      const rca = {
        title: 'Null session bug',
        confidence: 'high',
        tags: ['auth', 'session'],
      };
      const result = formatSlack(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok('text' in result, 'should have text field');
      assert.strictEqual(typeof result.text, 'string');
    });

    it('includes title in message', () => {
      const rca = { title: 'Database connection timeout', confidence: 'medium', tags: [] };
      const result = formatSlack(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.text.includes('Database connection timeout'));
    });

    it('includes confidence in message', () => {
      const rca = { title: 'Test', confidence: 'low', tags: ['performance'] };
      const result = formatSlack(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.text.includes('low'));
    });

    it('includes tags in message', () => {
      const rca = { title: 'Test', confidence: 'high', tags: ['auth', 'api'] };
      const result = formatSlack(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.text.includes('auth'));
    });

    it('handles empty tags gracefully', () => {
      const rca = { title: 'Test', confidence: 'high', tags: [] };
      const result = formatSlack(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.strictEqual(typeof result.text, 'string');
      assert.ok(result.text.length > 0);
    });
  });

  describe('formatDiscord', () => {
    it('produces { content: "..." } shape', () => {
      const rca = { title: 'DB crash', confidence: 'high', tags: ['database'] };
      const result = formatDiscord(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok('content' in result, 'should have content field');
      assert.strictEqual(typeof result.content, 'string');
    });

    it('includes **New RCA:** prefix', () => {
      const rca = { title: 'Memory leak', confidence: 'medium', tags: ['memory'] };
      const result = formatDiscord(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.content.includes('**New RCA:**'));
    });

    it('includes title in message', () => {
      const rca = { title: 'Race condition in scheduler', confidence: 'high', tags: [] };
      const result = formatDiscord(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.content.includes('Race condition in scheduler'));
    });

    it('includes confidence in message', () => {
      const rca = { title: 'Test', confidence: 'low', tags: [] };
      const result = formatDiscord(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.content.includes('low'));
    });

    it('includes tags in message', () => {
      const rca = { title: 'Test', confidence: 'high', tags: ['cache', 'redis'] };
      const result = formatDiscord(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.ok(result.content.includes('cache'));
    });
  });

  describe('formatGeneric', () => {
    it('produces structured object with event field', () => {
      const rca = { title: 'Outage', confidence: 'high', tags: ['infra'] };
      const result = formatGeneric(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.strictEqual(result.event, 'rca_generated');
    });

    it('includes title field', () => {
      const rca = { title: 'Connection refused', confidence: 'medium', tags: [] };
      const result = formatGeneric(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.strictEqual(result.title, 'Connection refused');
    });

    it('includes confidence field', () => {
      const rca = { title: 'Test', confidence: 'low', tags: [] };
      const result = formatGeneric(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.strictEqual(result.confidence, 'low');
    });

    it('includes tags as array', () => {
      const rca = { title: 'Test', confidence: 'high', tags: ['api', 'timeout'] };
      const result = formatGeneric(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.deepStrictEqual(result.tags, ['api', 'timeout']);
    });

    it('includes path field', () => {
      const rca = { title: 'Test', confidence: 'high', tags: [] };
      const result = formatGeneric(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.strictEqual(result.path, '/rca/2026/04/RCA-abc1234.md');
    });

    it('tags defaults to empty array when missing', () => {
      const rca = { title: 'Test', confidence: 'medium' };
      const result = formatGeneric(rca, '/rca/2026/04/RCA-abc1234.md');
      assert.deepStrictEqual(result.tags, []);
    });
  });

  describe('sendWebhook signature', () => {
    it('sendWebhook is a function accepting (rca, writtenPath, cfg)', async () => {
      // Verify the function accepts arguments without throwing synchronously
      // We do NOT make real HTTP calls — just test that it's callable
      const mod = await import('../../src/webhook.mjs');
      assert.strictEqual(typeof mod.sendWebhook, 'function');
      // sendWebhook should return a Promise (async)
      const result = mod.sendWebhook(
        { title: 'Test', confidence: 'high', tags: [] },
        '/rca/test.md',
        { webhooks: { enabled: false, url: '', format: 'generic' } },
      );
      assert.ok(result instanceof Promise, 'sendWebhook should return a Promise');
      // Allow the promise to settle (it should resolve silently since enabled=false)
      await result;
    });

    it('sendWebhook does nothing when enabled=false', async () => {
      const mod = await import('../../src/webhook.mjs');
      let requestCalled = false;
      await mod.sendWebhook(
        { title: 'Test', confidence: 'high', tags: [] },
        '/rca/test.md',
        { webhooks: { enabled: false, url: 'https://hooks.test/webhook', format: 'generic' } },
        {
          request: () => {
            requestCalled = true;
          },
        },
      );
      assert.strictEqual(requestCalled, false, 'should not call request when disabled');
    });

    it('sendWebhook does nothing when url is empty', async () => {
      const mod = await import('../../src/webhook.mjs');
      let requestCalled = false;
      await mod.sendWebhook(
        { title: 'Test', confidence: 'high', tags: [] },
        '/rca/test.md',
        { webhooks: { enabled: true, url: '', format: 'generic' } },
        {
          request: () => {
            requestCalled = true;
          },
        },
      );
      assert.strictEqual(requestCalled, false, 'should not call request when url is empty');
    });

    it('sendWebhook silently handles invalid URL', async () => {
      const mod = await import('../../src/webhook.mjs');
      let requestCalled = false;
      await mod.sendWebhook(
        { title: 'Test', confidence: 'high', tags: [] },
        '/rca/test.md',
        { webhooks: { enabled: true, url: 'not-a-url', format: 'generic' } },
        {
          request: () => {
            requestCalled = true;
          },
        },
      );
      assert.strictEqual(requestCalled, false, 'should not call request for invalid URL');
    });

    it('sendWebhook POSTs correct payload via injection (slack format)', async () => {
      const mod = await import('../../src/webhook.mjs');
      let capturedOptions = null;
      let capturedBody = '';

      function mockRequest(options, callback) {
        capturedOptions = options;
        // Simulate a minimal response object
        const mockRes = {
          resume() {},
          on(event, handler) {
            if (event === 'end') handler();
            return this;
          },
        };
        // Call callback asynchronously
        setTimeout(() => callback(mockRes), 0);
        return {
          on() {
            return this;
          },
          setTimeout() {
            return this;
          },
          write(data) {
            capturedBody += data;
          },
          end() {},
          destroy() {},
        };
      }

      await mod.sendWebhook(
        { title: 'Slack test', confidence: 'high', tags: ['auth'] },
        '/rca/2026/04/test.md',
        {
          webhooks: {
            enabled: true,
            url: 'https://hooks.slack.com/services/T/B/x',
            format: 'slack',
          },
        },
        { request: mockRequest },
      );

      assert.ok(capturedOptions !== null, 'request should have been called');
      assert.strictEqual(capturedOptions.method, 'POST');
      assert.ok(capturedBody.length > 0, 'request body should not be empty');
      const parsed = JSON.parse(capturedBody);
      assert.ok('text' in parsed, 'slack payload should have text field');
      assert.ok(parsed.text.includes('Slack test'));
    });

    it('sendWebhook POSTs correct payload via injection (discord format)', async () => {
      const mod = await import('../../src/webhook.mjs');
      let capturedBody = '';

      function mockRequest(options, callback) {
        const mockRes = {
          resume() {},
          on(event, handler) {
            if (event === 'end') handler();
            return this;
          },
        };
        setTimeout(() => callback(mockRes), 0);
        return {
          on() {
            return this;
          },
          setTimeout() {
            return this;
          },
          write(data) {
            capturedBody += data;
          },
          end() {},
          destroy() {},
        };
      }

      await mod.sendWebhook(
        { title: 'Discord test', confidence: 'medium', tags: ['api'] },
        '/rca/2026/04/test.md',
        {
          webhooks: {
            enabled: true,
            url: 'https://discord.com/api/webhooks/123/abc',
            format: 'discord',
          },
        },
        { request: mockRequest },
      );

      const parsed = JSON.parse(capturedBody);
      assert.ok('content' in parsed, 'discord payload should have content field');
      assert.ok(parsed.content.includes('**New RCA:**'));
    });

    it('sendWebhook POSTs correct payload via injection (generic format)', async () => {
      const mod = await import('../../src/webhook.mjs');
      let capturedBody = '';

      function mockRequest(options, callback) {
        const mockRes = {
          resume() {},
          on(event, handler) {
            if (event === 'end') handler();
            return this;
          },
        };
        setTimeout(() => callback(mockRes), 0);
        return {
          on() {
            return this;
          },
          setTimeout() {
            return this;
          },
          write(data) {
            capturedBody += data;
          },
          end() {},
          destroy() {},
        };
      }

      await mod.sendWebhook(
        { title: 'Generic test', confidence: 'low', tags: ['backend'] },
        '/rca/2026/04/test.md',
        { webhooks: { enabled: true, url: 'https://api.example.com/webhook', format: 'generic' } },
        { request: mockRequest },
      );

      const parsed = JSON.parse(capturedBody);
      assert.strictEqual(parsed.event, 'rca_generated');
      assert.strictEqual(parsed.title, 'Generic test');
    });

    it('sendWebhook resolves silently on network error', async () => {
      const mod = await import('../../src/webhook.mjs');

      function mockRequest(_options, _callback) {
        const req = {
          errorHandler: null,
          on(event, handler) {
            if (event === 'error') this.errorHandler = handler;
            return this;
          },
          setTimeout() {
            return this;
          },
          write() {
            // Trigger error on write
            if (this.errorHandler) this.errorHandler(new Error('ECONNREFUSED'));
          },
          end() {},
          destroy() {},
        };
        return req;
      }

      // Should resolve without throwing
      await assert.doesNotReject(
        mod.sendWebhook(
          { title: 'Test', confidence: 'high', tags: [] },
          '/rca/test.md',
          {
            webhooks: { enabled: true, url: 'https://api.example.com/webhook', format: 'generic' },
          },
          { request: mockRequest },
        ),
      );
    });

    it('sendWebhook resolves silently on timeout', async () => {
      const mod = await import('../../src/webhook.mjs');

      function mockRequest(_options, _callback) {
        const req = {
          timeoutHandler: null,
          on() {
            return this;
          },
          setTimeout(ms, handler) {
            this.timeoutHandler = handler;
            return this;
          },
          write() {
            // Trigger timeout on write
            if (this.timeoutHandler) this.timeoutHandler();
          },
          end() {},
          destroy() {},
        };
        return req;
      }

      await assert.doesNotReject(
        mod.sendWebhook(
          { title: 'Test', confidence: 'high', tags: [] },
          '/rca/test.md',
          {
            webhooks: { enabled: true, url: 'https://api.example.com/webhook', format: 'generic' },
          },
          { request: mockRequest },
        ),
      );
    });
  });
});

describe('config schema webhooks section', () => {
  it('accepts config with webhooks section', async () => {
    const { validateConfig } = await import('../../src/schema.mjs');
    const result = validateConfig({
      version: 1,
      webhooks: {
        enabled: true,
        url: 'https://hooks.slack.com/services/xxx',
        format: 'slack',
      },
    });
    assert.strictEqual(result.valid, true, `Errors: ${result.errors.join(', ')}`);
  });

  it('accepts webhooks with default values', async () => {
    const { validateConfig } = await import('../../src/schema.mjs');
    const result = validateConfig({
      version: 1,
      webhooks: {},
    });
    assert.strictEqual(result.valid, true, `Errors: ${result.errors.join(', ')}`);
  });

  it('rejects unknown keys in webhooks', async () => {
    const { validateConfig } = await import('../../src/schema.mjs');
    const result = validateConfig({
      version: 1,
      webhooks: { enabled: true, bogus: 'field' },
    });
    assert.strictEqual(result.valid, false);
  });

  it('rejects invalid format value', async () => {
    const { validateConfig } = await import('../../src/schema.mjs');
    const result = validateConfig({
      version: 1,
      webhooks: { format: 'msteams' },
    });
    assert.strictEqual(result.valid, false);
  });

  it('accepts all valid format values', async () => {
    const { validateConfig } = await import('../../src/schema.mjs');
    for (const format of ['slack', 'discord', 'generic']) {
      const result = validateConfig({ version: 1, webhooks: { format } });
      assert.strictEqual(result.valid, true, `format "${format}" should be valid`);
    }
  });

  it('webhooks key appears in VALID_KEYS', async () => {
    const { VALID_KEYS } = await import('../../src/schema.mjs');
    assert.ok(VALID_KEYS.has('webhooks'), 'webhooks should be in VALID_KEYS');
    assert.ok(VALID_KEYS.has('webhooks.enabled'), 'webhooks.enabled should be in VALID_KEYS');
    assert.ok(VALID_KEYS.has('webhooks.url'), 'webhooks.url should be in VALID_KEYS');
    assert.ok(VALID_KEYS.has('webhooks.format'), 'webhooks.format should be in VALID_KEYS');
  });
});
