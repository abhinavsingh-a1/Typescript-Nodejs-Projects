// Plugin: call a web address.
// Security: only hosts in ALLOWED_HTTP_HOSTS may be called (prevents SSRF:
// a customer making OUR server call internal systems). Redirects are refused.
import { config } from '../config.js';
import type { NodePlugin } from '../types.js';
import { asObject } from './helpers.js';

interface HttpParams {
  url: string;
  method: 'GET' | 'POST';
}

export const httpPlugin: NodePlugin<HttpParams> = {
  type: 'http',
  description: 'Call an allowed URL (GET, or POST with the current data as JSON).',
  validate(params) {
    const { url, method = 'GET' } = asObject(params);
    if (typeof url !== 'string') throw new Error('params.url must be a string');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`params.url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('only http/https URLs');
    if (!config.allowedHttpHosts.includes(parsed.hostname)) {
      throw new Error(`host "${parsed.hostname}" is not allowed (allowed: ${config.allowedHttpHosts.join(', ')})`);
    }
    if (method !== 'GET' && method !== 'POST') throw new Error('params.method must be GET or POST');
    return { url, method };
  },
  async execute(input, { url, method }) {
    const res = await fetch(url, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(input) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let body: unknown = text.slice(0, 1000);
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON, keep text */
    }
    return { ...input, http: { status: res.status, body } };
  },
};
