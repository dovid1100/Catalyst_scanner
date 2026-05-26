const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());

// ─── Data Persistence ────────────────────────────────────────────────────────

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { signals: [], grades: [], scans: [] };
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'CatalystScanner/1.0 (research tool; contact@example.com)',
        'Accept': 'application/json, text/html',
        ...options.headers
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── SEC EDGAR ────────────────────────────────────────────────────────────────

const POSITIVE_8K_KEYWORDS = [
  'partnership', 'memorandum of understanding', 'MOU', 'financing', 'contract',
  'acquisition', 'acquires', 'acquired', 'pivot', 'pivoting', 'new business',
  'government grant', 'revenue', 'strategic alliance', 'letter of intent',
  'LOI', 'collaboration agreement', 'distribution agreement', 'license agreement',
  'reverse merger', 'change of business', 'new direction', 'rebranding'
];

const PIVOT_KEYWORDS = [
  'reverse merger', 'change of business', 'new direction', 'acquired', 'pivoting to',
  'change in control', 'name change', 'new management', 'strategic pivot'
];

const COMPLIANCE_KEYWORDS = [
  'minimum bid price', 'bid price requirement', 'compliance notice',
  'deficiency notice', '$1.00 minimum', 'continued listing standards',
  'transfer to', 'nasdaq deficiency', 'nyse deficiency'
];

async function searchEdgarFullText(query, dateFilter = null) {
  try {
    const dateParam = dateFilter ? `&dateRange=custom&startdt=${dateFilter}&enddt=${new Date().toISOString().split('T')[0]}` : '';
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(query)}%22&dateRange=custom&startdt=${dateFilter || getYesterdayDate()}&enddt=${getTodayDate()}&forms=8-K,6-K`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    return data.hits?.hits || [];
  } catch (e) {
    console.error('EDGAR full text search error:', e.message);
    return [];
  }
}

async function searchEdgar8Ks() {
  try {
    const today = getTodayDate();
    const yesterday = getYesterdayDate();
    const url = `https://efts.sec.gov/LATEST/search-index?forms=8-K,6-K&dateRange=custom&startdt=${yesterday}&enddt=${today}`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    return data.hits?.hits || [];
  } catch (e) {
    console.error('EDGAR 8K search error:', e.message);
    return [];
  }
}

async function searchEdgar13D13G() {
  try {
    const today = getTodayDate();
    const yesterday = getYesterdayDate();
    const url = `https://efts.sec.gov/LATEST/search-index?forms=SC+13D,SC+13G,SC+13D%2FA,SC+13G%2FA&dateRange=custom&startdt=${yesterday}&enddt=${today}`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    return data.hits?.hits || [];
  } catch (e) {
    console.error('EDGAR 13D/13G search error:', e.message);
    return [];
  }
}

async function getCompanyInfo(cik) {
  try {
    const url = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;
    return JSON.parse(res.body);
  } catch (e) {
    return null;
  }
}

async function getFilingContent(accessionNumber, cik) {
  try {
    const acc = accessionNumber.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/`;
    const res = await fetchUrl(url);
    return res.body || '';
  } catch (e) {
    return '';
  }
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────

async function getStockData(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=30d`;
    const res = await fetchUrl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystScanner/1.0)' }
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const volumes = result.indicators?.quote?.[0]?.volume || [];

    const validCloses = closes.filter(v => v != null);
    const validVolumes = volumes.filter(v => v != null);

    const currentPrice = meta.regularMarketPrice || validCloses[validCloses.length - 1];
    const currentVolume = meta.regularMarketVolume || validVolumes[validVolumes.length - 1];

    const last20Volumes = validVolumes.slice(-20);
    const avgVolume = last20Volumes.length > 0
      ? last20Volumes.reduce((a, b) => a + b, 0) / last20Volumes.length
      : 0;

    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;

    return {
      ticker,
      price: currentPrice,
      volume: currentVolume,
      avgVolume: Math.round(avgVolume),
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      marketCap: meta.marketCap || null,
      sharesOutstanding: meta.sharesOutstanding || null,
      currency: meta.currency || 'USD'
    };
  } catch (e) {
    console.error(`Yahoo Finance error for ${ticker}:`, e.message);
    return null;
  }
}

