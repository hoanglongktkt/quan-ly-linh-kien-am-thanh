import { CategorySelection, MarketplacePlatform } from '../types/marketplaceCategory';

const HISTORY_KEY = 'omni_category_history';

type HistoryStore = Partial<Record<MarketplacePlatform, CategorySelection[]>>;

function readStore(): HistoryStore {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStore(store: HistoryStore) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
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
