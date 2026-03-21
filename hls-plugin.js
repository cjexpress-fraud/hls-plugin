/**
 * HLS Proxy — ใช้เฉพาะ FFmpeg: รับ streamUrl + startOffset แล้วรัน FFmpeg ออก HLS
 * ไม่ใช้ MediaMTX
 *
 * รัน: node hls-proxy.js  (พอร์ต 9555)
 *   GET /hls?u=streamUrl&startTime=ISO&endTime=ISO&startOffset=0&aspect=16:9&aspectMode=stretch → สตาร์ท FFmpeg แล้ว redirect ไป /live/:playbackId/playlist.m3u8
 *   aspectMode: stretch=เต็ม 16:9 (ยืด) | pad=แถบดำ | cover=crop กลาง (env HLS_16_9_MODE เป็นค่าเริ่มต้นเมื่อไม่ส่ง query)
 *   GET /live/:playbackId/playlist.m3u8 และ /live/:playbackId/:file → เสิร์ฟ HLS
 *   GET /hls/stop?path=playbackId → หยุด FFmpeg และลบโฟลเดอร์
 *   GET /open-mpv?u=<rtspUrl> → เปิด mpv.exe — ลำดับค้นหา: env MPV_PATH → mpv.exe โฟลเดอร์เดียวกับ hls-plugin.js → .\\mpv\\mpv.exe
 *   MPV (env):
 *     MPV_VIDEO_ASPECT_OVERRIDE=16:9  (ค่าเริ่มต้น 16:9 — ว่างเพื่อปิดการบังคับสัดส่วน)
 *     MPV_GEOMETRY=1280x720             (ขนาดหน้าต่างเริ่มต้น — ส่งเป็นอาร์กิวเมนต์ --geometry=)
 *     MPV_AUTOFIT=1280x720 หรือ 1280   (--autofit= หรือ --autofit-larger=)
 *     MPV_CONFIG_DIR=...               (override — ถ้าไม่ตั้ง แต่มี mpv.conf ข้าง hls-plugin.js จะใช้อัตโนมัติ)
 *     MPV_EXTRA_ARGS                   (อาร์กิวเมนต์เพิ่ม คั่นช่องว่าง), MPV_NO_AUDIO=1
 *     MPV_ONTOP=0                      (ปิด --ontop — ค่าเริ่มต้นเปิด on-top ให้โผล่หน้าเบราว์เซอร์)
 *
 * ดิสก์ / ไฟล์ .ts:
 * - เก็บใต้โฟลเดอร์ temp ของ OS (เช่น %TEMP%\\fraud-cctv-live) ไม่เขียนลงโปรเจกต์
 * - โหมด playlist แบบ event + list_size 0 จะเก็บ segment จนจบสตรีม — ใช้พื้นที่ประมาณ (ความยาววินาที / hls_time) × ขนาดต่อไฟล์
 * - ลบอัตโนมัติเมื่อ: ปิด VDO (เรียก /hls/stop), เปิดคลิปใหม่ที่ playbackId เดิม, FFmpeg จบเอง, หรือสตาร์ท proxy ใหม่ (ลบ session เก่า)
 * - ความยาว segment: env HLS_SEGMENT_DURATION=2..30 (ค่าเริ่มต้น 3 วิ — สั้นเริ่มเล่นเร็วขึ้น แต่ไฟล์ .ts มากขึ้น)
 *
 * Debug (คอนโซล):
 * - set HLS_DEBUG=1  → log คำขอ (ยกเว้น /ping), timing, playbackId, URL แบบซ่อนรหัสผ่าน + บรรทัด mpv/open-mpv (ซ่อนรหัส)
 * - set HLS_DEBUG_FFMPEG=1 → เพิ่ม stderr จาก FFmpeg ตอนสตรีม HLS (ละเอียดมาก)
 * - set HLS_DEBUG_MPV=1 → log RTSP เต็ม (มีรหัส) + คำสั่ง mpv สำหรับคัดลอก — ใช้เฉพาะเครื่อง dev แล้วลบ log
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// เก็บ segment ชั่วคราวในโฟลเดอร์ temp ของระบบ (ไม่บันทึกลงโปรเจกต์) — ลบเมื่อปิด VDO / สตาร์ท proxy ใหม่
const LIVE_DIR = path.join(os.tmpdir(), 'fraud-cctv-live');
const FFMPEG_DIR = path.join(__dirname, 'ffmpeg');
const FFMPEG_PATH = path.join(FFMPEG_DIR, 'ffmpeg.exe');
/** ลำดับ: MPV_PATH (env) → mpv.exe ข้าง hls-plugin.js → mpv\\mpv.exe (แบบเดิม) */
function resolveMpvPath() {
  if (process.env.MPV_PATH) return path.resolve(process.env.MPV_PATH);
  const beside = path.join(__dirname, 'mpv.exe');
  if (fs.existsSync(beside)) return beside;
  return path.join(__dirname, 'mpv', 'mpv.exe');
}

