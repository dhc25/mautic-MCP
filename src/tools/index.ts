import type { MauticApiClient } from '../api/client.js';
import type { ToolResult } from '../types/index.js';

import * as contacts from './contacts.js';
import * as campaigns from './campaigns.js';
import * as emails from './emails.js';
import * as forms from './forms.js';
import * as segments from './segments.js';
import * as content from './content.js';
import * as business from './business.js';
import * as advanced from './advanced.js';
import * as integration from './integration.js';
import * as projects from './projects.js';

const modules = [
  contacts,
  campaigns,
  emails,
  forms,
  segments,
  content,
  business,
  advanced,
  integration,
  projects,
];

// Explicit allowlist: new tools default to potentially mutating.
const readOnly = new Set([
  'get_contact', 'search_contacts', 'list_segments', 'get_segment_contacts',
  'list_emails', 'get_email', 'get_email_stats', 'get_email_graph_stats', 'preview_email_audience',
  'list_campaigns', 'get_campaign', 'get_campaign_contacts', 'export_campaign',
  'get_campaign_event_details', 'get_campaign_graph_stats', 'get_campaign_map_stats',
  'list_forms', 'get_form', 'get_form_submissions', 'list_assets', 'get_asset',
  'list_pages', 'list_sms', 'list_companies', 'get_contact_notes', 'list_tags',
  'list_categories', 'list_stages', 'list_contact_fields', 'get_contact_activity',
  'list_webhooks', 'list_reports', 'list_projects', 'get_project',
]);
export const allToolDefinitions = modules.flatMap(m => m.toolDefinitions).map(tool => ({
  ...tool, annotations: { readOnlyHint: readOnly.has(tool.name) },
}));
const MAX_RESPONSE_CHARS = 12000;

const allHandlers: Record<string, (client: MauticApiClient, args: any) => Promise<ToolResult>> = {};
for (const mod of modules) {
  Object.assign(allHandlers, mod.toolHandlers);
}

export async function dispatchTool(
  toolName: string,
  client: MauticApiClient,
  args: any,
): Promise<ToolResult> {
  const handler = allHandlers[toolName];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }
  const result = await handler(client, args);
  // Keep full JSON intact; never return a misleading partial JSON record.
  const length = result.content.reduce((n, item) => n + item.text.length, 0);
  if (length <= MAX_RESPONSE_CHARS) return result;
  if (!readOnly.has(toolName) && !result.isError) {
    return { content: [{ type: 'text', text: 'Operation returned successfully, but its response exceeded the output limit. Do not repeat the write; verify using a read tool.' }] };
  }
  return { isError: true, content: [{ type: 'text', text: 'Response exceeded the 12000-character output limit. Narrow the search, reduce the page size, or request fewer fields.' }] };
}
