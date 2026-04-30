import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listReceivePaymentsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('created_at').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getReceivePaymentsByInvoiceSchema = z.object({
  invoice_id: z.string().describe('Invoice ID to fetch payments for'),
});

export const createReceivePaymentSchema = z.object({
  transaction_id: z.number().int().positive().describe('The invoice transaction ID to apply payment to (numeric ID from the invoice)'),
  transaction_date: z.string().describe('Payment date in YYYY-MM-DD format'),
  amount: z.number().positive().describe('Payment amount'),
  deposit_to_name: z.string().describe('Name of the bank/cash account to deposit to (e.g. "BCA 4748"). Use get_accounts to find the account name.'),
  payment_method_id: z.number().int().positive().describe('Payment method ID (e.g. Transfer Bank). Use get_payment_methods to find the correct ID.'),
  payment_method_name: z.string().optional().describe('Payment method name (optional, e.g. "Transfer Bank")'),
  custom_id: z.string().optional().describe('Custom payment reference ID (optional)'),
  memo: z.string().optional().describe('Payment memo/note (optional)'),
  is_draft: z.boolean().default(false).describe('Whether to save as draft (default: false)'),
});

interface PaymentItem {
  id: number | string;
  custom_id?: string;
  amount?: number;
  transaction_date?: string;
  [key: string]: unknown;
}

interface PaymentsResponse {
  receive_payments?: PaymentItem[];
  receive_payment?: PaymentItem;
  [key: string]: unknown;
}

export async function listReceivePayments(params: z.infer<typeof listReceivePaymentsSchema>) {
  const data = await jurnalRequest<PaymentsResponse>('GET', '/api/v1/receive_payments', {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  return data.receive_payments ?? [];
}

export async function getReceivePaymentsByInvoice(params: z.infer<typeof getReceivePaymentsByInvoiceSchema>) {
  const data = await jurnalRequest<PaymentsResponse>('GET', '/api/v1/receive_payments', {
    invoice_id: params.invoice_id,
  });

  const payments = data.receive_payments ?? [];
  const totalPaid = payments.reduce((sum: number, p: PaymentItem) => sum + (Number(p.amount) || 0), 0);

  return {
    payments,
    total_paid: totalPaid,
  };
}

export async function createReceivePayment(params: z.infer<typeof createReceivePaymentSchema>) {
  const body: Record<string, unknown> = {
    receive_payment: {
      transaction_date: params.transaction_date,
      deposit_to_name: params.deposit_to_name,
      payment_method_id: params.payment_method_id,
      is_draft: params.is_draft,
      ...(params.payment_method_name ? { payment_method_name: params.payment_method_name } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      records_attributes: [
        {
          transaction_id: params.transaction_id,
          amount: params.amount,
        },
      ],
    },
  };

  const data = await jurnalRequest<PaymentsResponse>('POST', '/api/v1/receive_payments', undefined, body);
  return data.receive_payment ?? data;
}