const MPV_PATH = resolveMpvPath();
/** โฟลเดอร์ที่มี mpv.exe — ใช้เป็น cwd ตอน spawn ให้โหลด DLL ข้างๆ บน Windows ได้ถูกต้อง */
const MPV_DIR = path.dirname(MPV_PATH);
/** แยกอาร์กิวเมนต์เพิ่มให้ mpv — คั่นด้วยช่องว่าง (ต่อท้ายหลัง default ของเรา — override ได้) */
const MPV_EXTRA_ARGS = (process.env.MPV_EXTRA_ARGS || '')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

/**
 * อาร์กิวเมนต์ mpv สำหรับ RTSP: บังคับ 16:9, ขนาดหน้าต่าง, แล้วต่อด้วย MPV_EXTRA_ARGS
 */
/** โฟลเดอร์ที่มี mpv.conf — env MPV_CONFIG_DIR หรือโฟลเดอร์เดียวกับ hls-plugin.js ถ้ามีไฟล์ mpv.conf */
function resolveMpvConfigDir() {
  const fromEnv = String(process.env.MPV_CONFIG_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (fs.existsSync(path.join(__dirname, 'mpv.conf'))) return __dirname;
  return '';
}

function buildMpvArgs(streamUrl) {
  const args = [];
  const cfgDir = resolveMpvConfigDir();
  if (cfgDir) args.push('--config-dir=' + cfgDir);

  const ao = process.env.MPV_VIDEO_ASPECT_OVERRIDE;
  const aspectOverride = ao === undefined ? '16:9' : String(ao).trim();
  if (aspectOverride) args.push('--video-aspect-override=' + aspectOverride);

  const geom = String(process.env.MPV_GEOMETRY || '').trim();
  if (geom) args.push('--geometry=' + geom);

  const autofit = String(process.env.MPV_AUTOFIT || '').trim();
  if (autofit) {
    if (/^\d+x\d+$/i.test(autofit)) args.push('--autofit=' + autofit);
    else if (/^\d+$/.test(autofit)) args.push('--autofit-larger=' + autofit);
  }

  const mpvOntopOff = ['0', 'false', 'no', 'off'].includes(String(process.env.MPV_ONTOP || '').toLowerCase());
  if (!mpvOntopOff) args.push('--ontop');

  args.push(...MPV_EXTRA_ARGS);
  if (process.env.MPV_NO_AUDIO === '1') args.push('--no-audio');
  args.push('--demuxer-lavf-o=rtsp_transport=tcp');
  args.push(streamUrl);
  return args;
}

function quoteArgForMpvDebug(s) {
  const t = String(s);
  if (/[\s"]/.test(t)) return '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return t;
}
const _segDur = parseInt(process.env.HLS_SEGMENT_DURATION, 10);
const HLS_SEGMENT_DURATION = Number.isFinite(_segDur) && _segDur >= 2 && _segDur <= 30 ? _segDur : 3;
/** คุณภาพ HLS: superfast ชัดกว่า ultrafast; ปรับผ่าน env HLS_VIDEO_PRESET / HLS_VIDEO_BITRATE */
const HLS_VIDEO_PRESET = String(process.env.HLS_VIDEO_PRESET || 'superfast').trim() || 'superfast';
const HLS_VIDEO_BITRATE = String(process.env.HLS_VIDEO_BITRATE || '2500k').trim() || '2500k';
const PLAYLIST_WAIT_MS = 45000;
const POLL_MS = 120;

/**
 * 16:9 เอาต์พุต 1920×1080
 * - stretch (ค่าเริ่มต้น): ยืด/บีบให้เต็มเฟรม — ไม่มีแถบดำ (กล้อง 4:3 จะถูกยืดแนวนอน)
 * - pad: คงสัดส่วนต้นทาง แล้ว pad ดำ (pillarbox/letterbox)
 * - cover: คงสัดส่วน แล้ว crop กลางให้เต็ม 16:9
 * env HLS_16_9_MODE=stretch|pad|cover — แต่ละคำขอ override ได้ด้วย query aspectMode=…
 */
function normalize1639Mode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'pad' || s === 'fit' || s === 'letterbox' || s === 'pillarbox') return 'pad';
  if (s === 'cover' || s === 'crop') return 'cover';
  if (s === 'stretch' || s === 'fill' || s === 'scale') return 'stretch';
  return 'stretch';
}

const HLS_16_9_MODE_DEFAULT = normalize1639Mode(process.env.HLS_16_9_MODE || 'stretch');

function vfFilter16x9(modeNorm) {
  switch (modeNorm) {
    case 'pad':
      return 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1';
    case 'cover':
      return 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2,setsar=1';
    default:
      return 'scale=1920:1080,setsar=1';
  }
}

const HLS_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.HLS_DEBUG || '').toLowerCase());
const HLS_DEBUG_FFMPEG = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.HLS_DEBUG_FFMPEG || '').toLowerCase()
);
const HLS_DEBUG_MPV = ['1', 'true', 'yes', 'on'].includes(String(process.env.HLS_DEBUG_MPV || '').toLowerCase());

