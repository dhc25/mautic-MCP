import { emailSummary, pageLimit, writeSummary, mutationSummary } from './safety.js';
import { emailFields, payload, readEmail, validateAudience, validateSegments, assertNoDncOverride, assertUnsubscribe, assertExplicit, clonePayload, parseDate, positiveId, invalid, sendToContact } from './email-management.js';
import type { MauticApiClient } from '../api/client.js';
import type { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinitions: ToolDefinition[] = [
  // Existing email tools
  {
    name: 'send_email',
    description: 'Send a real tracked email to explicitly specified one existing contact; requires explicit confirmation and matching email addresses',
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'number', description: 'Email template ID' },
        contactIds: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 1, description: 'One existing contact ID' },
        contactEmails: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1, description: 'One matching email address' },
        confirmSend: { type: 'boolean', description: 'Explicit approval to send' },
      },
      required: ['emailId','contactIds','contactEmails','confirmSend'],
    },
  },
  {
    name: 'list_emails',
    description: 'Get all email templates and campaigns',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term' },
        limit: { type: 'number', description: 'Number of results (max 20)', maximum: 20 },
        start: { type: 'number', description: 'Starting offset' },
        publishedOnly: { type: 'boolean', description: 'Only published emails' },
      },
    },
  },
  {
    name: 'get_email',
    description: 'Get email metadata; optionally include content',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Email ID' },
        includeContent: { type: 'boolean', description: 'Include HTML and plain text (may be large)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_email_template',
    description: 'Create an unpublished email draft, including segment emails with recipient lists. Use schedule_email to activate.',
    inputSchema: { type: 'object', properties: emailFields, required: ['name', 'subject'] },
  },
  {
    name: 'update_email',
    description: 'PATCH an unpublished email; preserve unspecified fields. Unpublish an active email in a separate explicit operation before editing.',
    inputSchema: { type: 'object', properties: { ...emailFields, id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'clone_email',
    description: 'Create a new unpublished draft copying supported email content and settings, not send history, scheduling or A/B relationships.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id', 'name'] },
  },
  {
    name: 'preview_email_audience',
    description: 'Return assigned and excluded segment membership counts, not a deduplicated or deliverable-recipient count.',
    inputSchema: { type: 'object', properties: { emailId: { type: 'integer' } }, required: ['emailId'] },
  },
  {
    name: 'send_test_email',
    description: 'Send a real tracked test email to one explicitly identified existing contact; draft only. May affect statistics. Never overrides DNC.',
    inputSchema: { type: 'object', properties: { emailId: { type: 'integer' }, contactId: { type: 'integer' }, recipientEmail: { type: 'string' }, confirmSend: { type: 'boolean' } }, required: ['emailId','contactId','recipientEmail','confirmSend'] },
  },
  {
    name: 'schedule_email',
    description: 'Activate an unpublished segment email for a future date/time with explicit timezone offset. The broadcast cron can send it automatically. Requires explicit approval.',
    inputSchema: { type: 'object', properties: { emailId: { type: 'integer' }, publishUp: { type: 'string' }, publishDown: { type: 'string' }, confirmPublish: { type: 'boolean' } }, required: ['emailId','publishUp','confirmPublish'] },
  },
  {
    name: 'publish_email',
    description: 'Explicitly publish an unpublished email. For segment emails the scheduled broadcast cron may send immediately. Use schedule_email for future sends.',
    inputSchema: { type: 'object', properties: { emailId: { type: 'integer' }, confirmPublish: { type: 'boolean' } }, required: ['emailId','confirmPublish'] },
  },
  {
    name: 'get_email_stats',
    description: 'Get lifetime sent/read counters from the email record',
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'number', description: 'Email ID' },
      },
      required: ['emailId'],
    },
  },

  // NEW Mautic 7 email tools
  {
    name: 'send_email_to_segment',
    description: 'Immediately send an active email to assigned segments; explicit approval required. Broadcast cron may also process active emails.',
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'number', description: 'Email ID (must be an active segment/list email)' },
        confirmSend: { type: 'boolean' },
      },
      required: ['emailId','confirmSend'],
    },
  },
  {
    name: 'record_email_reply',
    description: 'Record an email reply by tracking hash (Mautic 7)',
    inputSchema: {
      type: 'object',
      properties: {
        trackingHash: { type: 'string', description: 'The email tracking hash' },
      },
      required: ['trackingHash'],
    },
  },
  {
    name: 'get_email_graph_stats',
    description: 'Check email graph statistics availability; date-range counts are not supported by this connector',
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'number', description: 'Email ID' },
        isVariant: { type: 'boolean', description: 'Whether this is a variant email' },
        dateFrom: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['emailId', 'dateFrom', 'dateTo'],
    },
  },
];

