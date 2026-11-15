// RED stub: replaced in the GREEN commit.
export interface RouteForm {
  name: string;
  position: string;
  patterns: string;
  provider_ids: number[];
}
export interface RouteDtoLike {
  name: string;
  model_patterns: string[];
  is_default: boolean;
  position: number;
  provider_ids: number[];
}
export interface ChainProvider {
  id: number;
}
export type RouteFormErrors = Partial<Record<'name' | 'position', string>>;
export const splitPatterns = (_text: string): string[] => [];
export const emptyRouteForm = (_providers: ChainProvider[]): RouteForm => ({ name: 'x', position: '0', patterns: 'x', provider_ids: [] });
export const routeToForm = (_dto: RouteDtoLike): RouteForm => ({ name: '', position: '', patterns: '', provider_ids: [] });
export const buildRoutePayload = (_form: RouteForm, _dto?: RouteDtoLike): Record<string, unknown> => ({});
export const moveChainItem = (ids: number[], _index: number, _delta: -1 | 1): number[] => ids;
export const removeFromChain = (ids: number[], _id: number): number[] => ids;
export const addToChain = (ids: number[], _id: number): number[] => ids;
export const availableProviders = <T extends ChainProvider>(providers: T[], _ids: number[]): T[] => providers;
export const validateRouteForm = (_form: RouteForm): RouteFormErrors => ({ name: 'stub' });
