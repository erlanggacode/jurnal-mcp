import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listCustomersSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('name').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
  name: z.string().optional().describe('Filter by customer name (partial match)'),
});

interface Customer {
  id: number | string;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  billing_address?: string;
  outstanding_receivable?: number;
  [key: string]: unknown;
}

interface CustomersResponse {
  customers?: Customer[];
  [key: string]: unknown;
}

export async function listCustomers(params: z.infer<typeof listCustomersSchema>) {
  const queryParams: Record<string, string | number | boolean> = {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  };
  if (params.name) queryParams['name'] = params.name;

  const data = await jurnalRequest<CustomersResponse>('GET', '/api/v1/customers', queryParams);

  const customers = data.customers ?? [];
  return customers.map((c: Customer) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: c.billing_address ?? c.address,
    outstanding_receivable: c.outstanding_receivable,
  }));
}
