import { CategorySelection, MarketplacePlatform } from '../types/marketplaceCategory';

import { safeGetJson, safeSetItem } from '../utils/safeStorage';

const HISTORY_KEY = 'omni_category_history';

type HistoryStore = Partial<Record<MarketplacePlatform, CategorySelection[]>>;

function readStore(): HistoryStore {
  return safeGetJson<HistoryStore>(HISTORY_KEY, {});
}

function writeStore(store: HistoryStore) {
  safeSetItem(HISTORY_KEY, JSON.stringify(store));
}

export function getCategoryHistory(platform: MarketplacePlatform): CategorySelection[] {
  return readStore()[platform] || [];
}

export function pushCategoryHistory(selection: CategorySelection) {
  const store = readStore();
  const list = store[selection.platform] || [];
  const next = [
    selection,
    ...list.filter((c) => c.categoryId !== selection.categoryId),
  ].slice(0, 12);
  store[selection.platform] = next;
  writeStore(store);
}
