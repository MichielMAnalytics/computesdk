import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProviderConfig, getProviderStatus } from '../providers.js';

describe('Novita Workbench configuration', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('requires only NOVITA_API_KEY', () => {
    vi.stubEnv('NOVITA_API_KEY', '');
    expect(getProviderStatus('novita')).toMatchObject({ isComplete: false, missing: ['NOVITA_API_KEY'] });
    vi.stubEnv('NOVITA_API_KEY', 'novita-test');
    expect(getProviderStatus('novita')).toMatchObject({ isComplete: true, missing: [] });
    expect(getProviderConfig('novita')).toEqual({ apiKey: 'novita-test' });
  });
});

describe('boxd Workbench configuration', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('takes an API key with its org and region', () => {
    vi.stubEnv('BOXD_API_KEY', 'bxd_test');
    vi.stubEnv('BOXD_TOKEN', '');
    vi.stubEnv('BOXD_ORG', 'acme');
    vi.stubEnv('BOXD_REGION', 'nyc');
    vi.stubEnv('BOXD_BASE_URL', '');
    expect(getProviderStatus('boxd')).toMatchObject({ isComplete: true, missing: [] });
    expect(getProviderConfig('boxd')).toEqual({ apiKey: 'bxd_test', org: 'acme', region: 'nyc' });
  });

  it('takes a session token instead of a key', () => {
    vi.stubEnv('BOXD_API_KEY', '');
    vi.stubEnv('BOXD_TOKEN', 'session-test');
    expect(getProviderStatus('boxd')).toMatchObject({ isComplete: true, missing: [] });
  });

  it('asks for BOXD_API_KEY when neither is set', () => {
    vi.stubEnv('BOXD_API_KEY', '');
    vi.stubEnv('BOXD_TOKEN', '');
    expect(getProviderStatus('boxd')).toMatchObject({ isComplete: false, missing: ['BOXD_API_KEY'] });
  });
});

describe('microsandbox Workbench configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires cloud credentials by default', () => {
    vi.stubEnv('MSB_API_KEY', '');
    vi.stubEnv('MSB_PROFILE', '');

    expect(getProviderStatus('microsandbox')).toMatchObject({
      isComplete: false,
      present: [],
      missing: ['MSB_API_KEY'],
    });
  });

  it('accepts an API key and forwards its optional endpoint', () => {
    vi.stubEnv('MSB_API_KEY', 'msb_test');
    vi.stubEnv('MSB_API_URL', 'https://cloud.example.test');
    vi.stubEnv('MSB_PROFILE', '');

    expect(getProviderStatus('microsandbox')).toMatchObject({
      isComplete: true,
      present: ['MSB_API_KEY'],
      missing: [],
    });
    expect(getProviderConfig('microsandbox')).toEqual({
      apiKey: 'msb_test',
      apiUrl: 'https://cloud.example.test',
    });
  });

  it('accepts a named cloud profile', () => {
    vi.stubEnv('MSB_API_KEY', '');
    vi.stubEnv('MSB_API_URL', '');
    vi.stubEnv('MSB_PROFILE', 'production');

    expect(getProviderStatus('microsandbox')).toMatchObject({
      isComplete: true,
      present: ['MSB_PROFILE'],
      missing: [],
    });
    expect(getProviderConfig('microsandbox')).toEqual({ profile: 'production' });
  });

  it('prefers an explicit API key when a profile is also set', () => {
    vi.stubEnv('MSB_API_KEY', 'msb_test');
    vi.stubEnv('MSB_API_URL', 'https://cloud.example.test');
    vi.stubEnv('MSB_PROFILE', 'production');

    expect(getProviderConfig('microsandbox')).toEqual({
      apiKey: 'msb_test',
      apiUrl: 'https://cloud.example.test',
    });
  });
});

describe('Cloudflare Workbench configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the sandbox bridge URL and API key', () => {
    vi.stubEnv('CLOUDFLARE_SANDBOX_URL', 'https://sandbox.example.workers.dev');
    vi.stubEnv('CLOUDFLARE_SANDBOX_API_KEY', 'sandbox-key');

    expect(getProviderStatus('cloudflare')).toMatchObject({
      isComplete: true,
      missing: [],
    });
    expect(getProviderConfig('cloudflare')).toEqual({
      sandboxUrl: 'https://sandbox.example.workers.dev',
      sandboxApiKey: 'sandbox-key',
    });
  });

  it('accepts the deprecated sandbox secret as a fallback', () => {
    vi.stubEnv('CLOUDFLARE_SANDBOX_URL', 'https://sandbox.example.workers.dev');
    vi.stubEnv('CLOUDFLARE_SANDBOX_API_KEY', '');
    vi.stubEnv('CLOUDFLARE_SANDBOX_SECRET', 'legacy-key');

    expect(getProviderStatus('cloudflare')).toMatchObject({
      isComplete: true,
      missing: [],
    });
    expect(getProviderConfig('cloudflare')).toEqual({
      sandboxUrl: 'https://sandbox.example.workers.dev',
      sandboxApiKey: 'legacy-key',
    });
  });
});
