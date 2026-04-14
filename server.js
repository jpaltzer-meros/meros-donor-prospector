const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error?.message || 'HTTP ' + res.statusCode));
          else resolve(parsed);
        } catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractJSON(text) {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('No JSON array in response.');
  let str = m[0].replace(/```json|```/g, '').trim();
  try { return JSON.parse(str); } catch(e) {
    const last = str.lastIndexOf('}');
    if (last > -1) { try { return JSON.parse(str.slice(0, last + 1) + ']'); } catch(e2) {} }
    throw new Error('Could not parse JSON.');
  }
}

async function runWebSearch(prompt) {
  let messages = [{ role: 'user', content: prompt }];
  for (let i = 0; i < 6; i++) {
    const data = await callAnthropic({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages
    });
    if (data.stop_reason === 'end_turn') {
      return extractJSON((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'));
    }
    if (data.stop_reason === 'tool_use') {
      const results = (data.content || []).filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(b.input || '') }));
      messages = [...messages, { role: 'assistant', content: data.content }, { role: 'user', content: results }];
    } else {
      return extractJSON((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'));
    }
  }
  throw new Error('Loop limit reached.');
}

async function runKnowledge(prompt) {
  const data = await callAnthropic({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt + ' Use training knowledge. Use real ProPublica URLs. Flag uncertain records.' }]
  });
  return extractJSON((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Search endpoint
  if (req.method === 'POST' && req.url === '/search') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable not set.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { unis, keywords, sources } = JSON.parse(body);
        const uniList = unis.join(", ");
        const kwList = keywords.join(", ");
        const prompt = "Find real public donors for health research at: " + uniList + ". Keywords: " + kwList + ". Sources: " + sources + ". Return JSON array of 8 records, each with: name, type (Individual/Family Foundation/Corporate Foundation), location, giftAmount, giftDesignation, institution, sourceType (IRS 990/Honor Roll/Press Release), sourceUrl, year, healthRelevance (High/Medium/Low), contactClues, notes. JSON only, no markdown.";

        let prospects = null;
        try {
          prospects = await runWebSearch(prompt);
        } catch(e) {
          console.log('Web search failed, trying knowledge mode:', e.message);
          prospects = await runKnowledge(prompt);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prospects }));
      } catch(e) {
        console.error('Search error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('Meros Donor Prospector running on port ' + PORT));
