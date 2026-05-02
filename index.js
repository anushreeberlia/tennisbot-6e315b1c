const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const { Expo } = require('expo-server-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const expo = new Expo();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';

app.use(cors());
app.use(express.json());

// Initialize data file
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({
    tokens: [],
    logs: [],
    lastCheck: null,
    availableCourts: []
  }, null, 2));
}

function readData() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function addLog(message, type = 'info') {
  const data = readData();
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  data.logs.unshift(logEntry);
  if (data.logs.length > 100) {
    data.logs = data.logs.slice(0, 100);
  }
  writeData(data);
  console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
}

function getNextFridays(count = 4) {
  const fridays = [];
  const today = new Date();
  let current = new Date(today);
  
  // Find next Friday
  while (current.getDay() !== 5) {
    current.setDate(current.getDate() + 1);
  }
  
  for (let i = 0; i < count; i++) {
    fridays.push(new Date(current));
    current.setDate(current.getDate() + 7);
  }
  
  return fridays;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

async function scrapeCourtAvailability() {
  let browser;
  try {
    addLog('Starting court availability check...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto('https://rec.us/joedimaggio', { waitUntil: 'networkidle2' });
    
    addLog('Successfully loaded Joe DiMaggio recreation page');
    
    // Look for tennis court availability elements
    const availableCourts = [];
    const fridays = getNextFridays();
    
    for (const friday of fridays) {
      const dateStr = formatDate(friday);
      addLog(`Checking availability for ${dateStr}`);
      
      // Try to find date-specific elements
      try {
        const courtElements = await page.$$eval('[data-testid*="court"], .court-slot, .time-slot, .available', 
          (elements) => {
            return elements.map(el => ({
              text: el.textContent?.trim() || '',
              className: el.className || '',
              available: !el.classList.contains('booked') && !el.classList.contains('unavailable')
            }));
          }
        ).catch(() => []);
        
        if (courtElements.length > 0) {
          const availableSlots = courtElements.filter(court => court.available);
          if (availableSlots.length > 0) {
            availableCourts.push({
              date: dateStr,
              courts: availableSlots.length,
              details: availableSlots.map(slot => slot.text).slice(0, 3)
            });
            addLog(`Found ${availableSlots.length} available courts for ${dateStr}`);
          }
        }
      } catch (error) {
        addLog(`Error checking ${dateStr}: ${error.message}`, 'error');
      }
    }
    
    // If no specific court elements found, look for general availability indicators
    if (availableCourts.length === 0) {
      const generalAvailability = await page.$$eval('button, .btn, [role="button"]', 
        (buttons) => {
          return buttons.filter(btn => {
            const text = btn.textContent?.toLowerCase() || '';
            return text.includes('book') || text.includes('reserve') || text.includes('available');
          }).map(btn => btn.textContent?.trim());
        }
      ).catch(() => []);
      
      if (generalAvailability.length > 0) {
        availableCourts.push({
          date: 'General availability',
          courts: generalAvailability.length,
          details: generalAvailability.slice(0, 3)
        });
        addLog(`Found ${generalAvailability.length} general booking options`);
      }
    }
    
    const data = readData();
    const prevAvailable = data.availableCourts.length;
    data.availableCourts = availableCourts;
    data.lastCheck = new Date().toISOString();
    writeData(data);
    
    if (availableCourts.length > 0 && prevAvailable === 0) {
      addLog(`New courts available! Sending notifications...`);
      await sendNotifications(availableCourts);
    }
    
    addLog(`Check completed. Found ${availableCourts.length} available court slots`);
    return availableCourts;
    
  } catch (error) {
    addLog(`Scraping error: ${error.message}`, 'error');
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function sendNotifications(courts) {
  const data = readData();
  const messages = [];
  
  for (const token of data.tokens) {
    if (!Expo.isExpoPushToken(token)) {
      addLog(`Invalid push token: ${token}`, 'error');
      continue;
    }
    
    const courtSummary = courts.map(c => `${c.date}: ${c.courts} courts`).join(', ');
    
    messages.push({
      to: token,
      sound: 'default',
      title: '🎾 Tennis Courts Available!',
      body: `Joe DiMaggio courts found: ${courtSummary}`,
      data: { courts }
    });
  }
  
  if (messages.length > 0) {
    try {
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        addLog(`Sent ${chunk.length} notifications`);
      }
    } catch (error) {
      addLog(`Notification error: ${error.message}`, 'error');
    }
  }
}

// API Routes
app.get('/', (req, res) => {
  console.log(`${req.method} ${req.url} - Health check`);
  res.json({ 
    status: 'ok', 
    service: 'Tennis Court Bot API',
    timestamp: new Date().toISOString()
  });
});

app.post('/register-token', (req, res) => {
  console.log(`${req.method} ${req.url}`);
  const { token } = req.body;
  
  if (!token || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ error: 'Invalid push token' });
  }
  
  const data = readData();
  if (!data.tokens.includes(token)) {
    data.tokens.push(token);
    writeData(data);
    addLog(`Registered new push token: ${token}`);
  }
  
  res.json({ success: true, message: 'Token registered' });
});

app.get('/status', (req, res) => {
  console.log(`${req.method} ${req.url}`);
  const data = readData();
  res.json({
    lastCheck: data.lastCheck,
    availableCourts: data.availableCourts,
    registeredTokens: data.tokens.length,
    recentLogs: data.logs.slice(0, 10)
  });
});

app.get('/logs', (req, res) => {
  console.log(`${req.method} ${req.url}`);
  const data = readData();
  res.json({ logs: data.logs });
});

app.post('/test-notification', async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  try {
    const data = readData();
    const messages = [];
    
    for (const token of data.tokens) {
      if (Expo.isExpoPushToken(token)) {
        messages.push({
          to: token,
          sound: 'default',
          title: '🎾 Test Notification',
          body: 'Tennis court bot is working! You\'ll get notified when courts are available.',
          data: { test: true }
        });
      }
    }
    
    if (messages.length > 0) {
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        await expo.sendPushNotificationsAsync(chunk);
      }
      addLog(`Sent ${messages.length} test notifications`);
    }
    
    res.json({ success: true, sent: messages.length });
  } catch (error) {
    addLog(`Test notification error: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/check-now', async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  try {
    const courts = await scrapeCourtAvailability();
    res.json({ success: true, courts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule court checking every 30 minutes
cron.schedule('*/30 * * * *', () => {
  addLog('Scheduled court check starting...');
  scrapeCourtAvailability().catch(error => {
    addLog(`Scheduled check failed: ${error.message}`, 'error');
  });
});

// Initial check on startup
scrapeCourtAvailability().catch(error => {
  addLog(`Initial check failed: ${error.message}`, 'error');
});

app.listen(PORT, () => {
  console.log(`Tennis Court Bot API running on port ${PORT}`);
  addLog(`Server started on port ${PORT}`);
});