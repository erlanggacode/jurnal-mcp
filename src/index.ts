import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  listSalesOrdersSchema,
  getSalesOrderSchema,
  closeSalesOrderSchema,
  createSalesOrderSchema,
  listSalesOrders,
  getSalesOrder,
  closeSalesOrder,
  createSalesOrder,
} from './tools/sales-orders.js';

import {
  createDeliveryOrderSchema,
  createDeliveryOrder,
} from './tools/delivery-orders.js';

import {
  listSalesInvoicesSchema,
  listSalesInvoices,
} from './tools/invoices.js';

import {
  listReceivePaymentsSchema,
  getReceivePaymentsByInvoiceSchema,
  createReceivePaymentSchema,
  listReceivePayments,
  getReceivePaymentsByInvoice,
  createReceivePayment,
} from './tools/payments.js';

import {
  getBankAccountsSchema,
  getBankAccounts,
} from './tools/bank-accounts.js';

import {
  listJournalEntriesSchema,
  listJournalEntries,
} from './tools/journal-entries.js';

import {
  listCustomersSchema,
  listCustomers,
} from './tools/customers.js';

import {
  getAccountsSchema,
  getAccounts,
} from './tools/accounts.js';

import {
  getPaymentMethodsSchema,
  getPaymentMethods,
} from './tools/payment-methods.js';

import {
  listExpensesSchema,
  getExpenseSchema,
  createExpenseSchema,
  updateExpenseSchema,
  deleteExpenseSchema,
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
} from './tools/expenses.js';

