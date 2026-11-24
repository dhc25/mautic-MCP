import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

// Native Mautic 7 filter metadata, verified against a UI-created segment.
const native: Record<string, { object: string; type: string }> = {
  lead_email_sent: { object: 'behaviors', type: 'lead_email_received' },
  lead_email_received: { object: 'behaviors', type: 'lead_email_received' },
  leadlist: { object: 'lead', type: 'leadlist' },
  email: { object: 'lead', type: 'email' },
};

export function normalizeSegmentFilters(filters: unknown): any[] {
  if (!Array.isArray(filters)) invalid('filters must be an array');
  return filters.map((f: any, i: number) => {
    if (!f || typeof f !== 'object' || typeof f.field !== 'string' || !f.field ||
        typeof f.operator !== 'string' || !f.operator) invalid('Invalid filter at index ' + i);
    const glue = f.glue ?? 'and';
    if (glue !== 'and' && glue !== 'or') invalid('Invalid glue at index ' + i);
    const mapping = Object.prototype.hasOwnProperty.call(native, f.field) ? native[f.field] : undefined;
    const object = mapping?.object ?? f.object;
    const type = mapping?.type ?? f.type;
    if (typeof object !== 'string' || !object || typeof type !== 'string' || !type)
      invalid('Supply native Mautic object and type for filter ' + f.field);
    if (object === 'behaviors' && type === 'multiselect')
      invalid('Use native behavioral filter type, not multiselect: ' + f.field);
    const properties = f.properties ?? {};
    if (typeof properties !== 'object' || Array.isArray(properties))
      invalid('Invalid filter properties at index ' + i);
    let value = Object.prototype.hasOwnProperty.call(properties, 'filter') ? properties.filter : f.filter;
    if (['lead_email_sent', 'lead_email_received', 'leadlist'].includes(f.field)) {
      if (!['in', '!in'].includes(f.operator)) invalid('Expected in or !in for ' + f.field);
      if (!Array.isArray(value) || !value.length ||
          !value.every(v => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) &&
            Number.isSafeInteger(Number(v)) && Number(v) > 0))
        invalid('Expected non-empty array of positive IDs for ' + f.field);
      value = value.map(Number);
    }
    if (f.field === 'email' && ['empty', '!empty'].includes(f.operator)) value = null;
    return {
      glue, field: f.field, object, type, operator: f.operator,
      properties: { ...properties, filter: value ?? null },
    };
  });
}

export function pageLimit(value: unknown, maximum = 5): number {
  if (value === undefined || value === null) return Math.min(5, maximum);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalid('limit must be a positive integer');
  return Math.min(value, maximum);
}

export function contactSummary(contact: any) {
  const field = (name: string) => {
    const raw = contact?.fields?.all?.[name] ?? contact?.fields?.core?.[name] ?? contact?.[name];
    return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  };
  return {
    id: contact?.id,
    firstname: field('firstname'),
    lastname: field('lastname'),
    email: field('email'),
    company: field('company'),
    isPublished: contact?.isPublished,
    mailingListStatus: field('candeo_mailing_list_statu'),
  };
}

export function compactContacts(contacts: any) {
  return Object.fromEntries(Object.entries(contacts ?? {}).map(([key, value]) => [key, contactSummary(value)]));
}

export function emailSummary(email: any) {
  const { id, name, subject, emailType, isPublished, sentCount, readCount, publishUp, publishDown, lists } = email ?? {};
  return { id, name, subject, emailType, isPublished, sentCount, readCount, publishUp, publishDown,
    lists: lists ? Object.values(lists).map((list: any) => ({ id: list.id, name: list.name })) : undefined };
}

export function writeSummary(record: any, changedFields?: string[]) {
  return { success: true, id: record?.id, ...(changedFields ? { changedFields } : {}) };
}
