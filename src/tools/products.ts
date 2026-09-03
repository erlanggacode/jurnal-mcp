import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, nonNegativeNumber, numericId } from '../schema-utils.js';

// The API caps products at 10 per page regardless of the page_size asked for, so
// page length says nothing about whether more pages exist. Paging therefore runs
// until a page comes back empty or repeats, never until a page "underfills".
const MAX_PAGES = 30;
const REQUESTED_PAGE_SIZE = 100;

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
 * Walk every page of the catalogue.
 *
 * Deliberately does not treat a short page as the last one: the API serves 10 per
 * page whatever page_size is sent, so a "short" page is the normal case. Stops only
 * on an empty page, or on a page that adds no new IDs — which covers an API that
 * clamps an out-of-range page number back to a valid one instead of returning empty.
 */
async function collectAllProducts(): Promise<{ products: Product[]; exhausted: boolean; pages: number }> {
  const seenIds = new Set<string>();
  const products: Product[] = [];
  let exhausted = false;
  let pages = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchProductPage(page, REQUESTED_PAGE_SIZE);
    pages++;

    if (batch.length === 0) {
      exhausted = true;
      break;
    }

    let added = 0;
    for (const product of batch) {
      const key = String(product.id);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      products.push(product);
      added++;
    }

    if (added === 0) {
      exhausted = true;
      break;
    }
  }

  return { products, exhausted, pages };
}

/**
 * Match client-side rather than passing `query` through as a server-side filter:
 * the API's filter semantics are substring-based at best, which would miss
 * reordered and partial terms.
 */
