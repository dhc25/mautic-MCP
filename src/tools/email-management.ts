import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { MauticApiClient } from '../api/client.js';

export function invalid(message: string): never { throw new McpError(ErrorCode.InvalidParams, message); }
export function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid('Expected a positive integer ID');
  return value;
}
export function ids(value: unknown): number[] {
  if (!Array.isArray(value)) invalid('Expected an array of IDs');
  return [...new Set(value.map(positiveId))];
}
export function recordIds(value: any): number[] {
  return ids(Object.values(value ?? {}).map((v: any) => typeof v === 'number' ? v : v?.id));
}
const idArray = { type: 'array', items: { type: 'integer', minimum: 1 } };
const dateField = { type: ['string', 'null'], description: 'ISO 8601 date/time with explicit offset, or null to clear' };
export const emailFields = {
  name: { type: 'string' }, subject: { type: 'string' },
  language: { type: 'string', description: 'Mautic locale, e.g. en' },
  fromAddress: { type: 'string' }, fromName: { type: 'string' }, replyToAddress: { type: 'string' },
  customHtml: { type: 'string' }, plainText: { type: 'string' }, template: { type: 'string' },
  preheaderText: { type: 'string', maxLength: 130 },
  emailType: { type: 'string', enum: ['template', 'list'] },
  lists: { ...idArray, description: 'Recipient segment IDs for a segment email' },
  excludedLists: { ...idArray, description: 'Excluded segment IDs' },
  category: { type: ['integer', 'null'] }, assetAttachments: idArray,
  utmTags: { type: 'object', properties: Object.fromEntries(['utmSource','utmMedium','utmCampaign','utmContent'].map(k => [k, { type: ['string','null'] }])), additionalProperties: false },
  publishUp: dateField, publishDown: dateField,
  isPublished: { type: 'boolean', description: 'Only false is accepted here; use schedule_email to activate a segment email' },
};
const fieldNames = Object.keys(emailFields);
const dateKeys = ['publishUp','publishDown'];
export function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    invalid('Use an ISO 8601 date/time with explicit timezone offset, e.g. 2026-12-01T09:00:00+00:00');
  return new Date(value).toISOString();
}
export function payload(args: any, create: boolean): Record<string, any> {
  if (!args || typeof args !== 'object') invalid('Expected email fields');
  if (args.isPublished !== undefined && args.isPublished !== false) invalid('Use schedule_email to activate a segment email; drafts cannot be published here');
  if (args.sendToDnc !== undefined && args.sendToDnc !== false) invalid('Do Not Contact overrides are not permitted');
  const result: Record<string, any> = {};
  for (const key of fieldNames) if (args[key] !== undefined) result[key] = args[key];
  if (create) {
    for (const key of ['name','subject']) if (typeof result[key] !== 'string' || !result[key].trim()) invalid(key + ' is required');
    result.language ??= 'en';
    result.emailType ??= 'template';
    result.isPublished = false;
    result.sendToDnc = false;
  }
  if (result.emailType !== undefined && !['template','list'].includes(result.emailType)) invalid('Invalid emailType');
  if (result.preheaderText !== undefined && (typeof result.preheaderText !== 'string' || [...result.preheaderText].length > 130)) invalid('Preheader must be at most 130 characters');
  for (const key of ['lists','excludedLists','assetAttachments']) if (result[key] !== undefined) result[key] = ids(result[key]);
  if (result.category !== undefined && result.category !== null) positiveId(result.category);
  for (const key of dateKeys) if (result[key] !== undefined && result[key] !== null) result[key] = parseDate(result[key]);
  if (result.publishUp && result.publishDown && Date.parse(result.publishDown) <= Date.parse(result.publishUp)) invalid('Publication end must be after start');
  if (create && result.emailType === 'list' && !result.lists?.length) invalid('Segment email requires at least one recipient segment ID');
  if (create && result.emailType === 'template' && result.lists?.length) invalid('Use emailType list for segment recipients');
  return result;
}
export async function readEmail(client: MauticApiClient, id: number) {
  const email = (await client.v1.get('/emails/' + positiveId(id))).data.email;
  if (!email || Number(email.id) !== id) invalid('Email record not found');
  return email;
}
export async function validateSegments(client: MauticApiClient, listIds: number[], requirePublished = true) {
  const result = [];
  for (const id of listIds) {
    const segment = (await client.v1.get('/segments/' + id)).data.list;
    if (!segment || Number(segment.id) !== id) invalid('Segment not found: ' + id);
    if (requirePublished && segment.isPublished !== true) invalid('Segment is not published: ' + id);
    result.push(segment);
  }
  return result;
}
export async function validateAudience(client: MauticApiClient, email: any, changes: any = {}) {
  const type = changes.emailType ?? email.emailType;
  const lists = changes.lists ?? recordIds(email.lists);
  const excluded = changes.excludedLists ?? recordIds(email.excludedLists);
  if (type === 'list' && !lists.length) invalid('Segment email requires recipient segments');
  if (type === 'template' && lists.length) invalid('Template email cannot have recipient segments');
  if (lists.some((id: number) => excluded.includes(id))) invalid('A segment cannot be both included and excluded');
  await validateSegments(client, lists);
  await validateSegments(client, excluded);
  return { lists, excluded };
}
export function assertNoDncOverride(email: any) {
  if (email.sendToDnc !== false && email.sendToDnc !== 0) invalid('Cannot verify that Do Not Contact override is disabled; disable it in Mautic first');
}
export function assertUnsubscribe(email: any) {
  if (email.emailType !== 'list') return;
  const body = String(email.customHtml ?? '') + '\n' + String(email.plainText ?? '');
  if (!/\{unsubscribe_(?:url|text)\}/i.test(body)) invalid('Segment email must include a Mautic unsubscribe token ({unsubscribe_url} or {unsubscribe_text}) before sending or scheduling');
}
export function assertExplicit(value: unknown) { if (value !== true) invalid('Explicit confirmation is required'); }
export function clonePayload(source: any, name: string) {
  // API has no dedicated clone route. Copy content/settings, never counters, dates, publication or experiment relationships.
  const fields: any = {};
  for (const key of ['subject','language','fromAddress','fromName','replyToAddress','customHtml','plainText','template','preheaderText','emailType','utmTags'])
    if (source[key] !== null && source[key] !== undefined) fields[key] = source[key];
  fields.name = name;
  fields.lists = recordIds(source.lists);
  fields.excludedLists = recordIds(source.excludedLists);
  fields.assetAttachments = recordIds(source.assetAttachments);
  if (source.category?.id) fields.category = source.category.id;
  const result = payload(fields, true);
  // Preserve token definitions and unsubscribe configuration when exposed.
  if (source.dynamicContent) result.dynamicContent = source.dynamicContent;
  if (source.unsubscribeForm?.id) result.unsubscribeForm = source.unsubscribeForm.id;
  return result;
}
export async function sendToContact(client: MauticApiClient, email: any, contactId: number, expectedEmail: string) {
  assertNoDncOverride(email);
  assertUnsubscribe(email);
  const contact = (await client.v1.get('/contacts/' + positiveId(contactId))).data.contact;
  const raw = contact?.fields?.all?.email ?? contact?.fields?.core?.email ?? contact?.email;
  const address = typeof raw === 'object' ? raw?.value : raw;
  if (typeof expectedEmail !== 'string' || !expectedEmail.trim() || typeof address !== 'string' ||
      address.toLowerCase() !== expectedEmail.trim().toLowerCase()) invalid('Contact email does not match the explicitly specified recipient');
  // Mautic's native endpoint respects email.sendToDnc=false. No contact creation or suppression changes.
  const response = await client.v1.post('/emails/' + email.id + '/contact/' + contactId + '/send', {});
  return { emailId: email.id, contactId, success: response.data.success === true || response.data.success === 1, requestCompleted: true };
}
