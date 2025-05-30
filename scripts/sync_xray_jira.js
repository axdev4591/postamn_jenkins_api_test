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
    await linkTestToTestSet(testCaseKey, testSetKey);

    // Link to Test Execution
    await linkTestToTestExecution(testCaseKey, testExecutionKey);


    return testCaseKey;

  } catch (error) {
    console.error(`❌ Failed to sync test case "${name}":`, error.response?.data || error.message);
    throw error;
  }
}

// ==============================
// 📎 Description of test as ADF
// ============================== 
function formatToADF(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: text || ""
          }
        ]
      }
    ]
  };
}

// ============================
// 📎 Link test to test execution
// ============================
async function linkTestToTestExecution(testIssueKey, testExecutionKey) {
  try {
    const token = await getXrayAuthToken(); // ✅ Xray Bearer Token

    const response = await axios.post(
      `${XRAY_BASE_URL}/api/v2/testexecution/${testExecutionKey}/test`,
      {
        add: [testIssueKey],
      },
      {
        headers: {
          Authorization: `Bearer ${token}`, // ✅ Bearer token
          'Content-Type': 'application/json',
        },
      }
    );


    console.log(`🔗 Linked test to Test Execution: ${testExecutionKey}`);
  } catch (error) {
    console.error(`❌ Failed to link test ${testIssueKey} to Test Execution ${testExecutionKey}:`, error.response?.data || error.message);
  }
}

// ============================
// 📎 Link test to test set
// ============================
async function linkTestToTestSet(testKey, testSetKey) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issueLink`;

  const payload = {
    type: {
      name: "Test" // Use appropriate link type name for Test Sets in your config
    },
    inwardIssue: {
      key: testSetKey
    },
    outwardIssue: {
      key: testKey
    }
  };

  try {
    const response = await axios.post(url, payload, {
      auth: {
        username: process.env.JIRA_USER,
        password: process.env.JIRA_API_TOKEN
      },
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log(`🔗 Linked test ${testKey} to Test Set ${testSetKey}`);
  } catch (error) {
    console.error(`❌ Failed to link test ${testKey} to Test Set ${testSetKey}:`, error.response?.data || error.message);
  }
}

// ===============================
// ⚙️ Jira Workflow Transitions Map
// ===============================
const workflowMap = {};

// ================================
// 🔄 Fetch Jira Workflow Transitions
// ================================
async function fetchJiraWorkflowTransitions(issueKeyExample) {
  try {
    const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${issueKeyExample}/transitions`;
    const res = await axios.get(url, {
      auth: {
        username: process.env.JIRA_USER,
        password: process.env.JIRA_API_TOKEN,
      }
    });

    for (const key in workflowMap) delete workflowMap[key];

    for (const transition of res.data.transitions) {
      const name = transition.name.toUpperCase();
      if (name.includes('OPEN')) workflowMap.OPEN = transition.id;
      else if (name.includes('REOPEN')) workflowMap.REOPENED = transition.id;
      else if (name.includes('CLOSE')) workflowMap.CLOSED = transition.id;
    }

    console.log('🔄 Fetched Jira workflow transitions:', workflowMap);
  } catch (error) {
    console.error('❌ Error fetching Jira workflow transitions:', error.response?.data || error.message);
    throw error;
  }
}

// ================================
// 🔄 Update Jira Bug Status Function
// ================================
async function updateJiraBugStatus(issueKey, status) {
  if (!workflowMap[status]) {
    throw new Error(`No workflow transition ID found for status: ${status}`);
  }
  const transitionId = workflowMap[status];
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/transitions`;

  try {
    await axios.post(url, {
      transition: { id: transitionId }
    }, {
      auth: {
        username: process.env.JIRA_USER,
        password: process.env.JIRA_API_TOKEN
      }
    });
    console.log(`✅ Bug ${issueKey} transitioned to ${status} (ID: ${transitionId})`);
  } catch (error) {
    console.error(`❌ Failed to update bug ${issueKey} status to ${status}:`, error.response?.data || error.message);
  }
}

// =================================
// 📎 List all Jira Issue Link Types
// ==================================
async function listIssueLinkTypes() {
  try {
    const url = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issueLinkType');
    const response = await axios.get(url, {
      auth: JIRA_AUTH,
      headers: {
        'Content-Type': 'application/json',
      }
    });
    console.log('🔗 Jira Issue Link Types:', response.data.issueLinkTypes);
    return response.data.issueLinkTypes;
  } catch (error) {
    console.error('❌ Failed to fetch Jira issue link types:', error.response?.data || error.message);
    throw error;
  }
}

// ===============================
// 📎 Link bug to its test case
// ================================
async function linkBugToTestCase(bugKey, testKey) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issueLink`;
  const payload = {
    type: { name: "Relates" },
    inwardIssue: { key: bugKey },
    outwardIssue: { key: testKey }
  };

  await axios.post(url, payload, {
    auth: JIRA_AUTH,
    headers: { 'Content-Type': 'application/json' }
  });

  console.log(`🔗 Linked bug ${bugKey} to test case ${testKey}`);
}


