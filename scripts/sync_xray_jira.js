
// ============================
// 🔧 Required Node.js Modules
// ============================
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

//exec.requestExecuted?.name
//exec.tests

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
const XRAY_TEST_TYPE = "Jenkins_postman";
const XRAY_TEST_TYPE_FIELD_ID = "customfield_XXXXX"; // Replace with your actual custom field ID

// =====================
// 🔍 Regex Definitions
// =====================
const RE_TEST_CASE = /\[(API\d+-IDC\d+-IDC\d+)\]/;
// Matches multiple Jira keys like [IDC-7][IDC-6] Title
const RE_JIRA_KEYS = /\[(\w+-\d+)\]\[(\w+-\d+)\]/;


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


async function getXrayAuthToken() {
  const res = await axios.post(`${process.env.XRAY_BASE_URL}/api/v2/authenticate`, {
    client_id: process.env.XRAY_CLIENT_ID,
    client_secret: process.env.XRAY_CLIENT_SECRET
  }, {
    headers: { 'Content-Type': 'application/json' }
  });

  return res.data; // this will be the bearer token
}

module.exports = { getXrayAuthToken };

/**
 * Update test result in a test execution
 * @param {string} testExecutionKey - Key like "IDC-7"
 * @param {Array} results - Array of test results: { testKey, status, comment? }
 */
