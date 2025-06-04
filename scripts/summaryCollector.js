// summaryCollector.js
const summary = {
    execution: {},
    tests: [],
    bugs: [],
};

function setExecutionInfo(info) {
    summary.execution = info;
}

function addTestResult({ testKey, name, status, bugKey }) {
    summary.tests.push({ testKey, name, status, bugKey });
}

function addBugInfo({ bugKey, status, linkedTest }) {
    summary.bugs.push({ bugKey, status, linkedTest });
}

function getSummary() {
    return summary;
}

module.exports = {
    setExecutionInfo,
    addTestResult,
    addBugInfo,
    getSummary,
};