// =============================================
// 📎 Create or Update Bug base on test status
// =============================================
async function createOrUpdateBugForTest(testKey, testName, description) {
  const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');
  const jql = `project = ${process.env.JIRA_PROJECT_KEY} AND issuetype = ${process.env.BUG_ISSUE_TYPE} AND "Test Case" = ${testKey}`;

  const result = await axios.get(searchUrl, {
    auth: JIRA_AUTH,
    params: { jql, maxResults: 1 }
  });

  if (result.data.issues.length > 0) {
    return result.data.issues[0].key;
  }

  const createUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issue');
  const res = await axios.post(createUrl, {
    fields: {
      project: { key: process.env.JIRA_PROJECT_KEY },
      summary: `❌ Failed Test: ${testName}`,
      description,
      issuetype: { name: process.env.BUG_ISSUE_TYPE },
      labels: ['postman', 'automation'],
      // You may need to customize this field based on your Jira config
      // "customfield_XXXXX": testKey // Link test case to bug (custom field or use linking)
    }
  }, { auth: JIRA_AUTH });

  return res.data.key;
}

// =============================================
// 📎 Find existing bug for a specific test
// =============================================
async function findExistingBugForTest(testKey) {
  const jql = `project = ${process.env.JIRA_PROJECT_KEY} AND issuetype = ${process.env.BUG_ISSUE_TYPE} AND "Test Case" = ${testKey}`;
  const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');

  const res = await axios.get(searchUrl, {
    auth: JIRA_AUTH,
    params: { jql, maxResults: 1 }
  });

  if (res.data.issues.length > 0) {
    return res.data.issues[0].key;
  }

  return null;
}

// ============================
// 🔥 Main Sync Function
// ============================
async function syncPostmanResults(resultsJsonPath) {
  try {
    const exampleBugIssueKey = `${process.env.JIRA_PROJECT_KEY}-4`;
    await fetchJiraWorkflowTransitions(exampleBugIssueKey);
    await listIssueLinkTypes();

    const resultsData = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
    const collectionName = resultsData.run?.meta?.collectionName || 'Unnamed Collection';

    const teMatch = collectionName.match(RE_TEST_EXECUTION);
    const tsMatch = collectionName.match(RE_TEST_SET);
    if (!teMatch || !tsMatch) throw new Error('Missing TE-xx or TS-xx in collection name');

    const testExecutionKey = teMatch[1];
    const testSetKey = tsMatch[1];

    console.log(`🔎 Test Execution Key: ${testExecutionKey}`);
    console.log(`🔎 Test Set Key: ${testSetKey}`);

    await authenticateXray();

    for (const exec of resultsData.run.executions) {
      const testName = exec.requestExecuted?.name || 'Unnamed Test';
      const testCaseMatch = testName.match(RE_TEST_CASE);
      if (!testCaseMatch) {
        console.warn(`⚠️ Skipping test without proper test case key format: ${testName}`);
        continue;
      }
      const testCaseKey = testCaseMatch[1];

      const tests = Array.isArray(exec.tests) ? exec.tests : [];
      const status = tests.every(test => test.status === 'passed') ? TEST_STATUS.PASSED : TEST_STATUS.FAILED;
      const description = formatToADF(exec.requestExecuted?.description || '');

      const jiraTestKey = await createOrUpdateXrayTestCase(
        testCaseKey,
        testName,
        description,
        LABELS,
        testSetKey,
        testExecutionKey
      );

      if (status === TEST_STATUS.FAILED) {
        const bugKey = await createOrUpdateBugForTest(jiraTestKey, testName, description);
        await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.REOPENED);
        await linkBugToTestCase(bugKey, jiraTestKey);
      } else if (status === TEST_STATUS.PASSED) {
        const bugKey = await findExistingBugForTest(jiraTestKey);
        if (bugKey) {
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CLOSED);
        }
      }

    }

    console.log('🎉 Sync complete');

  } catch (error) {
    console.error('❌ Sync failed:', error.message);
  }
}


// =======================
// 🚀 CLI Entry Point
// =======================
if (require.main === module) {
  const resultsJsonPath = process.argv[2];
  if (!resultsJsonPath) {
    console.error('Usage: node sync.js <postman_results.json>');
    process.exit(1);
  }
  syncPostmanResults(resultsJsonPath);
}
