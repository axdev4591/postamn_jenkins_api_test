// ============================
// 🔧 Required Node.js Modules
// ============================
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// =============================
// 🔐 Environment Configuration
// =============================
require('dotenv').config(); // Load variables from .env (useful for local testing)

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

  try {

    const response = await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/import/test`,
      {
        testType: 'Jenkins_postman',
        testKey: key,
        projectKey: process.env.JIRA_PROJECT_KEY,
        summary: name,
        description,
        labels
      }, {
      headers: {
        Authorization: `Bearer ${XRAY_TOKEN}`,
        'Content-Type': "application/json"   // <--- FIXED HERE
      }
    });

    const testCaseId = response.data.key;

    await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/testset/${testSetKey}/test`, [testCaseId], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/testexecution/${testExecutionKey}/test`, [testCaseId], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    console.log(`✅ Linked to [${testSetKey}] and [${testExecutionKey}]`);
  } catch (error) {
    console.error(`❌ Error calling ${process.env.XRAY_BASE_URL}/api/v2/import/test`);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    throw error; // rethrow to be caught by upper-level try/catch
  }

}

// =====================================================
// 🐞 Create or Update Jira Bug Linked to a Test Case
// =====================================================
async function createOrUpdateJiraBug(testCaseKey, summary, description, labels) {
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
  }, { auth: JIRA_AUTH });

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
  const transitions = { OPEN: '11', REOPENED: '21', CLOSED: '31' };
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
    console.warn(`⚠️ Unknown transition: ${desiredStatus}`);
    return;
  }

  await axios.post(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${bugKey}/transitions`, {
    transition: { id: transitionId }
  }, { auth: JIRA_AUTH });

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

// Build full URL from Postman URL object
function buildUrl(urlObj) {
  if (typeof urlObj === 'string') return urlObj;
  const protocol = urlObj.protocol || 'https';
  const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host;
  const path = Array.isArray(urlObj.path) ? urlObj.path.join('/') : urlObj.path;
  return `${protocol}://${host}/${path}`;
}

function extractParams(urlObj) {
  if (!urlObj?.query || !Array.isArray(urlObj.query)) return 'None';
  return urlObj.query
    .map(param => `${param.key}=${param.value}`)
    .join('\n');
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
// 🚀 Main Sync Function
// ============================
async function main() {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('❌ Missing Postman results.json file path');

    const results = JSON.parse(fs.readFileSync(file, 'utf-8'));

    const collectionName = results.run?.meta?.collectionName;
    if (!collectionName) throw new Error('❌ Missing collectionName in results');

    const testExecutionKeyMatch = collectionName.match(RE_TEST_EXECUTION);
    if (!testExecutionKeyMatch) throw new Error('❌ Missing [TE-xx] in collection name');
    const testExecutionKey = testExecutionKeyMatch[1];

    const executions = results.run.executions || [];

    await authenticateXray();

    for (const exec of executions) {
      const name = exec.requestExecuted?.name || 'Unnamed Test';
      const match = name.match(RE_TEST_CASE);
      if (!match) {
        console.warn(`⚠️ Skipping invalid test name: ${name}`);
        continue;
      }

      const testCaseKey = match[1];
      const ts = `TS-${testCaseKey.split('-')[1].replace('TS', '')}`;
      const te = `TE-${testCaseKey.split('-')[2].replace('TE', '')}`;

      const url = buildUrl(exec.requestExecuted?.url);
      const method = exec.requestExecuted?.method || 'GET';
      const body = JSON.stringify(exec.requestExecuted?.body || {});
      const headers = JSON.stringify(exec.requestExecuted?.headers || []);
      const params = extractParams(exec.requestExecuted?.url);
      //const scripts = JSON.stringify(exec?.tests || []); 
      const scripts = extractTestScripts(exec.requestExecuted?.event);

      const description = `
**API Info:**
- Method: ${method}
- URL: ${url}
- Body: ${body}
- Headers: ${headers}
- Params: ${params}

**Tests:**  
${scripts}

**Triggered by Jenkins:**  
Pipeline: ${JENKINS_PIPELINE_LINK}  
Execution: ${te}  
Set: ${ts}
`.trim();

      const failedAssertions = exec.assertions?.filter(a => a.error) || [];
      const status = failedAssertions.length > 0 ? TEST_STATUS.FAILED : TEST_STATUS.PASSED;
      const result = { status, details: failedAssertions };

      await createOrUpdateXrayTestCase(testCaseKey, name, description, LABELS, ts, te);
      const bugKey = await createOrUpdateJiraBug(testCaseKey, `Bug - ${name}`, `Bug for ${testCaseKey}`, LABELS);

      if (result.status === TEST_STATUS.FAILED) {
        const logFile = await createLogFileForTest(testCaseKey, result);
        await attachFileToJiraIssue(bugKey, logFile);
        await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CREATED);
      } else {
        await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CLOSED);
      }
    }

    console.log('✅ Sync complete');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  }
}

// ====================
// 🏁 Run the Script
// ====================
main();
