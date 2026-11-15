// Pure gateway key payload and client setup snippet builders (VIEW-04). No imports, no DOM.

/** Shown in the Client setup snippets until a key has just been created. */
export const PLACEHOLDER_KEY = 'sk-gw-your-gateway-key';

/** The part of GatewayKeyDTO a save needs. */
export interface GatewayKeyLike {
  name: string;
  route_id: number | null;
  enabled: boolean;
}

/**
 * The PUT /gateway-keys/:id body. The Worker writes name, route_id and enabled on every call, so a
 * body that leaves one out resets it (an unpinned route_id turns a pinned key back to Auto, research
 * Pitfall 1). Everything not patched comes from the key as loaded; a null route_id stays null.
 */
export function gatewayKeyPayload(key: GatewayKeyLike, patch: Partial<GatewayKeyLike> = {}): GatewayKeyLike {
  return {
    name: patch.name ?? key.name,
    route_id: patch.route_id !== undefined ? patch.route_id : key.route_id,
    enabled: patch.enabled ?? key.enabled,
  };
}

export function claudeEnvSnippet(origin: string, key: string = PLACEHOLDER_KEY): string {
  return `export ANTHROPIC_BASE_URL="${origin}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"`;
}

export function claudeSettingsSnippet(origin: string, key: string = PLACEHOLDER_KEY): string {
  return JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: key } }, null, 2);
}

export function codexTomlSnippet(origin: string): string {
  return [
    'model_provider = "gateway"',
    '',
    '[model_providers.gateway]',
    'name = "AI Relay Gateway"',
    `base_url = "${origin}/v1"`,
    'env_key = "GATEWAY_KEY"',
    'wire_api = "responses"',
  ].join('\n');
}

export function codexEnvSnippet(key: string = PLACEHOLDER_KEY): string {
  return `export GATEWAY_KEY="${key}"`;
}
