import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId } from '../schema-utils.js';

const MAX_PAGES = 10;
const FETCH_PAGE_SIZE = 100;

export const searchProductsSchema = z.object({
  query: z.string().min(1).describe(
    'Name fragment or product code to search for. Terms may be in any order and may be ' +
    'partial, e.g. "merbau keruing fjl" matches "Mix Keruing Merbau FJLB Door Frame".'
  ),
  limit: z.number().int().positive().max(50).default(10).describe('Maximum candidates to return'),
  include_archived: z.boolean().default(false).describe('Include archived products in results'),
});

export const listProductsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().max(100).default(20).describe('Number of results per page'),
  include_archived: z.boolean().default(false).describe('Include archived products'),
});

interface Product {
  id: number | string;
  name?: string;
  product_name?: string;
  product_code?: string;
  code?: string;
  archive?: boolean;
  archived?: boolean;
  sell_price_per_unit?: number;
  buy_price_per_unit?: number;
  unit?: { name?: string };
  [key: string]: unknown;
}

interface ProductsResponse {
  products?: Product[];
  [key: string]: unknown;
}

/** The API has been seen returning products bare, under `products`, and nested. */
function extractProducts(data: ProductsResponse | Product[]): Product[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.products)) return data.products;
  return [];
}

const productName = (p: Product): string => p.name ?? p.product_name ?? '';
const productCode = (p: Product): string => p.product_code ?? p.code ?? '';
const isArchived = (p: Product): boolean => p.archive === true || p.archived === true;

/** Split on anything that is not a letter or digit, so "FJLB/Door-Frame" tokenises cleanly. */
function tokenise(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Score a product against the query tokens.
 *
 * Every query token must prefix-match some token of the product's name or code —
 * order-independent, so "merbau keruing fjl" matches "Mix Keruing Merbau FJLB Door
 * Frame", where the terms appear in a different order and "fjl" is only a prefix of
 * "FJLB". Returns null when any token is unmatched.
 */
function scoreProduct(product: Product, queryTokens: string[]): number | null {
  const name = productName(product);
  const code = productCode(product);
  const targetTokens = [...tokenise(name), ...tokenise(code)];
  if (targetTokens.length === 0) return null;

  let score = 0;
  for (const token of queryTokens) {
    const exact = targetTokens.includes(token);
    const prefixed = exact || targetTokens.some(target => target.startsWith(token));
    if (!prefixed) return null;
    score += exact ? 2 : 1;
  }

  // A code typed as a single run of characters ("kmfjlbdf") is the strongest signal.
  const normalisedCode = code.toLowerCase().replace(/[^a-z0-9]/gi, '');
  const normalisedQuery = queryTokens.join('');
  if (normalisedCode && normalisedCode === normalisedQuery) score += 100;
  else if (normalisedCode && normalisedCode.startsWith(normalisedQuery)) score += 50;

  return score;
}

function toResult(product: Product) {
  return {
    id: product.id,
    name: productName(product),
    product_code: productCode(product),
    sell_price_per_unit: product.sell_price_per_unit,
    buy_price_per_unit: product.buy_price_per_unit,
    unit: product.unit?.name,
    archived: isArchived(product),
  };
}

async function fetchProductPage(page: number, pageSize: number): Promise<Product[]> {
  const data = await jurnalRequest<ProductsResponse | Product[]>('GET', '/api/v1/products', {
    page,
    page_size: pageSize,
  });
  return extractProducts(data);
}

export async function listProducts(params: z.infer<typeof listProductsSchema>) {
  const products = await fetchProductPage(params.page, params.page_size);
  return products
    .filter(p => params.include_archived || !isArchived(p))
    .map(toResult);
}

/**
 * Match client-side rather than passing `query` through as a server-side filter:
 * the API's filter semantics are substring-based at best, which would miss
 * reordered and partial terms. Pages are walked up to MAX_PAGES.
 */
export async function searchProducts(params: z.infer<typeof searchProductsSchema>) {
  const queryTokens = tokenise(params.query);
  if (queryTokens.length === 0) {
    return { query: params.query, match_count: 0, matches: [], truncated: false };
  }

  const scored: { product: Product; score: number }[] = [];
  let scanned = 0;
  let pagesFetched = 0;
  let exhausted = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = await fetchProductPage(page, FETCH_PAGE_SIZE);
    pagesFetched++;
    scanned += products.length;

    for (const product of products) {
      if (!params.include_archived && isArchived(product)) continue;
      const score = scoreProduct(product, queryTokens);
      if (score !== null) scored.push({ product, score });
    }

    if (products.length < FETCH_PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }

  scored.sort((a, b) =>
    b.score - a.score || productName(a.product).length - productName(b.product).length
  );

  return {
    query: params.query,
    match_count: scored.length,
    // Not every product was seen, so a missing match may exist beyond the scanned pages.
    scanned_products: scanned,
    truncated: !exhausted,
    matches: scored.slice(0, params.limit).map(entry => toResult(entry.product)),
  };
}

export const getProductSchema = z.object({
  id: stringId.describe('Product ID'),
});

export async function getProduct(params: z.infer<typeof getProductSchema>) {
  const data = await jurnalRequest<{ product?: Product }>('GET', `/api/v1/products/${params.id}`);
  return data.product ?? data;
}