async function getStockSummary(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics,summaryDetail,price`;
    const res = await fetchUrl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystScanner/1.0)' }
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return null;

    const stats = result.defaultKeyStatistics || {};
    const summary = result.summaryDetail || {};
    const price = result.price || {};

    const marketCap = price.marketCap?.raw || summary.marketCap?.raw || null;
    const sharesFloat = stats.floatShares?.raw || null;
    const sharesOutstanding = stats.sharesOutstanding?.raw || null;

    return {
      ticker,
      marketCap,
      sharesFloat,
      sharesOutstanding,
      exchange: price.exchangeName || price.exchange || null,
      companyName: price.longName || price.shortName || ticker
    };
  } catch (e) {
    console.error(`Yahoo Finance summary error for ${ticker}:`, e.message);
    return null;
  }
}

// ─── Signal Scoring ───────────────────────────────────────────────────────────

function scoreSignal(signals) {
  let score = 0;
  const reasons = [];

  if (signals.nearCompliance) { score += 30; reasons.push('Near $1 compliance deadline (+30)'); }
  if (signals.positive8K) { score += 25; reasons.push('Positive 8-K filed today (+25)'); }
  if (signals.lowFloat) { score += 20; reasons.push('Low float under 10M shares (+20)'); }
  if (signals.volumeSpike) { score += 15; reasons.push('Volume spiking 2x+ (+15)'); }
  if (signals.stake13D) { score += 10; reasons.push('13D/13G stake filing (+10)'); }

  return { score, reasons };
}

function classifyUrgency(score, volumeRatio) {
  if (score >= 70 || (score >= 60 && volumeRatio >= 2)) return 'URGENT';
  if (score >= 60) return 'UPCOMING';
  return 'WATCHING';
}

function detectPositive8KLanguage(text) {
  if (!text) return { found: false, keywords: [] };
  const lower = text.toLowerCase();
  const found = POSITIVE_8K_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()));
  return { found: found.length > 0, keywords: found };
}

function detectPivotLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PIVOT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

function detectComplianceLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return COMPLIANCE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// ─── AI Analysis via Claude ───────────────────────────────────────────────────

async function analyzeFilingWithClaude(filingText, ticker, filingType) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const truncated = filingText.substring(0, 3000);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a micro-cap stock analyst. Analyze this ${filingType} filing for ticker ${ticker} and extract key information.

Filing excerpt:
${truncated}

Respond with ONLY a JSON object (no markdown) with these fields:
{
  "summary": "1-2 sentence plain English summary of what this filing says",
  "catalystType": "one of: partnership, financing, acquisition, pivot, compliance, stake, revenue, other",
  "sentiment": "positive, negative, or neutral",
  "keyFinding": "the single most important thing this filing reveals",
  "riskNote": "main risk or concern for traders"
}`
      }]
    });

    const text = message.content[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Claude analysis error:', e.message);
    return {
      summary: 'Filing detected — manual review recommended',
      catalystType: 'other',
      sentiment: 'neutral',
      keyFinding: 'Unable to auto-analyze',
      riskNote: 'Verify filing details manually'
    };
  }
}