function debug(...args) {
  if (HLS_DEBUG) console.log('[hls-debug]', new Date().toISOString(), ...args);
}

/** ซ่อน password ใน rtsp://user:pass@host ก่อนลง log */
function sanitizeStreamUrlForLog(u) {
  if (u == null || u === '') return '';
  return String(u).replace(/(rtsps?:\/\/)([^:/@]+):([^@]+)@/i, '$1$2:***@');
}

/** query string สำหรับ log — redact ?u= */
function debugRequestLine(url) {
  try {
    const u = new URL(url.href);
    if (u.searchParams.has('u')) {
      u.searchParams.set('u', sanitizeStreamUrlForLog(u.searchParams.get('u')) || '(empty)');
    }
    return u.pathname + u.search;
  } catch (_) {
    return url.pathname + url.search;
  }
}

// playbackId = pXXXXXXXXXXXXXXX_123 (pathName_startOffset)
const PLAYBACK_ID_REGEX = /^p[a-f0-9]{15}_\d+$/i;

try {
  require('child_process').execSync(`"${FFMPEG_PATH}" -version`, { stdio: 'ignore' });
} catch (e) {
  console.warn(`\x1b[33m[hls-proxy] WARNING: ffmpeg.exe not found at ${FFMPEG_PATH}\x1b[0m`);
}

const PROXY_PORT = parseInt(process.env.HLS_PROXY_PORT, 10) || 9555;

/** บรรทัดคัดลอกสำหรับทดสอบ mpv ด้วยมือ (รหัสซ่อน / หรือเต็มถ้า HLS_DEBUG_MPV) */
function logMpvDebugLines(streamUrl) {
  const argsReal = buildMpvArgs(streamUrl);
  const argsSafe = argsReal.map((a, i) =>
    i === argsReal.length - 1 ? sanitizeStreamUrlForLog(a) : a
  );
  const cmdSafe = 'mpv ' + argsSafe.map(quoteArgForMpvDebug).join(' ');
  console.log('[mpv-debug] copy (password hidden): ' + cmdSafe);
  console.log(
    '[mpv-debug] copy GET (password hidden): http://127.0.0.1:' +
      PROXY_PORT +
      '/open-mpv?u=' +
      encodeURIComponent(sanitizeStreamUrlForLog(streamUrl))
  );
  if (HLS_DEBUG_MPV) {
    const cmdReal = 'mpv ' + argsReal.map(quoteArgForMpvDebug).join(' ');
    console.log('[mpv-debug] FULL RTSP (local only — delete logs): ' + streamUrl);
    console.log('[mpv-debug] copy REAL mpv: ' + cmdReal);
    console.log(
      '[mpv-debug] copy REAL open-mpv: http://127.0.0.1:' +
        PROXY_PORT +
        '/open-mpv?u=' +
        encodeURIComponent(streamUrl)
    );
  }
}

// playbackId -> { process, outDir }
const processes = new Map();

