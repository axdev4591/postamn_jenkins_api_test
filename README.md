# Postman to Jira Sync

## Overview
This project contains:

- Jenkins pipeline (Jenkinsfile) that runs Postman collections and syncs failed tests to Jira bugs.
- Node.js script (`sync_jira.js`) that parses Postman results and manages Jira bugs.

## Setup

1. Install Node.js 16 or higher.
2. Install dependencies:
3. Set Jira environment variables in Jenkins or your environment:
- `JIRA_BASE_URL`
- `JIRA_USER`
- `JIRA_API_TOKEN`
- `JIRA_PROJECT_KEY` (optional, default is "TEST")

4. Run Postman collection via Postman CLI in Jenkins.
5. Run `node sync_jira.js` to sync results.

## Jenkins Pipeline

See the `Jenkinsfile` for full pipeline setup.

## Notes

- Attachments (logs and results) are uploaded to Jira bugs.
- Test keys should be in test names as `[PROJECT-123]`.


## Notes & Tips
Put sync_xray_jira.js and a package.json with at least axios dependency into your repo root.

Jenkins credentials (POSTMAN_API_KEY, XRAY_CLIENT_ID, XRAY_CLIENT_SECRET, JIRA_USER, JIRA_API_TOKEN) must be configured in Jenkins and referenced properly.

The script assumes Xray Cloud REST API v2. Adjust URLs or endpoints if you use Xray Server/Data Center.

The bug searching relies on Jira JQL searching by summary. If you want more robust linking, consider custom fields or labels.

The bug status transitions ("Reopen", "Close") must exist in your Jira workflows; you can adjust transition names as needed.

The Jira issue linking uses "Relates" link type; you can customize this.

Logs, request/response bodies, and attaching files can be added in the bug creation/update steps if desired, but that can get more complex.