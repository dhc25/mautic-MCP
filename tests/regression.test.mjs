import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSegmentFilters, pageLimit, contactSummary } from '../build/tools/safety.js';
import { dispatchTool, allToolDefinitions } from '../build/tools/index.js';

const workingFilters = [
  { glue: 'and', field: 'lead_email_sent', object: 'behaviors', type: 'lead_email_received', operator: 'in', properties: { filter: [24] } },
  { glue: 'and', field: 'lead_email_received', object: 'behaviors', type: 'lead_email_received', operator: '!in', properties: { filter: [24] } },
  { glue: 'and', field: 'leadlist', object: 'lead', type: 'leadlist', operator: '!in', properties: { filter: [6, 7, 5] } },
  { glue: 'and', field: 'email', object: 'lead', type: 'email', operator: '!empty', properties: { filter: null, display: null } },
];
const brokenFilters = workingFilters.map((f, i) => i < 3 ? { ...f, object: 'lead', type: 'multiselect' } : f);
const client = (v1) => ({ v1 });
const resultData = (r) => JSON.parse(r.content[0].text.split('\n').slice(1).join('\n'));

test('normalize broken metadata to native Mautic segment 22 schema', () => {
  assert.deepEqual(normalizeSegmentFilters(brokenFilters), workingFilters);
  assert.deepEqual(normalizeSegmentFilters(workingFilters), workingFilters);
  assert.equal(brokenFilters[0].type, 'multiselect');
});
test('reject invalid IDs, missing metadata, unsupported operators and malformed glue', () => {
  for (const filter of [
    { ...workingFilters[0], properties: { filter: [] } },
    { ...workingFilters[0], properties: { filter: [null] } },
    { ...workingFilters[0], properties: { filter: [true] } },
    { ...workingFilters[0], operator: 'eq' },
    { ...workingFilters[0], glue: 'xor' },
    { field: 'unknown', operator: 'in' },
  ]) assert.throws(() => normalizeSegmentFilters([filter]));
});
test('create segment posts corrected filters and compact acknowledgement', async () => {
  const r = await dispatchTool('create_segment', client({
    post: async (url, data) => {
      assert.equal(url, '/segments/new');
      assert.deepEqual(data.filters, workingFilters);
      return { data: { list: { id: 100, filters: data.filters } } };
    },
  }), { name: 'test', filters: brokenFilters });
  assert.deepEqual(resultData(r), { success: true, id: 100, changedFields: ['name', 'filters'] });
});
test('invalid segment never invokes API', async () => {
  await assert.rejects(dispatchTool('create_segment', client({ post: () => assert.fail('API invoked') }), {
    name: 'invalid', filters: [{ ...workingFilters[0], properties: { filter: [] } }],
  }));
});
test('segment lookup uses alias contact search with capped pages', async () => {
  const calls = [];
  const r = await dispatchTool('get_segment_contacts', client({
    get: async (url, config) => {
      calls.push([url, config]);
      return url === '/segments/22'
        ? { data: { list: { id: 22, alias: 'bf-non-openers-rebuild' } } }
        : { data: { total: 1093, contacts: { 1: { id: 1, fields: { all: { email: 'example@example.invalid' } } } } } };
    },
  }), { segmentId: 22, limit: 200, start: 10 });
  assert.deepEqual(calls, [['/segments/22', undefined], ['/contacts', { params: { search: 'segment:bf-non-openers-rebuild', limit: 5, start: 10, minimal: true } }]]);
  assert.match(r.content[0].text, /1093/);
  assert.equal(resultData(r)['1'].email, 'example@example.invalid');
});
test('contact search is minimal by default and hard capped', async () => {
  assert.equal(pageLimit(undefined), 5);
  assert.equal(pageLimit(200), 5);
  assert.throws(() => pageLimit(-1));
  const r = await dispatchTool('search_contacts', client({
    get: async (url, { params }) => {
      assert.equal(url, '/contacts');
      assert.equal(params.minimal, true);
      assert.equal(params.limit, 5);
      return { data: { total: 1, contacts: { 1: { id: 1, fields: { core: { email: { value: 'test@example.invalid', label: 'Email' } } }, history: 'private' } } } };
    },
  }), { limit: 200, minimal: false });
  assert.equal(resultData(r)['1'].email, 'test@example.invalid');
  assert.doesNotMatch(r.content[0].text, /private|label|history/);
  assert.equal(contactSummary({ fields: { all: { firstname: 'Test' } } }).firstname, 'Test');
});
test('lifetime email stats use email record and never return HTML', async () => {
  const r = await dispatchTool('get_email_stats', client({
    get: async url => {
      assert.equal(url, '/emails/24');
      return { data: { email: { sentCount: 1855, readCount: 762, customHtml: 'large' } } };
    },
  }), { emailId: 24 });
  assert.deepEqual(resultData(r), { emailId: 24, sentCount: 1855, readCount: 762, scope: 'lifetime' });
});
test('tool annotations and response cap', async () => {
  assert.equal(allToolDefinitions.find(t => t.name === 'get_segment_contacts').annotations.readOnlyHint, true);
  assert.equal(allToolDefinitions.find(t => t.name === 'create_segment').annotations.readOnlyHint, false);
  const r = await dispatchTool('get_email', client({ get: async () => ({ data: { email: { id: 1, customHtml: 'x'.repeat(13000) } } }) }), { id: 1, includeContent: true });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /output limit/);
});

test('company mutation returns identifiers and not full records', async () => {
  const r = await dispatchTool('create_company', client({
    post: async () => ({ data: { company: { id: 17, name: 'Example', address: 'private address', nested: { field: 'private' } } } }),
  }), { companyname: 'Example' });
  assert.deepEqual(resultData(r), { id: 17, requestCompleted: true });
});
test('email mutation retains reported failures and counts without echoing contacts', async () => {
  const r = await dispatchTool('send_email_to_segment', client({
    post: async () => ({ data: { success: false, sent: 4, failed: 1, errors: [{ message: 'Delivery failed' }], contacts: [{ email: 'private@example.invalid' }] } }),
  }), { emailId: 24 });
  assert.deepEqual(resultData(r), { success: false, sent: 4, failed: 1, errors: ['Delivery failed'], requestCompleted: true });
  assert.doesNotMatch(r.content[0].text, /private@example/);
});
