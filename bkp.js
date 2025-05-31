
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
const RE_TEST_EXECUTION = /\[(IDC-\d+)\]/;
const RE_TEST_SET = /\[(IDC-\d+)\]/;
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

        // Link to Test Set
        console.log(`🔗 Add test to Test Set: ${testSetKey}`);
        await addTestToTestSet(testCaseKey, testSetKey)
        //await linkTestToTestSet(testCaseKey, testSetKey);

        // Link to Test Execution
        await linkTestToTestExecution(testCaseKey, testExecutionKey);

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

// ============================
// 📎 Link test to test execution
// ============================
/*
async function linkTestToTestExecution(testIssueKey, testExecutionKey) {
  try {
    const token = await getXrayAuthToken();

    const url = `${process.env.JIRA_BASE_URL}/rest/raven/1.0/api/testexec/${testExecutionKey}/test`;
    console.log("👉 Linking test to Test Execution via:", url);

    await axios.post(url, {
      //  testExecutionKey,
      "add": [testIssueKey]
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`🔗 Linked test ${testIssueKey} to Test Execution ${testExecutionKey}`);
  } catch (error) {
    console.error(`❌ Failed to link test ${testIssueKey} to Test Execution ${testExecutionKey}:`, error.response?.data || error.message);
  }
}*/
async function linkTestToTestExecution(testIssueKey, testExecutionKey) {
    try {
        const token = await getXrayAuthToken();

        const url = `${process.env.XRAY_BASE_URL}/api/v2/graphql`;

        const query = {
            query: `
        mutation {
          addTestsToTestExecution(issueId: "${testExecutionKey}", testIssueIds: ["${testIssueKey}"]) {
            addedTests
          }
        }
      `
        };

        const response = await axios.post(url, query, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            }
        });

        console.log(`✅ Linked test ${testIssueKey} to Test Execution ${testExecutionKey}`);
    } catch (error) {
        console.error(`❌ Failed to link test ${testIssueKey} to Test Execution ${testExecutionKey}:`, error.response?.data || error.message);
    }
}



// ============================
// 📎 Add test to test set
// ============================
async function addTestToTestSet(testKey, testSetKey) {
    const token = await getXrayAuthToken();
    const url = `${process.env.XRAY_BASE_URL}/api/v2/testset/${testSetKey}/test`;

    const payload = {
        add: [testKey]
    };

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ Added test ${testKey} to Test Set ${testSetKey}`);
    } catch (error) {
        console.error(`❌ Failed to add test ${testKey} to Test Set ${testSetKey}:`, error.response?.data || error.message);
    }
}

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

async function findTestSetBySummary(summary) {
    const jql = `project = ${JIRA_PROJECT_KEY} AND issuetype = "Test Set" AND summary ~ "${summary}"`;
    const url = `${JIRA_BASE_URL}/rest/api/2/search?jql=${encodeURIComponent(jql)}`;

    const response = await axios.get(url, {
        headers: {
            Authorization: `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`,
            Accept: 'application/json',
        },
    });

    if (response.data.issues.length > 0) {
        return response.data.issues[0];  // Return the first matched Test Set issue
    }
    return null;
}

async function createTestSet(summary) {
    const url = `${JIRA_BASE_URL}/rest/api/2/issue`;
    const payload = {
        fields: {
            project: {
                key: JIRA_PROJECT_KEY,
            },
            summary: summary,
            issuetype: {
                name: "Test Set",
            },
        },
    };

    const response = await axios.post(url, payload, {
        headers: {
            Authorization: `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`,
            'Content-Type': 'application/json',
        },
    });

    return response.data; // Contains new issue key and id
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


//verify keys exist in jira
/*
const verifyJiraIssueExists = async (issueKey, expectedType) => {
  try {
    const response = await axios.get(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}`, {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    const actualType = response.data.fields.issuetype.name;
    if (actualType !== expectedType) {
      throw new Error(`Issue ${issueKey} is of type ${actualType}, expected ${expectedType}`);
    }

    return true;
  } catch (err) {
    console.error(`❌ Failed to verify issue ${issueKey}:`, err.response?.data || err.message);
    return false;
  }
};*/

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
            // Note: exec.assertions or exec.tests array depends on Postman result structure
            // Here we check exec.assertions or fallback to exec.tests with 'assertions' array
            const testAssertions = exec.tests || (exec.tests && exec.tests.length ? exec.tests : []);
            // If no assertions, mark skipped
            let overallStatus = TEST_STATUS.SKIPPED;
            if (testAssertions.length > 0) {
                // If any assertion failed → FAILED, else PASSED
                const anyFailed = testAssertions.some(a => a.error !== undefined && a.error !== null);
                overallStatus = anyFailed ? TEST_STATUS.FAILED : TEST_STATUS.PASSED;
            }

            // Create or update the test case in Jira/Xray
            const testKey = await createOrUpdateXrayTestCase(testCaseKeyCandidate, testCaseName, description, LABELS, testSetKey, testExecutionKey);

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
    linkTestToTestExecution,
    linkTestToTestSet,
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


