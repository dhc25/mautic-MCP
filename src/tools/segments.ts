import { normalizeSegmentFilters, pageLimit, compactContacts, writeSummary } from './safety.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { MauticApiClient } from '../api/client.js';
import type { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'list_segments',
    description: 'Get all contact segments',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term' },
        limit: { type: 'number', description: 'Number of results', maximum: 200 },
        start: { type: 'number', description: 'Starting offset' },
        publishedOnly: { type: 'boolean', description: 'Only published segments' },
      },
    },
  },
  {
    name: 'create_segment',
    description: 'Create a new contact segment',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Segment name' },
        alias: { type: 'string', description: 'Segment alias' },
        description: { type: 'string', description: 'Segment description' },
        isPublished: { type: 'boolean', description: 'Publish immediately' },
        isGlobal: { type: 'boolean', description: 'Global segment' },
        filters: { type: 'array', description: 'Native Mautic filters: field, operator, glue, properties.filter; known email and membership metadata is normalized. Other fields require native object/type.', items: { type: 'object' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_segment_contacts',
    description: 'Get contacts in a specific segment',
    inputSchema: {
      type: 'object',
      properties: {
        segmentId: { type: 'number', description: 'Segment ID' },
        limit: { type: 'number', description: 'Number of contacts (max 5)', maximum: 5 },
        start: { type: 'number', description: 'Starting offset' },
      },
      required: ['segmentId'],
    },
  },
];

export const toolHandlers: Record<string, ToolHandler> = {
  async list_segments(client: MauticApiClient, args: any) {
    const params: any = {};
    if (args?.search) params.search = args.search;
    if (args?.limit) params.limit = Math.min(args.limit, 200);
    if (args?.start) params.start = args.start;
    if (args?.publishedOnly) params.publishedOnly = args.publishedOnly;

    const response = await client.v1.get('/segments', { params });
    return {
      content: [{ type: 'text', text: `Found ${response.data.total} segments:\n${JSON.stringify(response.data.lists, null, 2)}` }],
    };
  },

  async create_segment(client: MauticApiClient, args: any) {
    const payload = { ...args };
    if (args.filters !== undefined) payload.filters = normalizeSegmentFilters(args.filters);
    const response = await client.v1.post('/segments/new', payload);
    return {
      content: [{ type: 'text', text: `Segment created successfully:\n${JSON.stringify(writeSummary(response.data.list, Object.keys(payload)))}` }],
    };
  },

  async get_segment_contacts(client: MauticApiClient, args: any) {
    const { segmentId, limit, start } = args;
    if (!Number.isSafeInteger(segmentId) || segmentId < 1) throw new McpError(ErrorCode.InvalidParams, 'Invalid segment ID');
    const segment = (await client.v1.get(`/segments/${segmentId}`)).data.list;
    if (typeof segment?.alias !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(segment.alias)) {
      throw new McpError(ErrorCode.InvalidParams, 'Segment alias missing or unsupported for contact search');
    }
    const params = { search: `segment:${segment.alias}`, limit: pageLimit(limit), start: start ?? 0, minimal: true };
    const response = await client.v1.get('/contacts', { params });
    return {
      content: [{ type: 'text', text: `Found ${response.data.total} contacts in segment:\n${JSON.stringify(compactContacts(response.data.contacts))}` }],
    };
  },
};
