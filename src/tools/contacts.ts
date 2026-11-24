import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { pageLimit, compactContacts, contactSummary, writeSummary } from './safety.js';
import type { MauticApiClient } from '../api/client.js';
import type { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'create_contact',
    description: 'Create a new contact in Mautic',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email address' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        company: { type: 'string', description: 'Company name' },
        position: { type: 'string', description: 'Job position' },
        customFields: { type: 'object', description: 'Custom field values' },
      },
      required: ['email'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Contact ID' },
        email: { type: 'string', description: 'Contact email address' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        company: { type: 'string', description: 'Company name' },
        position: { type: 'string', description: 'Job position' },
        customFields: { type: 'object', description: 'Custom field values' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_contact',
    description: 'Get essential contact details by ID or email; request fields explicitly for more information',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Contact ID' },
        email: { type: 'string', description: 'Contact email address' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Additional field aliases to return (max 20)' },
      },
    },
  },
  {
    name: 'search_contacts',
    description: 'Search contacts with filters and pagination',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term' },
        limit: { type: 'number', description: 'Number of results (max 5)', maximum: 5 },
        start: { type: 'number', description: 'Starting offset for pagination' },
        orderBy: { type: 'string', description: 'Field to order by' },
        orderByDir: { type: 'string', enum: ['ASC', 'DESC'], description: 'Order direction' },
        publishedOnly: { type: 'boolean', description: 'Only published contacts' },
        minimal: { type: 'boolean', description: 'Minimal contact data is always returned in searches' },
      },
    },
  },
  {
    name: 'delete_contact',
    description: 'Delete a contact from Mautic',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Contact ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_contact_to_segment',
    description: 'Add a contact to a specific segment',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'number', description: 'Contact ID' },
        segmentId: { type: 'number', description: 'Segment ID' },
      },
      required: ['contactId', 'segmentId'],
    },
  },
];

export const toolHandlers: Record<string, ToolHandler> = {
  async create_contact(client: MauticApiClient, args: any) {
    const response = await client.v1.post('/contacts/new', args);
    return {
      content: [{ type: 'text', text: `Contact created successfully:\n${JSON.stringify(writeSummary(response.data.contact, Object.keys(args)))}` }],
    };
  },

  async update_contact(client: MauticApiClient, args: any) {
    const { id, ...updateData } = args;
    const response = await client.v1.patch(`/contacts/${id}/edit`, updateData);
    return {
      content: [{ type: 'text', text: `Contact updated successfully:\n${JSON.stringify(writeSummary(response.data.contact, Object.keys(updateData)))}` }],
    };
  },

  async get_contact(client: MauticApiClient, args: any) {
    const { id, email, fields } = args;
    let response;

    if (id) {
      response = await client.v1.get(`/contacts/${id}`);
    } else if (email) {
      const searchResponse = await client.v1.get('/contacts', {
        params: { search: `email:${email}`, limit: 1, minimal: true }
      });
      if (searchResponse.data.total === 0) {
        return { content: [{ type: 'text', text: `No contact found with email: ${email}` }] };
      }
      const contactId = Object.keys(searchResponse.data.contacts)[0];
      response = await client.v1.get(`/contacts/${contactId}`);
    } else {
      throw new McpError(ErrorCode.InvalidParams, 'Either id or email must be provided');
    }

    const contact = response.data.contact;
    const extra = Object.fromEntries((Array.isArray(fields) ? fields.slice(0, 20) : []).filter((f: unknown) => typeof f === 'string').map((f: string) => {
      const raw = contact?.fields?.all?.[f] ?? contact?.[f];
      return [f, raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw];
    }));
    return {
      content: [{ type: 'text', text: `Contact details:\n${JSON.stringify({ ...contactSummary(contact), additionalFields: extra })}` }],
    };
  },

  async search_contacts(client: MauticApiClient, args: any) {
    const params: any = {};
    if (args?.search) params.search = args.search;
    params.limit = pageLimit(args?.limit);
    if (args?.start) params.start = args.start;
    if (args?.orderBy) params.orderBy = args.orderBy;
    if (args?.orderByDir) params.orderByDir = args.orderByDir;
    if (args?.publishedOnly) params.publishedOnly = args.publishedOnly;
    params.minimal = true;

    const response = await client.v1.get('/contacts', { params });
    return {
      content: [{ type: 'text', text: `Found ${response.data.total} contacts:\n${JSON.stringify(compactContacts(response.data.contacts))}` }],
    };
  },

  async delete_contact(client: MauticApiClient, args: any) {
    const { id } = args;
    await client.v1.delete(`/contacts/${id}/delete`);
    return { content: [{ type: 'text', text: `Contact ${id} deleted successfully` }] };
  },

  async add_contact_to_segment(client: MauticApiClient, args: any) {
    const { contactId, segmentId } = args;
    await client.v1.post(`/segments/${segmentId}/contact/${contactId}/add`);
    return {
      content: [{ type: 'text', text: `Contact ${contactId} added to segment ${segmentId} successfully` }],
    };
  },
};
