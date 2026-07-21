import { z } from 'zod';

/** Strip wrappers that do not change the shape a caller may send. */
export function unwrapSchema(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; isOptional: boolean } {
  let inner = schema;
  let isOptional = false;

  for (;;) {
    if (inner instanceof z.ZodOptional) {
      isOptional = true;
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodNullable) {
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodDefault) {
      isOptional = true;
      inner = inner.removeDefault();
    } else if (inner instanceof z.ZodPipeline) {
      // Coercing helpers (schema-utils.ts) pipe a transform into a validator;
      // advertise the input side, which is what a caller may send.
      inner = inner._def.in;
    } else if (inner instanceof z.ZodEffects) {
      inner = inner._def.schema;
    } else {
      return { inner, isOptional };
    }
  }
}

/**
 * Convert a zod schema to JSON Schema, recursing into arrays and nested objects.
 *
 * Arrays previously advertised `items: { type: 'object' }`, which hid the shape of
 * every line-item array in the server: a caller could see that `line_items` was
 * required but had no way to learn it needs product_id/quantity/unit_price, and had
 * to discover the keys by trial and error.
 */
export function zodTypeToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { inner } = unwrapSchema(schema);
  const node: Record<string, unknown> = {};

  if (inner instanceof z.ZodString) {
    node['type'] = 'string';
  } else if (inner instanceof z.ZodUnion) {
    const options = inner.options as z.ZodTypeAny[];
    const types = [...new Set(options.map(option => {
      const { inner: optionInner } = unwrapSchema(option);
      if (optionInner instanceof z.ZodNumber) return 'number';
      if (optionInner instanceof z.ZodBoolean) return 'boolean';
      return 'string';
    }))];
    node['type'] = types.length === 1 ? types[0] : types;
  } else if (inner instanceof z.ZodNumber) {
    node['type'] = 'number';
  } else if (inner instanceof z.ZodBoolean) {
    node['type'] = 'boolean';
  } else if (inner instanceof z.ZodEnum) {
    node['type'] = 'string';
    node['enum'] = inner.options;
  } else if (inner instanceof z.ZodArray) {
    node['type'] = 'array';
    node['items'] = zodTypeToJsonSchema(inner.element as z.ZodTypeAny);
  } else if (inner instanceof z.ZodObject) {
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const field = value as z.ZodTypeAny;
      properties[key] = zodTypeToJsonSchema(field);
      if (!unwrapSchema(field).isOptional) required.push(key);
    }

    node['type'] = 'object';
    node['properties'] = properties;
    if (required.length > 0) node['required'] = required;
  } else {
    node['type'] = 'string';
  }

  const description = (schema as { description?: string }).description;
  if (description) node['description'] = description;

  return node;
}

// Accepts ZodTypeAny, not just ZodObject: schemas carrying a .refine() are ZodEffects,
// which zodTypeToJsonSchema unwraps to the object underneath.
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const root = zodTypeToJsonSchema(schema);
  return {
    type: 'object',
    properties: root['properties'] ?? {},
    required: root['required'],
  };
}
