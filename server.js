// ─────────────────────────────────────────────────────────────────────────────
//  CATALYST SCANNER v3 — Rebuilt from scratch
//  Data: Polygon.io (research) + Robinhood MCP (live prices)
//  AI:   Claude (final judge)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(stage, message, data = null) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${stage}] ${message}`;
  console.log(line);
  if (data !== null) console.log(JSON.stringify(data, null, 2));
  return line;
}

// ─── Data Persistence ─────────────────────────────────────────────────────────

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { picks: [], scans: [], grades: [] };
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: { 'Accept': 'application/json', ...headers },
      timeout: 20000
    };
    const req = lib.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ─── STEP 1: Polygon Universe Fetch ──────────────────────────────────────────
// Gets small-cap tickers from Polygon with volume and price data

async function getPolygonUniverse() {
  log('POLYGON', 'Fetching small-cap universe...');

  if (!POLYGON_KEY) {
    log('POLYGON', 'ERROR: POLYGON_API_KEY not set');
    return [];
  }

  // Get previous trading day's gainers — stocks with unusual volume and price movement
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false&apiKey=${POLYGON_KEY}`;

  try {
    const res = await fetchJSON(url);
    log('POLYGON', `Response status: ${res.status}`);

    if (res.status !== 200 || !res.data) {
      log('POLYGON', 'Bad response from Polygon gainers endpoint', res.data);
      return [];
    }

    const tickers = res.data.tickers || [];
    log('POLYGON', `Raw gainers returned: ${tickers.length}`);

    if (tickers.length === 0) {
      log('POLYGON', 'No tickers returned — trying previous close snapshot instead');
      return await getPolygonPrevClose();
    }

    return tickers;
  } catch (e) {
    log('POLYGON', `Fetch error: ${e.message}`);
    return [];
  }
}

async function getPolygonPrevClose() {
  log('POLYGON', 'Fetching previous close snapshot...');
  const date = getPrevTradingDay();
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${POLYGON_KEY}`;

  try {
    const res = await fetchJSON(url);
    log('POLYGON', `Prev close status: ${res.status}, results: ${res.data?.resultsCount || 0}`);

    if (res.status !== 200 || !res.data?.results) return [];

    // Return as ticker-like objects matching gainers shape
    return res.data.results.map(r => ({
      ticker: r.T,
      day: { c: r.c, o: r.o, v: r.v, vw: r.vw },
      prevDay: { c: r.c, v: r.v },
      todaysChangePerc: ((r.c - r.o) / r.o) * 100,
      todaysChange: r.c - r.o
    }));
  } catch (e) {
    log('POLYGON', `Prev close error: ${e.message}`);
    return [];
  }
}

// ─── STEP 2: Filter Universe ──────────────────────────────────────────────────
// Wide net first — log every drop so we can see what's happening

async function filterUniverse(tickers) {
  log('FILTER', `Starting filter on ${tickers.length} tickers`);

  const results = [];
  let dropped = { noPrice: 0, tooExpensive: 0, tooCheap: 0, noVolume: 0, passed: 0 };

  for (const t of tickers) {
    const ticker = t.ticker;
    if (!ticker || ticker.includes('.') || ticker.includes('/')) continue;

    const price = t.day?.c || t.lastTrade?.p || t.lastQuote?.P || 0;
    const volume = t.day?.v || 0;
    const changePerc = t.todaysChangePerc || 0;

    // Drop if no price
    if (!price || price <= 0) { dropped.noPrice++; continue; }

    // Price range: $0.50 to $20 (small caps)
    if (price < 0.50) { dropped.tooCheap++; continue; }
    if (price > 20) { dropped.tooExpensive++; continue; }

    // Minimum volume: 100k shares (very loose)
    if (volume < 100000) { dropped.noVolume++; continue; }

    dropped.passed++;
    results.push({
      ticker,
      price,
      volume,
      changePerc: Math.round(changePerc * 100) / 100,
      change: t.todaysChange || 0
    });
  }

  log('FILTER', `Filter results:`, dropped);
  log('FILTER', `Passed filter: ${results.length} tickers`);

  // Sort by volume descending, take top 50 for enrichment
  results.sort((a, b) => b.volume - a.volume);
  const top = results.slice(0, 50);
  log('FILTER', `Taking top ${top.length} by volume for enrichment`);

  return top;
}

// ─── STEP 3: Polygon Enrichment ───────────────────────────────────────────────
// Get detailed data for each filtered ticker

