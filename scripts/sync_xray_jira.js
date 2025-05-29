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

// ==============================
// 🔧 Safe URL builder function
// ==============================
function buildApiUrl(base, path) {
  try {
    // new URL() safely appends path to base URL
    return new URL(path, base).toString();
  } catch (err) {
    throw new Error(`Invalid URL components: base='${base}', path='${path}'`);
  }
}

// ==============================
// 🔧 Build full URL from Postman URL object or string
// ==============================
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

// ==============================
// 🔧 Extract query params from Postman URL object
// ==============================
function extractParams(urlObj) {
  if (!urlObj?.query || !Array.isArray(urlObj.query)) return 'undefined';
  if (urlObj.query.length === 0) return 'None';
  return urlObj.query.map(param => `${param.key || 'undefined'}=${param.value || 'undefined'}`).join('\n');
}

// ==============================
// 🔧 Extract test scripts from Postman event array
// ==============================
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
  if (!process.env.XRAY_BASE_URL) throw new Error('XRAY_BASE_URL is not set');
  if (!process.env.XRAY_CLIENT_ID) throw new Error('XRAY_CLIENT_ID is not set');
  if (!process.env.XRAY_CLIENT_SECRET) throw new Error('XRAY_CLIENT_SECRET is not set');

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
  console.log(`🔁 Syncing Xray test case ${key}...`);
  try {
    if (!process.env.JIRA_BASE_URL) throw new Error('JIRA_BASE_URL is not set');
    if (!process.env.JIRA_PROJECT_KEY) throw new Error('JIRA_PROJECT_KEY is not set');

    const jqlSafeName = name.replace(/[\[\]]/g, '');
    const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');
    let searchRes = await axios.get(searchUrl, {
      auth: JIRA_AUTH,
      params: {
        jql: `summary ~ "${jqlSafeName}" AND project = "${process.env.JIRA_PROJECT_KEY}" AND issuetype = Test`,
        maxResults: 1
      }
    });

    let testCaseKey;
    if (searchRes.data.issues.length > 0) {
      testCaseKey = searchRes.data.issues[0].key;
      console.log(`↩️ Test case already exists: ${testCaseKey}`);
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
      console.log(`✅ Created test case: ${testCaseKey}`);
    }

    // Link Test Case to Test Set and Test Execution in Xray
    await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, `/api/v2/testset/${testSetKey}/test`), [testCaseKey], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    await axios.post(buildApiUrl(process.env.XRAY_BASE_URL, `/api/v2/testexecution/${testExecutionKey}/test`), [testCaseKey], {
      headers: { Authorization: `Bearer ${XRAY_TOKEN}` }
    });

    console.log(`✅ Linked to [${testSetKey}] and [${testExecutionKey}]`);
    return testCaseKey;

  } catch (error) {
    console.error(`❌ Error syncing test case:`, error.response?.data || error.message);
    throw error;
  }
}

