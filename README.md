# 🧪 Xray-Jira-Postman Integration via Jenkins

This project automates API test execution using Postman, synchronizes test results with [Xray](https://www.getxray.app/) (Jira test management), and manages Jira bugs based on test outcomes — all integrated into a Jenkins CI/CD pipeline.

---

## 📦 What This Project Does

- ✅ Runs Postman collections from Postman Cloud via CLI
- ✅ Automatically generates `results.json` from Postman test runs
- ✅ Creates or updates test cases in **Xray**
- ✅ Creates, reopens, or closes **Jira Bugs** for failing/passing tests
- ✅ Extracts and attaches full **request/response logs** to bugs
- ✅ Keeps Xray test cases editable in the Jira UI

---

## 📁 Project Structure


---

## 🚀 Jenkins Pipeline
The Jenkins pipeline:
1. Downloads the Postman CLI
2. Runs the collection using Cloud Collection ID and Environment ID
3. Exports results as `results.json`
4. Runs the Node.js script to:
   - Update/create Xray test cases
   - Open/reopen/close Jira bugs
   - Attach logs with request/response data to relevant bugs

Pipeline uses `Jenkinsfile` (see this repo) and is triggered manually or by schedule (cron).

---

## 🔐 Environment Configuration

Create a Jenkins credential (or `.env` file locally for testing) with the following variables:

```env
# Postman
POSTMAN_API_KEY=...

# Jira
JIRA_USER=email@example.com
JIRA_API_TOKEN=your-api-token
JIRA_BASE_URL=https://yourdomain.atlassian.net
JIRA_PROJECT_KEY=ABC
BUG_ISSUE_TYPE=Bug

# Xray
XRAY_CLIENT_ID=your-xray-client-id
XRAY_CLIENT_SECRET=your-xray-secret
XRAY_BASE_URL=https://xray.cloud.getxray.app/api/v2


## Notes

- Attachments (logs and results) are uploaded to Jira bugs.
- Test keys should be in test names as `[PROJECT-123]`.



*Note:* Jenkins pipeline accesses these securely via Jenkins credentials binding.

---

## Setup

1. Clone the repository.
2. Run (npm init -y) `npm install` to install dependencies (`axios`, `form-data`, `dotenv`).
3. Configure Jenkins credentials:
   - `POSTMAN_API_KEY` — Your Postman API key.
   - `JIRA_USER` and `JIRA_API_TOKEN` or set as environment variables.
   - `XRAY_CLIENT_ID` and `XRAY_CLIENT_SECRET` for Xray API.
4. Set Jenkins NodeJS tool installation name to `NodeJS-16` or adjust the pipeline accordingly.

---

## How It Works

### Jenkins Pipeline (`Jenkinsfile`)

- Installs Postman CLI dynamically (cached).
- Logs in to Postman CLI using API key.
- Runs Postman collection tests based on collection ID and environment ID parameters.
- Generates a fresh `results.json` for the current run.
- Runs `sync_xray_jira.js` script to:
  - Create/update Xray test cases for each API test in the collection.
  - Create/update bugs in Jira for failed tests.
  - Attach detailed request/response logs to bugs.
  - Create/update a Test Execution in Xray reflecting the current test run results.

---

## sync_xray_jira.js

- Parses the Postman test results JSON.
- Extracts Jira test keys embedded in test names (e.g., `[TEST-123]`).
- Synchronizes test statuses and bugs in Jira/Xray.
- Attaches failed test logs (requests/responses) to Jira bugs.

---

## Notes

- The Postman collection and environment are **not stored locally**; they are fetched dynamically from Postman Cloud.
- Test logs and results are generated dynamically on each Jenkins run.
- Manual edits to test cases in Xray GUI are preserved and **not overwritten** by pipeline runs.
- Bugs are reopened or closed automatically based on test results.
- Jenkins pipeline is designed to run daily or on SCM changes as configured.

---



## Notes & Tips
Put sync_xray_jira.js and a package.json with at least axios dependency into your repo root.

Jenkins credentials (POSTMAN_API_KEY, XRAY_CLIENT_ID, XRAY_CLIENT_SECRET, JIRA_USER, JIRA_API_TOKEN) must be configured in Jenkins and referenced properly.

The script assumes Xray Cloud REST API v2. Adjust URLs or endpoints if you use Xray Server/Data Center.

The bug searching relies on Jira JQL searching by summary. If you want more robust linking, consider custom fields or labels.

The bug status transitions ("Reopen", "Close") must exist in your Jira workflows; you can adjust transition names as needed.

The Jira issue linking uses "Relates" link type; you can customize this.

Logs, request/response bodies, and attaching files can be added in the bug creation/update steps if desired, but that can get more complex.

Make sure your Postman test names include a test key like [TEST-123]. Example:

{
  "name": "[TEST-123] Should return 200 on GET /users"
}