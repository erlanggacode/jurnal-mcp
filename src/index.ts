import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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

const transports = new Map<string, SSEServerTransport>();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (url.pathname === '/sse' && req.method === 'GET') {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
    return;
  }

  if (url.pathname === '/messages' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing sessionId' }));
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Jurnal MCP server running on http://0.0.0.0:${PORT}`);
  console.log(`SSE endpoint: http://0.0.0.0:${PORT}/sse`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});