// ─── Main Scanner ─────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`[${new Date().toISOString()}] Starting scan...`);
  const data = await loadData();
  const newSignals = [];
  const scanRecord = { timestamp: new Date().toISOString(), found: 0, errors: [] };

  try {
    // --- Signal 1 & 4: 8-K / 6-K Filings ---
    const recentFilings = await searchEdgar8Ks();
    console.log(`Found ${recentFilings.length} recent 8K/6K filings`);

    for (const filing of recentFilings.slice(0, 30)) {
      try {
        const source = filing._source || {};
        const ticker = source.period_of_report || source.file_num || null;
        const cik = source.entity_id || source.cik || null;
        const entityName = source.display_names?.[0]?.name || source.entity_name || 'Unknown';
        const filingDate = source.period_of_report || source.file_date || '';
        const formType = source.form_type || '8-K';

        if (!ticker && !cik) continue;

        // Get company submissions to find ticker
        let actualTicker = null;
        if (cik) {
          const companyInfo = await getCompanyInfo(cik);
          actualTicker = companyInfo?.tickers?.[0] || null;
        }

        if (!actualTicker) continue;

        // Get stock data
        const stockData = await getStockData(actualTicker);
        const stockSummary = await getStockSummary(actualTicker);

        if (!stockData || !stockSummary) continue;

        // Filter: must be micro-cap under $100M
        const marketCap = stockSummary.marketCap || stockData.marketCap || 0;
        if (marketCap > 100_000_000 || marketCap === 0) continue;

        // Filter: Nasdaq or NYSE only
        const exchange = stockSummary.exchange || '';
        if (!exchange.toLowerCase().includes('nasdaq') && !exchange.toLowerCase().includes('nyse') && !['NMS', 'NGM', 'NCM', 'NYQ', 'ASE'].includes(exchange)) continue;

        // Get filing text for analysis
        const filingText = source.file_description || source.period_of_report || '';
        const positiveLang = detectPositive8KLanguage(filingText);
        const isPivot = detectPivotLanguage(filingText);
        const isCompliance = detectComplianceLanguage(filingText);

        if (!positiveLang.found && !isPivot && !isCompliance) continue;

        const float = stockSummary.sharesFloat || 0;
        const signals = {
          nearCompliance: isCompliance || stockData.price < 1.2,
          positive8K: positiveLang.found,
          lowFloat: float > 0 && float < 10_000_000,
          volumeSpike: stockData.volumeRatio >= 2,
          stake13D: false,
          isPivot
        };

        const { score, reasons } = scoreSignal(signals);
        if (score < 40) continue;

        // AI analysis
        const aiAnalysis = await analyzeFilingWithClaude(
          filingText + ' ' + (source.period_of_report || ''),
          actualTicker,
          formType
        );

        const urgency = classifyUrgency(score, stockData.volumeRatio);
        const entryNote = stockData.volumeRatio >= 2
          ? 'Volume already moving — enter carefully, spread may be wide'
          : stockData.price < 1.2
            ? 'Watch for morning gap above $1 — compliance plays often open volatile'
            : 'Monitor pre-market — ideal entry on first pull-back after open';

        const signal = {
          id: `${actualTicker}-${Date.now()}`,
          ticker: actualTicker,
          companyName: stockSummary.companyName || entityName,
          marketCap,
          float,
          filingType: formType,
          filingDate,
          filingDescription: aiAnalysis.summary,
          keyFinding: aiAnalysis.keyFinding,
          catalystType: aiAnalysis.catalystType,
          confidenceScore: score,
          scoreReasons: reasons,
          triggeredSignals: Object.entries(signals).filter(([, v]) => v).map(([k]) => k),
          currentPrice: stockData.price,
          volume: stockData.volume,
          avgVolume: stockData.avgVolume,
          volumeRatio: stockData.volumeRatio,
          urgency,
          entryNote,
          riskNote: aiAnalysis.riskNote,
          entryPrice: stockData.price,
          flaggedAt: new Date().toISOString(),
          graded: false,
          outcome: null
        };

        newSignals.push(signal);
        scanRecord.found++;
        console.log(`Flagged: ${actualTicker} — Score: ${score} — ${urgency}`);
      } catch (e) {
        console.error('Error processing filing:', e.message);
        scanRecord.errors.push(e.message);
      }
    }

    // --- Signal 3: 13D/13G Stake Filings ---
    const stakeFilings = await searchEdgar13D13G();
    console.log(`Found ${stakeFilings.length} stake filings`);

    for (const filing of stakeFilings.slice(0, 20)) {
      try {
        const source = filing._source || {};
        const cik = source.entity_id || source.cik || null;
        if (!cik) continue;

        const companyInfo = await getCompanyInfo(cik);
        const actualTicker = companyInfo?.tickers?.[0] || null;
        if (!actualTicker) continue;

        const stockData = await getStockData(actualTicker);
        const stockSummary = await getStockSummary(actualTicker);
        if (!stockData || !stockSummary) continue;

        const marketCap = stockSummary.marketCap || stockData.marketCap || 0;
        if (marketCap > 100_000_000 || marketCap === 0) continue;

        const exchange = stockSummary.exchange || '';
        if (!exchange.toLowerCase().includes('nasdaq') && !exchange.toLowerCase().includes('nyse') && !['NMS', 'NGM', 'NCM', 'NYQ', 'ASE'].includes(exchange)) continue;

        const float = stockSummary.sharesFloat || 0;
        const signals = {
          nearCompliance: stockData.price < 1.2,
          positive8K: false,
          lowFloat: float > 0 && float < 10_000_000,
          volumeSpike: stockData.volumeRatio >= 2,
          stake13D: true
        };

        const { score, reasons } = scoreSignal(signals);
        if (score < 40) continue;

        const aiAnalysis = await analyzeFilingWithClaude(
          `13D/13G stake filing for ${actualTicker}. ${source.display_names?.[0]?.name || ''} — investor acquired 5%+ stake.`,
          actualTicker,
          source.form_type || 'SC 13D'
        );

        const urgency = classifyUrgency(score, stockData.volumeRatio);

        const signal = {
          id: `${actualTicker}-13D-${Date.now()}`,
          ticker: actualTicker,
          companyName: stockSummary.companyName || source.display_names?.[0]?.name || actualTicker,
          marketCap,
          float,
          filingType: source.form_type || 'SC 13D',
          filingDate: source.period_of_report || source.file_date || '',
          filingDescription: aiAnalysis.summary,
          keyFinding: aiAnalysis.keyFinding,
          catalystType: 'stake',
          confidenceScore: score,
          scoreReasons: reasons,
          triggeredSignals: ['stake13D', ...Object.entries(signals).filter(([k, v]) => k !== 'stake13D' && v).map(([k]) => k)],
          currentPrice: stockData.price,
          volume: stockData.volume,
          avgVolume: stockData.avgVolume,
          volumeRatio: stockData.volumeRatio,
          urgency,
          entryNote: 'Stake filings often precede buyout offers — monitor for follow-on filings',
          riskNote: aiAnalysis.riskNote,
          entryPrice: stockData.price,
          flaggedAt: new Date().toISOString(),
          graded: false,
          outcome: null
        };

        newSignals.push(signal);
        scanRecord.found++;
        console.log(`Stake flagged: ${actualTicker} — Score: ${score}`);
      } catch (e) {
        console.error('Error processing stake filing:', e.message);
      }
    }

  } catch (e) {
    console.error('Scan error:', e.message);
    scanRecord.errors.push(e.message);
  }

  // Deduplicate: don't re-add same ticker if already flagged in last 12 hours
  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  const recentTickers = new Set(
    data.signals
      .filter(s => new Date(s.flaggedAt).getTime() > twelveHoursAgo)
      .map(s => s.ticker)
  );

  const uniqueNewSignals = newSignals.filter(s => !recentTickers.has(s.ticker));

  data.signals = [...uniqueNewSignals, ...data.signals];
  data.scans = [scanRecord, ...(data.scans || [])].slice(0, 100);

  await saveData(data);
  console.log(`[${new Date().toISOString()}] Scan complete. ${uniqueNewSignals.length} new signals added.`);
  return uniqueNewSignals;
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ─── Scheduled Scans ─────────────────────────────────────────────────────────
// Weekdays only: 6AM, 9:25AM, 4:30PM, 8PM EST (UTC offsets handled by server TZ)

