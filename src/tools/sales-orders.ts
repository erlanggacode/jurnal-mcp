import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listSalesOrdersSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open').describe('Filter by order status'),
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getSalesOrderSchema = z.object({
  id: z.string().describe('Sales order ID'),
});

export const closeSalesOrderSchema = z.object({
  id: z.string().describe('Sales order ID to close'),
});

export const createSalesOrderSchema = z.object({
  customer_id: z.string().describe('Customer ID'),
  transaction_date: z.string().describe('Transaction date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: z.string().describe('Product ID'),
    quantity: z.number().positive().describe('Quantity'),
    unit_price: z.number().nonnegative().describe('Unit price'),
  })).describe('Line items for the order'),
  memo: z.string().optional().describe('Optional memo/note'),
});

interface SalesOrderItem {
  id: number | string;
  transaction_no?: string;
  person?: { name?: string };
  transaction_date?: string;
  amount?: number;
  status?: string;
  [key: string]: unknown;
}

interface SalesOrdersResponse {
  sales_orders?: SalesOrderItem[];
  sales_order?: SalesOrderItem;
  [key: string]: unknown;
}

export async function listSalesOrders(params: z.infer<typeof listSalesOrdersSchema>) {
  const data = await jurnalRequest<SalesOrdersResponse>('GET', '/api/v1/sales_orders', {
    status: params.status,
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  const orders = data.sales_orders ?? [];
  return orders.map((order: SalesOrderItem) => ({
    id: order.id,
    number: order.transaction_no,
    customer_name: order.person?.name,
    date: order.transaction_date,
    total: order.amount,
    status: order.status,
  }));
}

export async function getSalesOrder(params: z.infer<typeof getSalesOrderSchema>) {
  const data = await jurnalRequest<SalesOrdersResponse>('GET', `/api/v1/sales_orders/${params.id}`);
  return data.sales_order ?? data;
}

export async function closeSalesOrder(params: z.infer<typeof closeSalesOrderSchema>) {
  const data = await jurnalRequest<SalesOrdersResponse>('PATCH', `/api/v1/sales_orders/${params.id}/close`);
  return data.sales_order ?? data;
}

export async function createSalesOrder(params: z.infer<typeof createSalesOrderSchema>) {
  const body = {
    sales_order: {
      person_id: params.customer_id,
      transaction_date: params.transaction_date,
      memo: params.memo,
      sales_order_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
      })),
    },
  };

  const data = await jurnalRequest<SalesOrdersResponse>('POST', '/api/v1/sales_orders', undefined, body);
  const order = data.sales_order as SalesOrderItem | undefined ?? data as unknown as SalesOrderItem;
  return {
    id: order.id,
    number: order.transaction_no,
  };
}
