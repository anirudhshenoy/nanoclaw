/**
 * Credential proxy for agent isolation.
 * Agent processes connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so agents never see them.
 *
 * Two primary auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Agent CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Optional fallback:
 *   If the primary Anthropic upstream returns a limit/quota style error,
 *   the proxy can retry once against a secondary Anthropic-compatible
 *   endpoint (for example LiteLLM exposing /v1/messages and backed by a
 *   ChatGPT/Codex subscription).
 */
/** Agents run on the same host — proxy binds to loopback. */
export const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1';

import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  RequestOptions,
  Server,
  ServerResponse,
} from 'http';
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

type UpstreamKind = 'primary' | 'fallback';

interface UpstreamTarget {
  kind: UpstreamKind;
  url: URL;
  makeRequest: typeof httpRequest | typeof httpsRequest;
}

interface ProxySecrets {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  NANOCLAW_FALLBACK_BASE_URL?: string;
  NANOCLAW_FALLBACK_API_KEY?: string;
  NANOCLAW_FALLBACK_AUTH_TOKEN?: string;
  NANOCLAW_FALLBACK_STATUS_CODES?: string;
  NANOCLAW_FALLBACK_ERROR_MATCH?: string;
}

interface ProxyRuntime {
  authMode: AuthMode;
  hasPrimaryAuth: boolean;
  primary: UpstreamTarget;
  fallback?: UpstreamTarget;
  fallbackStatusCodes: Set<number>;
  fallbackErrorMatchers: RegExp[];
  fallbackOnly: boolean;
  secrets: ProxySecrets;
}

export interface ProxyConfig {
  authMode: AuthMode;
}

function createUpstream(kind: UpstreamKind, rawUrl: string): UpstreamTarget {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === 'https:';
  return {
    kind,
    url,
    makeRequest: isHttps ? httpsRequest : httpRequest,
  };
}

function parseStatusCodes(value: string | undefined): Set<number> {
  const raw = value || '429,529';
  const codes = raw
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((code) => Number.isFinite(code) && code >= 100 && code <= 599);
  return new Set(codes);
}

function parseErrorMatchers(value: string | undefined): RegExp[] {
  const patterns = (
    value ||
    'rate limit,rate_limit,quota,credit balance,usage limit,too many requests'
  )
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return patterns.map(
    (pattern) =>
      new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  );
}

function buildRuntime(): ProxyRuntime {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'NANOCLAW_FALLBACK_BASE_URL',
    'NANOCLAW_FALLBACK_API_KEY',
    'NANOCLAW_FALLBACK_AUTH_TOKEN',
    'NANOCLAW_FALLBACK_STATUS_CODES',
    'NANOCLAW_FALLBACK_ERROR_MATCH',
  ]) as ProxySecrets;

  const hasPrimaryAuth = !!(
    secrets.ANTHROPIC_API_KEY ||
    secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    secrets.ANTHROPIC_AUTH_TOKEN
  );
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const fallbackOnly = !hasPrimaryAuth && !!secrets.NANOCLAW_FALLBACK_BASE_URL;

  return {
    authMode,
    hasPrimaryAuth,
    primary: createUpstream(
      'primary',
      secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ),
    fallback: secrets.NANOCLAW_FALLBACK_BASE_URL
      ? createUpstream('fallback', secrets.NANOCLAW_FALLBACK_BASE_URL)
      : undefined,
    fallbackStatusCodes: parseStatusCodes(
      secrets.NANOCLAW_FALLBACK_STATUS_CODES,
    ),
    fallbackErrorMatchers: parseErrorMatchers(
      secrets.NANOCLAW_FALLBACK_ERROR_MATCH,
    ),
    fallbackOnly,
    secrets,
  };
}

function stripHopByHopHeaders(
  headers: Record<string, string | number | string[] | undefined>,
): void {
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
}

function applyPrimaryAuth(
  headers: Record<string, string | number | string[] | undefined>,
  runtime: ProxyRuntime,
): void {
  const oauthToken =
    runtime.secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    runtime.secrets.ANTHROPIC_AUTH_TOKEN;

  if (runtime.authMode === 'api-key') {
    delete headers['x-api-key'];
    headers['x-api-key'] = runtime.secrets.ANTHROPIC_API_KEY;
    return;
  }

  // OAuth mode: replace placeholder Bearer token with the real one only when
  // the agent actually sends an Authorization header (exchange request +
  // auth probes). Post-exchange requests use x-api-key only, so they pass
  // through without token injection.
  if (headers.authorization) {
    delete headers.authorization;
    if (oauthToken) {
      headers.authorization = `Bearer ${oauthToken}`;
    }
  }
}

