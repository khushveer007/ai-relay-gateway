import type { Config, GatewayKey, Route } from '../types';
import { globMatch } from './model-map';

/**
 * Route resolution order:
 *   1. Route bound to the gateway key
 *   2. First non-default route whose model patterns match the requested model
 *   3. The default route
 */
export function resolveRoute(config: Config, gatewayKey: GatewayKey, model: string | null): Route | null {
  if (gatewayKey.route_id !== null) {
    const bound = config.routes.find((r) => r.id === gatewayKey.route_id);
    if (bound) return bound;
  }
  if (model) {
    for (const route of config.routes) {
      if (route.is_default) continue;
      if (route.model_patterns.some((p) => globMatch(p, model))) return route;
    }
  }
  return config.routes.find((r) => r.is_default) ?? null;
}
