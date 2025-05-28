// Required modules
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Constants for test statuses
const TEST_STATUS = { PASSED: 'PASSED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' };

// Bug lifecycle statuses
const BUG_LIFECYCLE = { CREATED: 'OPEN', REOPENED: 'REOPENED', CLOSED: 'CLOSED' };

// Labels applied to all issues
const LABELS = ['jenkins', 'postman', 'automation', 'TNR'];

// Regex patterns
const RE_TEST_EXECUTION = /\[(TE-\d+)\]/;
const RE_TEST_SET = /\[(TS-\d+)\]/;
const RE_TEST_CASE = /\[(API\d+-TS\d+-TE\d+)\]/;

// Jenkins URL
const JENKINS_PIPELINE_LINK = 'https://your-jenkins-pipeline-link.example.com';

// Auth headers for Jira
const JIRA_AUTH = {
  username: process.env.JIRA_USER,
  password: process.env.JIRA_API_TOKEN
};

// Global Xray access token
let XRAY_TOKEN = null;

// Authenticate to Xray and store token
async function authenticateXray() {
  const res = await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/authenticate`, {
    client_id: process.env.XRAY_CLIENT_ID,
    client_secret: process.env.XRAY_CLIENT_SECRET
  });
  XRAY_TOKEN = res.data;
}

// Create/update Xray Test Case and link it to test set & execution
async function createOrUpdateXrayTestCase(key, name, description, labels, testSetKey, testExecutionKey) {
  console.log(`🔁 Syncing Xray test case ${key}...`);

  const response = await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/import/test`, {
    testType: 'Manual',
    testKey: key,
    projectKey: process.env.JIRA_PROJECT_KEY,
    summary: name,
    description,
    labels,
  }, {
    headers: {
      Authorization: `Bearer ${XRAY_TOKEN}`
    }
  });

  const testCaseId = response.data.key;

  // Link to test set
  await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/testset/${testSetKey}/test`, [testCaseId], {
    headers: {
      Authorization: `Bearer ${XRAY_TOKEN}`
    }
  });

  // Link to test execution
  await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/testexecution/${testExecutionKey}/test`, [testCaseId], {
    headers: {
      Authorization: `Bearer ${XRAY_TOKEN}`
    }
  });

  console.log(`✅ Test Case ${testCaseId} linked to [${testSetKey}] and [${testExecutionKey}]`);
}

// Create or update Jira Bug linked to a test case
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

// Attach file to Jira issue
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

// Update Jira bug status
async function updateJiraBugStatus(bugKey, status) {
  // Use your actual transition IDs based on your Jira workflow
  const transitions = {
    OPEN: '11',
    REOPENED: '21',
    CLOSED: '31'
  };

  const transitionId = transitions[status];
  if (!transitionId) {
    console.warn(`⚠️ Unknown bug transition for status: ${status}`);
    return;
  }

  await axios.post(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${bugKey}/transitions`, {
    transition: { id: transitionId }
  }, {
    auth: JIRA_AUTH
  });

  console.log(`🔄 Bug ${bugKey} transitioned to ${status}`);
}

// Create a log file for failed test
async function createLogFileForTest(testCaseKey, result) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `log_${testCaseKey}_${timestamp}.txt`;
  const content = `Test: ${testCaseKey}\nStatus: ${result.status}\nDetails:\n${JSON.stringify(result.details, null, 2)}\n`;
  const filePath = path.join(__dirname, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Build full URL from Postman format
function buildUrl(urlObj) {
  if (typeof urlObj === 'string') return urlObj;
  const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host;
  const path = Array.isArray(urlObj.path) ? urlObj.path.join('/') : urlObj.path;
  return `${urlObj.protocol || 'https'}://${host}/${path}`;
}

// Extract query params from Postman URL
function extractParams(urlObj) {
  if (!urlObj || !urlObj.query) return '{}';
  const params = {};
  for (const p of urlObj.query) {
    params[p.key] = p.value;
  }
  return JSON.stringify(params);
}

// Extract test script lines
function extractTestScripts(events) {
  const event = events?.find(e => e.listen === 'test');
  return event?.script?.exec?.join('\n') || 'No tests';
}

// Find test result from Postman execution
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

// Entry point
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

        if (result.status === TEST_STATUS.FAILED) {
          const bugDescription = `
              Automatically created bug for test case ${testCaseKey}.  
              Failure details attached.

              Linked to: ${testCaseKey}
                        `.trim();

          const bugKey = await createOrUpdateJiraBug(testCaseKey, `Bug - ${name}`, bugDescription, LABELS);
          const logFile = await createLogFileForTest(testCaseKey, result);
          await attachFileToJiraIssue(bugKey, logFile);
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CREATED);
        }
      }
    }

    console.log('✅ Sync completed.');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  }
}

// Run script
main();
