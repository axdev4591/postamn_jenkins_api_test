# Postman to Jira/Xray Sync

## Overview

This Node.js script automates synchronizing Postman API test results with Jira and Xray test management tool. It performs the following:

- Extracts Test Execution, Test Set, and Test Case keys from Postman naming conventions.
- Creates or updates Jira issues for Test Executions, Test Sets, and Test Cases.
- Links Test Cases to their respective Test Sets and Test Executions.
- Automatically creates Jira Bugs for failed tests, attaches detailed logs, and links bugs to test cases.
- Adds useful labels (`jenkins`, `postman`, `automation`, `TNR`) for filtering.
- Provides descriptive issue descriptions including API details and test scenarios extracted from Postman scripts.
- Skips invalidly named test items but logs warnings for review.
- Writes detailed logs for each failed test case, attaches them to corresponding Jira Bugs.

---

## Naming Conventions

- **Test Execution (Postman Collection Name):**  
  Include `[TE-xx]` where `xx` is a two-digit numeric ID, e.g., `[TE-01]`

- **Test Set (Postman Folder Name):**  
  Include `[TS-xx]` where `xx` is a two-digit numeric ID, e.g., `[TS-01]`

- **Test Case (Postman Request Name):**  
  Must include `[APIxx-TSxx-TExx]` where:  
  - `APIxx` identifies the API/test number,  
  - `TSxx` corresponds to the test set,  
  - `TExx` corresponds to the test execution.

Example request name: `[API01-TS01-TE01] Get videogames list`

---

## Prerequisites

- **Jira & Xray setup:**  
  - Jira project with Test and Test Execution issue types.  
  - API tokens for Jira and Xray.

- **Postman CLI installed on Jenkins or local machine.**

- **Node.js environment:**  
  Tested with Node.js v16+

- **Environment Variables Required:**  
  - `XRAY_BASE_URL`  
  - `XRAY_CLIENT_ID`  
  - `XRAY_CLIENT_SECRET`  
  - `JIRA_BASE_URL`  
  - `JIRA_USER` (your Jira username/email)  
  - `JIRA_API_TOKEN` (Jira API token)  
  - `JIRA_PROJECT_KEY`  
  - `BUG_ISSUE_TYPE` (default: 'Bug')

---

## Setup & Usage

1. Clone or copy this repository.

2. Install dependencies:

   ```bash
   npm install axios