export async function searchProducts(params: z.infer<typeof searchProductsSchema>) {
  const queryTokens = tokenise(params.query);
  if (queryTokens.length === 0) {
    return {
      query: params.query,
      match_count: 0,
      scanned_products: 0,
      pages_scanned: 0,
      truncated: false,
      matches: [],
    };
  }

  const { products, exhausted, pages } = await collectAllProducts();

  const scored: { product: Product; score: number }[] = [];
  for (const product of products) {
    if (!params.include_archived && isArchived(product)) continue;
    const score = scoreProduct(product, queryTokens);
    if (score !== null) scored.push({ product, score });
  }

  scored.sort((a, b) =>
    b.score - a.score || productName(a.product).length - productName(b.product).length
  );

  return {
    query: params.query,
    match_count: scored.length,
    scanned_products: products.length,
    pages_scanned: pages,
    // True only when MAX_PAGES ran out before the catalogue did: a match may exist
    // beyond what was scanned. Never report a partial scan as complete.
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

export const createProductSchema = z.object({
  name: z.string().min(1).describe('Product name'),
  unit_name: z.string().min(1).describe('Unit of measure name (e.g. "M3", "pcs"). Use get_accounts or the Jurnal UI to see existing units.'),
  product_code: z.string().min(1).describe('Unique product/SKU code'),
  description: z.string().optional().describe('Product description'),
  custom_id: z.string().optional().describe('Custom reference ID (optional)'),
  purchasable: z.boolean().optional().describe(
    'Whether the product can be bought ("Saya beli produk ini" in the Jurnal UI). ' +
    'Must be true before the product can be put on a bill or purchase order.'
  ),
  sellable: z.boolean().optional().describe(
    'Whether the product can be sold ("Saya jual produk ini" in the Jurnal UI). ' +
    'Must be true before the product can be put on an invoice or sales order.'
  ),
  buy_price_per_unit: nonNegativeNumber.optional().describe('Purchase price per unit'),
  sell_price_per_unit: nonNegativeNumber.optional().describe('Selling price per unit'),
  taxable_buy: z.boolean().optional().describe('Whether purchases of this product are taxed'),
  taxable_sell: z.boolean().optional().describe('Whether sales of this product are taxed'),
  buy_tax_id: numericId.optional().describe('Tax ID applied on purchase (optional)'),
  sell_tax_id: numericId.optional().describe('Tax ID applied on sale (optional)'),
  track_inventory: z.boolean().optional().describe('Whether Jurnal tracks stock quantity for this product'),
  buy_account_name: z.string().optional().describe('Purchase (COGS/expense) account name, e.g. "Cost of Sales"'),
  sell_account_name: z.string().optional().describe('Sales/revenue account name, e.g. "Service Revenue"'),
  inventory_asset_account_name: z.string().optional().describe('Inventory asset account name (only relevant when track_inventory is true)'),
  product_category_ids: z.array(numericId).optional().describe('IDs of product categories to assign'),
});

export async function createProduct(params: z.infer<typeof createProductSchema>) {
  const body = {
    product: {
      name: params.name,
      unit_name: params.unit_name,
      product_code: params.product_code,
      ...(params.description ? { description: params.description } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.purchasable !== undefined ? { is_bought: params.purchasable } : {}),
      ...(params.sellable !== undefined ? { is_sold: params.sellable } : {}),
      ...(params.buy_price_per_unit !== undefined ? { buy_price_per_unit: String(params.buy_price_per_unit) } : {}),
      ...(params.sell_price_per_unit !== undefined ? { sell_price_per_unit: String(params.sell_price_per_unit) } : {}),
      ...(params.taxable_buy !== undefined ? { taxable_buy: params.taxable_buy } : {}),
      ...(params.taxable_sell !== undefined ? { taxable_sell: params.taxable_sell } : {}),
      ...(params.buy_tax_id !== undefined ? { buy_tax_id: params.buy_tax_id } : {}),
      ...(params.sell_tax_id !== undefined ? { sell_tax_id: params.sell_tax_id } : {}),
      ...(params.track_inventory !== undefined ? { track_inventory: String(params.track_inventory) } : {}),
      ...(params.buy_account_name ? { buy_account_name: params.buy_account_name } : {}),
      ...(params.sell_account_name ? { sell_account_name: params.sell_account_name } : {}),
      ...(params.inventory_asset_account_name ? { inventory_asset_account_name: params.inventory_asset_account_name } : {}),
      ...(params.product_category_ids ? { product_category_ids: params.product_category_ids } : {}),
    },
  };

  const data = await jurnalRequest<{ product?: Product }>('POST', '/api/v1/products', undefined, body);
  const product = (data.product ?? data) as Product;
  return toResult(product);
}

export const updateProductSchema = z.object({
  id: stringId.describe('Product ID. Use search_products to resolve one by name.'),
  purchasable: z.boolean().optional().describe(
    'Whether the product can be bought ("Saya beli produk ini" in the Jurnal UI). ' +
    'Must be true before the product can be put on a bill or purchase order.'
  ),
  sellable: z.boolean().optional().describe(
    'Whether the product can be sold ("Saya jual produk ini" in the Jurnal UI). ' +
    'Must be true before the product can be put on an invoice or sales order.'
  ),
  name: z.string().min(1).optional().describe('Product name'),
  product_code: z.string().optional().describe('Product code'),
  buy_price_per_unit: nonNegativeNumber.optional().describe('Purchase price per unit'),
  sell_price_per_unit: nonNegativeNumber.optional().describe('Selling price per unit'),
  archived: z.boolean().optional().describe('Whether the product is archived'),
}).refine(
  params => Object.keys(params).some(key => key !== 'id'),
  { message: 'Provide at least one field to change besides id' }
);

/**
 * Candidate API field names for each input, most likely first.
 *
 * Jurnal's product payload is not documented publicly and the flags do not appear on
 * the product summaries embedded in transactions, so the real key is resolved against
 * the live record rather than assumed — see resolveFieldName.
 */
const FIELD_CANDIDATES: Record<string, string[]> = {
  purchasable: ['is_buy', 'is_purchase', 'buy', 'purchase', 'is_bought'],
  sellable: ['is_sell', 'is_sale', 'sell', 'sale', 'is_sold'],
  name: ['name', 'product_name'],
  product_code: ['product_code', 'code'],
  buy_price_per_unit: ['buy_price_per_unit'],
  sell_price_per_unit: ['sell_price_per_unit'],
};

/** Pick the candidate the live record actually carries, so unknown keys are never sent. */
function resolveFieldName(current: Product, input: string): string | null {
  const candidates = FIELD_CANDIDATES[input] ?? [input];
  const present = candidates.find(candidate => candidate in current);
  return present ?? null;
}

export async function updateProduct(params: z.infer<typeof updateProductSchema>) {
  const { id, archived, ...requested } = params;

  const before = await jurnalRequest<{ product?: Product }>('GET', `/api/v1/products/${id}`);
  const current = (before.product ?? before) as Product;

  const changes: Record<string, unknown> = {};
  const unsupported: { field: string; tried: string[] }[] = [];

  for (const [input, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    const apiField = resolveFieldName(current, input);
    if (apiField === null) {
      unsupported.push({ field: input, tried: FIELD_CANDIDATES[input] ?? [input] });
      continue;
    }
    changes[apiField] = value;
  }

  if (unsupported.length > 0) {
    const detail = unsupported
      .map(u => `"${u.field}" (tried ${u.tried.join(', ')})`)
      .join('; ');
    throw new Error(
      `Cannot map ${detail} onto product ${id}. Fields present on the record: ` +
      `[${Object.keys(current).sort().join(', ')}]. Update the candidate list in products.ts ` +
      `with the correct field name.`
    );
  }

  if (Object.keys(changes).length > 0) {
    // Method is not documented either; PATCH first, fall back to PUT if it is rejected.
    const body = { product: changes };
    try {
      await jurnalRequest('PATCH', `/api/v1/products/${id}`, undefined, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/40[45]|method not allowed/i.test(message)) throw error;
      await jurnalRequest('PUT', `/api/v1/products/${id}`, undefined, body);
    }
  }

  // Archiving is not a PATCH field — Jurnal exposes it as two dedicated actions.
  if (archived !== undefined) {
    await jurnalRequest('POST', `/api/v1/products/${id}/${archived ? 'deactivate' : 'activate'}`);
  }

  // Read back rather than trusting the write: an API that ignores unknown or
  // read-only attributes returns 200 while changing nothing, which would otherwise
  // report success for an update that did not happen.
  const after = await jurnalRequest<{ product?: Product }>('GET', `/api/v1/products/${id}`);
  const updated = (after.product ?? after) as Product;

  const applied: string[] = [];
  const ignored: { field: string; requested: unknown; actual: unknown }[] = [];
  for (const [apiField, value] of Object.entries(changes)) {
    if (updated[apiField] === value) applied.push(apiField);
    else ignored.push({ field: apiField, requested: value, actual: updated[apiField] });
  }
  if (archived !== undefined) {
    if (isArchived(updated) === archived) applied.push('archived');
    else ignored.push({ field: 'archived', requested: archived, actual: isArchived(updated) });
  }

  return {
    id,
    applied,
    ignored,
    verified: ignored.length === 0,
    product: toResult(updated),
  };
}
