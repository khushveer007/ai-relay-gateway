// RED stub: replaced in the GREEN commit.
export const PLACEHOLDER_KEY = 'sk-gw-your-gateway-key';
export interface GatewayKeyLike {
  name: string;
  route_id: number | null;
  enabled: boolean;
}
export const gatewayKeyPayload = (_key: GatewayKeyLike, patch: Partial<GatewayKeyLike>): GatewayKeyLike => ({ name: '', route_id: null, enabled: true, ...patch });
export const claudeEnvSnippet = (_origin: string, _key?: string): string => '';
export const claudeSettingsSnippet = (_origin: string, _key?: string): string => '';
export const codexTomlSnippet = (_origin: string): string => '';
export const codexEnvSnippet = (_key?: string): string => '';
