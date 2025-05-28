const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Constants for test statuses returned by Postman / used in Xray
const TEST_STATUS = {
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
};

// Constants for Jira bug lifecycle statuses (you can adjust as needed)
const BUG_LIFECYCLE = {
  CREATED: 'OPEN',
  REOPENED: 'REOPENED',
  CLOSED: 'CLOSED',
};

// Labels applied to Test Executions, Test Sets, Test Cases, and Bugs
const LABELS = ['jenkins', 'postman', 'automation', 'TNR'];

// Regex patterns for naming conventions
const RE_TEST_EXECUTION = /\[(TE-\d+)\]/;    // e.g. [TE-01]
const RE_TEST_SET = /\[(TS-\d+)\]/;          // e.g. [TS-01]
const RE_TEST_CASE = /\[(API\d+-TS\d+-TE\d+)\]/;  // e.g. [API01-TS01-TE01]

// Link to Jenkins pipeline (to be customized)
const JENKINS_PIPELINE_LINK = 'https://af21-2001-861-e382-1c30-3121-f5e-3445-26f1.ngrok-free.app/job/postman-xray-pipeline/';

// Entry point of the script
async function main() {
  try {
    // Read command line argument for Postman results JSON path
    const resultsFile = process.argv[2];
    if (!resultsFile) {
      throw new Error('Missing Postman results JSON file argument');
    }

    // Load and parse Postman results JSON
    const results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));

    // Extract test execution key from collection name
    const collectionName = results.collection.info.name;
    const execKeyMatch = collectionName.match(RE_TEST_EXECUTION);
    if (!execKeyMatch) {
      throw new Error(`Collection name must contain test execution key like [TE-xx]. Found: ${collectionName}`);
    }
    const testExecutionKey = execKeyMatch[1];

    console.log(`Test Execution Key: ${testExecutionKey}`);

    // Extract test sets from folders
    const testSets = {};
    for (const folder of results.collection.item) {
      const folderName = folder.name;
      const testSetMatch = folderName.match(RE_TEST_SET);
      if (!testSetMatch) {
        console.warn(`Skipping folder with invalid test set name (missing [TS-xx]): ${folderName}`);
        continue; // Skip invalid test sets
      }
      const testSetKey = testSetMatch[1];
      testSets[testSetKey] = folder;
    }

    // Process each test set folder
    for (const [testSetKey, folder] of Object.entries(testSets)) {
      console.log(`Processing Test Set: ${testSetKey}`);

      // For each request (test case) inside the folder
      for (const requestItem of folder.item) {
        const testCaseName = requestItem.name;
        const testCaseMatch = testCaseName.match(RE_TEST_CASE);

        // Validate test case naming convention
        if (!testCaseMatch) {
          console.warn(`Skipping test case with invalid name (missing [APIxx-TSxx-TExx]): ${testCaseName}`);
          continue; // Skip invalid test cases
        }

        const testCaseKey = testCaseMatch[1];

        // Extract request details for description
        const method = requestItem.request.method || 'N/A';
        const url = requestItem.request.url ? buildUrl(requestItem.request.url) : 'N/A';
        const body = requestItem.request.body ? JSON.stringify(requestItem.request.body) : '{}';
        const headers = requestItem.request.header ? JSON.stringify(requestItem.request.header) : '{}';
        const params = extractParams(requestItem.request.url);

        // Extract test scripts from event listeners (tests)
        const testScripts = extractTestScripts(requestItem.event);

        // Compose test case description
        const testCaseDescription = `
This is an Automated Postman API test, triggered from Jenkins pipeline, running a Node.js script.

API:
- Method: ${method}
- Endpoint: ${url}
- Body: ${body}
- Headers: ${headers}
- Params: ${params}

Test scenarios:
${testScripts}

Jenkins Trigger Info:
- Test Execution Key: ${testExecutionKey}
- Test Set: ${testSetKey}
- Test Case Key: ${testCaseKey}
- Jenkins Pipeline: ${JENKINS_PIPELINE_LINK}
`.trim();

        // Determine test result for this test case from Postman results
        const testResult = findTestResult(results, testCaseKey);
        if (!testResult) {
          console.warn(`No test result found for test case key ${testCaseKey}. Marking as SKIPPED.`);
        }

        // Create or update Xray Test Case with description and labels
        await createOrUpdateXrayTestCase(testCaseKey, testCaseName, testCaseDescription, LABELS);

        // Handle test execution link and labels similarly (not shown here for brevity)

        // Handle bugs for failed tests
        if (testResult && testResult.status === TEST_STATUS.FAILED) {
          // Compose bug description
          const bugDescription = `
This is an automatically generated bug, triggered from Jenkins pipeline, running a Node.js script.

This bug is linked to the Jira test case ${testCaseKey}.

Logs are attached below.
          `.trim();

          // Create or update Jira bug linked to this test case
          const bugKey = await createOrUpdateJiraBug(testCaseKey, testCaseName, bugDescription, LABELS);

          // Attach logs file per failed test (file name includes test key + timestamp)
          const logFileName = await createLogFileForTest(testCaseKey, testResult);
          await attachFileToJiraIssue(bugKey, logFileName);

          // Update bug status according to lifecycle constants
          await updateJiraBugStatus(bugKey, BUG_LIFECYCLE.CREATED);
        }
      }
    }

    console.log('Sync completed successfully.');
  } catch (err) {
    console.error('Error during sync:', err);
    process.exit(1); // Fail script with error code
  }
}

