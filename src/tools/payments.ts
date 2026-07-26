import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, numericId, positiveNumber } from '../schema-utils.js';

export const listReceivePaymentsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('created_at').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getReceivePaymentsByInvoiceSchema = z.object({
  invoice_id: stringId.describe('Invoice ID to fetch payments for'),
});

export const createReceivePaymentSchema = z.object({
  transaction_id: numericId.describe('The invoice transaction ID to apply payment to (numeric ID from the invoice)'),
  transaction_date: z.string().describe('Payment date in YYYY-MM-DD format'),
  amount: positiveNumber.describe('Payment amount'),
  deposit_to_name: z.string().describe('Name of the bank/cash account to deposit to (e.g. "BCA 4748"). Use get_accounts to find the account name.'),
  payment_method_id: numericId.describe('Payment method ID (e.g. Transfer Bank). Use get_payment_methods to find the correct ID.'),
  payment_method_name: z.string().optional().describe('Payment method name (optional, e.g. "Transfer Bank")'),
  custom_id: z.string().optional().describe('Custom payment reference ID (optional)'),
  memo: z.string().optional().describe('Payment memo/note (optional)'),
  is_draft: z.boolean().default(false).describe('Whether to save as draft (default: false)'),
});

export const createBillPaymentSchema = z.object({
  bill_id: numericId.describe('The bill (purchase invoice) ID to pay. Use list_bills or get_bill to find it.'),
  transaction_date: z.string().describe('Payment date in YYYY-MM-DD format'),
  amount: positiveNumber.describe('Payment amount. May be less than the bill total for a partial payment.'),
  withdraw_from_name: z.string().describe('Name of the bank/cash account the money leaves (e.g. "BCA 4748"). Use get_accounts to find the account name.'),
  payment_method_id: numericId.describe('Payment method ID (e.g. Transfer Bank). Use get_payment_methods to find the correct ID.'),
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

/**
 * Paying a bill is the payable-side mirror of receive_payments, but the resource is not
 * documented and the name is not derivable from anything already in this codebase.
 * Rather than guess once and POST — which risks writing a real payment through the wrong
 * shape — probe with GETs first: the resource that answers is the resource that exists,
 * and any record it returns shows the field names to send back.
 */
const BILL_PAYMENT_RESOURCES = ['purchase_payments', 'bill_payments', 'pay_bills'];

/** Candidate names for the "which account did the money leave" field, best guess first. */
const WITHDRAW_FIELDS = ['withdraw_from_name', 'payment_from_name', 'credit_account_name', 'deposit_to_name'];

const isMissing = (error: unknown): boolean =>
  /\b40[045]\b|not found|method not allowed/i.test(error instanceof Error ? error.message : String(error));

async function discoverBillPaymentResource(): Promise<{ resource: string; sample?: PaymentItem }> {
  const tried: string[] = [];
  for (const resource of BILL_PAYMENT_RESOURCES) {
    try {
      const data = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/${resource}`, { page_size: 1 });
      const list = data[resource];
      const sample = Array.isArray(list) ? (list[0] as PaymentItem | undefined) : undefined;
      if (resource !== BILL_PAYMENT_RESOURCES[0]) {
        console.error(`[jurnal-mcp] bill payments live at "/api/v1/${resource}"`);
      }
      return { resource, sample };
    } catch (error) {
      if (!isMissing(error)) throw error; // a real error means the endpoint exists
      tried.push(`/api/v1/${resource}`);
    }
  }

  throw new Error(
    `No bill payment endpoint found. Tried ${tried.join(', ')}, all of which returned 404/405. ` +
    `Jurnal may not expose payable-side payments over the API, or may name the resource ` +
    `something else — add the correct name to BILL_PAYMENT_RESOURCES in payments.ts. ` +
    `Until then, bills have to be paid in the Jurnal UI.`
  );
}

export async function createBillPayment(params: z.infer<typeof createBillPaymentSchema>) {
  const { resource, sample } = await discoverBillPaymentResource();
  const envelope = resource.replace(/s$/, '');

  const billBefore = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/purchase_invoices/${params.bill_id}`);
  const bill = (billBefore.purchase_invoice ?? billBefore) as Record<string, unknown>;
  const remainingBefore = Number(bill.remaining ?? bill.original_amount ?? 0);

  // Prefer whatever an existing payment record actually calls the account field; fall
  // back to the best guess when the account has no payments to learn from.
  const withdrawField = (sample && WITHDRAW_FIELDS.find(f => f in sample)) ?? WITHDRAW_FIELDS[0];

  const body = {
    [envelope]: {
      transaction_date: params.transaction_date,
      [withdrawField]: params.withdraw_from_name,
      payment_method_id: params.payment_method_id,
      is_draft: params.is_draft,
      ...(params.payment_method_name ? { payment_method_name: params.payment_method_name } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      records_attributes: [
        {
          transaction_id: params.bill_id,
          amount: params.amount,
        },
      ],
    },
  };

  const data = await jurnalRequest<Record<string, unknown>>('POST', `/api/v1/${resource}`, undefined, body);
  const payment = (data[envelope] ?? data) as PaymentItem;

  // The bill is the source of truth for whether the payment applied. A payment that was
  // created but not linked to the bill leaves `remaining` untouched, and that looks
  // identical to success from the POST response alone.
  const billAfter = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/purchase_invoices/${params.bill_id}`);
  const updated = (billAfter.purchase_invoice ?? billAfter) as Record<string, unknown>;
  const remainingAfter = Number(updated.remaining ?? 0);
  const applied = remainingBefore - remainingAfter;

  return {
    payment_id: payment?.id,
    endpoint: `/api/v1/${resource}`,
    account_field_used: withdrawField,
    bill_id: params.bill_id,
    bill_number: updated.transaction_no,
    amount_sent: params.amount,
    amount_applied_to_bill: applied,
    remaining_before: remainingBefore,
    remaining_after: remainingAfter,
    verified: applied === params.amount,
    ...(applied === params.amount ? {} : {
      warning:
        `Jurnal accepted the payment but the bill's outstanding balance moved by ${applied}, ` +
        `not the ${params.amount} sent. The payment may not be linked to the bill, or the ` +
        `"${withdrawField}" account name may have been rejected. Check payment ` +
        `${payment?.id} in the Jurnal UI before treating this bill as paid.`,
    }),
  };
}