async function enrichWithPolygon(tickers) {
  log('ENRICH', `Enriching ${tickers.length} tickers with Polygon details`);
  const enriched = [];

  for (const t of tickers) {
    try {
      // Get ticker details (market cap, description, etc)
      const detailUrl = `https://api.polygon.io/v3/reference/tickers/${t.ticker}?apiKey=${POLYGON_KEY}`;
      const detailRes = await fetchJSON(detailUrl);

      if (detailRes.status !== 200 || !detailRes.data?.results) {
        log('ENRICH', `No detail for ${t.ticker}, skipping`);
        continue;
      }

      const detail = detailRes.data.results;
      const marketCap = detail.market_cap || 0;

      // Market cap filter: under $300M (small cap)
      // Log what we're dropping and why
      if (marketCap > 300_000_000) {
        log('ENRICH', `${t.ticker} dropped: market cap $${(marketCap/1e6).toFixed(0)}M > $300M`);
        continue;
      }

      // Get 30-day volume history for avg volume calculation
      const toDate = getTodayDate();
      const fromDate = getDateDaysAgo(30);
      const aggUrl = `https://api.polygon.io/v2/aggs/ticker/${t.ticker}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=30&apiKey=${POLYGON_KEY}`;
      const aggRes = await fetchJSON(aggUrl);

      let avgVolume = 0;
      let volumeRatio = 0;
      let recentPrices = [];

      if (aggRes.status === 200 && aggRes.data?.results?.length > 0) {
        const bars = aggRes.data.results;
        const vols = bars.map(b => b.v).filter(v => v > 0);
        avgVolume = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
        volumeRatio = avgVolume > 0 ? t.volume / avgVolume : 0;
        recentPrices = bars.slice(-10).map(b => b.c);
      }

      // Get recent news from Polygon
      const newsUrl = `https://api.polygon.io/v2/reference/news?ticker=${t.ticker}&limit=5&apiKey=${POLYGON_KEY}`;
      const newsRes = await fetchJSON(newsUrl);
      const news = newsRes.data?.results || [];

      enriched.push({
        ...t,
        marketCap,
        companyName: detail.name || t.ticker,
        description: detail.description || '',
        sic: detail.sic_description || '',
        listingDate: detail.list_date || '',
        avgVolume: Math.round(avgVolume),
        volumeRatio: Math.round(volumeRatio * 100) / 100,
        recentPrices,
        news: news.map(n => ({
          title: n.title,
          published: n.published_utc,
          summary: n.description || ''
        })),
        exchange: detail.primary_exchange || '',
        shareClassSharesOutstanding: detail.share_class_shares_outstanding || 0,
        weightedSharesOutstanding: detail.weighted_shares_outstanding || 0
      });

      log('ENRICH', `✓ ${t.ticker} — $${t.price} — Vol ratio: ${volumeRatio.toFixed(1)}x — MCap: $${(marketCap/1e6).toFixed(0)}M`);

      // Rate limit: Polygon Starter allows 5 calls/min
      await sleep(250);

    } catch (e) {
      log('ENRICH', `Error enriching ${t.ticker}: ${e.message}`);
    }
  }

  log('ENRICH', `Enrichment complete: ${enriched.length} stocks ready for Claude`);
  return enriched;
}

// ─── STEP 4: SEC EDGAR Catalyst Check ────────────────────────────────────────
// Check if any enriched stocks have recent filings

async function checkEdgarCatalysts(tickers) {
  log('EDGAR', `Checking EDGAR for ${tickers.length} tickers`);
  const withCatalysts = [];

  for (const t of tickers) {
    try {
      // Search EDGAR full text for this ticker
      const query = t.ticker;
      const fromDate = getDateDaysAgo(3);
      const toDate = getTodayDate();
      const url = `https://efts.sec.gov/LATEST/search-index?q=%22${query}%22&dateRange=custom&startdt=${fromDate}&enddt=${toDate}&forms=8-K,6-K,SC+13D,SC+13G`;

      const res = await fetchJSON(url, {
        'User-Agent': 'CatalystScanner research@example.com'
      });

      const hits = res.data?.hits?.hits || [];
      const catalysts = [];

      for (const hit of hits.slice(0, 3)) {
        const src = hit._source || {};
        const formType = src.form_type || '';
        const filingDate = src.file_date || src.period_of_report || '';
        const entityName = src.display_names?.[0]?.name || '';

        // Try to get actual filing text
        const accession = src.accession_no || '';
        const cik = src.entity_id || '';
        let filingText = src.period_of_report || '';

        if (accession && cik) {
          try {
            const acc = accession.replace(/-/g, '');
            const indexUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${formType}&dateb=&owner=include&count=5&search_text=`;
            // Use the filing index to find the actual document
            const txtUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${accession}.txt`;
            const txtRes = await fetchJSON(txtUrl, { 'User-Agent': 'CatalystScanner research@example.com' });
            if (txtRes.raw) filingText = txtRes.raw.substring(0, 2000);
          } catch { /* use what we have */ }
        }

        catalysts.push({
          formType,
          filingDate,
          entityName,
          filingText: filingText.substring(0, 1000),
          accession
        });
      }

      withCatalysts.push({ ...t, catalysts });

      if (catalysts.length > 0) {
        log('EDGAR', `${t.ticker}: ${catalysts.length} recent filing(s) found`);
      }

      await sleep(200);
    } catch (e) {
      log('EDGAR', `Error checking ${t.ticker}: ${e.message}`);
      withCatalysts.push({ ...t, catalysts: [] });
    }
  }

  return withCatalysts;
}

