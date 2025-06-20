
// ============================
// 🔧 Required Node.js Modules
// ============================
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

//exec.requestExecuted?.name
//exec.tests

const { setExecutionInfo, addTestResult, addBugInfo, getSummary } = require('./summaryCollector');
const { sendSummaryEmail } = require('./send-email');


// =============================
// 🔐 Environment Configuration
// =============================
require('dotenv').config();

// ======================
// 🔁 Constants and Enums
// ======================
const TEST_STATUS = { PASSED: 'PASSED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' };
const LABELS = ['jenkins', 'postman', 'automation', 'TNR'];
const XRAY_TEST_TYPE = "Jenkins_postman";
const XRAY_TEST_TYPE_FIELD_ID = "customfield_XXXXX"; // Replace with your actual custom field ID
const BUG_LIFECYCLE = { CREATED: 'To Do', REOPENED: 'In Progress', CLOSED: 'Done' };
const STATUS_KEYWORDS = {
  CREATED: ['to do', 'open'],
  REOPENED: ['reopened', 'in progress'],
  CLOSED: ['done', 'close']
};
// =====================
// 🔍 Regex Definitions
// =====================
const RE_TEST_CASE = /\[(API\d+-IDC\d+-IDC\d+)\]/;
// Matches multiple Jira keys like [IDC-7][IDC-6] Title
const RE_JIRA_KEYS = /\[(\w+-\d+)\]\[(\w+-\d+)\]/;

// ===============================
// ⚙️ Jira Workflow Transitions Map
// ===============================
const workflowMap = {
  "To Do": "11",
  "In Progress": "21",
  "Done": "31"
};
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
  const xrayToken = await getXrayAuthToken();

  // Use ISO 8601 full datetime format (e.g. 2025-06-03T10:00:00.000Z)
  const now = new Date();
  const startDate = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 minutes before now
  const finishDate = now.toISOString(); // now

  const resultPayload = {
    testExecutionKey,
    info: {
      summary: `IdCluster Api automation - Test run on ${now.toISOString().split('T')[0]}`,
      description: `This is an Automated test execution generated from Jenkins pipeline: Postman + nodejs script `,
      startDate,
      finishDate
    },
    tests: [
      {
        testKey,
        status,
        comment: `Everything: ${status}`
      }
    ]
  };

  console.log("➡️ Submitting test result:", JSON.stringify(resultPayload, null, 2));
  console.log("➡️ Using token:", xrayToken.slice(0, 10) + '...');

  try {
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
    console.log("✅ Test result submitted:", response.data);
  } catch (error) {
    console.error("❌ Error submitting test result:", error.response?.data || error.message);
  }
}