cron.schedule('0 6 * * 1-5', () => { console.log('6:00 AM scan'); runScan(); }, { timezone: 'America/New_York' });
cron.schedule('25 9 * * 1-5', () => { console.log('9:25 AM scan'); runScan(); }, { timezone: 'America/New_York' });
cron.schedule('30 16 * * 1-5', () => { console.log('4:30 PM scan'); runScan(); }, { timezone: 'America/New_York' });
cron.schedule('0 20 * * 1-5', () => { console.log('8:00 PM scan'); runScan(); }, { timezone: 'America/New_York' });

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET all signals (with optional filters)
app.get('/api/signals', async (req, res) => {
  try {
    const data = await loadData();
    let signals = data.signals || [];

    const { urgency, ticker, catalyst, graded, limit = 100 } = req.query;
    if (urgency) signals = signals.filter(s => s.urgency === urgency.toUpperCase());
    if (ticker) signals = signals.filter(s => s.ticker.toUpperCase().includes(ticker.toUpperCase()));
    if (catalyst) signals = signals.filter(s => s.catalystType === catalyst);
    if (graded === 'true') signals = signals.filter(s => s.graded);
    if (graded === 'false') signals = signals.filter(s => !s.graded);

    signals = signals.slice(0, parseInt(limit));
    res.json({ success: true, count: signals.length, signals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST manual trigger scan
app.post('/api/scan', async (req, res) => {
  try {
    res.json({ success: true, message: 'Scan started in background' });
    runScan().catch(console.error);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST grade a signal
app.post('/api/grade/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { exitPrice, notes } = req.body;
    const data = await loadData();

    const signal = data.signals.find(s => s.id === id);
    if (!signal) return res.status(404).json({ success: false, error: 'Signal not found' });

    const movePercent = ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100;
    const pnl = (movePercent / 100) * 1000; // $1000 per trade

    signal.graded = true;
    signal.outcome = {
      exitPrice,
      movePercent: Math.round(movePercent * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      result: movePercent >= 50 ? 'BIG_WIN' : movePercent >= 10 ? 'WIN' : movePercent >= 0 ? 'SMALL_WIN' : 'LOSS',
      gradedAt: new Date().toISOString(),
      notes: notes || ''
    };

    await saveData(data);
    res.json({ success: true, signal });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET accuracy stats
app.get('/api/stats', async (req, res) => {
  try {
    const data = await loadData();
    const graded = (data.signals || []).filter(s => s.graded && s.outcome);

    if (graded.length === 0) {
      return res.json({ success: true, stats: { totalGraded: 0, winRate: 0, avgWin: 0, avgLoss: 0, totalPnl: 0, bySignalType: {} } });
    }

    const wins = graded.filter(s => s.outcome.movePercent > 0);
    const losses = graded.filter(s => s.outcome.movePercent <= 0);
    const bigWins = graded.filter(s => s.outcome.movePercent >= 50);

    const avgWin = wins.length ? wins.reduce((a, s) => a + s.outcome.movePercent, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, s) => a + s.outcome.movePercent, 0) / losses.length : 0;
    const totalPnl = graded.reduce((a, s) => a + s.outcome.pnl, 0);

    // By signal type
    const bySignalType = {};
    for (const sig of graded) {
      for (const trigger of (sig.triggeredSignals || [])) {
        if (!bySignalType[trigger]) bySignalType[trigger] = { total: 0, wins: 0, pnl: 0 };
        bySignalType[trigger].total++;
        if (sig.outcome.movePercent > 0) bySignalType[trigger].wins++;
        bySignalType[trigger].pnl += sig.outcome.pnl;
      }
    }

    res.json({
      success: true,
      stats: {
        totalGraded: graded.length,
        totalSignals: (data.signals || []).length,
        winRate: Math.round((wins.length / graded.length) * 100),
        bigWinRate: Math.round((bigWins.length / graded.length) * 100),
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        bySignalType
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET history with search
app.get('/api/history', async (req, res) => {
  try {
    const data = await loadData();
    let signals = data.signals || [];

    const { ticker, date, catalyst, q } = req.query;
    if (ticker) signals = signals.filter(s => s.ticker.toUpperCase().includes(ticker.toUpperCase()));
    if (date) signals = signals.filter(s => s.flaggedAt?.startsWith(date));
    if (catalyst) signals = signals.filter(s => s.catalystType === catalyst);
    if (q) {
      const lower = q.toLowerCase();
      signals = signals.filter(s =>
        s.ticker?.toLowerCase().includes(lower) ||
        s.companyName?.toLowerCase().includes(lower) ||
        s.filingDescription?.toLowerCase().includes(lower) ||
        s.catalystType?.toLowerCase().includes(lower)
      );
    }

    res.json({ success: true, count: signals.length, signals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET last scan info
app.get('/api/status', async (req, res) => {
  try {
    const data = await loadData();
    const lastScan = (data.scans || [])[0] || null;
    res.json({ success: true, lastScan, totalSignals: (data.signals || []).length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE signal
app.delete('/api/signals/:id', async (req, res) => {
  try {
    const data = await loadData();
    data.signals = data.signals.filter(s => s.id !== req.params.id);
    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Catalyst Scanner running', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Catalyst Scanner backend running on port ${PORT}`);
  console.log('Scheduled scans: 6:00 AM, 9:25 AM, 4:30 PM, 8:00 PM EST (weekdays)');
});
