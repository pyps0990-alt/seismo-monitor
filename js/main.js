import { SimulatorSource } from './sources/simulator.js';
import { WebSocketSource } from './sources/websocket.js';
import { Detector, intensity, INTENSITY_COLORS, INTENSITY_NAMES } from './detector.js';
import { LongRecorder, EventRecorder, parseCsv } from './recorder.js';
import { drawWaves, drawSpark } from './chart.js';

const $ = id => document.getElementById(id);
const WINDOW_MS = 20000;

let source = null, detector = null;
let live = [];               // 最近 20 秒、已去重力的資料（gal）
let peakWindow = [];         // 最近 1 秒 PGA，用來顯示即時值
let sparkVals = [];          // PGA 走勢（每 250 ms 一點）
let marks = [];              // 波形上的事件標記
let rateCount = 0, rateT = performance.now(), sparkT = 0, eventCount = 0;
const longRec = new LongRecorder();
const eventRec = new EventRecorder();

function setStatus(cls, text) { $('statusDot').className = 'dot ' + cls; $('statusText').textContent = text; }

// ---- 震度色階 ----
const scaleEl = $('scale');
INTENSITY_NAMES.forEach(n => {
  const d = document.createElement('div');
  d.style.background = d.style.color = INTENSITY_COLORS[n];
  d.innerHTML = `<span>${n}</span>`;
  d.dataset.n = n;
  scaleEl.append(d);
});
let lastInt = null;
function showIntensity(name) {
  if (name === lastInt) return; lastInt = name;
  $('intNow').textContent = name ?? '–';
  document.documentElement.style.setProperty('--int', name ? INTENSITY_COLORS[name] : '#94a3b8');
  const idx = INTENSITY_NAMES.indexOf(name);
  [...scaleEl.children].forEach((d, i) => { d.classList.toggle('lit', i <= idx); d.classList.toggle('cur', i === idx); });
}

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
    const ac = new AudioContext();
    [0, 0.25, 0.5].forEach(d => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.25, ac.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + d + 0.2);
      o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.2);
    });
  } catch { /* 瀏覽器尚未允許播放音效 */ }
}

function connect() {
  const kind = $('sourceSel').value;
  source = kind === 'sim' ? new SimulatorSource({ rate: 100 }) : new WebSocketSource($('wsUrl').value.trim());
  detector = new Detector({ rate: 100, threshold: Number($('thr').value) });
  detector.onTrigger = ev => {
    eventRec.begin(ev); beep();
    marks.push({ t: ev.start, label: '觸發' });
    $('alert').hidden = false;
    $('alertText').textContent = ` ${new Date(ev.start).toLocaleTimeString()} 起，正在記錄事件資料…`;
  };
  detector.onEnd = ev => { eventRec.end(ev); $('alert').hidden = true; };
  live = []; peakWindow = []; sparkVals = []; marks = [];
  source.start(onSamples, setStatus);
  $('btnConnect').classList.add('stop');
  $('btnConnect').querySelector('.ico').textContent = '■';
  $('btnConnect').querySelector('.lbl').textContent = '停止';
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
  $('btnConnect').classList.remove('stop');
  $('btnConnect').querySelector('.ico').textContent = '▶';
  $('btnConnect').querySelector('.lbl').textContent = '開始';
}