// ─── STEP 5: Claude Final Analysis ───────────────────────────────────────────
// Claude gets ALL the data and picks the best 3

async function claudePickTopStocks(stocks) {
  log('CLAUDE', `Sending ${stocks.length} stocks to Claude for analysis`);

  if (stocks.length === 0) {
    log('CLAUDE', 'No stocks to analyze');
    return [];
  }

  // Build the data payload for Claude
  const stockData = stocks.map(s => ({
    ticker: s.ticker,
    company: s.companyName,
    price: s.price,
    priceChange: `${s.changePerc > 0 ? '+' : ''}${s.changePerc}%`,
    volume: s.volume,
    avgVolume: s.avgVolume,
    volumeRatio: `${s.volumeRatio}x average`,
    marketCap: s.marketCap ? `$${(s.marketCap / 1e6).toFixed(1)}M` : 'unknown',
    float: s.weightedSharesOutstanding ? `${(s.weightedSharesOutstanding / 1e6).toFixed(1)}M shares` : 'unknown',
    sector: s.sic || 'unknown',
    recentPrices: s.recentPrices?.slice(-5).join(', ') || 'no data',
    recentNews: s.news?.slice(0, 2).map(n => n.title).join(' | ') || 'no news',
    recentFilings: s.catalysts?.map(c => `${c.formType} on ${c.filingDate}`).join(', ') || 'none',
    filingDetails: s.catalysts?.[0]?.filingText?.substring(0, 300) || ''
  }));

  const prompt = `You are an expert small-cap stock trader. Your job is to identify stocks most likely to make a 20%+ move within the next 3-5 trading days.

Here are today's candidates with full data:

${JSON.stringify(stockData, null, 2)}

Your task:
1. Analyze each stock carefully
2. Look for: unusual volume spikes, recent catalysts (news/filings), low float (easier to move), price patterns, sector momentum
3. Pick the TOP 3 stocks you genuinely believe have the highest probability of a 20%+ move
4. If fewer than 3 are genuinely compelling, pick fewer — do NOT pick stocks just to fill the list
5. Be specific about WHY each pick could move

Respond ONLY with a valid JSON array (no markdown, no explanation outside the JSON):
[
  {
    "ticker": "XXXX",
    "companyName": "Company Name",
    "currentPrice": 1.23,
    "catalystSummary": "Clear 1-2 sentence explanation of the specific catalyst",
    "whyItWillMove": "Specific reasoning — what's the trigger, who's buying, what's the setup",
    "keyRisk": "Main thing that could go wrong",
    "targetMove": "estimated % move if catalyst plays out",
    "urgency": "TODAY or THIS_WEEK",
    "confidenceScore": 75
  }
]

If no stocks meet the bar for a genuine 20%+ setup, return an empty array: []`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content[0]?.text || '[]';
    log('CLAUDE', 'Response received, parsing...');

    // Clean and parse
    const clean = text.replace(/```json|```/g, '').trim();
    const picks = JSON.parse(clean);

    log('CLAUDE', `Claude selected ${picks.length} picks`);
    picks.forEach(p => log('CLAUDE', `  → ${p.ticker} (${p.confidenceScore}% confidence): ${p.catalystSummary}`));

    return picks;
  } catch (e) {
    log('CLAUDE', `Error: ${e.message}`);
    return [];
  }
}

// ─── Main Scan Runner ─────────────────────────────────────────────────────────

