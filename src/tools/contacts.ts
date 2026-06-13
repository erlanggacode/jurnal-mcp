import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listContactsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('display_name').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
  contact_type: z.enum(['Customer', 'Vendor', 'Both']).optional().describe('Filter by contact type: Customer, Vendor, or Both'),
  name: z.string().optional().describe('Filter by contact name (partial match)'),
});

export const getContactSchema = z.object({
  id: z.number().int().positive().describe('Contact ID'),
});

export const createContactSchema = z.object({
  display_name: z.string().describe('Contact display name (required)'),
  contact_type: z.enum(['Customer', 'Vendor', 'Both']).describe('Contact type: Customer, Vendor, or Both'),
  email: z.string().optional().describe('Contact email address'),
  phone: z.string().optional().describe('Office phone number'),
  mobile_phone: z.string().optional().describe('Mobile phone number'),
  company_name: z.string().optional().describe('Company name'),
  address: z.string().optional().describe('Street address'),
  city: z.string().optional().describe('City'),
  province: z.string().optional().describe('Province / state'),
  zip_code: z.string().optional().describe('Postal / ZIP code'),
  country: z.string().optional().describe('Country (default: Indonesia)'),
  tax_number: z.string().optional().describe('Tax identification number (NPWP)'),
  notes: z.string().optional().describe('Additional notes about this contact'),
});

export const updateContactSchema = z.object({
  id: z.number().int().positive().describe('Contact ID to update'),
  display_name: z.string().optional().describe('Contact display name'),
  contact_type: z.enum(['Customer', 'Vendor', 'Both']).optional().describe('Contact type: Customer, Vendor, or Both'),
  email: z.string().optional().describe('Contact email address'),
  phone: z.string().optional().describe('Office phone number'),
  mobile_phone: z.string().optional().describe('Mobile phone number'),
  company_name: z.string().optional().describe('Company name'),
  address: z.string().optional().describe('Street address'),
  city: z.string().optional().describe('City'),
  province: z.string().optional().describe('Province / state'),
  zip_code: z.string().optional().describe('Postal / ZIP code'),
  country: z.string().optional().describe('Country'),
  tax_number: z.string().optional().describe('Tax identification number (NPWP)'),
  notes: z.string().optional().describe('Additional notes about this contact'),
});

export const deleteContactSchema = z.object({
  id: z.number().int().positive().describe('Contact ID to delete'),
});

interface Contact {
  id: number | string;
  display_name?: string;
  contact_type?: string;
  email?: string;
  phone?: string;
  mobile_phone?: string;
  company_name?: string;
  address?: string;
  city?: string;
  province?: string;
  zip_code?: string;
  country?: string;
  tax_number?: string;
  notes?: string;
  outstanding_receivable?: number;
  outstanding_payable?: number;
  [key: string]: unknown;
}

interface ContactsResponse {
  contacts?: Contact[];
  contact?: Contact;
  [key: string]: unknown;
}

function mapContact(c: Contact) {
  return {
    id: c.id,
    display_name: c.display_name,
    contact_type: c.contact_type,
    email: c.email,
    phone: c.phone,
    mobile_phone: c.mobile_phone,
    company_name: c.company_name,
    address: c.address,
    city: c.city,
    province: c.province,
    zip_code: c.zip_code,
    country: c.country,
    tax_number: c.tax_number,
    notes: c.notes,
    outstanding_receivable: c.outstanding_receivable,
    outstanding_payable: c.outstanding_payable,
  };
}

export async function listContacts(params: z.infer<typeof listContactsSchema>) {
  const queryParams: Record<string, string | number | boolean> = {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  };
  if (params.contact_type) queryParams['contact_type'] = params.contact_type;
  if (params.name) queryParams['name'] = params.name;

  const data = await jurnalRequest<ContactsResponse>('GET', '/api/v1/contacts', queryParams);

  const contacts = data.contacts ?? [];
  return contacts.map(mapContact);
}

export async function getContact(params: z.infer<typeof getContactSchema>) {
  const data = await jurnalRequest<ContactsResponse>('GET', `/api/v1/contacts/${params.id}`);
  const contact = data.contact ?? (data as unknown as Contact);
  return mapContact(contact);
}

export async function createContact(params: z.infer<typeof createContactSchema>) {
  const contactBody: Record<string, unknown> = {
    display_name: params.display_name,
    contact_type: params.contact_type,
  };

  if (params.email !== undefined) contactBody['email'] = params.email;
  if (params.phone !== undefined) contactBody['phone'] = params.phone;
  if (params.mobile_phone !== undefined) contactBody['mobile_phone'] = params.mobile_phone;
  if (params.company_name !== undefined) contactBody['company_name'] = params.company_name;
  if (params.address !== undefined) contactBody['address'] = params.address;
  if (params.city !== undefined) contactBody['city'] = params.city;
  if (params.province !== undefined) contactBody['province'] = params.province;
  if (params.zip_code !== undefined) contactBody['zip_code'] = params.zip_code;
  if (params.country !== undefined) contactBody['country'] = params.country;
  if (params.tax_number !== undefined) contactBody['tax_number'] = params.tax_number;
  if (params.notes !== undefined) contactBody['notes'] = params.notes;

  const data = await jurnalRequest<ContactsResponse>('POST', '/api/v1/contacts', undefined, { contact: contactBody });
  const contact = data.contact ?? (data as unknown as Contact);
  return mapContact(contact);
}

export async function updateContact(params: z.infer<typeof updateContactSchema>) {
  const { id, ...fields } = params;
  const contactBody: Record<string, unknown> = {};

  if (fields.display_name !== undefined) contactBody['display_name'] = fields.display_name;
  if (fields.contact_type !== undefined) contactBody['contact_type'] = fields.contact_type;
  if (fields.email !== undefined) contactBody['email'] = fields.email;
  if (fields.phone !== undefined) contactBody['phone'] = fields.phone;
  if (fields.mobile_phone !== undefined) contactBody['mobile_phone'] = fields.mobile_phone;
  if (fields.company_name !== undefined) contactBody['company_name'] = fields.company_name;
  if (fields.address !== undefined) contactBody['address'] = fields.address;
  if (fields.city !== undefined) contactBody['city'] = fields.city;
  if (fields.province !== undefined) contactBody['province'] = fields.province;
  if (fields.zip_code !== undefined) contactBody['zip_code'] = fields.zip_code;
  if (fields.country !== undefined) contactBody['country'] = fields.country;
  if (fields.tax_number !== undefined) contactBody['tax_number'] = fields.tax_number;
  if (fields.notes !== undefined) contactBody['notes'] = fields.notes;

  const data = await jurnalRequest<ContactsResponse>('PUT', `/api/v1/contacts/${id}`, undefined, { contact: contactBody });
  const contact = data.contact ?? (data as unknown as Contact);
  return mapContact(contact);
}

export async function deleteContact(params: z.infer<typeof deleteContactSchema>) {
  await jurnalRequest<unknown>('DELETE', `/api/v1/contacts/${params.id}`);
  return { success: true, deleted_id: params.id };
}