const VERSION = '1.4.1';
const PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const fieldSchema = value as z.ZodTypeAny;
    const prop: Record<string, unknown> = {};

    let innerSchema = fieldSchema;
    let isOptional = false;

    if (innerSchema instanceof z.ZodOptional) {
      isOptional = true;
      innerSchema = innerSchema.unwrap();
    } else if (innerSchema instanceof z.ZodDefault) {
      isOptional = true;
      innerSchema = innerSchema.removeDefault();
    }

    if (innerSchema instanceof z.ZodString) {
      prop['type'] = 'string';
    } else if (innerSchema instanceof z.ZodNumber) {
      prop['type'] = 'number';
    } else if (innerSchema instanceof z.ZodBoolean) {
      prop['type'] = 'boolean';
    } else if (innerSchema instanceof z.ZodEnum) {
      prop['type'] = 'string';
      prop['enum'] = innerSchema.options;
    } else if (innerSchema instanceof z.ZodArray) {
      prop['type'] = 'array';
      prop['items'] = { type: 'object' };
    } else {
      prop['type'] = 'string';
    }

    const description = (fieldSchema as { description?: string }).description;
    if (description) {
      prop['description'] = description;
    }

    properties[key] = prop;
    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function createMcpServer(): Server {
  const server = new Server(
    { name: 'jurnal-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_sales_orders',
        description: 'List sales orders from Jurnal.id with optional filtering by status',
        inputSchema: zodToJsonSchema(listSalesOrdersSchema),
      },
      {
        name: 'get_sales_order',
        description: 'Get full details of a specific sales order including line items',
        inputSchema: zodToJsonSchema(getSalesOrderSchema),
      },
      {
        name: 'close_sales_order',
        description: 'Close an open sales order',
        inputSchema: zodToJsonSchema(closeSalesOrderSchema),
      },
      {
        name: 'create_sales_order',
        description: 'Create a new sales order with line items',
        inputSchema: zodToJsonSchema(createSalesOrderSchema),
      },
      {
        name: 'create_delivery_order',
        description: 'Create a delivery order from a sales order',
        inputSchema: zodToJsonSchema(createDeliveryOrderSchema),
      },
      {
        name: 'list_sales_invoices',
        description: 'List sales invoices from Jurnal.id',
        inputSchema: zodToJsonSchema(listSalesInvoicesSchema),
      },
      {
        name: 'list_receive_payments',
        description: 'List received payments from Jurnal.id',
        inputSchema: zodToJsonSchema(listReceivePaymentsSchema),
      },
      {
        name: 'get_receive_payments_by_invoice',
        description: 'Get all payments for a specific invoice with total paid amount',
        inputSchema: zodToJsonSchema(getReceivePaymentsByInvoiceSchema),
      },
      {
        name: 'create_receive_payment',
        description: 'Record a new payment received against an invoice',
        inputSchema: zodToJsonSchema(createReceivePaymentSchema),
      },
      {
        name: 'get_bank_accounts',
        description: 'List bank/cash accounts from Jurnal.id. Use this to find the payment_account_id for a bank account number before creating a receive payment.',
        inputSchema: zodToJsonSchema(getBankAccountsSchema),
      },
      {
        name: 'list_journal_entries',
        description: 'List general journal entries from Jurnal.id with optional date range filtering',
        inputSchema: zodToJsonSchema(listJournalEntriesSchema),
      },
      {
        name: 'list_customers',
        description: 'List customers from Jurnal.id with optional name search',
        inputSchema: zodToJsonSchema(listCustomersSchema),
      },
      {
        name: 'get_accounts',
        description: 'List chart of accounts from Jurnal.id. Useful for finding account IDs including bank and cash accounts.',
        inputSchema: zodToJsonSchema(getAccountsSchema),
      },
      {
        name: 'get_payment_methods',
        description: 'List available payment methods from Jurnal.id (e.g. Transfer Bank, Cash). Use this to find the payment_method_id needed for create_receive_payment.',
        inputSchema: zodToJsonSchema(getPaymentMethodsSchema),
      },
      {
        name: 'list_expenses',
        description: 'List expenses from Jurnal.id with optional date range filtering',
        inputSchema: zodToJsonSchema(listExpensesSchema),
      },
      {
        name: 'get_expense',
        description: 'Get full details of a specific expense including line items',
        inputSchema: zodToJsonSchema(getExpenseSchema),
      },
      {
        name: 'create_expense',
        description: 'Create a new expense entry with line items. Requires a payment_account_id (bank/cash account) and expense_lines_attributes with account_id for each expense category.',
        inputSchema: zodToJsonSchema(createExpenseSchema),
      },
      {
        name: 'update_expense',
        description: 'Update an existing expense entry',
        inputSchema: zodToJsonSchema(updateExpenseSchema),
      },
      {
        name: 'delete_expense',
        description: 'Delete an expense entry by ID',
        inputSchema: zodToJsonSchema(deleteExpenseSchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'list_sales_orders':
          result = await listSalesOrders(listSalesOrdersSchema.parse(args));
          break;
        case 'get_sales_order':
          result = await getSalesOrder(getSalesOrderSchema.parse(args));
          break;
        case 'close_sales_order':
          result = await closeSalesOrder(closeSalesOrderSchema.parse(args));
          break;
        case 'create_sales_order':
          result = await createSalesOrder(createSalesOrderSchema.parse(args));
          break;
        case 'create_delivery_order':
          result = await createDeliveryOrder(createDeliveryOrderSchema.parse(args));
          break;
        case 'list_sales_invoices':
          result = await listSalesInvoices(listSalesInvoicesSchema.parse(args));
          break;
        case 'list_receive_payments':
          result = await listReceivePayments(listReceivePaymentsSchema.parse(args));
          break;
        case 'get_receive_payments_by_invoice':
          result = await getReceivePaymentsByInvoice(getReceivePaymentsByInvoiceSchema.parse(args));
          break;
        case 'create_receive_payment':
          result = await createReceivePayment(createReceivePaymentSchema.parse(args));
          break;
        case 'get_bank_accounts':
          result = await getBankAccounts(getBankAccountsSchema.parse(args));
          break;
        case 'list_journal_entries':
          result = await listJournalEntries(listJournalEntriesSchema.parse(args));
          break;
        case 'list_customers':
          result = await listCustomers(listCustomersSchema.parse(args));
          break;
        case 'get_accounts':
          result = await getAccounts(getAccountsSchema.parse(args));
          break;
        case 'get_payment_methods':
          result = await getPaymentMethods(getPaymentMethodsSchema.parse(args));
          break;
        case 'list_expenses':
          result = await listExpenses(listExpensesSchema.parse(args));
          break;
        case 'get_expense':
          result = await getExpense(getExpenseSchema.parse(args));
          break;
        case 'create_expense':
          result = await createExpense(createExpenseSchema.parse(args));
          break;
        case 'update_expense':
          result = await updateExpense(updateExpenseSchema.parse(args));
          break;
        case 'delete_expense':
          result = await deleteExpense(deleteExpenseSchema.parse(args));
          break;
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const transports = new Map<string, StreamableHTTPServerTransport>();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'jurnal-mcp',
      version: VERSION,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (url.pathname === '/mcp') {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        const rawBody = await readBody(req);
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, body);
        return;
      }

      if (isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID or not an initialize request' }));
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid session ID' }));
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Jurnal MCP server running on http://0.0.0.0:${PORT}`);
  console.log(`MCP endpoint:  http://0.0.0.0:${PORT}/mcp`);
  console.log(`Health check:  http://0.0.0.0:${PORT}/health`);
});