async function runScan() {
  const scanStart = new Date().toISOString();
  log('SCAN', '═══════════════════════════════════════');
  log('SCAN', `Starting scan at ${scanStart}`);
  log('SCAN', '═══════════════════════════════════════');

  const scanRecord = {
    startedAt: scanStart,
    completedAt: null,
    steps: {},
    picksFound: 0,
    error: null
  };

  try {
    // STEP 1: Get universe from Polygon
    const universe = await getPolygonUniverse();
    scanRecord.steps.universeSize = universe.length;
    log('SCAN', `Step 1 complete: ${universe.length} stocks in universe`);

    if (universe.length === 0) {
      log('SCAN', 'PROBLEM: Universe is empty. Check POLYGON_API_KEY and market hours.');
      scanRecord.error = 'Empty universe from Polygon';
      await saveScanRecord(scanRecord);
      return [];
    }

    // STEP 2: Filter
    const filtered = await filterUniverse(universe);
    scanRecord.steps.afterFilter = filtered.length;
    log('SCAN', `Step 2 complete: ${filtered.length} stocks after filter`);

    if (filtered.length === 0) {
      log('SCAN', 'PROBLEM: All stocks dropped by filter. Filters may be too strict.');
      scanRecord.error = 'All stocks dropped by filter';
      await saveScanRecord(scanRecord);
      return [];
    }

    // STEP 3: Enrich with Polygon details
    const enriched = await enrichWithPolygon(filtered);
    scanRecord.steps.afterEnrichment = enriched.length;
    log('SCAN', `Step 3 complete: ${enriched.length} stocks enriched`);

    if (enriched.length === 0) {
      log('SCAN', 'PROBLEM: No stocks survived enrichment. Market cap filter may be too strict.');
      scanRecord.error = 'No stocks survived enrichment';
      await saveScanRecord(scanRecord);
      return [];
    }

    // STEP 4: Check EDGAR for catalysts
    const withCatalysts = await checkEdgarCatalysts(enriched);
    scanRecord.steps.withCatalysts = withCatalysts.filter(s => s.catalysts?.length > 0).length;
    log('SCAN', `Step 4 complete: ${scanRecord.steps.withCatalysts} stocks have recent filings`);

    // STEP 5: Claude picks top 3
    const picks = await claudePickTopStocks(withCatalysts);
    scanRecord.steps.claudePicks = picks.length;
    log('SCAN', `Step 5 complete: Claude made ${picks.length} picks`);

    // Save picks
    const data = await loadData();
    const finalPicks = picks.map(p => ({
      id: `${p.ticker}-${Date.now()}`,
      ...p,
      flaggedAt: new Date().toISOString(),
      entryPrice: p.currentPrice,
      graded: false,
      outcome: null
    }));

    data.picks = [...finalPicks, ...data.picks].slice(0, 500);
    scanRecord.completedAt = new Date().toISOString();
    scanRecord.picksFound = finalPicks.length;
    data.scans = [scanRecord, ...(data.scans || [])].slice(0, 100);
    await saveData(data);

    log('SCAN', '═══════════════════════════════════════');
    log('SCAN', `Scan complete. ${finalPicks.length} picks saved.`);
    log('SCAN', '═══════════════════════════════════════');

    return finalPicks;

  } catch (e) {
    log('SCAN', `FATAL ERROR: ${e.message}`);
    scanRecord.error = e.message;
    scanRecord.completedAt = new Date().toISOString();
    await saveScanRecord(scanRecord);
    return [];
  }
}

async function saveScanRecord(record) {
  const data = await loadData();
  data.scans = [record, ...(data.scans || [])].slice(0, 100);
  await saveData(data);
}

// ─── Diagnostic Endpoint ──────────────────────────────────────────────────────
// Run each step individually to find where things break

app.get('/api/diagnose', async (req, res) => {
  log('DIAGNOSE', 'Running diagnostic...');
  const report = {};

  // Check env vars
  report.env = {
    POLYGON_KEY: POLYGON_KEY ? `set (${POLYGON_KEY.substring(0, 4)}...)` : 'MISSING',
    ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'
  };

  // Test Polygon connection
  try {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false&apiKey=${POLYGON_KEY}`;
    const r = await fetchJSON(url);
    report.polygon = {
      status: r.status,
      tickersReturned: r.data?.tickers?.length || 0,
      sample: r.data?.tickers?.slice(0, 3).map(t => t.ticker) || [],
      error: r.data?.error || null
    };
  } catch (e) {
    report.polygon = { error: e.message };
  }

  // Test EDGAR
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom&startdt=${getDateDaysAgo(1)}&enddt=${getTodayDate()}`;
    const r = await fetchJSON(url, { 'User-Agent': 'CatalystScanner research@example.com' });
    report.edgar = {
      status: r.status,
      hitsReturned: r.data?.hits?.hits?.length || 0
    };
  } catch (e) {
    report.edgar = { error: e.message };
  }

  // Test Claude
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Reply with: OK' }]
    });
    report.claude = { status: 'connected', response: msg.content[0]?.text };
  } catch (e) {
    report.claude = { error: e.message };
  }

  res.json(report);
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({
  status: 'Catalyst Scanner v3 running',
  time: new Date().toISOString(),
  schedules: ['9:00 AM EST (weekdays)', '9:00 PM EST (weekdays)']
}));