eventRec.onSaved = (ev, name, url) => {
  const n = intensity(ev.pga);
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${new Date(ev.start).toLocaleString()}</td><td>${ev.pga.toFixed(1)} gal</td>
    <td><span class="badge" style="background:${INTENSITY_COLORS[n]}">${n}</span></td>
    <td>${((ev.end - ev.start) / 1000).toFixed(1)} 秒</td><td></td>`;
  const a = Object.assign(document.createElement('a'), { href: url, download: name, textContent: '⤓ CSV' , title: name });
  tr.lastElementChild.append(a);
  $('events').tBodies[0].prepend(tr);
  eventCount++;
  $('evEmpty').hidden = true;
  $('evCount').textContent = `共 ${eventCount} 筆`;
};

// ---- UI ----
document.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
  if (source) disconnect();
  document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b));
  $('sourceSel').value = b.dataset.src;
  $('wsBox').hidden = b.dataset.src !== 'ws';
  $('btnQuake').hidden = b.dataset.src !== 'sim';
});
$('btnConnect').onclick = () => (source ? disconnect() : connect());
$('btnQuake').onclick = () => {
  if (!(source instanceof SimulatorSource)) connect();
  source.injectQuake();
};
$('thr').onchange = () => { if (detector) detector.threshold = Number($('thr').value); };
$('btnRecord').onclick = async () => {
  const b = $('btnRecord');
  try {
    if (longRec.active) { await longRec.stop(); b.classList.remove('active'); b.querySelector('.lbl').textContent = '開始記錄'; $('recNow').textContent = '已停止'; }
    else { await longRec.start(); b.classList.add('active'); b.querySelector('.lbl').textContent = '停止記錄'; $('recNow').textContent = longRec.name; }
  } catch (e) { if (e.name !== 'AbortError') alert('記錄失敗：' + e.message); }
};

// ---- 回看 ----
async function loadReplay(file) {
  const raw = parseCsv(await file.text());
  if (!raw.length) { $('replayInfo').textContent = '讀不到資料（格式不符）'; return; }
  const dt = (raw[raw.length - 1].t - raw[0].t) / Math.max(1, raw.length - 1);
  const d = new Detector({ rate: Math.round(1000 / dt) || 100 });
  const f = raw.map(s => d.process(s));
  let peak = f[0];
  for (const s of f) if (s.pga > peak.pga) peak = s;
  const n = intensity(peak.pga);
  $('replayInfo').innerHTML = `${file.name} · ${((raw[raw.length - 1].t - raw[0].t) / 1000).toFixed(1)} 秒 · 最大 PGA <b>${peak.pga.toFixed(1)}</b> gal <span class="badge" style="background:${INTENSITY_COLORS[n]}">${n}</span>`;
  $('replay').hidden = false;
  drawWaves($('replay'), f, f[0].t, f[f.length - 1].t, { marks: [{ t: peak.t, label: `最大 ${peak.pga.toFixed(1)} gal` }] });
}
$('fileIn').onchange = () => $('fileIn').files[0] && loadReplay($('fileIn').files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', ev => ev.dataTransfer.files[0] && loadReplay(ev.dataTransfer.files[0]));

// ---- 繪圖迴圈 ----
function frame() {
  const now = Date.now();
  $('clock').textContent = new Date(now).toLocaleTimeString('zh-TW', { hour12: false });
  marks = marks.filter(m => now - m.t < WINDOW_MS);
  drawWaves($('live'), live, now - WINDOW_MS, now, { smooth: true, marks });
  if (detector) {
    const pga = peakWindow.reduce((m, s) => Math.max(m, s.pga), 0);
    $('pgaNow').textContent = pga.toFixed(1);
    showIntensity(intensity(pga));
    const r = detector.ratio ?? 0, thr = detector.threshold, full = thr * 2;
    $('ratioNow').textContent = r.toFixed(1);
    $('ratioBar').style.width = Math.min(100, (r / full) * 100) + '%';
    $('ratioBar').classList.toggle('hot', r >= thr);
    $('thrMark').style.left = '50%';
    if (now - sparkT > 250) { sparkT = now; sparkVals.push(pga); if (sparkVals.length > 120) sparkVals.shift(); }
    drawSpark($('spark'), sparkVals, pga >= 8 ? '#fb923c' : '#818cf8');
  }
  if (longRec.active) $('recRows').textContent = `${longRec.rows.toLocaleString()} 筆`;
  const p = performance.now();
  if (p - rateT > 1000) { $('rateNow').textContent = source ? Math.round(rateCount * 1000 / (p - rateT)) : '–'; rateCount = 0; rateT = p; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