export const toolHandlers: Record<string, ToolHandler> = {
  async send_email(client: MauticApiClient, args: any) {
    assertExplicit(args.confirmSend);
    const email = await readEmail(client, args.emailId);
    // Require exactly one contact per call so that a later failure cannot conceal partial sends.
    if (!Array.isArray(args.contactIds) || args.contactIds.length !== 1 || !Array.isArray(args.contactEmails) || args.contactEmails.length !== 1)
      invalid('Provide exactly one contact ID and its matching email address per send');
    const result = await sendToContact(client, email, positiveId(args.contactIds[0]), args.contactEmails[0]);
    return { isError: !result.success, content: [{ type: 'text', text: 'Contact send result:\n' + JSON.stringify(result) }] };
  },

  async list_emails(client: MauticApiClient, args: any) {
    const params: any = {};
    if (args?.search) params.search = args.search;
    params.limit = pageLimit(args?.limit, 20);
    if (args?.start) params.start = args.start;
    if (args?.publishedOnly) params.publishedOnly = args.publishedOnly;

    const response = await client.v1.get('/emails', { params });
    return {
      content: [{ type: 'text', text: `Found ${response.data.total} emails:\n${JSON.stringify(Object.fromEntries(Object.entries(response.data.emails ?? {}).map(([id, email]) => [id, emailSummary(email)])))}` }],
    };
  },

  async get_email(client: MauticApiClient, args: any) {
    const { id, includeContent } = args;
    const response = await client.v1.get(`/emails/${id}`);
    return {
      content: [{ type: 'text', text: `Email details:\n${JSON.stringify(includeContent ? { ...emailSummary(response.data.email), customHtml: response.data.email?.customHtml, plainText: response.data.email?.plainText } : emailSummary(response.data.email))}` }],
    };
  },

  async create_email_template(client: MauticApiClient, args: any) {
    const data = payload(args, true);
    await validateAudience(client, data, data);
    const response = await client.v1.post('/emails/new', data);
    return { content: [{ type: 'text', text: 'Email draft created:\n' + JSON.stringify(writeSummary(response.data.email, Object.keys(data))) }] };
  },

  async update_email(client: MauticApiClient, args: any) {
    const email = await readEmail(client, args.id);
    const data = payload(args, false);
    const keys = Object.keys(data);
    if (!keys.length) invalid('No email changes supplied');
    if (email.isPublished !== false && !(keys.length === 1 && data.isPublished === false))
      invalid('Unpublish the email in a separate operation before editing');
    if (!(keys.length === 1 && data.isPublished === false)) {
      await validateAudience(client, email, data);
      const up = data.publishUp === undefined ? email.publishUp : data.publishUp;
      const down = data.publishDown === undefined ? email.publishDown : data.publishDown;
      if (up && down && Date.parse(down) <= Date.parse(up)) invalid('Publication end must be after start');
    }
    const response = await client.v1.patch('/emails/' + email.id + '/edit', data);
    return { content: [{ type: 'text', text: 'Email updated:\n' + JSON.stringify(writeSummary(response.data.email, keys)) }] };
  },

  async clone_email(client: MauticApiClient, args: any) {
    const source = await readEmail(client, args.id);
    const data = clonePayload(source, args.name);
    await validateAudience(client, data, data);
    const response = await client.v1.post('/emails/new', data);
    return { content: [{ type: 'text', text: 'Email draft copied (content/settings only):\n' + JSON.stringify(writeSummary(response.data.email, Object.keys(data))) }] };
  },

  async preview_email_audience(client: MauticApiClient, args: any) {
    const email = await readEmail(client, args.emailId);
    const { lists, excluded } = await validateAudience(client, email);
    const counts = async (listIds: number[]) => {
      const result = [];
      for (const id of listIds) {
        const segment = ((await validateSegments(client, [id]))[0]);
        if (typeof segment.alias !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(segment.alias)) invalid('Unsupported segment alias');
        const total = Number((await client.v1.get('/contacts', { params: { search: 'segment:' + segment.alias, limit: 5, minimal: true } })).data.total);
        if (!Number.isSafeInteger(total) || total < 0) invalid('Invalid contact count returned');
        result.push({ id, name: segment.name, total });
      }
      return result;
    };
    const included = await counts(lists);
    const exclusions = await counts(excluded);
    return { content: [{ type: 'text', text: 'Audience preview:\n' + JSON.stringify({
      emailId: email.id, included, excluded: exclusions,
      maximumMembership: included.reduce((n, s) => n + s.total, 0),
      exactEligibleRecipients: null,
      note: 'Raw membership only; overlaps, exclusions, DNC, invalid addresses and prior sends are not subtracted.'
    }) }] };
  },

  async send_test_email(client: MauticApiClient, args: any) {
    assertExplicit(args.confirmSend);
    const email = await readEmail(client, args.emailId);
    if (email.isPublished !== false) invalid('Test sends require an unpublished draft');
    const result = await sendToContact(client, email, args.contactId, args.recipientEmail);
    return { isError: !result.success, content: [{ type: 'text', text: 'Tracked test send result:\n' + JSON.stringify(result) }] };
  },

  async schedule_email(client: MauticApiClient, args: any) {
    assertExplicit(args.confirmPublish);
    const email = await readEmail(client, args.emailId);
    if (email.emailType !== 'list' || email.isPublished !== false) invalid('Schedule an unpublished segment email only');
    assertNoDncOverride(email);
    assertUnsubscribe(email);
    await validateAudience(client, email);
    const publishUp = parseDate(args.publishUp);
    if (Date.parse(publishUp) <= Date.now()) invalid('Scheduled start must be in the future');
    const publishDown = args.publishDown === undefined ? email.publishDown ?? null : parseDate(args.publishDown);
    if (publishDown && Date.parse(publishDown) <= Date.parse(publishUp)) invalid('Publication end must be after start');
    const data = { publishUp, publishDown, isPublished: true, sendToDnc: false };
    const response = await client.v1.patch('/emails/' + email.id + '/edit', data);
    return { content: [{ type: 'text', text: 'Scheduled email:\n' + JSON.stringify({ ...writeSummary(response.data.email, Object.keys(data)), publishUp, publishDown }) }] };
  },

  async publish_email(client: MauticApiClient, args: any) {
    assertExplicit(args.confirmPublish);
    const email = await readEmail(client, args.emailId);
    if (email.isPublished !== false) invalid('Email must be unpublished');
    assertNoDncOverride(email);
    assertUnsubscribe(email);
    await validateAudience(client, email);
    if (email.publishUp && Date.parse(email.publishUp) > Date.now()) invalid('Use schedule_email for future publication');
    if (email.publishDown && Date.parse(email.publishDown) <= Date.now()) invalid('Publication end is in the past');
    const data = { isPublished: true, sendToDnc: false };
    const response = await client.v1.patch('/emails/' + email.id + '/edit', data);
    return { content: [{ type: 'text', text: 'Email published (segment broadcasts may send automatically):\n' + JSON.stringify(writeSummary(response.data.email, Object.keys(data))) }] };
  },

  async get_email_stats(client: MauticApiClient, args: any) {
    const { emailId } = args;
    const response = await client.v1.get(`/emails/${emailId}`);
    const { sentCount, readCount, variantSentCount, variantReadCount } = response.data.email;
    return {
      content: [{ type: 'text', text: `Email statistics:\n${JSON.stringify({ emailId, sentCount, readCount, variantSentCount, variantReadCount, scope: 'lifetime', recordedReadRate: sentCount > 0 && typeof readCount === 'number' ? Math.round(readCount / sentCount * 10000) / 100 : null })}` }],
    };
  },

  // NEW Mautic 7 handlers
  async send_email_to_segment(client: MauticApiClient, args: any) {
    assertExplicit(args.confirmSend);
    const email = await readEmail(client, args.emailId);
    if (email.emailType !== 'list' || email.isPublished !== true) invalid('An active segment email is required');
    if ((email.publishUp && Date.parse(email.publishUp) > Date.now()) || (email.publishDown && Date.parse(email.publishDown) <= Date.now())) invalid('Email is outside its publication window');
    assertNoDncOverride(email);
    assertUnsubscribe(email);
    await validateAudience(client, email);
    const response = await client.v1.post('/emails/' + email.id + '/send');
    const data = response.data;
    const failed = data.failedRecipients;
    const failedCount = Array.isArray(failed) ? failed.length : failed && typeof failed === 'object' ? Object.keys(failed).length : typeof failed === 'number' ? failed : null;
    return { isError: data.success !== true && data.success !== 1, content: [{ type: 'text', text: 'Segment send result:\n' + JSON.stringify({ emailId: email.id, requestCompleted: true, success: data.success, sentCount: data.sentCount, failedCount }) }] };
  },

  async record_email_reply(client: MauticApiClient, args: any) {
    const { trackingHash } = args;
    const response = await client.v1.post(`/emails/reply/${trackingHash}`);
    return {
      content: [{ type: 'text', text: `Email reply recorded for tracking hash ${trackingHash}:\n${JSON.stringify(mutationSummary(response.data))}` }],
    };
  },

  async get_email_graph_stats(client: MauticApiClient, args: any) {
    return { isError: true, content: [{ type: 'text', text: 'Date-range email graph statistics are not supported by the verified API. Use get_email_stats for lifetime counters.' }] };
  },
};
