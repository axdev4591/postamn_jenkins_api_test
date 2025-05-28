// ============================
// 🔧 Required Node.js Modules
// ============================
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// =============================
// 🔐 Environment Configuration
// =============================
require('dotenv').config(); // Optional: load .env if running locally

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

// 🔗 Jenkins Pipeline URL for traceability in test and bug descriptions
const JENKINS_PIPELINE_LINK = 'https://your-jenkins-pipeline-link.example.com';

// 🔐 Jira Auth Configuration
const JIRA_AUTH = {
  username: process.env.JIRA_USER,
  password: process.env.JIRA_API_TOKEN
};

// 🌍 Global Xray Access Token
let XRAY_TOKEN = null;

// ============================
// 🔐 Authenticate to Xray API
// ============================
async function authenticateXray() {
  const res = await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/authenticate`, {
    client_id: process.env.XRAY_CLIENT_ID,
    client_secret: process.env.XRAY_CLIENT_SECRET
  });
  XRAY_TOKEN = res.data;
}

// =================================================================
// 🔁 Create/Update Xray Test Case and Link to TestSet/TestExecution
// =================================================================
async function createOrUpdateXrayTestCase(key, name, description, labels, testSetKey, testExecutionKey) {
  console.log(`🔁 Syncing Xray test case ${key}...`);

  const response = await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/import/test`, {
    testType: 'Manual',
    testKey: key,
    projectKey: process.env.JIRA_PROJECT_KEY,
    summary: name,
    description,
    labels
  }, {
    headers: {
      Authorization: `Bearer ${XRAY_TOKEN}`
    }
  });

  const testCaseId = response.data.key;

  await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/testset/${testSetKey}/test`, [testCaseId], {
    headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
  });

  await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/testexecution/${testExecutionKey}/test`, [testCaseId], {
    headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
  });

  console.log(`✅ Test Case ${testCaseId} linked to [${testSetKey}] and [${testExecutionKey}]`);
}

// =====================================================
// 🐞 Create or Update Jira Bug Linked to a Test Case
// =====================================================
async function createOrUpdateJiraBug(testCaseKey, summary, description, labels) {
  console.log(`🐞 Checking if bug exists for test case ${testCaseKey}...`);

  const search = await axios.get(`${process.env.JIRA_BASE_URL}/rest/api/3/search`, {
    auth: JIRA_AUTH,
    params: {
      jql: `summary ~ "${summary}" AND project = "${process.env.JIRA_PROJECT_KEY}"`,
      maxResults: 1
    }
  });

  if (search.data.issues.length > 0) {
    console.log(`↩️ Bug already exists: ${search.data.issues[0].key}`);
    return search.data.issues[0].key;
  }

  const res = await axios.post(`${process.env.JIRA_BASE_URL}/rest/api/3/issue`, {
    fields: {
      project: { key: process.env.JIRA_PROJECT_KEY },
      summary,
      description,
      issuetype: { name: process.env.BUG_ISSUE_TYPE },
      labels
    }
  }, {
    auth: JIRA_AUTH
  });

  const bugKey = res.data.key;
  console.log(`✅ Created new bug: ${bugKey}`);

  return bugKey;
}

