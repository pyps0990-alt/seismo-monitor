import { SimulatorSource } from './sources/simulator.js';
import { WebSocketSource } from './sources/websocket.js';
import { Detector, intensity } from './detector.js';
import { LongRecorder, EventRecorder, parseCsv } from './recorder.js';
import { drawWaves } from './chart.js';

const $ = id => document.getElementById(id);
const WINDOW_MS = 20000;

let source = null, detector = null;
let live = [];               // 最近 20 秒、已去重力的資料（gal）
let peakWindow = [];         // 最近 1 秒 PGA，用來顯示即時值
let rateCount = 0, rateT = performance.now();
const longRec = new LongRecorder();
const eventRec = new EventRecorder();

function setStatus(cls, text) { $('statusDot').className = 'dot ' + cls; $('statusText').textContent = text; }

function onSamples(batch) {
  for (const s of batch) {
    longRec.add(s);
    eventRec.add(s);
    const f = detector.process(s);
    live.push(f);
    peakWindow.push(f);
  }
  rateCount += batch.length;
  const tNow = batch[batch.length - 1].t;
  while (live.length && tNow - live[0].t > WINDOW_MS) live.shift();
  while (peakWindow.length && tNow - peakWindow[0].t > 1000) peakWindow.shift();
}

function beep() {
  if (!$('sound').checked) return;
  try {
    const ac = new AudioContext(), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0.3, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.8);
    o.start(); o.stop(ac.currentTime + 0.8);
  } catch { /* 瀏覽器尚未允許播放音效 */ }
}

function connect() {
  const kind = $('sourceSel').value;
  source = kind === 'sim' ? new SimulatorSource({ rate: 100 }) : new WebSocketSource($('wsUrl').value.trim());
  detector = new Detector({ rate: 100, threshold: Number($('thr').value) });
  detector.onTrigger = ev => {
    eventRec.begin(ev); beep();
    $('alert').hidden = false;
    $('alert').textContent = `⚠ 偵測到震動！${new Date(ev.start).toLocaleTimeString()}`;
  };
  detector.onEnd = ev => { eventRec.end(ev); $('alert').hidden = true; };
  live = []; peakWindow = [];
  source.start(onSamples, setStatus);
  $('btnConnect').textContent = '停止';
}

function disconnect() {
  source?.stop(); source = null;
  if (eventRec.capture) { // 停止時若有事件正在錄，直接存檔，避免遺失
    const ev = eventRec.capture.ev;
    if (!ev.end) ev.end = live.length ? live[live.length - 1].t : Date.now();
    eventRec.save();
  }
  $('alert').hidden = true;
  setStatus('', '未連線');
  $('btnConnect').textContent = '開始';
}

eventRec.onSaved = (ev, name, url) => {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${new Date(ev.start).toLocaleString()}</td><td>${ev.pga.toFixed(1)}</td>
    <td>${intensity(ev.pga)}</td><td>${((ev.end - ev.start) / 1000).toFixed(1)}</td><td></td>`;
  const a = Object.assign(document.createElement('a'), { href: url, download: name, textContent: name });
  tr.lastElementChild.append(a);
  $('events').tBodies[0].prepend(tr);
};

// ---- UI ----
$('sourceSel').onchange = () => { $('wsBox').hidden = $('sourceSel').value !== 'ws'; $('btnQuake').hidden = $('sourceSel').value !== 'sim'; };
$('btnConnect').onclick = () => (source ? disconnect() : connect());
$('btnQuake').onclick = () => { if (source instanceof SimulatorSource) source.injectQuake(); else alert('請先選「模擬資料」並按開始'); };
$('thr').onchange = () => { if (detector) detector.threshold = Number($('thr').value); };
$('btnRecord').onclick = async () => {
  try {
    if (longRec.active) { await longRec.stop(); $('btnRecord').textContent = '開始記錄 CSV'; $('btnRecord').classList.remove('active'); $('recNow').textContent = '已停止'; }
    else { await longRec.start(); $('btnRecord').textContent = '停止記錄'; $('btnRecord').classList.add('active'); $('recNow').textContent = longRec.name; }
  } catch (e) { if (e.name !== 'AbortError') alert('記錄失敗：' + e.message); }
};

$('fileIn').onchange = async () => {
  const file = $('fileIn').files[0]; if (!file) return;
  const raw = parseCsv(await file.text());
  if (!raw.length) { $('replayInfo').textContent = '讀不到資料（格式不符）'; return; }
  const dt = (raw[raw.length - 1].t - raw[0].t) / Math.max(1, raw.length - 1);
  const d = new Detector({ rate: Math.round(1000 / dt) || 100 });
  const f = raw.map(s => d.process(s));
  const pga = f.reduce((m, s) => Math.max(m, s.pga), 0);
  $('replayInfo').textContent = ` ${raw.length} 筆，${((raw[raw.length - 1].t - raw[0].t) / 1000).toFixed(1)} 秒，最大 PGA ${pga.toFixed(1)} gal（估計震度 ${intensity(pga)}）`;
  drawWaves($('replay'), f, f[0].t, f[f.length - 1].t);
};

function frame() {
  const now = Date.now();
  drawWaves($('live'), live, now - WINDOW_MS, now);
  if (detector) {
    const pga = peakWindow.reduce((m, s) => Math.max(m, s.pga), 0);
    $('pgaNow').textContent = pga.toFixed(1);
    $('intNow').textContent = intensity(pga);
    $('ratioNow').textContent = (detector.ratio ?? 0).toFixed(1);
  }
  if (longRec.active) $('recRows').textContent = `${longRec.rows.toLocaleString()} 筆`;
  const p = performance.now();
  if (p - rateT > 1000) { $('rateNow').textContent = Math.round(rateCount * 1000 / (p - rateT)); rateCount = 0; rateT = p; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