// =====================================================
// 🐞 Create or Update Jira Bug Linked to a Test Case
// =====================================================
async function createOrUpdateJiraBug(testCaseKey, summary, description, labels) {
  if (!process.env.JIRA_BASE_URL) throw new Error('JIRA_BASE_URL is not set');
  if (!process.env.JIRA_PROJECT_KEY) throw new Error('JIRA_PROJECT_KEY is not set');
  if (!process.env.BUG_ISSUE_TYPE) throw new Error('BUG_ISSUE_TYPE is not set');

  const escapedSummary = summary.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  const jql = `summary ~ "${escapedSummary}" AND project = "${process.env.JIRA_PROJECT_KEY}"`;

  const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');
  const search = await axios.get(searchUrl, {
    auth: JIRA_AUTH,
    params: {
      jql,
      maxResults: 1
    }
  });

  if (search.data.issues.length > 0) {
    console.log(`↩️ Bug already exists: ${search.data.issues[0].key}`);
    return search.data.issues[0].key;
  }

  const createUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issue');
  const res = await axios.post(createUrl, {
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
  if (!process.env.JIRA_BASE_URL) throw new Error('JIRA_BASE_URL is not set');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const attachUrl = buildApiUrl(process.env.JIRA_BASE_URL, `/rest/api/3/issue/${issueKey}/attachments`);
  await axios.post(attachUrl, form, {
    auth: JIRA_AUTH,
    headers: {
      'X-Atlassian-Token': 'no-check',
      ...form.getHeaders()
    }
  });

  console.log(`📎 Attached log to ${issueKey}`);
}

// ======================================
// 🔄 Transition Jira Bug Status
// ======================================
async function updateJiraBugStatus(bugKey, desiredStatus) {
  if (!process.env.JIRA_BASE_URL) throw new Error('JIRA_BASE_URL is not set');

  // These transition IDs should be replaced with your actual Jira workflow transition IDs
  const transitions = { OPEN: '11', REOPENED: '21', CLOSED: '31' };

  const bugUrl = buildApiUrl(process.env.JIRA_BASE_URL, `/rest/api/3/issue/${bugKey}`);
  const bug = await axios.get(bugUrl, { auth: JIRA_AUTH });
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

  const transitionUrl = buildApiUrl(process.env.JIRA_BASE_URL, `/rest/api/3/issue/${bugKey}/transitions`);
  await axios.post(transitionUrl, { transition: { id: transitionId } }, { auth: JIRA_AUTH });

  console.log(`🔄 Transitioned bug ${bugKey} from ${currentStatus} to ${desiredStatus}`);
}

// =========================================
// 🧹 Link Jira Bug to Xray Test Case
// =========================================
async function linkBugToTestCase(testCaseKey, bugKey) {
  if (!process.env.JIRA_BASE_URL) throw new Error('JIRA_BASE_URL is not set');

  const linkUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/issueLink');
  await axios.post(linkUrl, {
    type: { name: 'Relates' },
    inwardIssue: { key: testCaseKey },
    outwardIssue: { key: bugKey }
  }, { auth: JIRA_AUTH });

  console.log(`🔗 Linked bug ${bugKey} to test case ${testCaseKey}`);
}

// ======================================
// 🔥 Main sync function for Postman results
// ======================================
async function syncPostmanResults(resultsJsonPath) {
  try {
    // Read and parse Postman results JSON file
    const resultsData = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
    const collectionName = resultsData.run?.meta?.collectionName || 'Unnamed Collection';

    // Extract Test Execution Key from collection name
    const teMatch = collectionName.match(RE_TEST_EXECUTION);
    if (!teMatch) throw new Error(`Test Execution key not found in collection name: ${collectionName}`);
    const testExecutionKey = teMatch[1];

    // Extract Test Set Key similarly
    const tsMatch = collectionName.match(RE_TEST_SET);
    if (!tsMatch) throw new Error(`Test Set key not found in collection name: ${collectionName}`);
    const testSetKey = tsMatch[1];

    console.log(`🚀 Syncing Postman collection '${collectionName}' to Xray test execution ${testExecutionKey} and test set ${testSetKey}`);

    // Authenticate Xray API
    await authenticateXray();

    // Loop over each test result execution
    for (const execution of resultsData.run.executions) {
      const itemName = execution.item?.name || 'Unnamed Test';
      const testCaseMatch = itemName.match(RE_TEST_CASE);

      if (!testCaseMatch) {
        console.warn(`⚠️ Skipping test without test case key in name: ${itemName}`);
        continue;
      }

      const testCaseKeyFromName = testCaseMatch[1];
      const testName = execution.assertions?.length ? execution.assertions[0].assertion : itemName;

      // Prepare test case description with request details
      const request = execution.request;
      const requestUrl = buildRequestUrl(request.url);
      const requestMethod = request.method || 'GET';
      const requestQueryParams = extractParams(request.url);
      const testScripts = extractTestScripts(execution.item.event);

      const description =
        `Request:\n- URL: ${requestUrl}\n- Method: ${requestMethod}\n- Query Params:\n${requestQueryParams}\n\nTest Scripts:\n${testScripts}\n\nLinked Jenkins Pipeline: ${JENKINS_PIPELINE_LINK}`;

      // Create or update the test case in Xray/Jira and link it
      const testCaseKey = await createOrUpdateXrayTestCase(
        testCaseKeyFromName,
        itemName,
        description,
        LABELS,
        testSetKey,
        testExecutionKey
      );

      // Determine test status from execution assertions
      let status = TEST_STATUS.PASSED;
      if (execution.assertions && execution.assertions.some(a => a.error)) {
        status = TEST_STATUS.FAILED;
      } else if (execution.assertions && execution.assertions.every(a => a.skipped)) {
        status = TEST_STATUS.SKIPPED;
      }

      // Create or update bug if test failed
      if (status === TEST_STATUS.FAILED) {
        const bugSummary = `Bug for failing test: ${itemName}`;
        const bugDescription = `Test case ${testCaseKey} failed during Jenkins/Postman run.\nSee details at ${JENKINS_PIPELINE_LINK}`;
        const bugKey = await createOrUpdateJiraBug(testCaseKey, bugSummary, bugDescription, LABELS);

        // Optionally attach logs or other files (assumed path)
        // await attachFileToJiraIssue(bugKey, '/path/to/logfile.log');

        // Link bug to test case
        await linkBugToTestCase(testCaseKey, bugKey);

        // Transition bug to Open or Reopened status
        await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.REOPENED);
      } else {
        // If test passed, try to close bug if it exists
        // Search bugs for this test case and close if open
        // (Implementation omitted for brevity - could be done similarly to createOrUpdateJiraBug with extra JQL)
      }
    }

    console.log('✅ Postman test results sync completed successfully.');
  } catch (err) {
    console.error('❌ Error syncing Postman results:', err.message);
    process.exit(1);
  }
}

// ============================
// 🔄 Run the script with Postman results.json path from CLI argument
// ============================
if (require.main === module) {
  const resultsJsonPath = process.argv[2];
  if (!resultsJsonPath) {
    console.error('Usage: node sync-postman-to-xray.js <postman-results.json>');
    process.exit(1);
  }
  syncPostmanResults(resultsJsonPath);
}

