// sendPromptToMCP.js
const fetch = require('node-fetch');
const fs = require('fs');

// You can replace this with clipboard or editor integration later
const promptText = fs.readFileSync('sample-code.js', 'utf8');

async function sendToMCP(prompt) {
  const payload = {
    prompt,
    context: {
      filename: 'sample-code.js',
      language: 'javascript',
      metadata: {}
    }
  };

  const response = await fetch('http://localhost:9222/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  console.log('\n🧠 MCP Response:\n');
  console.log(result.answer || result.text || JSON.stringify(result, null, 2));
}

sendToMCP(`Explain the following code:\n\n${promptText}`);

