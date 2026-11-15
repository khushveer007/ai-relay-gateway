import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_KEY,
  claudeEnvSnippet,
  claudeSettingsSnippet,
  codexEnvSnippet,
  codexTomlSnippet,
  gatewayKeyPayload,
} from '../src/dashboard/lib/gateway-snippets';

// Quotes are dropped so an assertion message holds no escaped quotes, which the TAP parser rejects.
const j = (v: unknown): string => JSON.stringify(v).replace(/"/g, '');

const ORIGIN = 'https://gw.example.com';
const KEY = 'sk-gw-abc123';

describe('gatewayKeyPayload (VIEW-04, research Pitfall 1)', () => {
  const pinned = { name: 'Laptop', route_id: 3, enabled: true };
  const auto = { name: 'CI', route_id: null, enabled: true };

  it('Enable or Disable sends name, route_id and enabled together, so the pinned route is never reset', () => {
    expect(j(gatewayKeyPayload(pinned, { enabled: false }))).toBe(j({ name: 'Laptop', route_id: 3, enabled: false }));
  });

  it('a null route_id stays null', () => {
    expect(j(gatewayKeyPayload(auto, { enabled: false }))).toBe(j({ name: 'CI', route_id: null, enabled: false }));
  });

  it('editing the name and route keeps enabled from the key', () => {
    expect(j(gatewayKeyPayload({ ...pinned, enabled: false }, { name: 'New', route_id: 5 }))).toBe(j({ name: 'New', route_id: 5, enabled: false }));
  });

  it('a patch can move a pinned key back to Auto with route_id null', () => {
    expect(j(gatewayKeyPayload(pinned, { route_id: null }))).toBe(j({ name: 'Laptop', route_id: null, enabled: true }));
  });
});

describe('client setup snippets (D-26, the old dashboard text)', () => {
  it('claudeEnvSnippet is the two export lines', () => {
    expect(claudeEnvSnippet(ORIGIN, KEY)).toBe(`export ANTHROPIC_BASE_URL="${ORIGIN}"\nexport ANTHROPIC_AUTH_TOKEN="${KEY}"`);
  });

  it('claudeSettingsSnippet is the pair as a two-space-indented JSON env object', () => {
    expect(claudeSettingsSnippet(ORIGIN, KEY)).toBe(
      `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "${ORIGIN}",\n    "ANTHROPIC_AUTH_TOKEN": "${KEY}"\n  }\n}`,
    );
  });

  it('codexTomlSnippet is the config.toml block with the /v1 base URL', () => {
    expect(codexTomlSnippet(ORIGIN)).toBe(
      `model_provider = "gateway"\n\n[model_providers.gateway]\nname = "AI Relay Gateway"\nbase_url = "${ORIGIN}/v1"\nenv_key = "GATEWAY_KEY"\nwire_api = "responses"`,
    );
  });

  it('codexEnvSnippet is the GATEWAY_KEY export', () => {
    expect(codexEnvSnippet(KEY)).toBe(`export GATEWAY_KEY="${KEY}"`);
  });

  it('uses the placeholder key when no key is given', () => {
    expect(PLACEHOLDER_KEY).toBe('sk-gw-your-gateway-key');
    expect(claudeEnvSnippet(ORIGIN)).toContain(`ANTHROPIC_AUTH_TOKEN="${PLACEHOLDER_KEY}"`);
    expect(claudeSettingsSnippet(ORIGIN)).toContain(`"ANTHROPIC_AUTH_TOKEN": "${PLACEHOLDER_KEY}"`);
    expect(codexEnvSnippet()).toBe(`export GATEWAY_KEY="${PLACEHOLDER_KEY}"`);
  });
});