/**
 * Build a full URL string from Postman URL object
 */
function buildUrl(urlObj) {
  if (typeof urlObj === 'string') return urlObj;
  const protocol = urlObj.protocol || 'https';
  const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host;
  const path = Array.isArray(urlObj.path) ? urlObj.path.join('/') : urlObj.path;
  return `${protocol}://${host}/${path}`;
}

/**
 * Extract query parameters string from Postman URL object
 */
function extractParams(urlObj) {
  if (!urlObj.query || urlObj.query.length === 0) return '{}';
  const params = {};
  for (const param of urlObj.query) {
    params[param.key] = param.value;
  }
  return JSON.stringify(params);
}

/**
 * Extract test scripts from Postman test event array
 */
function extractTestScripts(events) {
  if (!events) return 'No test scripts found.';
  const testEvent = events.find(e => e.listen === 'test');
  if (!testEvent || !testEvent.script || !testEvent.script.exec) return 'No test scripts found.';
  return testEvent.script.exec.join('\n');
}

/**
 * Find test result object for a given test case key inside Postman results
 */
function findTestResult(results, testCaseKey) {
  // Postman test results contain runs, each has assertions and test names
  for (const run of results.run.executions) {
    // The test name should contain the test case key (e.g. [API01-TS01-TE01])
    if (run.item.name.includes(testCaseKey)) {
      // Extract status from assertions
      const failedAssertions = run.assertions.filter(a => a.error);
      if (failedAssertions.length > 0) {
        return { status: TEST_STATUS.FAILED, details: failedAssertions };
      }
      return { status: TEST_STATUS.PASSED };
    }
  }
  return null; // Not found
}

/**
 * Stub: Create or update an Xray Test Case in Jira
 * Implement your REST API calls here
 */
async function createOrUpdateXrayTestCase(key, name, description, labels) {
  console.log(`Creating/updating Xray Test Case: ${key}`);
  // TODO: Implement API calls
}

/**
 * Stub: Create or update Jira Bug linked to a test case
 * Implement your REST API calls here
 */
async function createOrUpdateJiraBug(testCaseKey, summary, description, labels) {
  console.log(`Creating/updating Jira Bug for test case: ${testCaseKey}`);
  // TODO: Implement API calls
  return 'BUG-123'; // Example bug key
}

/**
 * Stub: Create a log file for failed test case
 */
async function createLogFileForTest(testCaseKey, testResult) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `sync_xray_jira_logs_${testCaseKey}_${timestamp}.txt`;
  const logContent = `Test case: ${testCaseKey}\nStatus: ${testResult.status}\nDetails: ${JSON.stringify(testResult.details || {})}\n`;
  fs.writeFileSync(path.join(__dirname, fileName), logContent);
  return path.join(__dirname, fileName);
}

/**
 * Stub: Attach a file to a Jira issue
 * Implement your REST API calls here
 */
async function attachFileToJiraIssue(issueKey, filePath) {
  console.log(`Attaching file ${filePath} to Jira issue ${issueKey}`);
  // TODO: Implement API calls
}

/**
 * Stub: Update Jira Bug status according to lifecycle constants
 */
async function updateJiraBugStatus(bugKey, lifecycleStatus) {
  console.log(`Updating Jira bug ${bugKey} status to ${lifecycleStatus}`);
  // TODO: Implement API calls
}

// Run main
main();