function pathNameFromStreamUrl(streamUrl) {
  const hash = crypto.createHash('sha256').update(streamUrl).digest('hex');
  return 'p' + hash.slice(0, 15);
}

function removePlaybackDir(playbackId) {
  const outDir = path.join(LIVE_DIR, playbackId);
  try {
    if (fs.existsSync(outDir)) {
      fs.readdirSync(outDir).forEach((f) => {
        try {
          fs.unlinkSync(path.join(outDir, f));
        } catch (_) {}
      });
      fs.rmdirSync(outDir);
    }
  } catch (_) {}
}

function stopPlayback(playbackId) {
  const entry = processes.get(playbackId);
  if (entry) {
    try {
      entry.process.kill('SIGTERM');
    } catch (_) {}
    processes.delete(playbackId);
  }
  removePlaybackDir(playbackId);
}

function waitForPlaylist(playlistPath) {
  return new Promise((resolve) => {
    const deadline = Date.now() + PLAYLIST_WAIT_MS;
    const t = setInterval(() => {
      if (fs.existsSync(playlistPath)) {
        clearInterval(t);
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(t);
        resolve(false);
      }
    }, POLL_MS);
  });
}

function startFfmpegHls(playbackId, streamUrl, startOffsetSec, aspect, aspectMode) {
  const outDir = path.join(LIVE_DIR, playbackId);
  if (fs.existsSync(outDir)) {
    stopPlayback(playbackId);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const segFile = path.join(outDir, 'seg_%03d.ts');
  const playlistPath = path.join(outDir, 'playlist.m3u8');
  const aspectVal = String(aspect || '16:9').trim();
  const force16x9 = aspectVal === '16:9';
  const modeNorm = normalize1639Mode(aspectMode != null && aspectMode !== '' ? aspectMode : HLS_16_9_MODE_DEFAULT);
  const videoFilterArgs = force16x9 ? ['-vf', vfFilter16x9(modeNorm)] : [];
  // -ss หลัง -i: RTSP หลายกล้องไม่รองรับ input seek ก่อน -i — ถ้วางก่อน -i มักได้ภาพตั้งแต่ต้นคลิปแม้ส่ง startOffset
  const seekAfterInput = Math.max(0, startOffsetSec);
  const args = [
    '-fflags', '+nobuffer',
    '-rtsp_transport', 'tcp',
    '-i', streamUrl,
    ...(seekAfterInput > 0 ? ['-ss', String(seekAfterInput)] : []),
    ...videoFilterArgs,
    '-c:v', 'libx264', '-preset', HLS_VIDEO_PRESET, '-tune', 'zerolatency', '-b:v', HLS_VIDEO_BITRATE,
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_DURATION),
    // 0 = รายการทุก segment อยู่ใน playlist — ไม่เลื่อนแบบ live สั้นๆ (กรณีเดิม list_size=10+delete_segments ทำให้ duration/seekable ในเบราว์เซอร์ไม่ตรงความยาวจริง)
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'append_list',
    '-hls_segment_filename', segFile,
    playlistPath,
  ];

  debug('startFfmpegHls', {
    playbackId,
    url: sanitizeStreamUrlForLog(streamUrl),
    startOffsetSec,
    aspect: aspectVal,
    aspect1639Mode: force16x9 ? modeNorm : '(off)',
    outDir,
  });

  const proc = spawn(FFMPEG_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', () => {});
  if (HLS_DEBUG_FFMPEG) {
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      s.split(/\r?\n/)
        .filter((line) => line.trim())
        .forEach((line) => console.log('[ffmpeg]', playbackId, line.trim()));
    });
  } else {
    proc.stderr.on('data', () => {});
  }
  proc.on('error', (err) => {
    console.error('[hls-proxy] FFmpeg spawn error:', err.message);
    debug('FFmpeg spawn error detail', err);
    stopPlayback(playbackId);
  });
  proc.on('exit', (code, sig) => {
    debug('FFmpeg exit', { playbackId, code, signal: sig });
    processes.delete(playbackId);
    // สตรีมจบเอง (RTSP ถึง endtime) — ลบ .ts ไม่ให้ค้างถ้าไม่มี /hls/stop
    removePlaybackDir(playbackId);
  });

  processes.set(playbackId, { process: proc, outDir });
  return playlistPath;
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (HLS_DEBUG && pathname !== '/ping' && pathname !== '/') {
    debug('req', req.method, debugRequestLine(url));
  }

  // --- ตรวจสอบว่า server ยังรันอยู่ (ให้ frontend เรียกก่อนกดเล่น VDO) ---
  if ((pathname === '' || pathname === '/' || pathname === '/ping') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...cors });
    res.end('OK');
    return;
  }

  // --- เปิด RTSP ใน MPV (mpv/mpv.exe ข้าง plugin) ---
  if (pathname === '/open-mpv' && req.method === 'GET') {
    const encoded = url.searchParams.get('u');
    if (!encoded) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
      res.end('Missing query: u=<streamUrl>');
      return;
    }
    let streamUrl;
    try {
      streamUrl = decodeURIComponent(encoded);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Invalid encoding');
      return;
    }
    if (!streamUrl.startsWith('rtsp://') && !streamUrl.startsWith('rtsps://')) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Invalid streamUrl');
      return;
    }
    if (HLS_DEBUG || HLS_DEBUG_MPV) {
      logMpvDebugLines(streamUrl);
    }
    if (!fs.existsSync(MPV_PATH)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
      res.end(
        'mpv.exe not found at: ' +
          MPV_PATH +
          ' — วาง mpv.exe โฟลเดียวกับ hls-plugin.js หรือในโฟลเดอร์ mpv\\ หรือตั้ง env MPV_PATH'
      );
      return;
    }
    let child;
    try {
      // cwd = โฟลเดอร์ mpv — บน Windows ช่วยให้โหลด dll ข้าง mpv.exe ได้ (ถ้าไม่ตั้ง บางเครื่องเปิดแล้วปิดทันที)
      // RTSP ผ่าน TCP — กับ Dahua/NVR หลายรุ่นต้องใช้แทน UDP (ส่งต่อไปยัง ffmpeg ใน mpv)
      child = spawn(MPV_PATH, buildMpvArgs(streamUrl), {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: MPV_DIR,
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
      res.end(String(e.message || e));
      return;
    }
    // spawn() แทบไม่ throw ถ้าไม่มีไฟล์ — Node จะ emit 'error' ทีหลัง; log จริงเมื่อ 'spawn' / 'exit'
    child.on('error', (err) => {
      console.error('[hls-proxy] MPV spawn error:', err.message, 'exe=', MPV_PATH);
    });
    child.on('spawn', () => {
      console.log('[hls-proxy] /open-mpv MPV process started pid=%s cwd=%s', child.pid, MPV_DIR);
    });
    child.on('exit', (code, signal) => {
      if (code === 0 || code === null) return;
      console.warn(
        '[hls-proxy] MPV exited: code=%s signal=%s url=%s (log ซ่อนรหัสผ่านเท่านั้น — ค่าจริงจาก API)',
        code,
        signal,
        sanitizeStreamUrlForLog(streamUrl)
      );
      if (code === 5) {
        console.warn(
          '[hls-proxy] hint: code 5 = เปิดสตรีมไม่ได้ — ลองตั้ง MPV_NO_AUDIO=1 ถ้าเสียงทำให้ล้ม; ตรวจรหัส cfg_cctv, ช่วงเวลาใน URL กับ NVR, มีคลิปในช่วงนั้น, และเน็ตถึง IP กล้อง — ตั้ง HLS_DEBUG_MPV=1 แล้วดูบรรทัด copy REAL mpv'
        );
      }
    });
    child.unref();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
    res.end('OK');
    return;
  }

  // --- หยุด playback (ปิด VDO / ปิด modal) ---
  if (pathname === '/hls/stop' && req.method === 'GET') {
    const playbackId = url.searchParams.get('path') || '';
    if (!PLAYBACK_ID_REGEX.test(playbackId)) {
      console.warn('[hls-proxy] /hls/stop ignored: invalid path param');
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Bad path');
      return;
    }
    console.log('[hls-proxy] /hls/stop playbackId=%s', playbackId);
    stopPlayback(playbackId);
    res.writeHead(200, { 'Content-Type': 'text/plain', ...cors });
    res.end('OK');
    return;
  }

  // --- เสิร์ฟ HLS playlist และ segment จากโฟลเดอร์ live/:playbackId ---
  const liveMatch = pathname.match(/^\/live\/([^/]+)\/(.+)$/);
  if (liveMatch && req.method === 'GET') {
    const playbackId = liveMatch[1];
    const file = liveMatch[2];
    if (!PLAYBACK_ID_REGEX.test(playbackId) || file.includes('..') || file.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Bad path');
      return;
    }
    const filePath = path.join(LIVE_DIR, playbackId, path.basename(file));
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        debug('live 404', { playbackId, file });
        res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
        res.end('Not Found');
        return;
      }
      const data = fs.readFileSync(filePath);
      if (HLS_DEBUG && file.endsWith('.m3u8')) {
        debug('live serve', { playbackId, file, bytes: data.length });
      }
      const contentType = file.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : (file.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': contentType, ...cors });
      res.end(data);
      return;
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
      res.end('Not Found');
      return;
    }
  }

  // --- ดาวน์โหลดเป็น MP4 ---
  if (pathname === '/hls/download' && req.method === 'GET') {
    const encoded = url.searchParams.get('u');
    if (!encoded) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Missing query: u=<streamUrl>');
      return;
    }
    let streamUrl;
    try { streamUrl = decodeURIComponent(encoded); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Invalid encoding');
      return;
    }
    if (!streamUrl.startsWith('rtsp://') && !streamUrl.startsWith('rtsps://')) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
      res.end('Invalid streamUrl');
      return;
    }

    const startOffsetSec = Math.max(0, parseInt(url.searchParams.get('startOffset') || '0', 10) || 0);
    const durationParam = url.searchParams.get('duration');
    const durationArgs = durationParam ? ['-t', String(Math.max(1, parseInt(durationParam, 10) || 60))] : [];

    const aspectVal = String(url.searchParams.get('aspect') || '16:9').trim();
    const aspectModeParam = url.searchParams.get('aspectMode');
    const modeNormDl = normalize1639Mode(
      aspectModeParam != null && aspectModeParam !== '' ? aspectModeParam : HLS_16_9_MODE_DEFAULT
    );
    const force16x9 = aspectVal === '16:9';
    const videoFilterArgs = force16x9 ? ['-vf', vfFilter16x9(modeNormDl)] : [];
    const seekAfterInput = Math.max(0, startOffsetSec);
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', streamUrl,
      ...(seekAfterInput > 0 ? ['-ss', String(seekAfterInput)] : []),
      ...videoFilterArgs,
      ...durationArgs,
      '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency', '-crf', '28',
      '-c:a', 'aac',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov',
      'pipe:1'
    ];

    debug('download start', {
      url: sanitizeStreamUrlForLog(streamUrl),
      startOffsetSec,
      duration: durationParam || '(open)',
      aspect: aspectVal,
      aspect1639Mode: force16x9 ? modeNormDl : '(off)',
    });
    console.log(
      `[hls-proxy] Starting MP4 Download... url=${sanitizeStreamUrlForLog(streamUrl)} offset=${startOffsetSec}`
    );
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    if (HLS_DEBUG_FFMPEG) {
      proc.stderr.on('data', (chunk) => {
        chunk
          .toString()
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .forEach((line) => console.log('[ffmpeg-download]', line.trim()));
      });
    } else {
      proc.stderr.on('data', () => {});
    }

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="cctv-export-' + Date.now() + '.mp4"',
      ...cors
    });

    proc.stdout.pipe(res);

    const killFfmpeg = () => { try { proc.kill('SIGKILL'); } catch (_) {} };
    res.on('close', killFfmpeg);
    res.on('finish', killFfmpeg);
    proc.on('error', () => { res.end(); });
    
    return;
  }

  // --- /hls?u=streamUrl&startTime=...&endTime=...&startOffset=0 ---
  if (pathname !== '/hls' || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
    res.end('Not Found');
    return;
  }

  const encoded = url.searchParams.get('u');
  if (!encoded) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
    res.end('Missing query: u=<streamUrl>');
    return;
  }

  let streamUrl;
  try {
    streamUrl = decodeURIComponent(encoded);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
    res.end('Invalid encoding');
    return;
  }

  if (!streamUrl.startsWith('rtsp://') && !streamUrl.startsWith('rtsps://')) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...cors });
    res.end('Invalid streamUrl');
    return;
  }

  const startOffsetSec = Math.max(0, parseInt(url.searchParams.get('startOffset') || '0', 10) || 0);
  const pathName = pathNameFromStreamUrl(streamUrl);
  const playbackId = pathName + '_' + startOffsetSec;

  const aspect = String(url.searchParams.get('aspect') || '16:9').trim();
  const aspectModeParam = url.searchParams.get('aspectMode');
  const playlistPath = startFfmpegHls(
    playbackId,
    streamUrl,
    startOffsetSec,
    aspect,
    aspectModeParam != null && aspectModeParam !== '' ? aspectModeParam : HLS_16_9_MODE_DEFAULT
  );
  const ready = await waitForPlaylist(playlistPath);
  if (!ready) {
    stopPlayback(playbackId);
    res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
    res.end('FFmpeg ยังไม่พร้อม — ลองกดเล่นใหม่');
    return;
  }

  const baseUrl = `http://127.0.0.1:${PROXY_PORT}/live/${playbackId}`;
  res.writeHead(302, {
    Location: baseUrl + '/playlist.m3u8',
    ...cors,
  });
  res.end();
});