// Get all picks
app.get('/api/picks', async (req, res) => {
  try {
    const data = await loadData();
    let picks = data.picks || [];
    const { limit = 50, ticker, graded } = req.query;
    if (ticker) picks = picks.filter(p => p.ticker?.toUpperCase().includes(ticker.toUpperCase()));
    if (graded === 'true') picks = picks.filter(p => p.graded);
    if (graded === 'false') picks = picks.filter(p => !p.graded);
    picks = picks.slice(0, parseInt(limit));
    res.json({ success: true, count: picks.length, picks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Manual scan trigger
app.post('/api/scan', async (req, res) => {
  log('SCAN', 'Manual scan triggered via API');
  res.json({ success: true, message: 'Scan started' });
  runScan().catch(e => log('SCAN', `Background scan error: ${e.message}`));
});

// Get last scan status
app.get('/api/status', async (req, res) => {
  try {
    const data = await loadData();
    const lastScan = (data.scans || [])[0] || null;
    res.json({
      success: true,
      lastScan,
      totalPicks: (data.picks || []).length,
      recentPicks: (data.picks || []).slice(0, 5).map(p => ({
        ticker: p.ticker,
        flaggedAt: p.flaggedAt,
        confidence: p.confidenceScore
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get scan logs
app.get('/api/logs', async (req, res) => {
  try {
    const data = await loadData();
    res.json({ success: true, scans: (data.scans || []).slice(0, 20) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Grade a pick
app.post('/api/grade/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { exitPrice, notes } = req.body;
    const data = await loadData();
    const pick = data.picks.find(p => p.id === id);
    if (!pick) return res.status(404).json({ success: false, error: 'Pick not found' });

    const movePercent = ((exitPrice - pick.entryPrice) / pick.entryPrice) * 100;
    pick.graded = true;
    pick.outcome = {
      exitPrice,
      movePercent: Math.round(movePercent * 100) / 100,
      result: movePercent >= 20 ? 'WIN' : movePercent >= 0 ? 'SMALL_WIN' : 'LOSS',
      gradedAt: new Date().toISOString(),
      notes: notes || ''
    };

    await saveData(data);
    res.json({ success: true, pick });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const data = await loadData();
    const graded = (data.picks || []).filter(p => p.graded && p.outcome);
    if (graded.length === 0) return res.json({ success: true, stats: { totalGraded: 0 } });

    const wins = graded.filter(p => p.outcome.movePercent >= 20);
    const totalPnl = graded.reduce((sum, p) => {
      return sum + (p.outcome.movePercent / 100) * 1000;
    }, 0);

    res.json({
      success: true,
      stats: {
        totalGraded: graded.length,
        totalPicks: (data.picks || []).length,
        winRate: Math.round((wins.length / graded.length) * 100),
        avgMove: Math.round(graded.reduce((s, p) => s + p.outcome.movePercent, 0) / graded.length * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Scheduled Scans ──────────────────────────────────────────────────────────
// 9:00 AM EST — morning pre-market scan
// 9:00 PM EST — overnight research scan

cron.schedule('0 9 * * 1-5', () => {
  log('CRON', '9:00 AM scan triggered');
  runScan();
}, { timezone: 'America/New_York' });

cron.schedule('0 21 * * 1-5', () => {
  log('CRON', '9:00 PM scan triggered');
  runScan();
}, { timezone: 'America/New_York' });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function getPrevTradingDay() {
  const d = new Date();
  // Go back until we hit a weekday
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().split('T')[0];
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log('START', `Catalyst Scanner v3 running on port ${PORT}`);
  log('START', `Polygon key: ${POLYGON_KEY ? 'set' : 'MISSING'}`);
  log('START', 'Scans scheduled: 9:00 AM and 9:00 PM EST weekdays');
  log('START', 'Diagnostic available at: /api/diagnose');
});
