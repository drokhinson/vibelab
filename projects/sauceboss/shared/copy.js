// UI strings — kept in one place so web and native can share them.

export const APP_NAME = 'SauceBoss';

export const HOME = {
  subtitle: "What are you cooking with?",
  tabs: { carbs: 'Carbs', proteins: 'Proteins', salads: 'Salads' },
  emptyCarbs: 'No carbs yet.',
  emptyProteins: 'No proteins yet.',
  emptySalads: 'No salads yet.',
};

export const SAUCE_SELECTOR = {
  filterButton: 'Filter ingredients',
  favoritesOnly: 'Favorites only',
  noResults: 'No options match your filter — try enabling more ingredients.',
  filterHint: "Uncheck ingredients you don't have — options will update.",
  keyHint: '— unlock the most options',
};

export const RECIPE = {
  totalLabel: 'Total',
  marinadeWarning: (mins) => `Start marinade ${mins}+ min before you cook`,
  servingsSingle: 'person',
  servingsMany: 'people',
  imperialLabel: 'Imperial',
  metricLabel: 'Metric',
  chartTipTitle: 'How to read the chart',
  chartTipBody: 'Each slice is proportional to that ingredient\'s amount in the bowl. Larger slice = more of it.',
};

export const ERROR = {
  generic: 'Something went wrong. Try again.',
  network: 'Network error. Check your connection.',
  unauthorized: 'You need to sign in to do that.',
  notFound: 'Not found.',
};

export const LOADING = {
  initial: 'Warming up the kitchen…',
  itemSauces: (item, label) => `Loading ${item.toLowerCase()} ${label}…`,
  recipe: 'Plating up your recipe…',
};
