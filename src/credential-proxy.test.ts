import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { detectAuthMode, startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server | undefined;
  let upstreamServer: http.Server | undefined;
  let fallbackServer: http.Server | undefined;
  let proxyPort: number;
  let upstreamPort: number;
  let fallbackPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastFallbackHeaders: http.IncomingHttpHeaders;
  let upstreamStatusCode = 200;
  let upstreamBody = JSON.stringify({ ok: true, source: 'primary' });
  let fallbackBody = JSON.stringify({ ok: true, source: 'fallback' });
  let upstreamCalls = 0;
  let fallbackCalls = 0;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    lastFallbackHeaders = {};
    upstreamStatusCode = 200;
    upstreamBody = JSON.stringify({ ok: true, source: 'primary' });
    fallbackBody = JSON.stringify({ ok: true, source: 'fallback' });
    upstreamCalls = 0;
    fallbackCalls = 0;

    upstreamServer = http.createServer((req, res) => {
      upstreamCalls += 1;
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(upstreamStatusCode, { 'content-type': 'application/json' });
      res.end(upstreamBody);
    });
    await new Promise<void>((resolve) =>
      upstreamServer!.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    fallbackServer = http.createServer((req, res) => {
      fallbackCalls += 1;
      lastFallbackHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fallbackBody);
    });
    await new Promise<void>((resolve) =>
      fallbackServer!.listen(0, '127.0.0.1', resolve),
    );
    fallbackPort = (fallbackServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (proxyServer) {
      await new Promise<void>((r) => proxyServer!.close(() => r()));
    }
    if (upstreamServer) {
      await new Promise<void>((r) => upstreamServer!.close(() => r()));
    }
    if (fallbackServer) {
      await new Promise<void>((r) => fallbackServer!.close(() => r()));
    }
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env);
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders.authorization).toBe('Bearer real-oauth-token');
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders.authorization).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('falls back to the secondary upstream on 429 responses', async () => {
    upstreamStatusCode = 429;
    upstreamBody = JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'subscription limit reached',
      },
    });

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      NANOCLAW_FALLBACK_BASE_URL: `http://127.0.0.1:${fallbackPort}`,
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, source: 'fallback' });
    expect(upstreamCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(lastFallbackHeaders['x-api-key']).toBeUndefined();
  });

  it('injects fallback API key when configured', async () => {
    upstreamStatusCode = 429;
    upstreamBody = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'too many requests' },
    });

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      NANOCLAW_FALLBACK_BASE_URL: `http://127.0.0.1:${fallbackPort}`,
      NANOCLAW_FALLBACK_API_KEY: 'litellm-secret',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastFallbackHeaders['x-api-key']).toBe('litellm-secret');
  });

  it('routes directly to fallback in fallback-only mode and uses api-key auth mode', async () => {
    proxyPort = await startProxy({
      NANOCLAW_FALLBACK_BASE_URL: `http://127.0.0.1:${fallbackPort}`,
    });

    expect(detectAuthMode()).toBe('api-key');

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, source: 'fallback' });
    expect(upstreamCalls).toBe(0);
    expect(fallbackCalls).toBe(1);
    expect(lastFallbackHeaders['x-api-key']).toBeUndefined();
  });
});