// ============================================
// 📎 Retrieve All Custom Fields from Jira
// ============================================
async function fetchJiraCustomFields(fieldName) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/field`;
  const res = await axios.get(url, { auth: JIRA_AUTH });
  const field = res.data.find(f => f.name === fieldName);
  return field ? field.id : null;
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

    // Clear existing map
    for (const key in workflowMap) delete workflowMap[key];

    // Map transition names to your lifecycle keys using constants
    for (const transition of res.data.transitions) {
      const name = transition.name.toLowerCase();

      for (const [statusKey, keywords] of Object.entries(STATUS_KEYWORDS)) {
        if (keywords.some(keyword => name.includes(keyword))) {
          workflowMap[statusKey] = transition.id;
          break;  // once matched, skip checking other statuses
        }
      }
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

// ================================
// 🔄 Update Jira Bug Status Function
// ================================
function getLifecycleKeyFromStatus(statusLabel) {
  for (const [key, label] of Object.entries(BUG_LIFECYCLE)) {
    if (label.toLowerCase() === statusLabel.toLowerCase()) {
      return key;
    }
  }
  return null;
}

// ===============================
// 📎 Link bug to its test case
// ===============================
async function linkBugToTestCase(bugKey, testKey) {
  const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');
  const jql = `issue in linkedIssues("${testKey}", "is blocked by")`;
  const result = await axios.get(searchUrl, {
    auth: JIRA_AUTH,
    params: { jql, maxResults: 1 }
  });

  if (result.data.issues.length > 0) {
    return result.data.issues[0].key;
  }
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issueLink`;
  const payload = {
    type: { name: "Blocks" }, // ✅ This is the correct link type name
    inwardIssue: { key: bugKey },   // 🪳 Bug
    outwardIssue: { key: testKey }  // 🧪 Test
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
async function createBugForTest(testKey, testName, description) {
  const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');
  //const jql = `project = ${process.env.JIRA_PROJECT_KEY} AND issuetype = ${process.env.BUG_ISSUE_TYPE} AND "Test" = ${testKey}`;
  const jql = `issue in linkedIssues("${testKey}", "is blocked by")`;
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
      summary: `🪳 Failed Test: ${testName}`,
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
// 📎 Update Bug base on test status
// =============================================
async function updateJiraBugStatus(issueKey, statusLabel) {
  const lifecycleKey = getLifecycleKeyFromStatus(statusLabel);

  if (!lifecycleKey || !workflowMap[lifecycleKey]) {
    throw new Error(`No workflow transition ID found for status: ${statusLabel}`);
  }

  const transitionId = workflowMap[lifecycleKey];
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/transitions`;

  try {
    await axios.post(
      url,
      { transition: { id: transitionId } },
      {
        auth: {
          username: process.env.JIRA_USER,
          password: process.env.JIRA_API_TOKEN
        }
      }
    );
    console.log(`✅ Bug ${issueKey} transitioned to ${statusLabel} (ID: ${transitionId})`);
  } catch (error) {
    console.error(`❌ Failed to update bug ${issueKey} status to ${statusLabel}:`, error.response?.data || error.message);
  }
}


// =============================================
// 📎 Find existing bug for a specific test
// =============================================
async function findExistingBugForTest(testKey) {
  // JQL to find bugs linked to the testKey with the link type "is blocked by"
  //const jql = `project = ${process.env.JIRA_PROJECT_KEY} AND issuetype = ${process.env.BUG_ISSUE_TYPE} AND issue in linkedIssues("${testKey}", "is blocked by")`;
  const jql = `issue in linkedIssues("${testKey}", "is blocked by")`;

  const searchUrl = buildApiUrl(process.env.JIRA_BASE_URL, '/rest/api/3/search');

  try {
    const res = await axios.get(searchUrl, {
      auth: JIRA_AUTH,
      params: { jql, maxResults: 1 }
    });

    if (res.data.issues.length > 0) {
      return res.data.issues[0].key; // return first found bug key
    }

    return null; // no linked bug found
  } catch (error) {
    console.error(`❌ Failed to find existing bug for test ${testKey}:`, error.response?.data || error.message);
    return null;
  }
}



// =================================================================
// 🔁 Create/Update Xray Test Case and Link to TestSet/TestExecution
// =================================================================
async function createOrUpdateXrayTestCase(key, name, description, labels, testSetKey, testExecutionKey, overallStatus) {
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
      //const testCaseFieldId = await fetchJiraCustomFields(testCaseFieldName);
      console.log(`📤 Creating new test case: ${name}`);
      const createRes = await axios.post(createUrl, {
        fields: {
          project: { key: process.env.JIRA_PROJECT_KEY },
          summary: name,
          issuetype: { name: 'Test' },
          description,
          labels
          // [testCaseFieldId]: { value: XRAY_TEST_TYPE }  // <-- Here is the custom test type field
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
    const issueInfo = await axios.get(
      `${process.env.JIRA_BASE_URL}/rest/api/3/issue/${testCaseKey}`,
      { auth: JIRA_AUTH }
    );

    console.log(`✅ ${testCaseKey} issue type:`, issueInfo.data.fields.issuetype.name);

    submitTestResult(testCaseKey, testExecutionKey, overallStatus);

    return testCaseKey;

  } catch (error) {
    console.error(`❌ Failed to sync test case "${name}":`, error.response?.data || error.message);
    throw error;
  }
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

    // After you extract testExecutionKey and testSetKey
    setExecutionInfo({
      key: testExecutionKey,
      summary: collectionName,
      date: new Date().toISOString().split('T')[0],
    });

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
      const descriptionText = `Test case from Postman request: ${requestName}\nLinked Jenkins Pipeline: ${JENKINS_PIPELINE_LINK}`;

      const description = formatToADF(descriptionText);

      // Determine overall test status from all test assertions for this execution
      // Note: exec.test or exec.tests array depends on Postman result structure
      // Here we check exec.tests or fallback to exec.tests with 'assertions' array


      const testAssertions = Array.isArray(exec.tests) ? exec.tests : [];

      let overallStatus = TEST_STATUS.SKIPPED;

      if (testAssertions.length > 0) {
        const anyFailed = testAssertions.some(a => a.status !== 'passed');
        overallStatus = anyFailed ? TEST_STATUS.FAILED : TEST_STATUS.PASSED;
      }

      const assertions = (exec.tests || []).map(t => {
        const passed = t.status?.toUpperCase() === 'PASSED';
        return {
          name: t.name,
          status: passed ? 'PASSED' : 'FAILED',
          error: passed ? null : {
            name: t.error?.name,
            message: t.error?.message,
            stack: t.error?.stack
          }
        };
      });

      // Create or update the test case in Jira/Xray
      const testKey = await createOrUpdateXrayTestCase(testCaseKeyCandidate, testCaseName, description, LABELS, testSetKey, testExecutionKey, overallStatus);


      // Handle bug management based on test status
      let bugKey = null
      if (overallStatus === TEST_STATUS.FAILED) {

        // Create or get existing bug for this test
        bugKey = await findExistingBugForTest(testKey);
        if (bugKey) {
          console.log(`Bug ${bugKey} linked to test : ${testKey}`);
          // Update bug status to OPEN or REOPENED depending on current status
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.REOPENED);

          // Track bug info for report
          addBugInfo({
            bugKey,
            status: BUG_LIFECYCLE.REOPENED,
            linkedTest: testKey,
          });
        }
        else {
          // Bug description can include failure info + Jenkins link
          const descriptionLines = [
            `🪳 **Failure detected for test case ${testKey}.\n\n${description}**`,
            `**Request:** ${exec.requestExecuted?.method || ''} ${exec.requestExecuted?.url?.raw || ''}`,
            `**Response:** ${exec.response?.code} ${exec.response?.status} in ${exec.response?.responseTime}ms`,
            '',
            '**Assertions:**',
            ...assertions.map(a => {
              let line = `- **${a.name}**: ${a.status.toUpperCase()}`;
              if (a.status !== 'passed' && a.error) {
                line += `\n  - **Error**: ${a.error.message}`;
                line += `\n  - **Stack**: ${a.error.stack}`;
              }
              return line;
            })
          ];
          const bugDescriptionText = descriptionLines.join('\n');

          const bugDescription = formatToADF(bugDescriptionText);
          bugKey = await createBugForTest(testKey, testCaseName, bugDescription);
          // Link bug to test case if not linked yet
          await linkBugToTestCase(bugKey, testKey);
          // Track bug info for report
          addBugInfo({
            bugKey,
            status: BUG_LIFECYCLE.REOPENED,
            linkedTest: testKey,
          });
        }


      } else if (overallStatus === TEST_STATUS.PASSED) {
        // Check if bug exists, then close it if still open
        const bugKey = await findExistingBugForTest(testKey);

        if (bugKey) {
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CLOSED);
          // Optional: track bug closure
          addBugInfo({
            bugKey,
            status: BUG_LIFECYCLE.CLOSED,
            linkedTest: testKey,
          });
        }
      }

      // Logging summary per test
      console.log(`Test case ${testKey} processed with status: ${overallStatus}`);
      // Always add test result summary
      addTestResult({
        testKey,
        name: testCaseName,
        status: overallStatus,
        bugKey,
      });
    }

    console.log('✅ All Postman test results synchronized successfully.');

    const summary = getSummary();
    await sendSummaryEmail(summary, process.env.REPORT_RECIPIENTS); // comma-separated list in .env

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
  getXrayAuthToken,
  createOrUpdateXrayTestCase,
  addTestToTestExecution,
  submitTestResult,
  getIssueId,
  addTestToTestSet,
  createBugForTest,
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