// ===================================
// 📎 Attach Log File to Jira Issue
// ===================================
async function attachFileToJiraIssue(issueKey, filePath) {
  const data = fs.createReadStream(filePath);

  await axios.post(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`, data, {
    auth: JIRA_AUTH,
    headers: {
      'X-Atlassian-Token': 'no-check',
      'Content-Type': 'multipart/form-data'
    }
  });

  console.log(`📎 Attached log to ${issueKey}`);
}

// ======================================
// 🔄 Transition Jira Bug Status
// ======================================
async function updateJiraBugStatus(bugKey, desiredStatus) {
  const transitions = {
    OPEN: '11',      // Replace with actual transition ID
    REOPENED: '21',
    CLOSED: '31'
  };

  const bug = await axios.get(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${bugKey}`, {
    auth: JIRA_AUTH
  });

  const currentStatus = bug.data.fields.status.name.toUpperCase();
  if (currentStatus === desiredStatus) {
    console.log(`🔁 Bug ${bugKey} already in desired status: ${desiredStatus}`);
    return;
  }

  const transitionId = transitions[desiredStatus];
  if (!transitionId) {
    console.warn(`⚠️ Unknown transition for status: ${desiredStatus}`);
    return;
  }

  await axios.post(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${bugKey}/transitions`, {
    transition: { id: transitionId }
  }, {
    auth: JIRA_AUTH
  });

  console.log(`🔄 Bug ${bugKey} transitioned to ${desiredStatus}`);
}

// ==================================
// 📄 Create Log File for Test Result
// ==================================
async function createLogFileForTest(testCaseKey, result) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `log_${testCaseKey}_${timestamp}.txt`;
  const content = `Test: ${testCaseKey}\nStatus: ${result.status}\nDetails:\n${JSON.stringify(result.details, null, 2)}\n`;
  const filePath = path.join(__dirname, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ===================================================
// 🔎 Extract Request URL, Params, and Test Scripts
// ===================================================
function buildUrl(urlObj) {
  if (typeof urlObj === 'string') return urlObj;
  const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host;
  const path = Array.isArray(urlObj.path) ? urlObj.path.join('/') : urlObj.path;
  return `${urlObj.protocol || 'https'}://${host}/${path}`;
}

function extractParams(urlObj) {
  if (!urlObj || !urlObj.query) return '{}';
  const params = {};
  for (const p of urlObj.query) {
    params[p.key] = p.value;
  }
  return JSON.stringify(params);
}

function extractTestScripts(events) {
  const event = events?.find(e => e.listen === 'test');
  return event?.script?.exec?.join('\n') || 'No tests';
}

function findTestResult(results, testKey) {
  for (const run of results.run.executions) {
    if (run.item.name.includes(testKey)) {
      const failed = run.assertions.filter(a => a.error);
      return failed.length > 0
        ? { status: TEST_STATUS.FAILED, details: failed }
        : { status: TEST_STATUS.PASSED };
    }
  }
  return null;
}

// ============================
// 🚀 Main Sync Function
// ============================
async function main() {
  try {
    const resultsFile = process.argv[2];
    if (!resultsFile) throw new Error('❌ Missing Postman results JSON file argument');
    const results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));

    const collectionName = results.collection.info.name;
    const execMatch = collectionName.match(RE_TEST_EXECUTION);
    if (!execMatch) throw new Error(`❌ Missing [TE-xx] key in collection name`);
    const testExecutionKey = execMatch[1];

    const testSets = {};
    for (const folder of results.collection.item) {
      const match = folder.name.match(RE_TEST_SET);
      if (!match) continue;
      testSets[match[1]] = folder;
    }

    await authenticateXray();

    for (const [testSetKey, folder] of Object.entries(testSets)) {
      for (const item of folder.item) {
        const name = item.name;
        const testCaseMatch = name.match(RE_TEST_CASE);
        if (!testCaseMatch) continue;

        const testCaseKey = testCaseMatch[1];
        const testSetKeyFormatted = `TS-${testCaseKey.split('-')[1].replace('TS', '')}`;
        const testExecutionKeyFormatted = `TE-${testCaseKey.split('-')[2].replace('TE', '')}`;

        const url = item.request.url ? buildUrl(item.request.url) : 'N/A';
        const body = item.request.body ? JSON.stringify(item.request.body) : '{}';
        const headers = item.request.header ? JSON.stringify(item.request.header) : '{}';
        const params = extractParams(item.request.url);
        const scripts = extractTestScripts(item.event);

        const description = `
**API Info:**
- Method: ${item.request.method}
- URL: ${url}
- Body: ${body}
- Headers: ${headers}
- Params: ${params}

**Tests:**  
${scripts}

**Triggered by Jenkins:**  
Pipeline: ${JENKINS_PIPELINE_LINK}  
Execution: ${testExecutionKeyFormatted}  
Set: ${testSetKeyFormatted}
        `.trim();

        const result = findTestResult(results, testCaseKey) || { status: TEST_STATUS.SKIPPED };

        await createOrUpdateXrayTestCase(testCaseKey, name, description, LABELS, testSetKeyFormatted, testExecutionKeyFormatted);

        const bugSummary = `Bug - ${name}`;
        const bugDescription = `Auto-generated bug for test case ${testCaseKey}.`;

        const bugKey = await createOrUpdateJiraBug(testCaseKey, bugSummary, bugDescription, LABELS);

        if (result.status === TEST_STATUS.FAILED) {
          const logFile = await createLogFileForTest(testCaseKey, result);
          await attachFileToJiraIssue(bugKey, logFile);
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CREATED);
        } else if (result.status === TEST_STATUS.PASSED) {
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CLOSED);
        }
      }
    }

    console.log('✅ Sync completed.');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  }
}

// ====================
// 🏁 Run the Script
// ====================
main();
