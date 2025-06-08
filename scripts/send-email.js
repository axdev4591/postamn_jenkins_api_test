const nodemailer = require("nodemailer");

async function sendSummaryEmail(summary, recipients) {
  const { execution, tests, bugs } = summary;

  const passed = tests.filter(t => t.status === "PASSED").length;
  const failed = tests.filter(t => t.status === "FAILED").length;

  const html = `
    <h2>🧪 Test Execution Summary: ${execution.key}</h2>
    <p><b>Summary:</b> ${execution.summary}<br>
       <b>Date:</b> ${execution.date}<br>
       <b>Total Tests:</b> ${tests.length} |
       ✅ <b>Passed:</b> ${passed} |
       ❌ <b>Failed:</b> ${failed}</p>

    <h3>📋 Test Results</h3>
    <table border="1" cellpadding="5" cellspacing="0">
      <thead>
        <tr><th>Test Key</th><th>Name</th><th>Status</th><th>Bug</th></tr>
      </thead>
      <tbody>
        ${tests.map(t => `
          <tr>
            <td>${t.testKey}</td>
            <td>${t.name}</td>
            <td style="color:${t.status === 'PASSED' ? 'green' : 'red'}">${t.status}</td>
            <td>${t.bugKey || ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    <h3>🐞 Bug Summary</h3>
    <ul>
      ${bugs.map(b => `
        <li><b>${b.bugKey}</b> (${b.status}) — linked to ${b.linkedTest}</li>
      `).join('')}
    </ul>
  `;

  console.log('DEBUG - USER_EMAIL:', process.env.USER_EMAIL);
  console.log('DEBUG - USER_PASS:', process.env.USER_PASS ? 'Present' : 'Missing');

  const transporter = nodemailer.createTransport({
    service: 'Gmail', // or use 'SendGrid', 'Outlook', etc.
    auth: {
      user: process.env.USER_EMAIL,
      pass: process.env.USER_PASS,
    },
  });

  try {
    await transporter.sendMail({
      from: process.env.USER_EMAIL,
      to: recipients,
      subject: `📊 Xray Test Report - ${execution.key}`,
      html,
    });
    console.log(`📧 Summary email sent to: ${recipients}`);
  } catch (err) {
    console.error('❌ Failed to send summary email:', err.message || err);
  }


}

module.exports = { sendSummaryEmail };
