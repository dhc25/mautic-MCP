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
  assert.deepEqual(resultData(r), { emailId: 24, sentCount: 1855, readCount: 762, scope: 'lifetime', recordedReadRate: 41.08 });
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

const draft = { id: 24, name: 'Test', subject: 'Subject', language: 'en', emailType: 'list', lists: [{id: 22}], excludedLists: [], sendToDnc: false, isPublished: false, customHtml: '<a href="{unsubscribe_url}">Unsubscribe</a>', publishUp: null, publishDown: null };
const segment = {id: 22, name: 'Test audience', alias: 'test-audience', isPublished: true};
const fake = (email = draft, extra = {}) => client({
  get: async (url, config) => {
    if (url === '/emails/24') return {data: {email}};
    if (url === '/segments/22') return {data: {list: segment}};
    if (url === '/contacts') {
      assert.equal(config.params.search, 'segment:test-audience');
      assert.equal(config.params.limit, 5);
      assert.equal(config.params.minimal, true);
      return {data: {total: 123, contacts: {}}};
    }
    if (url === '/contacts/42') return {data: {contact: {id: 42, fields: {all: {email: 'test@example.invalid'}}}}};
    assert.fail('Unexpected GET ' + url);
  },
  post: async () => assert.fail('Unexpected POST'),
  patch: async () => assert.fail('Unexpected PATCH'),
  ...extra
});
test('creates unpublished segment email with native list IDs and metadata', async () => {
  const r = await dispatchTool('create_email_template', fake(draft, {post: async (url, body) => {
    assert.equal(url, '/emails/new');
    assert.equal(body.isPublished, false);
    assert.equal(body.sendToDnc, false);
    assert.deepEqual(body.lists, [22]);
    assert.equal(body.language, 'en');
    assert.equal(body.preheaderText, 'Preview');
    assert.equal(body.utmTags.utmCampaign, 'test');
    assert.deepEqual(body.assetAttachments, [3]);
    return {data: {email: {id: 99, customHtml: 'private body'}}};
  }}), {name: 'Draft', subject: 'Subject', emailType: 'list', lists: [22,22], preheaderText: 'Preview', utmTags: {utmCampaign: 'test'}, assetAttachments: [3]});
  assert.equal(resultData(r).id, 99);
  assert.doesNotMatch(r.content[0].text, /private body/);
});
test('rejects missing recipients, DNC override and implicit publishing', async () => {
  for (const options of [{emailType: 'list'}, {sendToDnc: true}, {isPublished: true}, {emailType: 'list', lists: [0]}])
    await assert.rejects(dispatchTool('create_email_template', fake(), {name:'Draft', subject:'Subject', ...options}));
});
test('PATCH draft without replacing omitted fields; active edit rejected', async () => {
  await dispatchTool('update_email', fake(draft, {patch: async (url, data) => {
    assert.equal(url, '/emails/24/edit');
    assert.deepEqual(data, {subject: 'New subject'});
    return {data: {email: {id: 24}}};
  }}), {id:24, subject:'New subject'});
  await assert.rejects(dispatchTool('update_email', fake({...draft,isPublished:true}), {id:24, subject:'New subject'}));
});
test('clone strips schedule and publication, copies audience and content', async () => {
  await dispatchTool('clone_email', fake({...draft, isPublished:true, sentCount:99, publishUp:'2026-01-01T00:00:00Z'}, {post: async (url, data) => {
    assert.equal(url, '/emails/new'); assert.equal(data.isPublished,false);
    assert.deepEqual(data.lists,[22]); assert.equal(data.customHtml,draft.customHtml);
    assert.equal(data.publishUp,undefined); assert.equal(data.sentCount,undefined);
    return {data:{email:{id:99}}};
  }}), {id:24,name:'Copy'});
});
test('audience preview shows membership not eligible recipients', async () => {
  const r = await dispatchTool('preview_email_audience', fake(), {emailId:24});
  assert.equal(resultData(r).maximumMembership,123);
  assert.equal(resultData(r).exactEligibleRecipients,null);
  assert.equal(allToolDefinitions.find(t => t.name === 'preview_email_audience').annotations.readOnlyHint,true);
});
test('test send requires confirmation, draft, matching contact and DNC safety', async () => {
  const args = {emailId:24,contactId:42,recipientEmail:'test@example.invalid',confirmSend:true};
  for (const [email,input] of [[draft,{...args,confirmSend:false}],[draft,{...args,recipientEmail:'wrong@example.invalid'}],[{...draft,sendToDnc:true},args],[{...draft,isPublished:true},args]])
    await assert.rejects(dispatchTool('send_test_email', fake(email), input));
  const r = await dispatchTool('send_test_email', fake(draft, {post:async (url,data) => {
    assert.equal(url,'/emails/24/contact/42/send');assert.deepEqual(data,{});
    return {data:{success:true}};
  }}), args);
  assert.equal(resultData(r).success,true);
});
test('schedule validates timezone and future start, confirmation, unsubscribe and DNC', async () => {
  const future = '2099-01-01T09:00:00+01:00';
  const args = {emailId:24,publishUp:future,confirmPublish:true};
  for (const [email,input] of [[draft,{...args,confirmPublish:false}],[draft,{...args,publishUp:'2099-01-01T09:00'}],[draft,{...args,publishUp:'2000-01-01T09:00:00Z'}],[{...draft,customHtml:'No link'},args],[{...draft,sendToDnc:true},args]])
    await assert.rejects(dispatchTool('schedule_email', fake(email), input));
  await dispatchTool('schedule_email', fake(draft,{patch:async (url,data) => {
    assert.equal(url,'/emails/24/edit');assert.equal(data.publishUp,'2099-01-01T08:00:00.000Z');
    assert.equal(data.isPublished,true);assert.equal(data.sendToDnc,false);
    return {data:{email:{id:24}}};
  }}), args);
});
test('segment send requires explicit approval and reports failure counts without addresses', async () => {
  const active = {...draft,isPublished:true};
  await assert.rejects(dispatchTool('send_email_to_segment',fake(active),{emailId:24}));
  const r = await dispatchTool('send_email_to_segment',fake(active,{post:async url => {
    assert.equal(url,'/emails/24/send');
    return {data:{success:1,sentCount:4,failedRecipients:['private@example.invalid']}};
  }}),{emailId:24,confirmSend:true});
  assert.equal(resultData(r).sentCount,4);
  assert.equal(resultData(r).failedCount,1);
  assert.doesNotMatch(r.content[0].text,/private@example/);
});
test('publish email requires explicit approval and rejects unsafe content', async () => {
  await assert.rejects(dispatchTool('publish_email',fake(),{emailId:24}));
  await assert.rejects(dispatchTool('publish_email',fake({...draft,customHtml:'No link'}),{emailId:24,confirmPublish:true}));
  await dispatchTool('publish_email',fake(draft,{patch:async (url,data) => {
    assert.equal(url,'/emails/24/edit'); assert.deepEqual(data,{isPublished:true,sendToDnc:false});
    return {data:{email:{id:24}}};
  }}),{emailId:24,confirmPublish:true});
});
