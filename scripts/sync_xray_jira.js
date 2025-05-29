// ============================
// 🔧 Required Node.js Modules
// ============================
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// =============================
// 🔐 Environment Configuration
// =============================
require('dotenv').config();

// ======================
// 🔁 Constants and Enums
// ======================
const TEST_STATUS = { PASSED: 'PASSED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' };
const BUG_LIFECYCLE = { CREATED: 'OPEN', REOPENED: 'REOPENED', CLOSED: 'CLOSED' };
const LABELS = ['jenkins', 'postman', 'automation', 'TNR'];

// =====================
// 🔍 Regex Definitions
// =====================
const RE_TEST_EXECUTION = /\[(TE-\d+)\]/;
const RE_TEST_SET = /\[(TS-\d+)\]/;
const RE_TEST_CASE = /\[(API\d+-TS\d+-TE\d+)\]/;

// 🔗 Jenkins Pipeline URL for traceability
const JENKINS_PIPELINE_LINK = 'https://your-jenkins-pipeline-link.example.com';

// 🔐 Jira Auth Configuration
const JIRA_AUTH = {
  username: process.env.JIRA_USER,
  password: process.env.JIRA_API_TOKEN
};

// 🌍 Global Xray Access Token
let XRAY_TOKEN = null;

// ==============================
// 🔧 Safe URL builder function
// ==============================
function buildApiUrl(base, path) {
  try {
    return new URL(path, base).toString();
  } catch (err) {
    throw new Error(`Invalid URL: base='${base}', path='${path}'`);
  }
}

function buildRequestUrl(urlObj) {
  if (typeof urlObj === 'string') return urlObj;
  if (!urlObj) return 'undefined';
  const protocol = urlObj.protocol || 'http';
  const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : (urlObj.host || '');
  const pathPart = Array.isArray(urlObj.path) ? urlObj.path.join('/') : (urlObj.path || '');
  const queryParams = urlObj.query && Array.isArray(urlObj.query)
    ? urlObj.query.map(param => `${param.key}=${param.value}`).join('&')
    : '';
  let url = `${protocol}://${host}`;
  if (pathPart) url += `/${pathPart}`;
  if (queryParams) url += `?${queryParams}`;
  return url;
}

function extractParams(urlObj) {
  if (!urlObj?.query || !Array.isArray(urlObj.query)) return 'undefined';
  if (urlObj.query.length === 0) return 'None';
  return urlObj.query.map(param => `${param.key || 'undefined'}=${param.value || 'undefined'}`).join('\n');
}

function extractTestScripts(event) {
  if (!event || !Array.isArray(event)) return 'None';
  const testScripts = event
    .filter(e => e.listen === 'test')
    .flatMap(e => (e.script?.exec || []))
    .join('\n');
  return testScripts || 'None';
}

// ============================
// 🔐 Authenticate to Xray API
// ============================
async function authenticateXray() {
  const authUrl = buildApiUrl(process.env.XRAY_BASE_URL, '/api/v2/authenticate');
  const res = await axios.post(authUrl, {
    client_id: process.env.XRAY_CLIENT_ID,
    client_secret: process.env.XRAY_CLIENT_SECRET
  });
  XRAY_TOKEN = res.data;
}

// =================================================================
// 🔁 Create/Update Xray Test Case and Link to TestSet/TestExecution
// =================================================================
async function createOrUpdateXrayTestCase(key, name, description, labels, testSetKey, testExecutionKey) {
  try {
    const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');
    const sanitizedSummary = `"${name.replace(/[\[\]"]+/g, '').replace(/"/g, '\\"')}"`;
    const jqlQuery = `summary ~ ${sanitizedSummary} AND project = \"${process.env.JIRA_PROJECT_KEY}\" AND issuetype = Test`;

    console.log(`🔍 Searching for existing test case with summary = ${sanitizedSummary}`);

    const searchRes = await axios.get(searchUrl, {
      auth: JIRA_AUTH,
      params: {
        jql: jqlQuery,
        maxResults: 1
      }
    });

    let testCaseKey;
    if (searchRes.data.issues.length > 0) {
      testCaseKey = searchRes.data.issues[0].key;
      console.log(`↩️ Found existing test case: ${testCaseKey}`);
    } else {
      const createUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issue');
      console.log(`📤 Creating new test case: ${name}`);
      const createRes = await axios.post(createUrl, {
        fields: {
          project: { key: process.env.JIRA_PROJECT_KEY },
          summary: name,
          description,
          issuetype: { name: 'Test' },
          labels
        }
      }, { auth: JIRA_AUTH });

      testCaseKey = createRes.data.key;
      console.log(`✅ Created new test case: ${testCaseKey}`);
    }

    // Link to Test Set
    console.log(`🔗 Linking test to Test Set: ${testSetKey}`);
    await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, `/api/v2/testset/${testSetKey}/test`), [testCaseKey], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    // Link to Test Execution
    console.log(`🔗 Linking test to Test Execution: ${testExecutionKey}`);
    await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, `/api/v2/testexecution/${testExecutionKey}/test`), [testCaseKey], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    return testCaseKey;

  } catch (error) {
    console.error(`❌ Failed to sync test case "${name}":`, error.response?.data || error.message);
    throw error;
  }
}

// 🔥 Main Sync Function
async function syncPostmanResults(resultsJsonPath) {
  try {
    const resultsData = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
    const collectionName = resultsData.run?.meta?.collectionName || 'Unnamed Collection';

    const teMatch = collectionName.match(RE_TEST_EXECUTION);
    const tsMatch = collectionName.match(RE_TEST_SET);
    if (!teMatch || !tsMatch) throw new Error('Missing TE-xx or TS-xx in collection name');

    const testExecutionKey = teMatch[1];
    const testSetKey = tsMatch[1];
    console.log(`📦 Syncing: ${collectionName} to TE=${testExecutionKey}, TS=${testSetKey}`);

    await authenticateXray();

    for (const execution of resultsData.run.executions) {
      const request = execution?.requestExecuted || {};
      const event = execution?.tests || [];
      const itemName = request?.name || 'Unnamed Test';

      console.log(`🔍 Processing test: "${itemName}"`);

      const testCaseMatch = itemName.match(RE_TEST_CASE);
      if (!testCaseMatch) {
        console.warn(`⚠️ Skipping test without valid key: ${itemName}`);
        continue;
      }

      const testCaseKeyFromName = testCaseMatch[1];
      const testName = (execution.tests?.[0]?.name || itemName).trim();

      const requestUrl = buildRequestUrl(request.url);
      const method = request.method || 'GET';
      const queryParams = extractParams(request.url);
      const testScripts = extractTestScripts(event);

      const description =
        `Request:\n- URL: ${requestUrl}\n- Method: ${method}\n- Query Params:\n${queryParams}\n\n` +
        `Test Scripts:\n${testScripts}\n\nLinked Jenkins Pipeline: ${JENKINS_PIPELINE_LINK}`;

      const testCaseKey = await createOrUpdateXrayTestCase(
        testCaseKeyFromName, testName, description, LABELS, testSetKey, testExecutionKey
      );

      console.log(`✅ Synced test: ${testName} (${testCaseKey})`);
    }
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
  }
}

// Export for CLI or Jenkins
module.exports = { syncPostmanResults };

// If run directly from CLI
if (require.main === module) {
  const filePath = process.argv[2] || './results.json';
  syncPostmanResults(filePath);
}