function applyFallbackAuth(
  headers: Record<string, string | number | string[] | undefined>,
  runtime: ProxyRuntime,
): void {
  delete headers.authorization;
  delete headers['x-api-key'];

  if (runtime.secrets.NANOCLAW_FALLBACK_API_KEY) {
    headers['x-api-key'] = runtime.secrets.NANOCLAW_FALLBACK_API_KEY;
    return;
  }

  if (runtime.secrets.NANOCLAW_FALLBACK_AUTH_TOKEN) {
    headers.authorization = `Bearer ${runtime.secrets.NANOCLAW_FALLBACK_AUTH_TOKEN}`;
  }
}

function buildRequestOptions(
  req: IncomingMessage,
  body: Buffer,
  target: UpstreamTarget,
  runtime: ProxyRuntime,
): RequestOptions {
  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    host: target.url.host,
    'content-length': body.length,
  };

  stripHopByHopHeaders(headers);

  if (target.kind === 'primary') {
    applyPrimaryAuth(headers, runtime);
  } else {
    applyFallbackAuth(headers, runtime);
  }

  return {
    hostname: target.url.hostname,
    port: target.url.port || (target.url.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
  };
}

function shouldFallbackFromResponse(
  statusCode: number,
  responseBody: Buffer,
  runtime: ProxyRuntime,
): boolean {
  if (!runtime.fallback || runtime.fallbackOnly) return false;
  if (runtime.fallbackStatusCodes.has(statusCode)) return true;
  if (statusCode < 400) return false;

  const text = responseBody.toString('utf-8').toLowerCase();
  return runtime.fallbackErrorMatchers.some((matcher) => matcher.test(text));
}

function relayBufferedResponse(
  res: ServerResponse,
  statusCode: number,
  headers: Record<string, string | string[] | number | undefined>,
  body: Buffer,
): void {
  res.writeHead(statusCode, headers);
  res.end(body);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const runtime = buildRuntime();

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const initialTarget =
          runtime.fallbackOnly && runtime.fallback
            ? runtime.fallback
            : runtime.primary;

        const forward = (
          target: UpstreamTarget,
          allowFallback: boolean,
        ): void => {
          const upstream = target.makeRequest(
            buildRequestOptions(req, body, target, runtime),
            (upRes) => {
              const statusCode = upRes.statusCode ?? 502;
              const responseHeaders = {
                ...(upRes.headers as Record<
                  string,
                  string | string[] | number | undefined
                >),
              };

              if (allowFallback && runtime.fallback) {
                const responseChunks: Buffer[] = [];
                upRes.on('data', (chunk) =>
                  responseChunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                  ),
                );
                upRes.on('end', () => {
                  const responseBody = Buffer.concat(responseChunks);
                  if (
                    shouldFallbackFromResponse(
                      statusCode,
                      responseBody,
                      runtime,
                    )
                  ) {
                    logger.warn(
                      {
                        url: req.url,
                        statusCode,
                        primaryUpstream: runtime.primary.url.toString(),
                        fallbackUpstream: runtime.fallback?.url.toString(),
                      },
                      'Primary upstream failed with a fallbackable error; retrying against fallback upstream',
                    );
                    forward(runtime.fallback!, false);
                    return;
                  }
                  relayBufferedResponse(
                    res,
                    statusCode,
                    responseHeaders,
                    responseBody,
                  );
                });
                return;
              }

              res.writeHead(statusCode, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            if (allowFallback && runtime.fallback) {
              logger.warn(
                {
                  err,
                  url: req.url,
                  primaryUpstream: runtime.primary.url.toString(),
                  fallbackUpstream: runtime.fallback.url.toString(),
                },
                'Primary upstream request failed; retrying against fallback upstream',
              );
              forward(runtime.fallback, false);
              return;
            }

            logger.error(
              { err, url: req.url, upstream: target.url.toString() },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        };

        forward(
          initialTarget,
          initialTarget.kind === 'primary' && !!runtime.fallback,
        );
      });
    });

    server.listen(port, host, () => {
      logger.info(
        {
          port,
          host,
          authMode: runtime.authMode,
          primaryUpstream: runtime.primary.url.toString(),
          fallbackUpstream: runtime.fallback?.url.toString(),
          fallbackOnly: runtime.fallbackOnly,
        },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'NANOCLAW_FALLBACK_BASE_URL',
  ]) as ProxySecrets;

  if (secrets.ANTHROPIC_API_KEY) return 'api-key';
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN) {
    return 'oauth';
  }
  return secrets.NANOCLAW_FALLBACK_BASE_URL ? 'api-key' : 'oauth';
}