async function submitTestResult(testKey, testExecutionKey, status = 'PASSED') {
  const xrayToken = await authenticateXray();
  const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

  const resultPayload = {
    testExecutionKey,
    info: {
      summary: `Nodejs script - Test run on ${today}`,
      description: `Postman-jenkins Automated test execution created on ${today}`,
      startDate: today,
      finishDate: today
    },
    tests: [
      {
        testKey,
        status,
        comment: `Everything: ${status}`
      }
    ]
  };

  const response = await axios.post(
    `${process.env.XRAY_BASE_URL}/api/v2/import/execution`,
    resultPayload,
    {
      headers: {
        Authorization: `Bearer ${xrayToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log('Test result submitted:', response.data);
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
          issuetype: { name: 'Test' },
          //description,
          //labels,
          // [XRAY_TEST_TYPE_FIELD_ID]: { value: XRAY_TEST_TYPE }  // <-- Here is the custom test type field
        }
      }, { auth: JIRA_AUTH });

      testCaseKey = createRes.data.key;
      console.log(`✅ Created new test case: ${testCaseKey}`);
    }

    //issue IDs
    const testId = await getIssueId(testCaseKey);
    const testSetId = await getIssueId(testSetKey);
    const testExecutionId = await getIssueId(testExecutionKey);

    // Link to Test Set
    console.log(`🔗 Add test: ${testId} to Test Set: ${testSetId}`);
    await addTestToTestSet(testSetId, testId)

    // Link to Test Execution
    console.log(`🔗 Add test: ${testId}  to Test Execution: ${testExecutionId}`);
    await addTestToTestExecution(testExecutionId, testId);

    // Submit Test result Execution
    console.log(`🔗 Update test status in test execution, test = ${testId}, Test Execution = ${testExecutionId}`);
    submitTestResult(testCaseKey, testExecutionKey, overallStatus);

    return testCaseKey;

  } catch (error) {
    console.error(`❌ Failed to sync test case "${name}":`, error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// 📎 Retrieve All Custom Fields from Jira
// ============================================
async function fetchJiraCustomFields() {
  try {
    const url = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/field');
    const response = await axios.get(url, {
      auth: JIRA_AUTH,
      headers: { 'Content-Type': 'application/json' }
    });

    const customFields = response.data.filter(field => field.custom);
    console.log('📋 Retrieved custom fields:');
    for (const field of customFields) {
      console.log(`- ${field.name} (ID: ${field.id})`);
    }

    return customFields;
  } catch (error) {
    console.error('❌ Failed to fetch custom fields:', error.response?.data || error.message);
    throw error;
  }
}

// Example usage:
(async () => {
  const fields = await fetchJiraCustomFields();
  const xrayField = fields.find(f => f.name === 'Jenkins_postman'); // Change this to match your field label
  if (xrayField) {
    console.log(`✅ Found Test Type field ID: ${xrayField.id}`);
  } else {
    console.warn('⚠️ Test Type field not found!');
  }
})();

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


/**
 * Get issue internal ID from Jira issue key using Jira REST API
 * @param {string} issueKey - Jira issue key like "IDC-5"
 * @returns {Promise<string>} - Returns internal numeric issue ID
 */
async function getIssueId(issueKey) {

  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}`;

  const response = await axios.get(url, {
    auth: JIRA_AUTH,
    headers: { 'Content-Type': 'application/json' }
  });


  if (response.status !== 200 || !response.data || !response.data.id) {
    throw new Error(`Failed to get issue ID for ${issueKey}: ${response.status} ${response.statusText}`);
  }

  return response.data.id;
}

/**
 * Add tests to test set using GraphQL mutation by keys
 * @param {string} testSetId - Test Set issue key like "TS-01"
 * @param {string[]} testId - Array of test issue keys like ["IDC-5", "IDC-6"]
 */
async function addTestToTestSet(testSetId, testId) {

  const query = `
    mutation {
      addTestsToTestSet(issueId: "${testSetId}", testIssueIds: ["${testId}"]) {
        addedTests
        warning
      }
    }
  `;

  const payload = { query };
  const token = await getXrayAuthToken();
  const url = `${process.env.XRAY_BASE_URL}/api/v2/graphql`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ Successfully added test(s) ${testId} to Test Set ${testSetId}`);
  } catch (error) {
    console.error(`❌ Failed to add test(s) ${testId} to Test Set ${testSetId}:`, error.response?.data || error.message);
  }
}

/**
 * Add tests to test set using GraphQL mutation by keys
 * @param {string} testExecId - Test Set issue key like "TS-01"
 * @param {string[]} testId - Array of test issue keys like ["IDC-5", "IDC-6"]
 */
async function addTestToTestExecution(testExecId, testId) {

  const query = `
    mutation {
      addTestsToTestExecution(issueId: "${testExecId}", testIssueIds: ["${testId}"]) {
        addedTests
        warning
      }
    }
  `;

  const payload = { query };
  const token = await getXrayAuthToken();
  const url = `${process.env.XRAY_BASE_URL}/api/v2/graphql`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ Successfully added test(s) ${testId} to Test Execution ${testExecId}`);
  } catch (error) {
    console.error(`❌ Failed to add test(s) ${testId} to Test Execution ${testExecId}:`, error.response?.data || error.message);
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

// ============================================
// 📎 Retrieve All Custom Fields from Jira
// ============================================
async function fetchJiraCustomFields() {
  try {
    const url = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/field');
    const response = await axios.get(url, {
      auth: JIRA_AUTH,
      headers: { 'Content-Type': 'application/json' }
    });

    const customFields = response.data.filter(field => field.custom);
    console.log('📋 Retrieved custom fields:');
    for (const field of customFields) {
      console.log(`- ${field.name} (ID: ${field.id})`);
    }

    return customFields;
  } catch (error) {
    console.error('❌ Failed to fetch custom fields:', error.response?.data || error.message);
    throw error;
  }
}

// Example usage:
(async () => {
  const fields = await fetchJiraCustomFields();
  const xrayField = fields.find(f => f.name === 'Jenkins_postman'); // Change this to match your field label
  if (xrayField) {
    console.log(`✅ Found Test Type field ID: ${xrayField.id}`);
  } else {
    console.warn('⚠️ Test Type field not found!');
  }
})();

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
// ===============================
async function linkBugToTestCase(bugKey, testKey) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issueLink`;
  const payload = {
    type: { name: "Relates" }, // You can use other types like "Blocks", "Tests", etc.
    inwardIssue: { key: bugKey },
    outwardIssue: { key: testKey }
  };

  try {
    await axios.post(url, payload, {
      auth: JIRA_AUTH,
      headers: { 'Content-Type': 'application/json' }
    });

    console.log(`🔗 Linked bug ${bugKey} to test case ${testKey}`);
  } catch (error) {
    console.error(`❌ Failed to link bug ${bugKey} to test case ${testKey}:`, error.response?.data || error.message);
  }
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
    // Example bug issue key to fetch workflow transitions (required once)
    const exampleBugIssueKey = `${process.env.JIRA_PROJECT_KEY}-1`;
    await fetchJiraWorkflowTransitions(exampleBugIssueKey);

    // List Jira Issue Link Types (optional diagnostic)
    await listIssueLinkTypes();

    // Read Postman results.json
    const resultsData = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));

    // Extract Test Execution key from collection name (e.g. "My API Tests [IDC-1]")
    // Logging summary per test
    const collectionName = resultsData.run?.meta.collectionName || 'Unknown Collection';
    //const testExecutionMatch = collectionName.match(RE_JIRA_KEYS);

    const match = collectionName.match(RE_JIRA_KEYS);
    if (!match || match.length < 3) {
      throw new Error(`❌ Collection name does not contain valid test execution and test set keys.: ${collectionName}`);
    }

    // By position: [IDC-7][IDC-6] → match[1] = IDC-7, match[2] = IDC-6
    const testExecutionKey = match[1];
    const testSetKey = match[2];

    console.log(`🧩 Test Execution Key: ${testExecutionKey}`);
    console.log(`🧩 Test Set Key: ${testSetKey}`);

    //await verifyJiraIssueExists(testExecutionKey, 'Test Execution');
    //await verifyJiraIssueExists(testSetKey, 'Test Set');

    // const testExecutionKey = testExecutionMatch[1]; // e.g. "TE-01"

    // Loop through each Postman execution (individual request test result)
    for (const exec of resultsData.run.executions) {
      const requestName = exec.requestExecuted?.name || 'Unnamed Request';
      // Extract test case key from request name (e.g. "[API01-TS01-TE01]")
      const testCaseMatch = requestName.match(RE_TEST_CASE);
      if (!testCaseMatch) {
        console.warn(`⚠️ Test case key not found in request name: ${requestName}`);
        continue; // skip this test
      }
      const testCaseKeyCandidate = testCaseMatch[1]; // e.g. "API01-TS01-TE01"

      // Compose test case name and description
      const testCaseName = `${requestName}`;
      const description = `Test case from Postman request: ${requestName}\nLinked Jenkins Pipeline: ${JENKINS_PIPELINE_LINK}`;

      // Determine overall test status from all test assertions for this execution
      // Note: exec.test or exec.tests array depends on Postman result structure
      // Here we check exec.tests or fallback to exec.tests with 'assertions' array
      const testAssertions = Array.isArray(exec.tests) ? exec.tests : [];

      let overallStatus = TEST_STATUS.SKIPPED;

      if (testAssertions.length > 0) {
        const anyFailed = testAssertions.some(a => a.status !== 'passed');
        overallStatus = anyFailed ? TEST_STATUS.FAILED : TEST_STATUS.PASSED;
      }


      // Create or update the test case in Jira/Xray
      const testKey = await createOrUpdateXrayTestCase(testCaseKeyCandidate, testCaseName, description, LABELS, testSetKey, testExecutionKey, overallStatus);

      // Handle bug management based on test status
      if (overallStatus === TEST_STATUS.FAILED) {
        // Create or get existing bug for this test
        let bugKey = await findExistingBugForTest(testKey);
        if (!bugKey) {
          // Bug description can include failure info + Jenkins link
          const bugDescription = `Failure detected for test case ${testKey}.\n\n${description}`;
          bugKey = await createOrUpdateBugForTest(testKey, testCaseName, bugDescription);
        }
        // Link bug to test case if not linked yet
        await linkBugToTestCase(bugKey, testKey);
        // Update bug status to OPEN or REOPENED depending on current status
        await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.REOPENED);
      } else if (overallStatus === TEST_STATUS.PASSED) {
        // Check if bug exists, then close it if still open
        const bugKey = await findExistingBugForTest(testKey);
        if (bugKey) {
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CLOSED);
        }
      }

      // Logging summary per test
      console.log(`Test case ${testKey} processed with status: ${overallStatus}`);
    }

    console.log('✅ All Postman test results synchronized successfully.');
  } catch (error) {
    console.error('❌ Error during Postman results synchronization:', error.response?.data || error.message || error);
  }
}

module.exports = {
  TEST_STATUS,
  BUG_LIFECYCLE,
  XRAY_TEST_TYPE,
  XRAY_TEST_TYPE_FIELD_ID,
  JENKINS_PIPELINE_LINK,
  authenticateXray,
  getXrayAuthToken,
  createOrUpdateXrayTestCase,
  addTestToTestExecution,
  getIssueId,
  addTestToTestSet,
  updateJiraBugStatus,
  fetchJiraWorkflowTransitions,
  fetchJiraCustomFields,
  listIssueLinkTypes,
  linkBugToTestCase,
  buildApiUrl,
  buildRequestUrl,
  extractParams,
  extractTestScripts,
  formatToADF
};

// Export for CLI or Jenkins
module.exports = { syncPostmanResults };

// If run directly from CLI
if (require.main === module) {
  const filePath = process.argv[2] || './results.json';
  syncPostmanResults(filePath);
}


