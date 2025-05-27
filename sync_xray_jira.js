// sync_xray_jira.js
// Description: Syncs Postman results with Xray test cases and Jira bugs

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const {
  JIRA_BASE_URL,
  JIRA_USER,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY,
  BUG_ISSUE_TYPE,
  XRAY_CLIENT_ID,
  XRAY_CLIENT_SECRET,
  XRAY_BASE_URL
} = process.env;

const auth = {
  username: JIRA_USER,
  password: JIRA_API_TOKEN
};

let xrayToken = null;

/**
 * Authenticate with Xray Cloud and get a token
 */
async function getXrayToken() {
  if (xrayToken) return xrayToken;

  const res = await axios.post(`${XRAY_BASE_URL}/api/v2/authenticate`, {
    client_id: XRAY_CLIENT_ID,
    client_secret: XRAY_CLIENT_SECRET
  });

  xrayToken = res.data;
  return xrayToken;
}

/**
 * Extract Jira test key from Postman request title (e.g., "[TEST-123]")
 */
function extractTestKey(name) {
  const match = name.match(/\[(TEST-\d+)\]/);
  return match ? match[1] : null;
}

/**
 * Load Postman results from results.json
 */
function loadResults(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Get existing bug related to a test key (if exists)
 */
async function getBugForTestKey(testKey) {
  const jql = `project = ${JIRA_PROJECT_KEY} AND issuetype = ${BUG_ISSUE_TYPE} AND description ~ "${testKey}"`;
  const res = await axios.get(`${JIRA_BASE_URL}/rest/api/2/search?jql=${encodeURIComponent(jql)}`, { auth });
  return res.data.issues[0];
}

/**
 * Create a Jira bug and link to test key
 */
async function createBug(testKey, summary, logs) {
  const res = await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue`, {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary: `[AUTO] Bug for ${testKey}: ${summary}`,
      description: `Auto-generated bug linked to test case ${testKey}`,
      issuetype: { name: BUG_ISSUE_TYPE }
    }
  }, { auth });

  const issueKey = res.data.key;
  await attachFile(issueKey, logs);
  await linkIssues(testKey, issueKey);
  return issueKey;
}

/**
 * Reopen a closed Jira issue
 */
async function reopenIssue(issueKey) {
  const res = await axios.get(`${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/transitions`, { auth });
  const reopen = res.data.transitions.find(t => t.name.toLowerCase().includes('reopen'));
  if (reopen) {
    await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/transitions`, {
      transition: { id: reopen.id }
    }, { auth });
  }
}

/**
 * Close a Jira issue (if not already closed)
 */
async function closeIssue(issueKey) {
  const res = await axios.get(`${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/transitions`, { auth });
  const done = res.data.transitions.find(t => t.name.toLowerCase().includes('done') || t.name.toLowerCase().includes('close'));
  if (done) {
    await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/transitions`, {
      transition: { id: done.id }
    }, { auth });
  }
}

/**
 * Link test and bug
 */
async function linkIssues(testKey, bugKey) {
  await axios.post(`${JIRA_BASE_URL}/rest/api/2/issueLink`, {
    type: { name: "Relates" },
    inwardIssue: { key: testKey },
    outwardIssue: { key: bugKey }
  }, { auth }).catch(() => { });
}

/**
 * Attach a log file to a Jira issue
 */
async function attachFile(issueKey, content) {
  const form = new FormData();
  const fileName = `temp-${issueKey}.log`;
  fs.writeFileSync(fileName, content);
  form.append('file', fs.createReadStream(fileName));
  await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/attachments`, form, {
    headers: {
      ...form.getHeaders(),
      'X-Atlassian-Token': 'no-check'
    },
    auth
  });
  fs.unlinkSync(fileName);
}

/**
 * Create a test case in Xray (if not already exists)
 */
async function createXrayTest(name) {
  const res = await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue`, {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary: name,
      issuetype: { name: 'Test' },
      description: 'Test generated from Postman collection',
      customfield_10049: 'Jenkins_postman' // Change this to match your custom field ID if needed
    }
  }, { auth });

  return res.data.key;
}

/**
 * Create a Test Execution in Xray
 */
async function createTestExecution(name) {
  const res = await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue`, {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary: `Test Execution - ${name}`,
      issuetype: { name: 'Test Execution' },
      description: `Run from Jenkins for collection: ${name}`
    }
  }, { auth });

  return res.data.key;
}

/**
 * Submit test result to Xray
 */
async function submitResultToXray(testKey, status, execKey) {
  const token = await getXrayToken();

  const payload = {
    testExecutionKey: execKey,
    info: {
      summary: "Automated Execution from Postman CLI",
      description: "Postman test result sync from Jenkins",
      testEnvironments: ["Jenkins"]
    },
    tests: [{
      testKey,
      status
    }]
  };

  await axios.post(`${XRAY_BASE_URL}/api/v2/import/execution`, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Main entrypoint
 */
async function main(resultsPath) {
  const results = loadResults(resultsPath);
  const collectionName = results.collection.info.name;
  const executionKey = await createTestExecution(collectionName);

  for (const run of results.run.executions) {
    const name = run.item.name;
    let testKey = extractTestKey(name);

    // If testKey is not embedded, create a new test case
    if (!testKey) {
      testKey = await createXrayTest(name);
    }

    // Generate log content
    const logs = `Request:\n${JSON.stringify(run.request, null, 2)}\n\nResponse:\n${JSON.stringify(run.response, null, 2)}`;
    const failed = run.assertions?.some(a => a.error);

    // Update test result in Xray
    await submitResultToXray(testKey, failed ? "FAIL" : "PASS", executionKey);

    // Bug sync
    const bug = await getBugForTestKey(testKey);
    if (failed) {
      if (!bug) {
        await createBug(testKey, name, logs);
      } else if (['done', 'close'].includes(bug.fields.status.name.toLowerCase())) {
        await reopenIssue(bug.key);
        await attachFile(bug.key, logs);
      } else {
        await attachFile(bug.key, logs);
      }
    } else if (bug) {
      await closeIssue(bug.key);
    }
  }
}

// Run the script
main(process.argv[2] || 'results.json').catch(err => {
  console.error("❌ Error:", err.response?.data || err.message || err);
  process.exit(1);
});
