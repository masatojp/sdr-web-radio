const net = require('net');
const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const fs = require('fs');
const flac = require('flac-bindings');
const path = require('path');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
    rtlHost: '127.0.0.1',
    rtlPort: 1234,
    webPort: 3000,
    // 初期設定
    frequency: 93500000,
    mode: 'FM',
    // RTL-SDRのサンプリングレート (250k)
    sampleRate: 250000,
    // 目標とする音声レート
    audioRate: 16000,
    password: "admin",
    squelchFile: path.join(__dirname, 'squelch_data.json'),
    recordingsPath: path.join(__dirname, 'recordings')
};

// デシメーション比率と、実際の音声レートを計算
const DECIMATION = Math.floor(CONFIG.sampleRate / CONFIG.audioRate);
const ACTUAL_AUDIO_RATE = CONFIG.sampleRate / DECIMATION;

let squelchDB = {};
try {
    if (fs.existsSync(CONFIG.squelchFile)) {
        squelchDB = JSON.parse(fs.readFileSync(CONFIG.squelchFile, 'utf8'));
        console.log(`[System] Loaded squelch data.`);
    }
} catch (e) {
    console.log('[System] New squelch DB created.');
}

let bookmarks = [];
const bookmarksFile = path.join(__dirname, 'bookmarks.json');
try {
    if (fs.existsSync(bookmarksFile)) {
        bookmarks = JSON.parse(fs.readFileSync(bookmarksFile, 'utf8'));
        console.log(`[System] Loaded ${bookmarks.length} bookmarks.`);
    }
} catch (e) {
    console.log('[System] Failed to load bookmarks.');
}

function saveSquelchDB() {
    fs.writeFile(CONFIG.squelchFile, JSON.stringify(squelchDB, null, 2), (err) => {
        if (err) console.error('[System] Save Error:', err);
    });
}

// 録音ディレクトリを作成
if (!fs.existsSync(CONFIG.recordingsPath)) {
    fs.mkdirSync(CONFIG.recordingsPath);
}

console.log(`[System] Starting Web SDR Monitor (Android Background Fix)...`);
console.log(`[Init] RF: ${CONFIG.frequency}Hz`);
console.log(`[Audio] Decimation: 1/${DECIMATION}, Rate: ${ACTUAL_AUDIO_RATE.toFixed(2)}Hz`);

// ==========================================
// Webサーバー & フロントエンド
// ==========================================
const workerCode = `
self.onmessage = function(e) {
    if (e.data.type === 'connect') {
        connectWs(e.data.url);
    } else if (e.data.type === 'command') {
        if (self.ws && self.ws.readyState === WebSocket.OPEN) {
            self.ws.send(JSON.stringify(e.data.payload));
        }
    }
};

function connectWs(url) {
    self.ws = new WebSocket(url);
    self.ws.binaryType = 'arraybuffer';

    self.ws.onopen = () => {
        self.postMessage({ type: 'status', status: 'connected' });
    };

    self.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                self.postMessage({ type: 'server_msg', payload: msg });
            } catch(e) {}
        } else {
            // Buffer転送 (Transferable Objectsを使用して負荷軽減)
            self.postMessage({ type: 'audio', data: event.data }, [event.data]);
        }
    };

    self.ws.onclose = () => {
        self.postMessage({ type: 'status', status: 'disconnected' });
        setTimeout(() => connectWs(url), 3000);
    };

    self.ws.onerror = (e) => {
        self.postMessage({ type: 'error', msg: 'WS Error' });
    };
}
`;

