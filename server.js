// server.js - simulation with persistent state + logs endpoint
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// multer with file size limit 5MB
const upload = require("multer")({
  dest: UPLOAD_DIR,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// persistence files
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const LOGS_FILE = path.join(__dirname, "logs.json");

// load/save helpers
function loadJson(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load", filePath, e);
  }
  return defaultValue;
}
function saveJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("Failed to save", filePath, e);
  }
}

// default simulation state
let simulation = loadJson(SESSIONS_FILE, {
  running: false,
  targetType: "",
  targetValue: "",
  delay: 10,
  prefix: "",
  sessionId: Math.random().toString(36).substring(2, 10),
  uptime: 0,
  filePath: null,
  totalLines: 0,
  currentIndex: 0,
  linesPreview: [],
  lastSentAt: null,
  number: null
});

// logs array persisted to disk (capped)
let logs = loadJson(LOGS_FILE, []);

function appendLog(entry) {
  const obj = { time: new Date().toISOString(), ...entry };
  logs.push(obj);
  // cap logs to last 2000 entries
  if (logs.length > 2000) logs = logs.slice(logs.length - 2000);
  saveJson(LOGS_FILE, logs);
}

// uptime tick
setInterval(() => {
  if (simulation.running) simulation.uptime += 1;
}, 1000);

// helpers for file lines
function readLinesFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function detectGroupUIDs(lines) {
  // matches common group UID patterns (ends with @g.us or contains - and @g)
  return lines.filter(l => /@g(\.|us)|-.*@g\.us/i.test(l));
}

let loopTimer = null;

function startLoop() {
  if (!simulation.filePath) return;
  if (loopTimer) clearInterval(loopTimer);

  // set up interval according to simulation.delay (in seconds)
  const delayMs = Math.max(1000, (parseInt(simulation.delay, 10) || 10) * 1000);

  loopTimer = setInterval(() => {
    if (!simulation.running) return;

    // re-read file on each cycle so uploads update instantly
    let lines;
    try {
      lines = readLinesFromFile(simulation.filePath);
    } catch (e) {
      appendLog({ type: "error", message: "Failed reading upload file", error: String(e) });
      return;
    }
    if (lines.length === 0) return;

    if (simulation.currentIndex >= lines.length) simulation.currentIndex = 0;
    const plain = lines[simulation.currentIndex];
    const textToSend = (simulation.prefix ? simulation.prefix + " " : "") + plain;

    // SIMULATION: we log the send instead of actually sending
    const logEntry = {
      action: "simulated-send",
      targetType: simulation.targetType,
      targetValue: simulation.targetValue,
      message: textToSend,
      index: simulation.currentIndex
    };
    console.log("[SIM]", logEntry);
    appendLog(logEntry);

    simulation.lastSentAt = new Date().toISOString();
    simulation.currentIndex = simulation.currentIndex + 1;
    if (simulation.currentIndex >= lines.length) simulation.currentIndex = 0;
    simulation.totalLines = lines.length;
    saveJson(SESSIONS_FILE, simulation);

  }, delayMs);
}

// routes
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/pair", (req, res) => {
  const { number } = req.body;
  const code = Math.floor(100000 + Math.random() * 900000);
  simulation.number = number || simulation.number;
  saveJson(SESSIONS_FILE, simulation);
  appendLog({ type: "pair", number: simulation.number, pairingCode: code });
  res.json({ message: "Pairing simulated (demo).", pairingCode: code });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const fileExt = path.extname(req.file.originalname).toLowerCase();
  simulation.filePath = req.file.path;
  try {
    const lines = readLinesFromFile(simulation.filePath);
    simulation.totalLines = lines.length;
    simulation.linesPreview = lines.slice(0, 20);
    simulation.currentIndex = 0; // reset to start
    saveJson(SESSIONS_FILE, simulation);
    appendLog({ type: "upload", filename: req.file.originalname, totalLines: lines.length });
  } catch (e) {
    return res.status(500).json({ error: "Failed to read uploaded file." });
  }
  if (simulation.running) startLoop();
  res.json({ message: "File uploaded and saved.", totalLines: simulation.totalLines });
});

app.post("/start", (req, res) => {
  const { targetType, targetValue, delay, prefix } = req.body;
  simulation.targetType = targetType || simulation.targetType;
  simulation.targetValue = targetValue || simulation.targetValue;
  simulation.delay = Math.min(60, Math.max(1, parseInt(delay || simulation.delay)));
  simulation.prefix = prefix || simulation.prefix;
  simulation.running = true;
  simulation.uptime = 0;
  saveJson(SESSIONS_FILE, simulation);
  appendLog({ type: "start", targetType: simulation.targetType, targetValue: simulation.targetValue, delay: simulation.delay });
  if (simulation.filePath) startLoop();
  res.json({ message: "Simulation started (demo).", sessionId: simulation.sessionId });
});

app.post("/stop", (req, res) => {
  simulation.running = false;
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  saveJson(SESSIONS_FILE, simulation);
  appendLog({ type: "stop" });
  res.json({ message: "Simulation stopped." });
});

app.get("/session", (req, res) => {
  res.json({
    running: simulation.running,
    sessionId: simulation.sessionId,
    number: simulation.number || null,
    targetType: simulation.targetType,
    targetValue: simulation.targetValue,
    delay: simulation.delay,
    prefix: simulation.prefix,
    uptime: simulation.uptime + "s",
    totalLines: simulation.totalLines,
    currentIndex: simulation.currentIndex,
    lastSentAt: simulation.lastSentAt,
    linesPreview: simulation.linesPreview
  });
});

app.get("/health", (req, res) => res.json({ status: "✅ Healthy (simulation)", uptime: simulation.uptime + "s" }));

app.get("/groupuids", (req, res) => {
  if (!simulation.filePath) return res.json({ groupUIDs: [] });
  try {
    const lines = readLinesFromFile(simulation.filePath);
    const groups = detectGroupUIDs(lines);
    res.json({ groupUIDs: groups });
  } catch (e) {
    res.status(500).json({ error: "Failed to read file." });
  }
});

// logs endpoint - returns last N logs (default 200)
app.get("/logs", (req, res) => {
  const n = Math.min(2000, Math.max(1, parseInt(req.query.n || "200")));
  const start = Math.max(0, logs.length - n);
  res.json({ count: logs.length, logs: logs.slice(start) });
});

// download sessions file
app.get("/download-sessions", (req, res) => {
  if (!fs.existsSync(SESSIONS_FILE)) return res.status(404).send("No session file");
  res.download(SESSIONS_FILE);
});

function detectGroupUIDs(lines) {
  return lines.filter(l => /@g(\.|us)|-.*@g\.us/i.test(l));
}

// start server
app.listen(PORT, () => {
  console.log(`Servus Yadav Replyer (simulation) running on port ${PORT}`);  // auto-start loop if running true and file present
  if (simulation.running && simulation.filePath) startLoop();
});
