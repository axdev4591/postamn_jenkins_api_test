const fs = require('fs');
const axios = require('axios');

const XRAY_BASE_URL = process.env.XRAY_BASE_URL; // e.g. https://xray.cloud.getxray.app/api/v2
const XRAY_CLIENT_ID = process.env.XRAY_CLIENT_ID;
const XRAY_CLIENT_SECRET = process.env.XRAY_CLIENT_SECRET;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL; // e.g. https://yourdomain.atlassian.net
const JIRA_USER = process.env.JIRA_USER;         // Jira email or username
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'TEST';
const BUG_ISSUE_TYPE = process.env.BUG_ISSUE_TYPE || 'Bug';
const BUG_LINK_TYPE = 'Relates'; // You can customize this (e.g. "Blocks")

if (!XRAY_BASE_URL || !XRAY_CLIENT_ID || !XRAY_CLIENT_SECRET || !JIRA_BASE_URL || !JIRA_USER || !JIRA_API_TOKEN) {
  console.error('Missing one or more required environment variables.');
  process.exit(1);
}

const jiraAuthHeader = {
  Authorization: `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`,
  'Content-Type': 'application/json'
};

async function getXrayToken() {
  try {
    const resp = await axios.post(`${XRAY_BASE_URL}/authenticate`, {
      client_id: XRAY_CLIENT_ID,
      client_secret: XRAY_CLIENT_SECRET
    });
    return resp.data;
  } catch (err) {
    console.error('Error authenticating with Xray:', err.response?.data || err.message);
    process.exit(1);
  }
}

async function importResultsToXray(token, resultsData) {
  try {
    const resp = await axios.post(
      `${XRAY_BASE_URL}/import/execution/postman`,
      resultsData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Xray import response:', JSON.stringify(resp.data, null, 2));
    return resp.data;
  } catch (err) {
    console.error('Error importing results to Xray:', err.response?.data || err.message);
    process.exit(1);
  }
}

async function findBugIssue(jiraAuthHeader, testKey) {
  // Search for an existing bug issue with summary containing testKey and unresolved status
  const jql = `project = ${JIRA_PROJECT_KEY} AND summary ~ "${testKey}" AND issuetype = ${BUG_ISSUE_TYPE} ORDER BY created DESC`;
  try {
    const resp = await axios.get(
      `${JIRA_BASE_URL}/rest/api/3/search`,
      {
        params: { jql, maxResults: 10 },
        headers: jiraAuthHeader
      }
    );
    return resp.data.issues;
  } catch (err) {
    console.error('Error searching Jira issues:', err.response?.data || err.message);
    return [];
  }
}

async function createBugIssue(jiraAuthHeader, testKey, summary, description) {
  const payload = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary,
      description,
      issuetype: { name: BUG_ISSUE_TYPE }
    }
  };
  try {
    const resp = await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue`,
      payload,
      { headers: jiraAuthHeader }
    );
    return resp.data.key;
  } catch (err) {
    console.error('Error creating Jira bug:', err.response?.data || err.message);
    return null;
  }
}

async function updateBugStatus(jiraAuthHeader, issueKey, transitionName) {
  try {
    // Get transitions available for the issue
    const resp = await axios.get(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/transitions`, { headers: jiraAuthHeader });
    const transition = resp.data.transitions.find(t => t.name.toLowerCase() === transitionName.toLowerCase());
    if (!transition) {
      console.warn(`Transition "${transitionName}" not found for issue ${issueKey}`);
      return false;
    }
    // Perform transition
    await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/transitions`,
      { transition: { id: transition.id } },
      { headers: jiraAuthHeader }
    );
    return true;
  } catch (err) {
    console.error(`Error transitioning issue ${issueKey}:`, err.response?.data || err.message);
    return false;
  }
}

async function linkIssues(jiraBaseUrl, jiraAuthHeader, inwardIssueKey, outwardIssueKey) {
  // inwardIssueKey = bug; outwardIssueKey = xray test
  const payload = {
    type: { name: BUG_LINK_TYPE },
    inwardIssue: { key: inwardIssueKey },
    outwardIssue: { key: outwardIssueKey }
  };
  try {
    await axios.post(`${jiraBaseUrl}/rest/api/3/issueLink`, payload, { headers: jiraAuthHeader });
    console.log(`Linked bug ${inwardIssueKey} to test case ${outwardIssueKey}`);
  } catch (err) {
    if (err.response && err.response.status === 400 && err.response.data.errorMessages && err.response.data.errorMessages.some(m => m.includes('already exists'))) {
      console.log(`Link between ${inwardIssueKey} and ${outwardIssueKey} already exists.`);
    } else {
      console.error(`Error linking issues ${inwardIssueKey} -> ${outwardIssueKey}:`, err.response?.data || err.message);
    }
  }
}

async function processFailedTests(tests) {
  for (const test of tests.filter(t => t.status === 'FAILED')) {
    const testKey = test.testKey;
    if (!testKey) {
      console.warn('Skipping failed test with no testKey:', test);
      continue;
    }

    // Search for existing bugs related to this testKey
    const existingBugs = await findBugIssue(jiraAuthHeader, testKey);

    let bugKey = null;

    if (existingBugs.length === 0) {
      // Create a new bug
      console.log(`Creating new bug for failed test ${testKey}`);
      const summary = `Failed test bug for ${testKey}`;
      const description = `Automatically created bug for failed test case ${testKey} imported from Postman results.`;
      bugKey = await createBugIssue(jiraAuthHeader, testKey, summary, description);
    } else {
      // Pick the most recent bug
      bugKey = existingBugs[0].key;

      // Check if bug is closed/done and reopen if needed
      const status = existingBugs[0].fields.status.name.toLowerCase();
      if (['done', 'closed', 'resolved'].includes(status)) {
        console.log(`Reopening closed bug ${bugKey} for failed test ${testKey}`);
        await updateBugStatus(jiraAuthHeader, bugKey, 'Reopen');
      }
    }

    if (bugKey) {
      // Link bug to Xray test case
      await linkIssues(JIRA_BASE_URL, jiraAuthHeader, bugKey, testKey);
    }
  }
}

async function processPassedTests(tests) {
  for (const test of tests.filter(t => t.status === 'PASSED')) {
    const testKey = test.testKey;
    if (!testKey) {
      continue;
    }
    // Search for existing bugs related to this testKey
    const existingBugs = await findBugIssue(jiraAuthHeader, testKey);

    for (const bug of existingBugs) {
      const bugKey = bug.key;
      const status = bug.fields.status.name.toLowerCase();
      if (!['done', 'closed', 'resolved'].includes(status)) {
        console.log(`Closing bug ${bugKey} for passed test ${testKey}`);
        await updateBugStatus(jiraAuthHeader, bugKey, 'Close');
      }
    }
  }
}

async function main() {
  const resultsFile = process.argv[2] || 'results.json';
  if (!fs.existsSync(resultsFile)) {
    console.error(`Results file "${resultsFile}" not found!`);
    process.exit(1);
  }

  const resultsData = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const xrayToken = await getXrayToken();
  const importResponse = await importResultsToXray(xrayToken, resultsData);

  if (!importResponse.tests || importResponse.tests.length === 0) {
    console.log('No tests found in Xray import response.');
    return;
  }

  await processFailedTests(importResponse.tests);
  await processPassedTests(importResponse.tests);

  console.log('Finished syncing Xray and Jira.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