const htmlContent = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>SDR Monitor</title>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#000000">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📻</text></svg>">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
            background-color: #000000;
            color: #e0e0e0;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 15px;
            box-sizing: border-box;
            overscroll-behavior-y: none; /* Pull to refresh無効化 */
        }
        .container { max-width: 400px; width: 100%; text-align: center; padding-bottom: 50px; }

        .freq-card {
            background: linear-gradient(145deg, #1a1a1a, #222);
            padding: 20px;
            border-radius: 20px;
            margin-bottom: 20px;
            border: 1px solid #333;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        .freq-value {
            font-size: 3.5rem; font-weight: 800;
            font-family: "Helvetica Neue", Arial, sans-serif;
            color: #fff;
            text-shadow: 0 0 20px rgba(0, 255, 200, 0.3);
            line-height: 1;
        }
        .unit { font-size: 1rem; color: #888; }
        .mode-tag {
            display: inline-block; padding: 4px 12px;
            border-radius: 12px; font-size: 0.8rem; font-weight: bold;
            margin-top: 5px; background: #333; color: #aaa;
        }

        .meter-section {
            margin-top: 20px;
            background: #000;
            padding: 10px;
            border-radius: 10px;
            position: relative;
        }
        .meter-label {
            font-size: 0.7rem; color: #888; display: flex; justify-content: space-between; margin-bottom: 5px;
        }
        .meter-track {
            height: 12px; background: #222; border-radius: 6px;
            overflow: hidden; position: relative;
        }
        .meter-fill {
            height: 100%; background: #2196f3; width: 0%;
            transition: width 0.05s linear;
        }
        .noise-floor-marker {
            position: absolute; top: 0; bottom: 0; width: 2px; background: #666;
            z-index: 5; opacity: 0.5; transition: left 0.2s;
        }
        .threshold-marker {
            position: absolute; top: 0; bottom: 0; width: 3px; background: #ffeb3b;
            z-index: 10; box-shadow: 0 0 5px #ffeb3b; transition: left 0.1s;
        }

        .controls { background: #111; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
        .input-row { display: flex; gap: 10px; margin-bottom: 15px; }
        input[type="number"] {
            flex: 1; background: #222; border: 1px solid #444; color: #fff;
            padding: 12px; border-radius: 8px; font-size: 1.1rem; text-align: center;
        }
        .btn {
            flex: 1; background: #444; color: white; border: none;
            padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer;
        }
        .btn:active { background: #666; }

        .mode-switch { display: flex; background: #222; border-radius: 8px; padding: 4px; margin-bottom: 15px; }
        .mode-opt {
            flex: 1; padding: 8px; text-align: center; cursor: pointer;
            border-radius: 6px; font-size: 0.9rem; color: #666; transition: 0.2s;
        }
        .mode-opt.active { background: #444; color: #fff; font-weight: bold; }

        #playBtn {
            width: 100%; padding: 20px; background: #00897b;
            color: white; font-size: 1.2rem; font-weight: bold;
            border: none; border-radius: 50px; cursor: pointer;
            margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,137,123,0.4);
            transition: all 0.2s;
        }
        #playBtn.playing { background: #c62828; box-shadow: 0 4px 15px rgba(198,40,40,0.4); }

        .android-hint-link {
            display: none; /* JSでAndroidのみ表示 */
            font-size: 0.8rem; color: #ff9800; text-decoration: underline;
            margin-bottom: 25px; cursor: pointer;
        }

        .slider-label { font-size: 0.8rem; color: #aaa; margin-top: 10px; display: flex; justify-content: space-between;}
        input[type=range] { width: 100%; margin-top: 5px; }

        /* Audio要素は不可視だがDOM上に存在させる */
        audio { width: 1px; height: 1px; opacity: 0.01; position: absolute; pointer-events: none; }

        .bw-info {
            text-align: center; font-size: 0.7rem; color: #666; margin-top: 5px;
        }

        .adj-btn-group {
            display: flex; gap: 5px; justify-content: center; margin-top: 10px;
        }
        .adj-btn {
            flex: 1; background: #333; color: #ccc; border: 1px solid #444;
            padding: 8px 0; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: bold;
            transition: background 0.1s;
        }
        .adj-btn:active { background: #555; color: #fff; }

        /* Modal */
        #modalOverlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.85); z-index: 9999;
            justify-content: center; align-items: center;
            backdrop-filter: blur(5px);
        }
        .modal-box {
            background: #1e1e1e; padding: 25px; border-radius: 16px; width: 85%; max-width: 320px;
            text-align: center; border: 1px solid #444; box-shadow: 0 20px 50px rgba(0,0,0,0.7);
        }
        .modal-title { color: #fff; margin-bottom: 20px; font-size: 1.2rem; font-weight: bold; }
        .modal-input {
            width: 100%; padding: 12px; box-sizing: border-box; margin-bottom: 20px;
            background: #333; border: 1px solid #555; color: #fff; border-radius: 8px;
            text-align: center; font-size: 1.2rem;
        }
        .modal-btns { display: flex; gap: 10px; }
        .modal-btn { flex: 1; padding: 12px; border-radius: 8px; border: none; cursor: pointer; font-weight: bold; font-size: 1rem; }
        .btn-ok { background: #00897b; color: white; }
        .btn-cancel { background: #444; color: #aaa; }

        /* Hint Modal */
        .hint-step { text-align: left; font-size: 0.9rem; color: #ccc; margin-bottom: 10px; line-height: 1.4; }
        .hint-highlight { color: #ff9800; font-weight: bold; }

        .bookmark-list {
            margin-top: 15px;
            background: #1a1a1a;
            border-radius: 8px;
            padding: 10px;
            max-height: 600px;
            overflow-y: auto;
        }
        .bookmark-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px;
            border-bottom: 1px solid #333;
            cursor: pointer;
            transition: background 0.2s;
        }
        .bookmark-item:last-child { border-bottom: none; }
        .bookmark-item:hover { background: #333; }
        .bm-title { font-weight: bold; color: #e0e0e0; font-size: 0.9rem; }
        .bm-info { font-size: 0.8rem; color: #888; }

        .bm-header { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; margin-bottom: 5px; }
        .bm-label { font-size: 0.9rem; color: #aaa; font-weight: bold; }
        .bm-add-btn { background: #00897b; color: white; border: none; padding: 5px 10px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; }

        .bm-actions { display: flex; gap: 5px; }
        .bm-btn { padding: 4px 8px; border-radius: 4px; border: none; cursor: pointer; font-size: 0.7rem; color: white; }
        .bm-edit { background: #555; }
        .bm-del { background: #b71c1c; }

        .bm-folder {
            background: #222;
            margin-bottom: 5px;
            border-radius: 6px;
            overflow: hidden;
        }
        .bm-folder-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px; cursor: pointer; background: #2a2a2a;
            border-bottom: 1px solid #333;
        }
        .bm-folder-header:hover { background: #333; }
        .bm-folder-title { font-weight: bold; color: #fff; font-size: 0.9rem; display: flex; align-items: center; gap: 5px; }
        .bm-children { padding-left: 15px; border-left: 2px solid #333; margin-left: 10px; display: none; }
        .bm-children.open { display: block; }
        .bm-icon { font-size: 0.8rem; color: #aaa; transition: transform 0.2s; }
        .bm-icon.open { transform: rotate(90deg); }
    </style>
</head>
<body>
    <div class="container">
        <div style="font-size:0.8rem; color:#666; margin-bottom:10px;" id="statusText">Ready</div>

        <div class="freq-card">
            <div class="freq-value" id="freqLabel">---.-</div>
            <div class="unit">MHz</div>
            <div class="mode-tag" id="modeLabel">--</div>
            <div class="bw-info" id="bwInfoText">Filter: Auto</div>

            <div class="meter-section">
                <div class="meter-label">
                    <span id="meterTitle">SIGNAL / THRESHOLD</span>
                    <span id="sqLed" style="color:#333">● RX</span>
                </div>
                <div class="meter-track">
                    <div class="meter-fill" id="signalBar"></div>
                    <div class="noise-floor-marker" id="floorMarker" style="left: 0%"></div>
                    <div class="threshold-marker" id="threshMarker" style="left: 0%"></div>
                </div>
                <div style="font-size: 0.7rem; color:#aaa; margin-top:5px;">
                    RSS: <span id="rssiVal">--</span>
                    <span style="float:right; font-size:0.6rem; color:#666;">AUTO SQUELCH</span>
                </div>
            </div>

            <div class="slider-label">
                <span>SQL MARGIN</span> <span><span id="sqValText">+10</span></span>
            </div>
            <input type="range" id="squelchRange" min="-50" max="50" value="10">

            <div class="adj-btn-group">
                <button class="adj-btn" id="btnM10">-10</button>
                <button class="adj-btn" id="btnM1">-1</button>
                <button class="adj-btn" id="btnP1">+1</button>
                <button class="adj-btn" id="btnP10">+10</button>
            </div>
        </div>

        <button id="playBtn">START MONITOR</button>
        <div id="androidHintLink" class="android-hint-link" onclick="openHintModal()">⚠️ バックグラウンド再生が止まる場合</div>

        <div class="controls">
            <div class="mode-switch">
                <div class="mode-opt" id="optAM" onclick="setModeUI('AM')">AM</div>
                <div class="mode-opt" id="optFM" onclick="setModeUI('FM')">FM</div>
            </div>
            <div class="input-row">
                <input type="number" id="newFreq" placeholder="Freq" step="0.1">
                <button class="btn" id="tuneBtn">TUNE</button>
            </div>
        </div>

        <div class="bm-header">
            <div class="bm-label">RECORDINGS</div>
            <button class="bm-add-btn" id="recBtn">REC</button>
        </div>
        <div id="recordingList" class="bookmark-list"></div>

        <div class="bm-header">
            <div class="bm-label">BOOKMARKS</div>
            <div style="display:flex; gap:5px;">
                <button class="bm-add-btn" onclick="openFolderModal('add')">+ FOLDER</button>
                <button class="bm-add-btn" onclick="openBmModal('add')">+ BM</button>
            </div>
        </div>
        <div id="bookmarkList" class="bookmark-list"></div>

        <!-- 重要: controls属性をつけてユーザー操作を可能にする。playsinlineは必須 -->
        <audio id="mainAudio" playsinline controls></audio>
    </div>

    <!-- Tune Modal -->
    <div id="modalOverlay">
        <div class="modal-box">
            <div class="modal-title" id="modalTitle">Enter Password</div>
            <input type="password" class="modal-input" id="modalPass" placeholder="Password">
            <div class="modal-btns">
                <button class="modal-btn btn-cancel" id="modalCancel">Cancel</button>
                <button class="modal-btn btn-ok" id="modalOk">Tune</button>
            </div>
        </div>
    </div>

    <!-- Android Hint Modal -->
    <div id="hintModalOverlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); justify-content:center; align-items:center; z-index:9999; backdrop-filter: blur(5px);">
        <div class="modal-box">
            <div class="modal-title" style="color:#ff9800">Android設定ガイド</div>
            <div style="text-align:left; margin-bottom:20px; font-size:0.9rem; color:#ddd;">
                バックグラウンド再生を安定させるには、Chromeのバッテリー制限を解除してください。
            </div>
            <div class="hint-step">1. Androidの<span class="hint-highlight">「設定」</span>を開く</div>
            <div class="hint-step">2. <span class="hint-highlight">「アプリ」</span> > <span class="hint-highlight">「Chrome」</span>を選択</div>
            <div class="hint-step">3. <span class="hint-highlight">「バッテリー」</span>をタップ</div>
            <div class="hint-step">4. <span class="hint-highlight">「制限なし」</span>(または「最適化しない」)を選択</div>
            <div style="margin-top:20px;">
                <button class="modal-btn btn-ok" onclick="closeHintModal()">閉じる</button>
            </div>
        </div>
    </div>

    <!-- Bookmark Modal -->
    <div id="bmModalOverlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); justify-content:center; align-items:center; z-index:2000;">
        <div class="modal-box">
            <div class="modal-title" id="bmModalTitle">Add Bookmark</div>
            <input type="text" class="modal-input" id="bmTitle" placeholder="Station Name" style="margin-bottom:10px;">
            <input type="number" class="modal-input" id="bmFreq" placeholder="Frequency (MHz)" step="0.1" style="margin-bottom:10px;">
            <div style="margin-bottom:10px;">
                <select id="bmParent" class="modal-input" style="background:#333; color:white; border:1px solid #555;">
                    <option value="">(Root)</option>
                </select>
            </div>
            <div style="display:flex; gap:10px; margin-bottom:15px;">
                <button class="mode-opt active" id="bmModeFM" onclick="setBmMode('FM')" style="flex:1; padding:8px; background:#333; border:1px solid #555; color:#ccc; border-radius:4px;">FM</button>
                <button class="mode-opt" id="bmModeAM" onclick="setBmMode('AM')" style="flex:1; padding:8px; background:#222; border:1px solid #444; color:#666; border-radius:4px;">AM</button>
            </div>
            <div class="modal-btns">
                <button class="modal-btn btn-cancel" onclick="closeBmModal()">Cancel</button>
                <button class="modal-btn btn-ok" onclick="saveBm()">Save</button>
            </div>
        </div>
    </div>

    <!-- Folder Modal -->
    <div id="folderModalOverlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); justify-content:center; align-items:center; z-index:2000;">
        <div class="modal-box">
            <div class="modal-title" id="folderModalTitle">Add Folder</div>
            <input type="text" class="modal-input" id="folderTitle" placeholder="Folder Name" style="margin-bottom:10px;">
            <div style="margin-bottom:10px;">
                <select id="folderParent" class="modal-input" style="background:#333; color:white; border:1px solid #555;">
                    <option value="">(Root)</option>
                </select>
            </div>
            <div class="modal-btns">
                <button class="modal-btn btn-cancel" onclick="closeFolderModal()">Cancel</button>
                <button class="modal-btn btn-ok" onclick="saveFolder()">Save</button>
            </div>
        </div>
    </div>

    <script>
        const workerBlob = new Blob([\`${workerCode}\`], {type: 'application/javascript'});
        const worker = new Worker(URL.createObjectURL(workerBlob));

        const els = {
            playBtn: document.getElementById('playBtn'),
            status: document.getElementById('statusText'),
            freqLabel: document.getElementById('freqLabel'),
            modeLabel: document.getElementById('modeLabel'),
            bwInfo: document.getElementById('bwInfoText'),
            signalBar: document.getElementById('signalBar'),
            floorMarker: document.getElementById('floorMarker'),
            threshMarker: document.getElementById('threshMarker'),
            sqRange: document.getElementById('squelchRange'),
            sqLed: document.getElementById('sqLed'),
            sqValText: document.getElementById('sqValText'),
            rssiVal: document.getElementById('rssiVal'),
            mainAudio: document.getElementById('mainAudio'),
            newFreq: document.getElementById('newFreq'),
            tuneBtn: document.getElementById('tuneBtn'),
            optAM: document.getElementById('optAM'),
            optFM: document.getElementById('optFM'),
            modalOverlay: document.getElementById('modalOverlay'),
            modalTitle: document.getElementById('modalTitle'),
            modalPass: document.getElementById('modalPass'),
            modalOk: document.getElementById('modalOk'),
            modalCancel: document.getElementById('modalCancel'),
            btnM10: document.getElementById('btnM10'),
            btnM1: document.getElementById('btnM1'),
            btnP1: document.getElementById('btnP1'),
            btnP10: document.getElementById('btnP10'),
            recBtn: document.getElementById('recBtn'),
            recordingList: document.getElementById('recordingList')
        };

        // Android判定 & ガイド表示ロジック
        const isAndroid = /Android/i.test(navigator.userAgent);
        if (isAndroid) {
            document.getElementById('androidHintLink').style.display = 'block';
        }

        window.openHintModal = () => {
            document.getElementById('hintModalOverlay').style.display = 'flex';
        };

        window.closeHintModal = () => {
            document.getElementById('hintModalOverlay').style.display = 'none';
        };

        let state = {
            audioCtx: null,
            masterGain: null,
            destNode: null,
            keepAliveOsc: null, // Android対策: 無音再生用オシレータ
            isPlaying: false,
            nextTime: 0,
            sqMargin: 10,
            noiseFloor: 30,
            selectedMode: 'FM',
            currentFreqMHz: 0,
            lastSignalTime: 0,
            isSquelchOpen: false,
            pendingFreq: 0,
            audioRate: 16000,
            isRecording: false
        };

        // Androidはバッファ枯渇に敏感なので少し長めに
        const HOLD_TIME = 0.8;
        const BUFFER_AHEAD = 0.15; // バッファリング先行量 (秒)

        function updateSqUI() {
            const val = state.sqMargin;
            const sign = val > 0 ? "+" : "";
            els.sqValText.innerText = sign + val;
            els.sqRange.value = val;
        }

        const adjustSq = (delta) => {
            let newVal = state.sqMargin + delta;
            if (newVal < -50) newVal = -50;
            if (newVal > 50) newVal = 50;
            state.sqMargin = newVal;
            updateSqUI();
        };

        els.btnM10.addEventListener('click', () => adjustSq(-10));
        els.btnM1.addEventListener('click', () => adjustSq(-1));
        els.btnP1.addEventListener('click', () => adjustSq(1));
        els.btnP10.addEventListener('click', () => adjustSq(10));

        window.setModeUI = (mode) => {
            state.selectedMode = mode;
            if(mode === 'AM') {
                els.optAM.classList.add('active');
                els.optFM.classList.remove('active');
                state.sqMargin = 10;
            } else {
                els.optAM.classList.remove('active');
                els.optFM.classList.add('active');
                state.sqMargin = -20;
            }
            updateSqUI();
        };

        els.sqRange.addEventListener('input', (e) => {
            state.sqMargin = parseInt(e.target.value);
            updateSqUI();
        });

        // ==========================================
        // Android Background Fix Implementation
        // ==========================================

        // ファビコン用のDataURI（通知アイコンとして使用）
        const ICON_DATA_URI = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📻</text></svg>";

        function updateMediaSession(freq, mode) {
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: freq ? \`\${freq.toFixed(3)} MHz\` : "SDR Receiver",
                    artist: mode + " Radio Monitor",
                    album: 'Live Stream',
                    artwork: [
                        { src: ICON_DATA_URI, sizes: '96x96', type: 'image/svg+xml' },
                        { src: ICON_DATA_URI, sizes: '512x512', type: 'image/svg+xml' }
                    ]
                });

                // 通知領域のアクションハンドラ。これらが定義されていないと通知が消えることがある。
                navigator.mediaSession.setActionHandler('play', async () => {
                    console.log('[MediaSession] Play command');
                    if(state.audioCtx) await state.audioCtx.resume();
                    els.mainAudio.play();
                    navigator.mediaSession.playbackState = 'playing';
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                     console.log('[MediaSession] Pause command');
                     // ストリーミングなので一時停止はしない（停止扱い）
                     // ただしUI上はPlayingのままにすることもあるが、ここではStop動作へ
                     els.playBtn.click(); 
                });
                navigator.mediaSession.setActionHandler('stop', () => {
                    els.playBtn.click();
                });
            }
        }

        // ページの可視性が変わった時（バックグラウンド移行時など）の処理
        document.addEventListener('visibilitychange', () => {
            if (state.isPlaying && state.audioCtx) {
                if (document.visibilityState === 'hidden') {
                    // バックグラウンドへ: コンテキストの状態を確認
                    if (state.audioCtx.state === 'suspended' || state.audioCtx.state === 'interrupted') {
                        state.audioCtx.resume();
                    }
                } else {
                    // フォアグラウンドへ復帰
                    state.audioCtx.resume();
                    // Audio要素が停止していないか確認
                    if (els.mainAudio.paused) {
                        els.mainAudio.play().catch(e => console.log('Resume play failed', e));
                    }
                }
            }
        });

        function saveNoiseFloor() {
            if (state.currentFreqMHz > 0) {
                worker.postMessage({
                    type: 'command',
                    payload: {
                        type: 'save_squelch',
                        freq: Math.floor(state.currentFreqMHz * 1000000),
                        floor: state.noiseFloor
                    }
                });
            }
        }

        setInterval(saveNoiseFloor, 30000);

        els.playBtn.addEventListener('click', async () => {
            if (!state.isPlaying) {
                // ==========================================
                // AudioContext Initialization (Android Robust)
                // ==========================================
                if (!state.audioCtx) {
                    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                        sampleRate: state.audioRate,
                        latencyHint: 'playback' // 再生優先（遅延許容）
                    });
                    
                    // コンテキストの状態変化監視 (Android対策の要)
                    state.audioCtx.onstatechange = () => {
                        console.log('[AudioCtx] State changed to:', state.audioCtx.state);
                        if (state.isPlaying && (state.audioCtx.state === 'suspended' || state.audioCtx.state === 'interrupted')) {
                            state.audioCtx.resume();
                        }
                    };
                }
                
                await state.audioCtx.resume();

                if (!state.masterGain) {
                    state.masterGain = state.audioCtx.createGain();
                    state.masterGain.gain.value = 1.0;
                }

                if (!state.destNode) {
                    // ストリーム先を作成
                    state.destNode = state.audioCtx.createMediaStreamDestination();
                    state.masterGain.connect(state.destNode);
                    
                    // HTML5 Audio要素に接続 (これがバックグラウンド再生の鍵)
                    els.mainAudio.srcObject = state.destNode.stream;
                }

                // ==========================================
                // Keep-Alive Oscillator (Android対策)
                // ==========================================
                // 全くの無音だとChromeは処理をサスペンドするため、
                // 人間には聞こえないが信号としては存在する音を混ぜ続ける
                if (!state.keepAliveOsc) {
                    const osc = state.audioCtx.createOscillator();
                    const gain = state.audioCtx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = 20; // 20Hz (可聴域ギリギリ、スマホスピーカーでは聞こえない)
                    gain.gain.value = 0.001; // 非常に小さい音量
                    osc.connect(gain);
                    gain.connect(state.destNode); // 直接出力へ
                    osc.start();
                    state.keepAliveOsc = osc;
                }

                // ノイズジェネレータ（可聴確認用）
                const noiseBuffer = state.audioCtx.createBuffer(1, state.audioRate, state.audioRate);
                const output = noiseBuffer.getChannelData(0);
                for (let i = 0; i < output.length; i++) output[i] = (Math.random() * 2 - 1) * 0.0001;
                const noiseSrc = state.audioCtx.createBufferSource();
                noiseSrc.buffer = noiseBuffer;
                noiseSrc.loop = true;
                noiseSrc.connect(state.masterGain);
                noiseSrc.start();

                // 実際のAudio要素を再生開始
                try {
                    await els.mainAudio.play();
                    console.log('[Audio] HTML5 Audio started');
                } catch(e) {
                    console.error('[Audio] Play failed:', e);
                    alert('Audio Playback Failed. Please interact with the page.');
                }

                if ('mediaSession' in navigator) {
                    updateMediaSession(state.currentFreqMHz, state.selectedMode);
                    navigator.mediaSession.playbackState = 'playing';
                }

                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                worker.postMessage({ type: 'connect', url: protocol + '//' + window.location.host });

                els.playBtn.innerText = "STOP";
                els.playBtn.classList.add('playing');
                state.isPlaying = true;
                state.nextTime = state.audioCtx.currentTime + 0.1;

            } else {
                saveNoiseFloor();
                // 停止時はリロードしてクリーンアップ（簡易実装）
                location.reload();
            }
        });

        els.tuneBtn.addEventListener('click', () => {
            let mhz = parseFloat(els.newFreq.value);
            if (isNaN(mhz)) {
                if(state.currentFreqMHz) mhz = state.currentFreqMHz;
                else mhz = (state.selectedMode === 'AM') ? 120.4 : 77.1;
            }
            if (mhz < 76 || mhz > 137) { alert('Range Error'); return; }

            saveNoiseFloor();

            state.pendingFreq = mhz;

            if (state.masterGain) {
                state.masterGain.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.02);
            }

            els.modalTitle.innerText = \`Tune to \${mhz} MHz\`;
            els.modalPass.value = "";
            els.modalOverlay.style.display = "flex";
            els.modalPass.focus();
        });

        els.modalOk.addEventListener('click', () => {
            const pass = els.modalPass.value;
            const mhz = state.pendingFreq;

            els.modalOverlay.style.display = "none";

            if (state.audioCtx) {
                state.nextTime = state.audioCtx.currentTime + 0.1;
            }

            state.noiseFloor = 0;

            worker.postMessage({
                type: 'command',
                payload: { type: 'auth_tune', freq: Math.floor(mhz * 1000000), mode: state.selectedMode, password: pass }
            });
        });

        els.modalCancel.addEventListener('click', () => {
            els.modalOverlay.style.display = "none";
            if (state.masterGain) {
                state.masterGain.gain.setTargetAtTime(1.0, state.audioCtx.currentTime, 0.1);
            }
        });

        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'audio') {
                processAudioChunk(msg.data);
            } else if (msg.type === 'status') {
                els.status.innerText = msg.status === 'connected' ? "Receiving" : "Connecting...";
                if(msg.status === 'connected' && state.audioCtx) state.nextTime = state.audioCtx.currentTime + 0.1;
            } else if (msg.type === 'debug') {
                console.log('[Worker]', msg.msg);
            } else if (msg.type === 'server_msg') {
                const pl = msg.payload;
                if (pl.type === 'status_update') {
                    state.currentFreqMHz = pl.freq / 1000000;
                    els.freqLabel.innerText = state.currentFreqMHz.toFixed(3);
                    els.modeLabel.innerText = pl.mode;

                    if (pl.bwInfo) els.bwInfo.innerText = \`Filter: \${pl.bwInfo}\`;

                    if (pl.savedNoiseFloor) {
                        state.noiseFloor = pl.savedNoiseFloor;
                    }

                    if (pl.audioRate && state.audioRate !== pl.audioRate) {
                        console.log('Synced Audio Rate:', pl.audioRate);
                        state.audioRate = pl.audioRate;
                    }

                    setModeUI(pl.mode);
                    updateMediaSession(state.currentFreqMHz, pl.mode);

                    if (state.audioCtx) {
                        state.nextTime = state.audioCtx.currentTime + 0.1;
                        if (state.masterGain) {
                            state.masterGain.gain.setTargetAtTime(1.0, state.audioCtx.currentTime, 0.5);
                        }
                    }
                } else if (pl.type === 'error') {
                    alert(pl.msg);
                    if (state.masterGain) state.masterGain.gain.value = 1.0;
                } else if (pl.type === 'bookmarks') {
                    allBookmarks = pl.data || [];
                    renderBookmarks();
                } else if (pl.type === 'recordings') {
                    state.recordings = pl.data || [];
                    renderRecordings();
                }
            }
        };

        function clampPercent(val) {
            if (val < 0) return 0;
            if (val > 100) return 100;
            return val;
        }

        function processAudioChunk(buffer) {
            if (!state.audioCtx || !state.destNode) return;
            
            // AudioContextがサスペンドしていたら復帰を試みる
            if (state.audioCtx.state === 'suspended') {
                state.audioCtx.resume();
            }

            const int16Data = new Int16Array(buffer);
            const rssiRaw = int16Data[0] / 100.0;
            const audioSamples = new Float32Array(int16Data.length - 1);
            for(let i=0; i<audioSamples.length; i++) {
                audioSamples[i] = int16Data[i+1] / 32768.0;
            }

            els.rssiVal.innerText = Math.floor(rssiRaw);
            const rssiPercent = rssiRaw;

            if (state.noiseFloor === 0) state.noiseFloor = rssiPercent;

            if (rssiPercent < state.noiseFloor) {
                state.noiseFloor = state.noiseFloor * 0.9 + rssiPercent * 0.1;
            } else {
                if (!state.isSquelchOpen) {
                    if (state.noiseFloor < rssiPercent) {
                        state.noiseFloor += 0.005;
                    }
                }
            }

            const thresholdPercent = state.noiseFloor + state.sqMargin;

            let isOpen = false;
            if (state.selectedMode === 'FM') {
                isOpen = (rssiPercent > thresholdPercent);
            } else {
                const hysterisis = state.isSquelchOpen ? 0.9 : 1.0;
                isOpen = (rssiPercent > (thresholdPercent * hysterisis));
            }

            state.isSquelchOpen = isOpen;

            els.signalBar.style.width = clampPercent(rssiPercent) + '%';
            els.floorMarker.style.left = clampPercent(state.noiseFloor) + '%';
            els.threshMarker.style.left = clampPercent(thresholdPercent) + '%';

            if (isOpen) state.lastSignalTime = state.audioCtx.currentTime;
            const isOutput = (state.audioCtx.currentTime - state.lastSignalTime) < HOLD_TIME;

            if (isOutput) {
                els.sqLed.style.color = "#00e676";
                els.sqLed.style.textShadow = "0 0 5px #00e676";

                const audioBuf = state.audioCtx.createBuffer(1, audioSamples.length, state.audioRate);
                audioBuf.getChannelData(0).set(audioSamples);
                const src = state.audioCtx.createBufferSource();
                src.buffer = audioBuf;
                src.connect(state.masterGain);

                const currentTime = state.audioCtx.currentTime;

                // バッファリングロジック修正
                if (state.nextTime < currentTime) {
                    // 遅延しすぎている場合は現在時刻＋少し先にリセット
                    state.nextTime = currentTime + BUFFER_AHEAD;
                }
                else if (state.nextTime > currentTime + 3.0) {
                    // 進みすぎている場合は調整
                    state.nextTime = currentTime + 1.0;
                }

                src.start(state.nextTime);
                state.nextTime += audioBuf.duration;
            } else {
                els.sqLed.style.color = "#333";
                els.sqLed.style.textShadow = "none";
                if (state.nextTime < state.audioCtx.currentTime) {
                    state.nextTime = state.audioCtx.currentTime;
                }
            }
        }

        let currentBmId = null;
        let currentBmMode = 'FM';
        let allBookmarks = [];
        let expandedFolders = new Set();

        function setBmMode(mode) {
            currentBmMode = mode;
            const btnFM = document.getElementById('bmModeFM');
            const btnAM = document.getElementById('bmModeAM');
            if(mode === 'FM') {
                btnFM.style.background = '#333'; btnFM.style.color = '#ccc'; btnFM.style.borderColor = '#555';
                btnAM.style.background = '#222'; btnAM.style.color = '#666'; btnAM.style.borderColor = '#444';
            } else {
                btnAM.style.background = '#333'; btnAM.style.color = '#ccc'; btnAM.style.borderColor = '#555';
                btnFM.style.background = '#222'; btnFM.style.color = '#666'; btnFM.style.borderColor = '#444';
            }
        }

        function populateParentSelect(selectId, currentId = null) {
            const select = document.getElementById(selectId);
            select.innerHTML = '<option value="">(Root)</option>';
            const folders = allBookmarks.filter(b => b.isFolder && b.id !== currentId);
            folders.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.id;
                opt.innerText = f.title;
                select.appendChild(opt);
            });
        }

        window.openBmModal = (type, id) => {
            const modal = document.getElementById('bmModalOverlay');
            const titleEl = document.getElementById('bmModalTitle');
            const titleInput = document.getElementById('bmTitle');
            const freqInput = document.getElementById('bmFreq');
            const parentSelect = document.getElementById('bmParent');

            modal.style.display = 'flex';
            populateParentSelect('bmParent');

            if (type === 'add') {
                currentBmId = null;
                titleEl.innerText = "Add Bookmark";
                titleInput.value = "";
                freqInput.value = els.newFreq.value || "";
                parentSelect.value = "";
                setBmMode(state.selectedMode);
            } else {
                currentBmId = id;
                titleEl.innerText = "Edit Bookmark";
                const bm = allBookmarks.find(b => b.id === id);
                if(bm) {
                    titleInput.value = bm.title;
                    freqInput.value = bm.freq;
                    parentSelect.value = bm.parentId || "";
                    setBmMode(bm.mode);
                }
            }
        };

        window.openFolderModal = (type, id) => {
            const modal = document.getElementById('folderModalOverlay');
            const titleEl = document.getElementById('folderModalTitle');
            const titleInput = document.getElementById('folderTitle');
            const parentSelect = document.getElementById('folderParent');

            modal.style.display = 'flex';
            populateParentSelect('folderParent', id);

            if (type === 'add') {
                currentBmId = null;
                titleEl.innerText = "Add Folder";
                titleInput.value = "";
                parentSelect.value = "";
            } else {
                currentBmId = id;
                titleEl.innerText = "Edit Folder";
                const bm = allBookmarks.find(b => b.id === id);
                if(bm) {
                    titleInput.value = bm.title;
                    parentSelect.value = bm.parentId || "";
                }
            }
        };

        window.closeBmModal = () => { document.getElementById('bmModalOverlay').style.display = 'none'; };
        window.closeFolderModal = () => { document.getElementById('folderModalOverlay').style.display = 'none'; };

        window.saveBm = () => {
            const title = document.getElementById('bmTitle').value;
            const freq = parseFloat(document.getElementById('bmFreq').value);
            const parentId = document.getElementById('bmParent').value || null;

            if(!title || isNaN(freq)) { alert('Invalid Input'); return; }

            const payload = { title, freq, mode: currentBmMode, isFolder: false, parentId };

            if (currentBmId) {
                payload.id = currentBmId;
                worker.postMessage({ type: 'command', payload: { type: 'edit_bookmark', data: payload } });
            } else {
                worker.postMessage({ type: 'command', payload: { type: 'add_bookmark', data: payload } });
            }
            closeBmModal();
        };

        window.saveFolder = () => {
            const title = document.getElementById('folderTitle').value;
            const parentId = document.getElementById('folderParent').value || null;

            if(!title) { alert('Invalid Input'); return; }

            const payload = { title, isFolder: true, parentId };

            if (currentBmId) {
                payload.id = currentBmId;
                worker.postMessage({ type: 'command', payload: { type: 'edit_bookmark', data: payload } });
            } else {
                worker.postMessage({ type: 'command', payload: { type: 'add_bookmark', data: payload } });
            }
            closeFolderModal();
        };

        window.deleteBm = (id) => {
            if(confirm('Delete this item?')) {
                worker.postMessage({ type: 'command', payload: { type: 'delete_bookmark', id: id } });
            }
        };

        function renderBookmarks() {
            const container = document.getElementById('bookmarkList');
            container.innerHTML = '';
            if (!allBookmarks || allBookmarks.length === 0) {
                container.style.display = 'none';
                return;
            }
            container.style.display = 'block';

            const tree = buildTree(allBookmarks);
            renderTree(tree, container);
        }

        function buildTree(items) {
            const map = {};
            const roots = [];
            items.forEach(item => { map[item.id] = { ...item, children: [] }; });
            items.forEach(item => {
                if (item.parentId && map[item.parentId]) {
                    map[item.parentId].children.push(map[item.id]);
                } else {
                    roots.push(map[item.id]);
                }
            });
            return roots;
        }

        function renderTree(nodes, container) {
            nodes.forEach(node => {
                if (node.isFolder) {
                    const folderDiv = document.createElement('div');
                    folderDiv.className = 'bm-folder';

                    const isOpen = expandedFolders.has(node.id);
                    const iconChar = isOpen ? '▼' : '▶';

                    const header = document.createElement('div');
                    header.className = 'bm-folder-header';
                    header.innerHTML = \`
                        <div class="bm-folder-title">
                            <span class="bm-icon \${isOpen ? 'open' : ''}">\${iconChar}</span> \${node.title}
                        </div>
                        <div class="bm-actions">
                            <button class="bm-btn bm-edit" onclick="event.stopPropagation(); openFolderModal('edit', '\${node.id}')">EDIT</button>
                            <button class="bm-btn bm-del" onclick="event.stopPropagation(); deleteBm('\${node.id}')">DEL</button>
                        </div>
                    \`;
                    header.onclick = () => {
                        if (expandedFolders.has(node.id)) expandedFolders.delete(node.id);
                        else expandedFolders.add(node.id);
                        renderBookmarks();
                    };

                    const childrenDiv = document.createElement('div');
                    childrenDiv.className = \`bm-children \${isOpen ? 'open' : ''}\`;

                    folderDiv.appendChild(header);
                    folderDiv.appendChild(childrenDiv);
                    container.appendChild(folderDiv);

                    renderTree(node.children, childrenDiv);
                } else {
                    const div = document.createElement('div');
                    div.className = 'bookmark-item';
                    div.innerHTML = \`
                        <div style="flex:1">
                            <div class="bm-title">\${node.title}</div>
                            <div class="bm-info">\${node.freq.toFixed(1)} MHz (\${node.mode})</div>
                        </div>
                        <div class="bm-actions">
                            <button class="bm-btn bm-edit" onclick="event.stopPropagation(); openBmModal('edit', '\${node.id}')">EDIT</button>
                            <button class="bm-btn bm-del" onclick="event.stopPropagation(); deleteBm('\${node.id}')">DEL</button>
                        </div>
                    \`;
                    div.onclick = () => {
                        els.newFreq.value = node.freq;
                        setModeUI(node.mode);
                    };
                    container.appendChild(div);
                }
            });
        }

        // Recording UI
        els.recBtn.addEventListener('click', () => {
            state.isRecording = !state.isRecording;
            if (state.isRecording) {
                worker.postMessage({ type: 'command', payload: { type: 'start_recording' } });
                els.recBtn.style.background = '#c62828';
                els.recBtn.style.boxShadow = '0 0 8px #c62828';
                els.recBtn.innerText = 'STOP REC';
            } else {
                worker.postMessage({ type: 'command', payload: { type: 'stop_recording' } });
                els.recBtn.style.background = '#00897b';
                els.recBtn.style.boxShadow = 'none';
                els.recBtn.innerText = 'REC';
            }
        });

        function renderRecordings() {
            const container = els.recordingList;
            container.innerHTML = '';
            if (!state.recordings || state.recordings.length === 0) {
                container.style.display = 'none';
                return;
            }
            container.style.display = 'block';

            state.recordings.forEach(rec => {
                const div = document.createElement('div');
                div.className = 'bookmark-item';
                div.innerHTML = \`
                    <div style="flex:1">
                        <div class="bm-title">\${rec.name}</div>
                        <div class="bm-info">\${(rec.size / 1024 / 1024).toFixed(2)} MB</div>
                    </div>
                    <div class="bm-actions">
                        <a href="/download/\${rec.name}" download class="bm-btn bm-edit" style="text-decoration:none; background:#00897b;">DL</a>
                        <button class="bm-btn bm-del" onclick="deleteRecording('\${rec.name}')">DEL</button>
                    </div>
                \`;
                container.appendChild(div);
            });
        }

        window.deleteRecording = (filename) => {
            if (confirm(\`Delete \${filename}?\`)) {
                worker.postMessage({ type: 'command', payload: { type: 'delete_recording', filename: filename } });
            }
        };
    </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
    const reqUrl = url.parse(req.url);
    const pathname = reqUrl.pathname;

    if (pathname.startsWith('/download/')) {
        const filename = path.basename(decodeURIComponent(pathname)).replace(/\.\.+/g, '.');
        const filePath = path.join(CONFIG.recordingsPath, filename);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Disposition': `attachment; filename="${filename}"`
            });
            fs.createReadStream(filePath).pipe(res);
        } else {
            res.writeHead(404);
            res.end('File not found');
        }
    } else if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlContent);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

// ==========================================
// Backend DSP (AM/FM Demodulator)
// ==========================================
let rtlSocket = null;
let currentFreq = CONFIG.frequency;
let currentMode = CONFIG.mode;
let isTuning = false;

// Recording State
let isRecording = false;
let recordingStream = null;

// DSP State
let bufferRemainder = Buffer.alloc(0);
let dcOffset = 0;
let prevAngle = 0;
let i_dc = 0, q_dc = 0;
let lpf1 = 0;
let lpf2 = 0;
let agcGain = 10.0;
let deemphState = 0;

// Biquad Filter Class
class Biquad {
    constructor(fs, fc, q) {
        this.x1 = 0; this.x2 = 0;
        this.y1 = 0; this.y2 = 0;
        this.calcCoeffs(fs, fc, q);
    }

    calcCoeffs(fs, fc, q) {
        const omega = 2 * Math.PI * fc / fs;
        const sn = Math.sin(omega);
        const cs = Math.cos(omega);
        const alpha = sn / (2 * q);

        const b0 = (1 - cs) / 2;
        const b1 = 1 - cs;
        const b2 = (1 - cs) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cs;
        const a2 = 1 - alpha;

        this.b0 = b0 / a0;
        this.b1 = b1 / a0;
        this.b2 = b2 / a0;
        this.a1 = a1 / a0;
        this.a2 = a2 / a0;
    }

    process(input) {
        const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1; this.x1 = input;
        this.y2 = this.y1; this.y1 = output;
        return output;
    }

    reset() {
        this.x1 = 0; this.x2 = 0;
        this.y1 = 0; this.y2 = 0;
    }
}

class CascadeBiquad {
    constructor(fs, fc, q, stages = 2) {
        this.stages = [];
        for (let i = 0; i < stages; i++) {
            this.stages.push(new Biquad(fs, fc, q));
        }
    }
    calcCoeffs(fs, fc, q) {
        this.stages.forEach(s => s.calcCoeffs(fs, fc, q));
    }
    process(input) {
        let out = input;
        for (let s of this.stages) out = s.process(out);
        return out;
    }
    reset() {
        this.stages.forEach(s => s.reset());
    }
}

// Balanced 2nd Order LPF (ACTUAL_AUDIO_RATE is used for calculation)
// 正確なレートに合わせて7kHzのLPFを設定
const audioLPF = new Biquad(ACTUAL_AUDIO_RATE, 7000, 0.707);

// IF Filters (I/Q Channels)
let ifFilterI = new CascadeBiquad(CONFIG.sampleRate, 100000, 0.707, 2);
let ifFilterQ = new CascadeBiquad(CONFIG.sampleRate, 100000, 0.707, 2);

function resetDspState() {
    bufferRemainder = Buffer.alloc(0);
    dcOffset = 0;
    prevAngle = 0;
    i_dc = 0;
    q_dc = 0;
    lpf1 = 0;
    lpf2 = 0;
    agcGain = 10.0;
    deemphState = 0;
    audioLPF.reset();
    ifFilterI.reset();
    ifFilterQ.reset();
}

function sendCmd(cmd, param) {
    if (!rtlSocket || rtlSocket.destroyed) return;
    const buf = Buffer.alloc(5);
    buf.writeUInt8(cmd, 0);
    buf.writeUInt32BE(param, 1);
    rtlSocket.write(buf);
}

function updateFilterBandwidth(mode) {
    if (mode === 'AM') {
        const bw = 5000;
        ifFilterI.calcCoeffs(CONFIG.sampleRate, bw, 0.707);
        ifFilterQ.calcCoeffs(CONFIG.sampleRate, bw, 0.707);
        console.log(`[DSP] Set IF Filter to Narrow AM (${bw}Hz, 4th Order)`);
    } else {
        const bw = 100000;
        ifFilterI.calcCoeffs(CONFIG.sampleRate, bw, 0.707);
        ifFilterQ.calcCoeffs(CONFIG.sampleRate, bw, 0.707);
        console.log(`[DSP] Set IF Filter to Wide FM (${bw}Hz)`);
    }
}

function tuneRadio(freq, mode) {
    console.log(`[Tuning] ${freq} Hz (${mode})`);
    isTuning = true;
    resetDspState();
    updateFilterBandwidth(mode);
    sendCmd(0x01, freq);
    currentFreq = freq;
    currentMode = mode;
    broadcastStatus();
    setTimeout(() => { isTuning = false; }, 800);
}

function broadcastStatus() {
    const bwText = (currentMode === 'FM') ? "Wide (100kHz)" : "Sharp (5kHz)";

    let savedFloor = null;
    if (squelchDB[currentFreq]) {
        savedFloor = squelchDB[currentFreq];
    }

    const msg = JSON.stringify({
        type: 'status_update',
        freq: currentFreq,
        mode: currentMode,
        bwInfo: bwText,
        savedNoiseFloor: savedFloor,
        audioRate: ACTUAL_AUDIO_RATE
    });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function getRecordings() {
    try {
        const files = fs.readdirSync(CONFIG.recordingsPath)
            .filter(f => f.endsWith('.flac'))
            .map(f => ({ name: f, size: fs.statSync(path.join(CONFIG.recordingsPath, f)).size }))
            .sort((a, b) => b.name.localeCompare(a.name));
        return files;
    } catch (e) {
        return [];
    }
}

function saveBookmarks() {
    fs.writeFile(bookmarksFile, JSON.stringify(bookmarks, null, 2), (err) => {
        if (err) console.error('[System] Bookmark Save Error:', err);
    });
    const msg = JSON.stringify({ type: 'bookmarks', data: bookmarks });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastRecordings() {
    const msg = JSON.stringify({ type: 'recordings', data: getRecordings() });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// 受信部
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
        type: 'status_update',
        freq: currentFreq,
        mode: currentMode,
        audioRate: ACTUAL_AUDIO_RATE
    }));
    ws.send(JSON.stringify({ type: 'bookmarks', data: bookmarks }));
    broadcastRecordings();
    ws.on('message', (msg) => {
        try {
            const strMsg = msg.toString();
            if (!strMsg.startsWith('{')) return;

            const cmd = JSON.parse(strMsg);

            if (cmd.type === 'auth_tune' && cmd.password === CONFIG.password) {
                tuneRadio(cmd.freq, cmd.mode);
            } else if (cmd.type === 'auth_tune') {
                console.log('[Auth] Authentication failed. Wrong password:', cmd.password);
            } else if (cmd.type === 'save_squelch') {
                if (cmd.freq && cmd.floor) {
                    squelchDB[cmd.freq] = cmd.floor;
                    saveSquelchDB();
                }
            } else if (cmd.type === 'add_bookmark') {
                const newBm = cmd.data;
                if (newBm) {
                    newBm.id = Date.now().toString();
                    bookmarks.push(newBm);
                    saveBookmarks();
                }
            } else if (cmd.type === 'edit_bookmark') {
                const idx = bookmarks.findIndex(b => b.id === cmd.data.id);
                if (idx !== -1) {
                    bookmarks[idx] = cmd.data;
                    saveBookmarks();
                }
            } else if (cmd.type === 'delete_bookmark') {
                const idsToDelete = new Set([cmd.id]);
                let added = true;
                while (added) {
                    added = false;
                    bookmarks.forEach(b => {
                        if (b.parentId && idsToDelete.has(b.parentId) && !idsToDelete.has(b.id)) {
                            idsToDelete.add(b.id);
                            added = true;
                        }
                    });
                }
                bookmarks = bookmarks.filter(b => !idsToDelete.has(b.id));
                saveBookmarks();
            } else if (cmd.type === 'start_recording') {
                startRecording();
            } else if (cmd.type === 'stop_recording') {
                stopRecording();
                broadcastRecordings();
            } else if (cmd.type === 'delete_recording') {
                if (cmd.filename) {
                    const filePath = path.join(CONFIG.recordingsPath, cmd.filename);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log(`[Recording] Deleted: ${cmd.filename}`);
                    }
                }
                broadcastRecordings();
            }
        } catch (e) {
            console.error('[System] WS Message Error:', e);
        }
    });
});

function getFormattedTimestamp() {
    const d = new Date();
    const YYYY = d.getFullYear();
    const MM = (d.getMonth() + 1).toString().padStart(2, '0');
    const DD = d.getDate().toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    return `${YYYY}${MM}${DD}_${hh}${mm}${ss}`;
}

function startRecording() {
    if (isRecording) return;
    isRecording = true;
    const filename = `${currentMode}_${currentFreq}_${getFormattedTimestamp()}.flac`;
    const filePath = path.join(CONFIG.recordingsPath, filename);

    const fileStream = fs.createWriteStream(filePath);
    recordingStream = new flac.StreamEncoder({
        sampleRate: Math.round(ACTUAL_AUDIO_RATE),
        channels: 1,
        bitsPerSample: 16
    });
    recordingStream.pipe(fileStream);

    console.log(`[Recording] Started: ${filename}`);
}

function stopRecording() {
    if (!isRecording || !recordingStream) return;
    isRecording = false;
    const filename = path.basename(recordingStream.path);
    recordingStream = null;
    console.log(`[Recording] Stopped: ${filename}`);
}

function connectToRtlTcp() {
    rtlSocket = new net.Socket();
    rtlSocket.connect(CONFIG.rtlPort, CONFIG.rtlHost, () => {
        console.log('[RTL-TCP] Connected.');
        tuneRadio(currentFreq, currentMode);
        sendCmd(0x02, CONFIG.sampleRate);
        sendCmd(0x03, 0); // Auto Gain
    });

    rtlSocket.on('data', (chunk) => {
        if (isTuning) {
            bufferRemainder = Buffer.alloc(0);
            return;
        }

        const rawData = Buffer.concat([bufferRemainder, chunk]);
        const processingLength = rawData.length - (rawData.length % 2);
        bufferRemainder = rawData.slice(processingLength);
        const audioSamples = [];
        const isFM = (currentMode === 'FM');

        let frameRssiSum = 0;
        let frameRssiCount = 0;

        for (let i = 0; i < processingLength; i += 2 * DECIMATION) {
            let sampleSum = 0, count = 0;
            let rssiSum = 0;

            for (let k = 0; k < DECIMATION; k++) {
                const idx = i + (k * 2);
                if (idx + 1 >= processingLength) break;

                let I = rawData[idx] - 127.5;
                let Q = rawData[idx + 1] - 127.5;

                const I_filt = ifFilterI.process(I);
                const Q_filt = ifFilterQ.process(Q);

                if (isFM) {
                    rssiSum += Math.sqrt(I_filt * I_filt + Q_filt * Q_filt);
                    i_dc = (i_dc * 0.99) + (I_filt * 0.01);
                    q_dc = (q_dc * 0.99) + (Q_filt * 0.01);
                    const I_fm = I_filt - i_dc;
                    const Q_fm = Q_filt - q_dc;
                    const angle = Math.atan2(Q_fm, I_fm);
                    let dAngle = angle - prevAngle;
                    if (dAngle > Math.PI) dAngle -= 2 * Math.PI;
                    if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
                    prevAngle = angle;
                    sampleSum += dAngle;
                } else {
                    const mag = Math.sqrt(I_filt * I_filt + Q_filt * Q_filt);
                    rssiSum += mag;
                    sampleSum += mag;
                }
                count++;
            }
            if (count === 0) continue;

            const val = sampleSum / count;
            const avgRssi = rssiSum / count;
            frameRssiSum += avgRssi;
            frameRssiCount++;

            const dcAlpha = isFM ? 0.999 : 0.95;
            dcOffset = (dcOffset * dcAlpha) + (val * (1.0 - dcAlpha));
            let rawAudio = (val - dcOffset);

            if (isFM) {
                const deemphAlpha = 0.38;
                deemphState = (deemphState * (1.0 - deemphAlpha)) + (rawAudio * deemphAlpha);
                rawAudio = deemphState;
            }

            let targetAlpha = 0.5;
            let softMuteGain = 1.0;
            if (isFM) {
                const strength = Math.min(100, Math.max(0, avgRssi));
                if (strength < 40) targetAlpha = 0.02;
                else if (strength > 70) targetAlpha = 0.35;
                else targetAlpha = 0.02 + (strength - 40) * (0.33 / 30);

                if (strength < 25) {
                    softMuteGain = strength / 25.0;
                    if (softMuteGain < 0) softMuteGain = 0;
                    softMuteGain = Math.sqrt(softMuteGain);
                }
            } else {
                targetAlpha = 0.35;
            }

            lpf1 = (lpf1 * (1.0 - targetAlpha)) + (rawAudio * targetAlpha);
            lpf2 = (lpf2 * (1.0 - targetAlpha)) + (lpf1 * targetAlpha);

            let audio = lpf2;
            audio = audioLPF.process(audio);
            if (isFM) audio *= softMuteGain;

            // AGC
            const currentLevel = Math.abs(audio * agcGain);
            if (currentLevel > 0.6) agcGain *= 0.99;
            else agcGain += 0.002;

            const maxGain = isFM ? 10.0 : 100.0;
            if (agcGain > maxGain) agcGain = maxGain;
            if (agcGain < 0.01) agcGain = 0.01;
            audio *= agcGain;

            if (audio > 1.0) audio = 1.0;
            else if (audio < -1.0) audio = -1.0;

            audioSamples.push(audio);
        }

        if (audioSamples.length > 0 && wss.clients.size > 0) {
            const finalRssi = frameRssiCount > 0 ? (frameRssiSum / frameRssiCount) : 0;

            // RSSIからパーセント(0-100)を計算
            const rssiLog = 20 * Math.log10(finalRssi + 1);
            const rssiPercent = Math.min(100, Math.max(0, (rssiLog / 50.0) * 100.0));

            // Float32 -> Int16 変換による帯域削減
            // Int16Array: [0]=RSSI*100, [1..n]=Audio*32767
            const int16Buffer = new Int16Array(audioSamples.length + 1);

            // RSSIを格納
            int16Buffer[0] = Math.floor(rssiPercent * 100);

            // 音声データを格納
            for (let i = 0; i < audioSamples.length; i++) {
                int16Buffer[i + 1] = Math.floor(audioSamples[i] * 32767);
            }

            if (isRecording && recordingStream) {
                const audioDataBuffer = Buffer.from(int16Buffer.buffer, int16Buffer.byteOffset + 2, int16Buffer.byteLength - 2);
                recordingStream.write(audioDataBuffer);
            }

            wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(int16Buffer.buffer); });
        }
    });

    rtlSocket.on('error', () => setTimeout(connectToRtlTcp, 5000));
    rtlSocket.on('close', () => setTimeout(connectToRtlTcp, 5000));
}

server.listen(CONFIG.webPort, '0.0.0.0', () => {
    console.log(`[Web] Server running at http://0.0.0.0:${CONFIG.webPort}`);
    connectToRtlTcp();
}); 