if (!fs.existsSync(LIVE_DIR)) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
} else {
  // ลบโฟลเดอร์ session เก่าที่ค้างจากรันก่อนหน้า
  try {
    fs.readdirSync(LIVE_DIR).forEach((name) => {
      const dir = path.join(LIVE_DIR, name);
      if (PLAYBACK_ID_REGEX.test(name) && fs.statSync(dir).isDirectory()) {
        fs.readdirSync(dir).forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} });
        fs.rmdirSync(dir);
      }
    });
  } catch (_) {}
}

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log('[hls-proxy] FFmpeg-only listening on http://127.0.0.1:' + PROXY_PORT);
  console.log('[hls-proxy] HLS segments in temp:', LIVE_DIR);
  console.log('[hls-proxy] HLS_SEGMENT_DURATION=' + HLS_SEGMENT_DURATION + 's (env HLS_SEGMENT_DURATION, 2–30)');
  console.log('[hls-proxy] HLS encode: preset=' + HLS_VIDEO_PRESET + ' b:v=' + HLS_VIDEO_BITRATE + ' (HLS_VIDEO_PRESET, HLS_VIDEO_BITRATE)');
  console.log(
    '[hls-proxy] MPV exe:', MPV_PATH,
    'exists=' + fs.existsSync(MPV_PATH),
    'spawn cwd=' + MPV_DIR
  );
  const _ao = process.env.MPV_VIDEO_ASPECT_OVERRIDE;
  const _aspectLog = _ao === undefined ? '16:9 (default)' : String(_ao).trim() || 'off';
  console.log(
    '[hls-proxy] MPV window: aspect-override=' +
      _aspectLog +
      ' geometry=' +
      (process.env.MPV_GEOMETRY || '(unset)') +
      ' autofit=' +
      (process.env.MPV_AUTOFIT || '(unset)') +
      ' config-dir=' +
      (resolveMpvConfigDir() || '(unset)')
  );
  console.log(
    '[hls-proxy] debug: HLS_DEBUG=' +
      (HLS_DEBUG ? 'on' : 'off') +
      ' HLS_DEBUG_FFMPEG=' +
      (HLS_DEBUG_FFMPEG ? 'on' : 'off') +
      ' HLS_DEBUG_MPV=' +
      (HLS_DEBUG_MPV ? 'on' : 'off') +
      ' HLS_16_9_MODE=' +
      HLS_16_9_MODE_DEFAULT +
      ' (stretch=เต็มเฟรม pad=แถบดำ cover=crop)'
  );
});

// --- System Tray Integration (Windows, Node.js) ---
try {
  const Systray = require('systray').default;
  const iconPath = path.join(__dirname, 'hls.ico');
  const iconBase64 = fs.existsSync(iconPath) ? fs.readFileSync(iconPath, 'base64') : '';
  const systray = new Systray({
    menu: {
      icon: iconBase64,
      title: 'CCTV HLS Proxy',
      tooltip: 'HLS Proxy Status',
      items: [
        { title: 'เปิดใช้งาน (Running)', checked: true, enabled: false },
        { title: 'ออก (Exit)', checked: false, enabled: true }
      ]
    },
    debug: false,
    copyDir: true
  });
  systray.onClick(action => {
    if (action.seq_id === 1) {
      systray.kill();
      process.exit(0);
    }
  });
  process.on('SIGTERM', () => systray.kill());
  process.on('exit', () => systray.kill());
} catch (e) {
  console.warn('[hls-proxy] systray2 not available:', e.message);
}
