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
  return new URL(path, base).toString();
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
    const sanitizedSummary = name.replace(/[\[\]]/g, '');

    const searchRes = await axios.get(searchUrl, {
      auth: JIRA_AUTH,
      params: {
        jql: `summary ~ "\"${sanitizedSummary}\"" AND project = "${process.env.JIRA_PROJECT_KEY}" AND issuetype = Test`,
        maxResults: 1
      }
    });


    let testCaseKey;
    if (searchRes.data.issues.length > 0) {
      testCaseKey = searchRes.data.issues[0].key;
    } else {
      const createUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issue');
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
    }

    // Link to Test Set
    await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, `/api/v2/testset/${testSetKey}/test`), [testCaseKey], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    // Link to Test Execution
    await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, `/api/v2/testexecution/${testExecutionKey}/test`), [testCaseKey], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    return testCaseKey;

  } catch (error) {
    console.error(`❌ Failed to sync test case "${name}":`, error.response?.data || error.message);
    throw error;
  }
}

// =============================================
// 🐞 Create or Update Bug Based on Test Status
// =============================================
async function syncBugForTest(testKey, testName, status) {
  try {
    const jql = `summary ~ "[Bug] ${testKey}" AND project = "${process.env.JIRA_PROJECT_KEY}" AND issuetype = "${process.env.BUG_ISSUE_TYPE}"`;
    const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');

    const res = await axios.get(searchUrl, {
      auth: JIRA_AUTH,
      params: { jql, maxResults: 1 }
    });

    let bugKey = null;
    const existing = res.data.issues?.[0];

    if (status === TEST_STATUS.FAILED) {
      if (existing) {
        bugKey = existing.key;
        if (existing.fields.status.name === BUG_LIFECYCLE.CLOSED) {
          await transitionJiraIssue(bugKey, BUG_LIFECYCLE.REOPENED);
        }
      } else {
        const createUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issue');
        const bugSummary = `[Bug] ${testKey}`;
        const bugDesc = `Bug from failed test ${testKey}: ${testName}\n\nLinked Test: ${testKey}`;
        const bug = await axios.post(createUrl, {
          fields: {
            project: { key: process.env.JIRA_PROJECT_KEY },
            summary: bugSummary,
            description: bugDesc,
            issuetype: { name: process.env.BUG_ISSUE_TYPE },
            labels: LABELS
          }
        }, { auth: JIRA_AUTH });
        bugKey = bug.data.key;
      }

      // Link bug to test case
      await linkJiraIssues(testKey, bugKey);
    }

    if (status === TEST_STATUS.PASSED && existing) {
      const isOpen = existing.fields.status.name !== BUG_LIFECYCLE.CLOSED;
      if (isOpen) {
        await transitionJiraIssue(existing.key, BUG_LIFECYCLE.CLOSED);
      }
    }

  } catch (err) {
    console.error(`❌ Failed to sync bug for test ${testKey}:`, err.response?.data || err.message);
  }
}

// 🔁 Transition Jira Issue by Status Name
async function transitionJiraIssue(issueKey, targetStatus) {
  const transitionsUrl = buildApiUrl(process.env.JIRA_BASE_URL, `/rest/api/3/issue/${issueKey}/transitions`);
  const { data } = await axios.get(transitionsUrl, { auth: JIRA_AUTH });
  const transition = data.transitions.find(t => t.to.name.toUpperCase() === targetStatus);
  if (!transition) return console.warn(`⚠️ No transition to ${targetStatus} found for ${issueKey}`);
  await axios.post(transitionsUrl, { transition: { id: transition.id } }, { auth: JIRA_AUTH });
  console.log(`🔁 Transitioned ${issueKey} to ${targetStatus}`);
}

// 🔗 Link two Jira Issues (e.g., bug ↔ test)
async function linkJiraIssues(issueA, issueB) {
  const url = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issueLink');
  await axios.post(url, {
    type: { name: 'Relates' },
    inwardIssue: { key: issueA },
    outwardIssue: { key: issueB }
  }, { auth: JIRA_AUTH });
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

    await authenticateXray();

    for (const execution of resultsData.run.executions) {
      const request = execution?.requestExecuted || {};
      const event = execution?.events || [];
      const itemName = request?.name || 'Unnamed Test';

      const testCaseMatch = itemName.match(RE_TEST_CASE);
      if (!testCaseMatch) {
        console.warn(`⚠️ Skipping test without valid key: ${itemName}`);
        continue;
      }

      const testKey = testCaseMatch[1];
      const testName = (execution.assertions?.[0]?.assertion || itemName).trim();

      const requestUrl = buildRequestUrl(request.url);
      const method = request.method || 'GET';
      const queryParams = extractParams(request.url);
      const testScripts = extractTestScripts(event);
      const description =
        `Request:\n- URL: ${requestUrl}\n- Method: ${method}\n- Query Params:\n${queryParams}\n\n` +
        `Test Scripts:\n${testScripts}\n\nLinked Jenkins Pipeline: ${JENKINS_PIPELINE_LINK}`;

      const testStatus = execution.assertions?.some(a => !a.error) ? TEST_STATUS.PASSED : TEST_STATUS.FAILED;

      const testCaseKey = await createOrUpdateXrayTestCase(
        testKey, testName, description, LABELS, testSetKey, testExecutionKey
      );

      // Upload execution result
      await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, '/api/v2/import/execution'), {
        testExecutionKey,
        tests: [{ testKey: testCaseKey, status: testStatus }]
      }, {
        headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
      });

      // Sync related bug
      await syncBugForTest(testCaseKey, testName, testStatus);

      console.log(`✅ Synced test: ${testName} (${testCaseKey}) as ${testStatus}`);
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
