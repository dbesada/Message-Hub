const express = require('express');
const path = require('path');

const app = express();
const QUO_BASE = 'https://api.openphone.com/v1';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Proxy all /api/* to Quo REST API
app.all('/api/*', async (req, res) => {
  const apiKey = req.headers['x-quo-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing x-quo-api-key header' });

  const apiPath = req.path.replace(/^\/api/, '');
  const url = new URL(QUO_BASE + apiPath);

  // Forward query params (handle arrays: participants[]=x or participants=x repeated)
  for (const [key, val] of Object.entries(req.query)) {
    if (Array.isArray(val)) {
      val.forEach(v => url.searchParams.append(key, v));
    } else {
      url.searchParams.set(key, val);
    }
  }

  const fetchOpts = {
    method: req.method,
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
  };

  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length) {
    fetchOpts.body = JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(url.toString(), fetchOpts);
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Upstream request failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Message Hub running at http://localhost:${PORT}`);
});
