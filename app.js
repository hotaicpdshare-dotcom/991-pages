const state = {
  updateStatus: null,
  requestId: 0,
  submittedKeyword: '',
  loading: false,
  partData: null,
  found: false,
  activeProductType: '',
  activeVersion: null,
  activeLoadedAt: 0,
  keys: null,
  locked: false
};

// Published data is encrypted (same format as the dashboard's data.enc):
// file = 12-byte IV + AES-256-GCM ciphertext of gzip(JSON). The key is only
// in the link after '#', which the browser never sends to the server.
// Lookup index keys are HMAC-SHA256(indexKey, normalized keyword), with
// indexKey = HMAC-SHA256(key, LOOKUP_INDEX_LABEL) (see lookup_crypto.py).
const LOOKUP_INDEX_LABEL = '991-pages/lookup-index/v1';
const DATA_SCHEMA_VERSION = 3;
const KEY_ERROR_MESSAGE = '缺少金鑰或金鑰不正確，請向管理者要完整連結';
const OLD_BROWSER_MESSAGE = '這個瀏覽器太舊，請改用新版 Edge、Chrome 或 Safari。';

const form = document.getElementById('searchForm');
const keywordInput = document.getElementById('keyword');
const searchButton = document.getElementById('searchButton');
const message = document.getElementById('message');
const result = document.getElementById('result');
const updateButton = document.getElementById('updateButton');
const updateModal = document.getElementById('updateModal');
const modalClose = document.getElementById('modalClose');
const kbToggle = document.getElementById('kbToggle');
const clearInput = document.getElementById('clearInput');
const toast = document.getElementById('toast');
const suggestList = document.getElementById('suggestList');

// 11/06 輸入時的件號建議：打 2 個字以上，列出含這幾個字的零件件號。
// 開頭就符合的排前面，中間才符合的排後面；最多 10 筆。點一筆就直接查詢。
// 清單在發布版本裡的 parts.enc（加密，跟查詢同一把金鑰）；讀不到就不顯示建議。
const SUGGEST_MIN_CHARS = 2;
const SUGGEST_LIMIT = 10;
const suggest = { version: '', parts: null, loading: null };

// 11/06 條碼槍：按鍵間隔很短就是掃描。掃完（條碼槍送 Enter／Tab，或停下來 0.2 秒）直接查詢，不用按「查詢」；
// 下一次掃描會蓋掉上一次的內容。手打（間隔較長）不受影響，還是要按查詢。
const SCAN_GAP_MS = 60;
const SCAN_MIN_CHARS = 6;
const SCAN_IDLE_MS = 200;
const scan = { lastKeyAt: 0, chars: 0, baseLength: 0, timer: 0, quiet: false };

// 注音等輸入法開著時，條碼槍的按鍵是 key=Process：用實體鍵位換回英數字（同 abmanager scan.js）。
function charFromKeyCode(code) {
  let match = /^Key([A-Z])$/.exec(code || '');
  if (match) {
    return match[1];
  }
  match = /^(?:Digit|Numpad)(\d)$/.exec(code || '');
  if (match) {
    return match[1];
  }
  if (code === 'Minus' || code === 'NumpadSubtract') {
    return '-';
  }
  return code === 'Space' ? ' ' : '';
}

// 只有 key=Process（電腦開著注音等輸入法）才由程式自己補字。11/10：iPhone 數字鍵盤的按鍵也是 keyCode 229，
// 但 key 是正常字元，而且 iOS 不理 preventDefault、自己還會再打一次 → 按一下出現兩個字。所以不能用 keyCode 229 判斷。
function isImeKey(event) {
  return event.key === 'Process';
}

function scanCharOf(event) {
  if (isImeKey(event)) {
    return charFromKeyCode(event.code);
  }
  return event.key && event.key.length === 1 ? event.key : '';
}

// 記錄這個按鍵；連續的快速按鍵才算在同一次掃描。baseLength＝這次掃描之前留在輸入框的字數（送出時去掉）。
function trackScanKey(event) {
  const char = scanCharOf(event);
  if (!char) {
    scan.chars = 0;
    return;
  }
  if (scan.chars > 0 && event.timeStamp - scan.lastKeyAt <= SCAN_GAP_MS) {
    scan.chars += 1;
  } else {
    scan.chars = 1;
    scan.baseLength = keywordInput.selectionStart || 0;
  }
  scan.lastKeyAt = event.timeStamp;
  if (isImeKey(event)) {
    // 不讓輸入法接手，直接把英數字放進輸入框。
    event.preventDefault();
    keywordInput.setRangeText(
      char,
      keywordInput.selectionStart || 0,
      keywordInput.selectionEnd || 0,
      'end'
    );
    keywordInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function isScanning() {
  return scan.chars >= SCAN_MIN_CHARS;
}

function finishScan() {
  clearTimeout(scan.timer);
  keywordInput.value = keywordInput.value.slice(scan.baseLength).trim();
  scan.chars = 0;
  scan.baseLength = 0;
  scan.quiet = true;
  syncClearButton();
  hideSuggestions();
  runSearch(true);
}

// 預設數字鍵盤（inputmode=numeric）；件號有英文字母時按 ABC 切換成一般鍵盤，再按 123 切回。
// iOS 要先 blur 再 focus 才會換鍵盤；pointerdown 擋掉預設，避免按鈕搶走焦點時鍵盤先收起來閃一下。
kbToggle.addEventListener('pointerdown', function(event) {
  event.preventDefault();
});
kbToggle.addEventListener('click', function() {
  const toText = keywordInput.getAttribute('inputmode') !== 'text';
  keywordInput.setAttribute('inputmode', toText ? 'text' : 'numeric');
  kbToggle.textContent = toText ? '123' : 'ABC';
  kbToggle.setAttribute('aria-label', toText ? '切換成數字鍵盤' : '切換成英文鍵盤');
  keywordInput.blur();
  keywordInput.focus();
});

// 輸入框的 X：有內容才顯示；按下去清空輸入、查詢結果與狀態訊息，游標留在輸入框（pointerdown 擋掉預設，鍵盤不會收起來）。
clearInput.addEventListener('pointerdown', function(event) {
  event.preventDefault();
});
clearInput.addEventListener('click', function() {
  keywordInput.value = '';
  state.requestId += 1;
  state.submittedKeyword = '';
  state.partData = null;
  state.found = false;
  setLoading(false);
  result.innerHTML = '';
  showMessage('', '');
  syncClearButton();
  hideSuggestions();
  keywordInput.focus();
});

suggestList.addEventListener('pointerdown', function(event) {
  // 點建議時不要讓輸入框先失去焦點（否則清單會在 click 之前被收起來）。
  event.preventDefault();
});
suggestList.addEventListener('click', function(event) {
  const item = event.target.closest('[data-part]');
  if (!item) {
    return;
  }
  keywordInput.value = item.getAttribute('data-part') || '';
  syncClearButton();
  hideSuggestions();
  keywordInput.blur();
  runSearch();
});

keywordInput.addEventListener('focus', function() {
  loadSuggestParts();
  renderSuggestions();
});
// 11/06：iPhone 按鍵盤上的「✓」只是收起鍵盤（輸入框失去焦點），使用者是要看被鍵盤擋住的建議，
// 所以失去焦點時不收清單；點輸入框和清單以外的地方才收（用 click，滑動頁面不會觸發）。
document.addEventListener('click', function(event) {
  if (suggestList.hidden) {
    return;
  }
  if (
    event.target === keywordInput ||
    suggestList.contains(event.target) ||
    event.target.closest('.input-wrap')
  ) {
    return;
  }
  hideSuggestions();
});
keywordInput.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    hideSuggestions();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.key === 'Enter') {
    return;      // 交給 form 的 submit
  }
  if (event.key === 'Tab' && isScanning()) {
    event.preventDefault();      // 條碼槍設定成送 Tab 時，不要跳到下一個欄位
    finishScan();
    return;
  }
  trackScanKey(event);
});
// 游標不在輸入框時掃描（例如剛點過結果）：把按鍵接到輸入框，並蓋掉上一次的內容。
document.addEventListener('keydown', function(event) {
  if (
    event.target === keywordInput ||
    keywordInput.disabled ||
    event.ctrlKey || event.metaKey || event.altKey ||
    updateModal.classList.contains('show') ||
    !scanCharOf(event)
  ) {
    return;
  }
  scan.quiet = true;
  keywordInput.focus();
  keywordInput.select();
  trackScanKey(event);
});

function hideSuggestions() {
  suggestList.hidden = true;
  suggestList.innerHTML = '';
}

async function loadSuggestParts() {
  if (state.locked || !state.keys || !state.activeVersion) {
    return null;
  }
  const version = state.activeVersion.version;
  if (suggest.version === version && (suggest.parts || suggest.loading)) {
    return suggest.loading || suggest.parts;
  }
  suggest.version = version;
  suggest.parts = null;
  suggest.loading = (async function() {
    try {
      const response = await fetch(
        `data/releases/${encodeURIComponent(version)}/parts.enc`,
        { cache: 'force-cache' }
      );
      if (!response.ok) {
        return null;
      }
      const parts = await decryptJson(await response.arrayBuffer());
      if (suggest.version === version && Array.isArray(parts)) {
        suggest.parts = parts;
      }
      return suggest.parts;
    } catch (error) {
      return null;
    } finally {
      if (suggest.version === version) {
        suggest.loading = null;
      }
    }
  })();
  const parts = await suggest.loading;
  if (parts && document.activeElement === keywordInput) {
    renderSuggestions();
  }
  return parts;
}

// 打 A_件號 時，用底線後面的件號來比對。
function suggestKeyword(value) {
  return normalizeLookupKey(value).replace(/^[A-Z]_/, '');
}

function findSuggestions(keyword) {
  const parts = suggest.parts || [];
  const starts = [];
  const middle = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const at = part.indexOf(keyword);
    if (at === 0) {
      if (starts.length < SUGGEST_LIMIT) {
        starts.push(part);
      }
    } else if (at > 0) {
      middle.push({ part: part, at: at });
    }
  }
  middle.sort(function(a, b) {
    return a.at - b.at || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0);
  });
  const room = Math.max(0, SUGGEST_LIMIT - starts.length);
  const total = starts.length + middle.length;
  return {
    starts: starts,
    middle: middle.slice(0, room).map(function(item) { return item.part; }),
    more: total > SUGGEST_LIMIT
  };
}

function highlightPart(part, keyword) {
  const at = part.indexOf(keyword);
  if (at < 0) {
    return escapeHtml(part);
  }
  return escapeHtml(part.slice(0, at)) +
    '<mark>' + escapeHtml(part.slice(at, at + keyword.length)) + '</mark>' +
    escapeHtml(part.slice(at + keyword.length));
}

function renderSuggestions() {
  if (scan.quiet || scan.chars >= 2) {
    return;
  }
  const keyword = suggestKeyword(keywordInput.value);
  if (keyword.length < SUGGEST_MIN_CHARS || !suggest.parts) {
    hideSuggestions();
    return;
  }
  const found = findSuggestions(keyword);
  if (!found.starts.length && !found.middle.length) {
    hideSuggestions();
    return;
  }
  // 只剩一筆而且就是輸入的件號，不用再提示。
  if (
    found.starts.length === 1 &&
    !found.middle.length &&
    found.starts[0] === keyword
  ) {
    hideSuggestions();
    return;
  }
  function items(list) {
    return list.map(function(part) {
      return `<button class="suggest-item" type="button" role="option" data-part="${escapeHtml(part)}">${highlightPart(part, keyword)}</button>`;
    }).join('');
  }
  let html = '';
  if (found.starts.length) {
    html += '<div class="suggest-group">開頭符合</div>' + items(found.starts);
  }
  if (found.middle.length) {
    html += '<div class="suggest-group">中間符合</div>' + items(found.middle);
  }
  if (found.more) {
    html += '<div class="suggest-more">只列前 10 筆，多打幾個字可以縮小範圍</div>';
  }
  suggestList.innerHTML = html;
  suggestList.hidden = false;
}

function syncClearButton() {
  clearInput.hidden = !keywordInput.value || keywordInput.disabled;
}

form.addEventListener('submit', function(event) {
  event.preventDefault();
  if (isScanning()) {
    finishScan();      // 條碼槍最後送的 Enter
    return;
  }
  hideSuggestions();
  runSearch();
});

keywordInput.addEventListener('input', function(event) {
  const start = this.selectionStart;
  this.value = this.value.toUpperCase();
  this.setSelectionRange(start, start);
  // 有些條碼槍／掃描 App 是一次放進整串（一個 input 事件就 6 個字以上）。
  const inserted = String(event.data || '').length;
  if (inserted >= SCAN_MIN_CHARS) {
    scan.chars = inserted;
    scan.baseLength = Math.max(0, (start || 0) - inserted);
  }
  if (!isScanning()) {
    scan.quiet = false;
  }
  clearTimeout(scan.timer);
  if (isScanning()) {
    scan.timer = setTimeout(finishScan, SCAN_IDLE_MS);      // 沒有送 Enter 的條碼槍：停下來就查詢
  }
  syncClearButton();
  if (!suggest.parts) {
    loadSuggestParts();
  }
  renderSuggestions();
  if (state.loading) {
    const changed =
      this.value.trim() !== state.submittedKeyword;
    if (changed) {
      state.requestId += 1;
      setLoading(false);
      showMessage('已取消顯示舊查詢，修改完成後再按查詢', '');
    }
  }
});

result.addEventListener('click', function(event) {
  const copyButton = event.target.closest('[data-copy]');
  if (copyButton) {
    copyText(copyButton.getAttribute('data-copy') || '');
    return;
  }
  const button = event.target.closest('[data-product-type]');
  if (!button || !state.partData) {
    return;
  }
  state.activeProductType =
    button.getAttribute('data-product-type') || '';
  renderPartView();
  window.scrollTo({ top: result.offsetTop - 8, behavior: 'smooth' });
});

updateButton.addEventListener('click', openUpdateModal);
modalClose.addEventListener('click', closeUpdateModal);
updateModal.addEventListener('click', function(event) {
  if (event.target === updateModal) {
    closeUpdateModal();
  }
});

// Pasting the full link into an already open page only changes the hash.
window.addEventListener('hashchange', function() {
  location.reload();
});

syncClearButton();
initializeDirectSearch();

async function initializeDirectSearch() {
  try {
    state.keys = await importLookupKeys(readKeyFromHash());
    await loadUpdateStatus();
  } catch (error) {
    if (error && error.lockMessage) {
      lockSearch(error.lockMessage);
      return;
    }
    renderUpdateStatus({
      status: 'unknown',
      label: '資料尚未發布',
      latestDisplay: '尚未更新',
      sheets: []
    });
    showMessage(errorMessage(error), 'error');
  }
}

function lockError(text) {
  const error = new Error(text);
  error.lockMessage = text;
  return error;
}

// No key, a wrong key or an old browser: say so and disable the search box.
function lockSearch(text) {
  state.locked = true;
  state.requestId += 1;
  setLoading(false);
  keywordInput.disabled = true;
  kbToggle.disabled = true;
  syncClearButton();
  renderUpdateStatus({
    status: 'unknown',
    label: '無法讀取',
    latestDisplay: '無法讀取',
    sheets: []
  });
  state.updateStatus = null;
  result.innerHTML = '';
  showMessage(text, 'error');
}

function readKeyFromHash() {
  // Same convention as the dashboard: #<key>, anything after '/' ignored.
  return location.hash.slice(1).split(/[/?&]/)[0].trim();
}

async function importLookupKeys(keyText) {
  if (!keyText) {
    throw lockError(KEY_ERROR_MESSAGE);
  }
  if (!window.crypto || !crypto.subtle || !window.DecompressionStream) {
    throw lockError(OLD_BROWSER_MESSAGE);
  }
  let raw;
  try {
    raw = Uint8Array.from(
      atob(keyText.replace(/-/g, '+').replace(/_/g, '/')),
      function(char) {
        return char.charCodeAt(0);
      }
    );
  } catch (error) {
    throw lockError(KEY_ERROR_MESSAGE);
  }
  if (raw.length !== 32) {
    throw lockError(KEY_ERROR_MESSAGE);
  }
  const hmac = { name: 'HMAC', hash: 'SHA-256' };
  const aes = await crypto.subtle.importKey(
    'raw', raw, 'AES-GCM', false, ['decrypt']
  );
  const base = await crypto.subtle.importKey(
    'raw', raw, hmac, false, ['sign']
  );
  const indexBytes = await crypto.subtle.sign(
    'HMAC', base, new TextEncoder().encode(LOOKUP_INDEX_LABEL)
  );
  const index = await crypto.subtle.importKey(
    'raw', indexBytes, hmac, false, ['sign']
  );
  return { aes: aes, index: index };
}

// Identical in behaviour to the dashboard loader: AES-GCM, then gunzip.
async function decryptJson(buffer) {
  const bytes = new Uint8Array(buffer);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      state.keys.aes,
      bytes.slice(12)
    );
  } catch (error) {
    throw lockError(KEY_ERROR_MESSAGE);
  }
  const text = await new Response(
    new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).text();
  return JSON.parse(text);
}

async function lookupHashHex(value) {
  const signature = await crypto.subtle.sign(
    'HMAC', state.keys.index, new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(signature))
    .map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
}

async function runSearch(fromScan) {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    showMessage('請輸入台車號或零件號碼', 'error');
    keywordInput.focus();
    return;
  }

  if (state.locked || !state.keys) {
    return;
  }

  const requestId = ++state.requestId;
  state.submittedKeyword = keyword;
  setLoading(true);
  showMessage('正在查詢…', '');

  try {
    const data = await readPrecomputedResult(keyword);
    if (requestId !== state.requestId) {
      return;
    }
    setLoading(false);
    if (data.scanTo) {
      keywordInput.value = data.scanTo;
      state.submittedKeyword = data.scanTo;
      syncClearButton();
    }
    renderResult(data);
    if (data.scanTo) {
      showMessage(`${data.scanFrom} 找不到，已去掉確認碼，改查 ${data.scanTo}`, 'success');
    }
    selectAfterScan(fromScan);
  } catch (error) {
    if (error && error.lockMessage) {
      lockSearch(error.lockMessage);
      return;
    }
    if (requestId !== state.requestId) {
      return;
    }
    setLoading(false);
    showMessage(errorMessage(error), 'error');
    selectAfterScan(fromScan);
  }
}

// 掃描查完把內容選起來，下一次掃描直接蓋掉（不呼叫 focus：手機不會因此跳出鍵盤）。
function selectAfterScan(fromScan) {
  if (fromScan && document.activeElement === keywordInput) {
    keywordInput.select();
  }
}

async function loadUpdateStatus() {
  const response = await fetch(
    `data/active.json?t=${Date.now()}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    throw new Error('尚未產生 GitHub Pages 查詢資料');
  }
  const active = await response.json();
  if (!active.version) {
    throw new Error('active.json 版本內容異常');
  }
  if (Number(active.schemaVersion) !== DATA_SCHEMA_VERSION) {
    throw new Error('查詢資料版本不符，請稍後重新整理頁面');
  }
  // updateStatus lives in the release's encrypted manifest; a release never
  // changes once published, so it may come from the HTTP cache.
  const manifestResponse = await fetch(
    `data/releases/${encodeURIComponent(active.version)}/manifest.enc`,
    { cache: 'force-cache' }
  );
  if (!manifestResponse.ok) {
    throw new Error(`更新狀態讀取失敗：HTTP ${manifestResponse.status}`);
  }
  const manifest = await decryptJson(await manifestResponse.arrayBuffer());
  state.activeVersion = active;
  state.activeLoadedAt = Date.now();
  state.updateStatus = manifest.updateStatus || {
    status: 'unknown',
    label: '狀態未知',
    latestDisplay: '未知',
    sheets: []
  };
  renderUpdateStatus(state.updateStatus);
  return active;
}

// Only the newest two releases stay published. A page left open across
// several updates must reload active.json instead of reporting "not found".
const ACTIVE_REFRESH_MS = 5 * 60 * 1000;
const RELEASE_GONE = 'release-gone';

async function readPrecomputedResult(keyword) {
  if (!state.activeVersion || Date.now() - state.activeLoadedAt > ACTIVE_REFRESH_MS) {
    await loadUpdateStatus();
  }
  const normalized = normalizeLookupKey(keyword);
  const lookupHash = await lookupHashHex(normalized);
  let data = await readFromRelease(state.activeVersion, keyword, normalized, lookupHash);
  if (data === RELEASE_GONE) {
    const staleVersion = state.activeVersion.version;
    const active = await loadUpdateStatus();
    data = active.version === staleVersion
      ? RELEASE_GONE
      : await readFromRelease(active, keyword, normalized, lookupHash);
  }
  if (data !== RELEASE_GONE && data.found !== false) {
    return data;
  }
  const scanned = data === RELEASE_GONE ? null : await readScannedCode(keyword);
  return scanned || (data === RELEASE_GONE ? buildNotFoundResult(keyword, normalized) : data);
}

// 條碼常是「件號＋確認碼」（實際掃到的多半直接黏在後面 1 碼，例如 681520M010Z；也可能中間有空格）。整串查不到時：
// 1. 有空格取第一段、去掉符號後再查一次；2. 去掉末 1～3 碼（至少留 8 碼），恰好一個是零件件號才採用。不符合就維持查無。
async function readScannedCode(keyword) {
  const text = String(keyword).trim().replace(/^['’]+/, '').toUpperCase();
  const head = text.split(/\s+/)[0];
  const match = /^([A-Z]_)(.*)$/.exec(head);
  const prefix = match ? match[1] : '';
  const core = (match ? match[2] : head).replace(/[^A-Z0-9]/g, '');
  const original = normalizeLookupKey(keyword);
  const readCandidate = async function(candidate) {
    const hash = await lookupHashHex(candidate);
    const data = await readFromRelease(state.activeVersion, candidate, candidate, hash);
    return data !== RELEASE_GONE && data.found !== false ? data : null;
  };
  const scannedResult = function(data, candidate) {
    data.scanFrom = text;
    data.scanTo = candidate;
    return data;
  };
  const whole = prefix + core;
  if (core && whole !== original) {
    const data = await readCandidate(whole);
    if (data) {
      return scannedResult(data, whole);
    }
  }
  const hits = [];
  for (let cut = 1; cut <= 3; cut += 1) {
    if (core.length - cut >= 8) {
      const candidate = prefix + core.slice(0, core.length - cut);
      const data = await readCandidate(candidate);
      if (data && data.mode !== 'cart') {
        hits.push({ data: data, candidate: candidate });
      }
    }
  }
  return hits.length === 1 ? scannedResult(hits[0].data, hits[0].candidate) : null;
}

async function readFromRelease(active, keyword, normalized, lookupHash) {
  const releaseBase =
    `data/releases/${encodeURIComponent(active.version)}`;
  const lookupResponse = await fetch(
    `${releaseBase}/lookup/${lookupHash.slice(0, 2)}.enc`,
    { cache: 'force-cache' }
  );
  if (lookupResponse.status === 404) {
    return RELEASE_GONE;
  }
  if (!lookupResponse.ok) {
    throw new Error(`索引讀取失敗：HTTP ${lookupResponse.status}`);
  }
  const lookupBucket = await decryptJson(await lookupResponse.arrayBuffer());
  const recordId = String(lookupBucket[lookupHash] || '');

  if (!recordId) {
    return buildNotFoundResult(keyword, normalized);
  }
  if (!/^[a-f0-9]{64}$/.test(recordId)) {
    throw new Error('查詢索引內容異常');
  }
  const resultResponse = await fetch(
    `${releaseBase}/records/${recordId.slice(0, 2)}.enc`,
    { cache: 'force-cache' }
  );
  if (resultResponse.status === 404) {
    return RELEASE_GONE;
  }
  if (!resultResponse.ok) {
    throw new Error('查詢結果不存在，請稍後再試');
  }
  const resultBucket = await decryptJson(await resultResponse.arrayBuffer());
  const data = resultBucket[recordId];
  if (!data) {
    throw new Error('查詢結果索引不一致，請稍後再試');
  }
  data.keyword = keyword;
  data.updateStatus = state.updateStatus;
  return data;
}

function buildNotFoundResult(keyword, normalized) {
  return {
    mode: 'part',
    keyword: keyword,
    found: false,
    part: {
      partNo: normalized,
      fullPartNos: [],
      productTypes: [],
      name: '查無中文名稱',
      hopes: { oh: 0, locations: [] },
      wes: { oh: 0, storageCount: 0 },
      openCase: { count: 0, quantity: 0, details: [] },
      clo: { closeQty: 0, releaseQty: 0, remaining: 0 },
      suspense: { count: 0, quantity: 0, details: [] },
      sizes: [],
      abnormalCell: {
        storageCount: 0,
        quantity: 0,
        groups: []
      },
      pickAbnormal: {
        labelCount: 0,
        quantity: 0,
        groups: []
      },
      abnormalArea: {
        selectedProductType: '',
        matchMode: 'part_only',
        confirmedQuantity: 0,
        possibleQuantity: 0,
        totalQuantity: 0,
        confirmedCaseCount: 0,
        possibleCaseCount: 0,
        caseCount: 0,
        locations: [],
        details: [],
        otherProductTypes: []
      },
      variants: []
    },
    updateStatus: state.updateStatus
  };
}

function normalizeLookupKey(value) {
  return String(value || '')
    .trim()
    .replace(/^['’]+/, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function errorMessage(error) {
  const message =
    error && error.message ? error.message : String(error);
  return message || '查詢失敗';
}

function renderResult(data) {
  if (data.mode === 'cart') {
    renderCart(data.cart);
    return;
  }
  renderPart(data.part, data.found);
}

function renderCart(cart) {
  const records = cart.records || [];
  const first = records[0] || {};
  showMessage('已找到台車資料', 'success');

  let html = `
    <article class="hero-card">
      <div class="eyebrow">台車</div>
      <h2 class="hero-title">${escapeHtml(first.CARTNO || '')}</h2>
      <div class="state-box">${escapeHtml(first.STATE_SUMMARY || '查無狀態')}</div>
    </article>
  `;

  records.forEach(function(item, index) {
    html += `
      <section class="panel">
        <h3 class="panel-title">台車狀態${records.length > 1 ? ' ' + (index + 1) : ''}</h3>
        ${infoList([
          ['目前狀態', item.NOWSTS || '無'],
          ['上架序號', item.BIN_SEQNO || '無'],
          ['主要工作', item.MAINJOB || '無'],
          ['作業項目', item.RCCODE || '無'],
          ['最後更新', item.MTDT || '無']
        ])}
      </section>
    `;
  });

  html += openCaseDetails(
    cart.openCases || [],
    `${formatNumber(cart.openCaseCount)} 點未上架零件`,
    `合計 ${formatNumber(cart.openCaseQuantity)} pcs`
  );
  result.innerHTML = html;
}

function renderPart(part, found) {
  state.partData = part;
  state.found = found;
  const variants = part.variants || [];
  const requestedType = requestedProductType(
    state.submittedKeyword
  );
  const preferred = variants.find(function(item) {
    return item.productType === requestedType;
  });
  state.activeProductType = preferred
    ? preferred.productType
    : (variants[0] ? variants[0].productType : '');
  renderPartView();
}

function renderPartView() {
  const part = state.partData || {};
  const found = state.found;
  if (!found) {
    showMessage('查無此件號資料', 'error');
  } else {
    showMessage('已找到零件資料', 'success');
  }

  const variants = part.variants || [];
  const selected = variants.find(function(item) {
    return item.productType === state.activeProductType;
  }) || variants[0] || part;
  const hopes = selected.hopes || {};
  const wes = selected.wes || {};
  const openCase = selected.openCase || {};
  const clo = selected.clo || {};
  const suspense = selected.suspense || {};
  const abnormalCell = selected.abnormalCell || {};
  const pickAbnormal = selected.pickAbnormal || {};
  const abnormalArea = selected.abnormalArea || {};
  const variantButtons = variants.length > 1
    ? `
      <nav class="variant-strip" aria-label="選擇商品別">
        ${variants.map(function(item) {
          const active =
            item.productType === selected.productType;
          return `
            <button
              class="variant-button${active ? ' active' : ''}"
              type="button"
              data-product-type="${escapeHtml(item.productType)}"
            >商品別 ${escapeHtml(item.productType)}</button>
          `;
        }).join('')}
      </nav>
    `
    : '';

  const copyType = String(selected.productType || '');
  const copyPart = String(selected.partNo || part.partNo || '');
  const copyValue = found && copyPart ? (copyType ? copyType + '_' + copyPart : copyPart) : '';
  const copyButton = copyValue
    ? `<button class="copy-button" type="button" data-copy="${escapeHtml(copyValue)}" aria-label="複製 ${escapeHtml(copyValue)}">複製</button>`
    : '';

  let html = `
    <article class="hero-card${copyButton ? ' has-copy' : ''}">
      ${copyButton}
      <div class="eyebrow">零件件號</div>
      <h2 class="hero-title">${escapeHtml(selected.partNo || part.partNo || '')}</h2>
      <p class="hero-subtitle">${escapeHtml(selected.name || part.name || '查無中文名稱')}</p>
      <div class="warning-note">
        商品別：${escapeHtml(selected.productType || '查無')}
      </div>
    </article>

    ${variantButtons}

    <section class="panel">
      <h3 class="panel-title">庫存與作業摘要</h3>
      <div class="metric-grid">
        ${metric('異常區', abnormalAreaMetricText(abnormalArea), 'orange', true)}
        ${metric('HOPES OH', `${formatNumber(hopes.oh)} pcs`, 'blue')}
        ${metric('WES OH', `${formatNumber(wes.oh)} pcs`, 'green')}
        ${metric('未上架', `${formatNumber(openCase.count)} 點`, 'orange')}
        ${metric('剩餘封箱', `${formatNumber(clo.remaining)} pcs`, 'blue')}
        ${metric('暫存總數', `${formatNumber(suspense.quantity)} pcs`, 'orange')}
        ${metric('WES 儲位', `${formatNumber(wes.storageCount)} 個`, 'green')}
        ${metric('儲位缺', `${formatNumber(abnormalCell.storageCount)} 個`, 'red')}
        ${metric('儲位缺 PCS', `${formatNumber(abnormalCell.quantity)} pcs`, 'red')}
        ${metric('倉缺貼紙', `${formatNumber(pickAbnormal.labelCount)} 張`, 'red')}
        ${metric('倉缺總數', `${formatNumber(pickAbnormal.quantity)} pcs`, 'red')}
      </div>
    </section>

    ${abnormalAreaOverview(abnormalArea)}
    <section class="panel">
      <h3 class="panel-title">零件位置與尺寸</h3>
      ${infoList([
        ['HOPES庫位', (hopes.locations || []).join('、') || '無'],
        ['零件尺寸', formatSizes(selected.sizes || [])]
      ])}
    </section>
  `;

  html += suspenseDetails(
    suspense.details || [],
    `有 ${formatNumber(suspense.count)} 個暫存`,
    `共暫存 ${formatNumber(suspense.quantity)} pcs`
  );
  html += openCaseDetails(
    openCase.details || [],
    `${formatNumber(openCase.count)} 點未上架零件`,
    `合計 ${formatNumber(openCase.quantity)} pcs`
  );
  html += abnormalAreaDetails(abnormalArea);
  html += abnormalGroupsDetails(
    abnormalCell.groups || [],
    '儲位缺明細',
    `${formatNumber(abnormalCell.storageCount)} 個儲位，共缺 ${formatNumber(abnormalCell.quantity)} pcs`,
    true
  );
  html += pickAbnormalDetails(
    pickAbnormal.details || [],
    `${formatNumber(pickAbnormal.labelCount)} 張貼紙，共缺 ${formatNumber(pickAbnormal.quantity)} pcs`
  );
  result.innerHTML = html;
}

function abnormalAreaMetricText(area) {
  const confirmed = Number(area.confirmedQuantity || 0);
  const possible = Number(area.possibleQuantity || 0);
  if (confirmed <= 0 && possible <= 0) {
    return '0 pcs';
  }
  if (confirmed > 0 && possible > 0) {
    return `${formatNumber(confirmed)} pcs＋可能 ${formatNumber(possible)} pcs`;
  }
  if (confirmed > 0) {
    return `${formatNumber(confirmed)} pcs`;
  }
  return `可能 ${formatNumber(possible)} pcs`;
}

function abnormalAreaOverview(area) {
  const total = Number(area.totalQuantity || 0);
  const possible = Number(area.possibleQuantity || 0);
  const confirmed = Number(area.confirmedQuantity || 0);
  const locations = area.locations || [];
  const otherTypes = area.otherProductTypes || [];

  if (total <= 0 && !otherTypes.length) {
    return '';
  }

  const confirmedLabel = area.matchMode === 'product_type'
    ? '商品別一致'
    : '有商品別資料';

  let locationHtml = '';
  if (!locations.length) {
    locationHtml = '<div class="empty">本商品別沒有符合的異常區資料</div>';
  } else {
    locationHtml = `
      <div class="abnormal-location-list">
        ${locations.map(function(item) {
          const itemConfirmed = Number(item.confirmedQuantity || 0);
          const itemPossible = Number(item.possibleQuantity || 0);
          const layerText = item.layer && item.layer !== '未填'
            ? item.layer + '層'
            : '層別未填';
          return `
            <article class="abnormal-location-card">
              <div class="abnormal-location-head">
                <strong>${escapeHtml(item.floor || '未填')}・${escapeHtml(layerText)}</strong>
                <span>${escapeHtml(formatNumber(item.totalQuantity))} pcs</span>
              </div>
              <div class="abnormal-location-meta">
                ${itemConfirmed > 0
                  ? `<span>${escapeHtml(confirmedLabel)} ${escapeHtml(formatNumber(itemConfirmed))}</span>`
                  : ''}
                ${itemPossible > 0
                  ? `<span class="possible">可能符合 ${escapeHtml(formatNumber(itemPossible))}</span>`
                  : ''}
                <span>${escapeHtml(formatNumber(item.caseCount))} 件案件</span>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `;
  }

  const possibleNote = possible > 0
    ? `
      <div class="abnormal-possible-note">
        其中 ${escapeHtml(formatNumber(possible))} pcs 沒有商品別，僅依零件件號比對，請到案件明細確認。
      </div>
    `
    : '';

  const otherTypeNote = otherTypes.length
    ? `
      <div class="abnormal-other-note">
        另有其他商品別案件，未計入上方數量：
        ${otherTypes.map(function(item) {
          return `商品別 ${escapeHtml(item.productType || '未填')} ${escapeHtml(formatNumber(item.quantity))} pcs`;
        }).join('、')}
      </div>
    `
    : '';

  return `
    <section class="panel abnormal-area-panel">
      <h3 class="panel-title">異常區位置</h3>
      <div class="abnormal-total-line">
        <span>異常區合計</span>
        <strong>${escapeHtml(formatNumber(total))} pcs</strong>
      </div>
      ${locationHtml}
      ${possibleNote}
      ${otherTypeNote}
    </section>
  `;
}

function abnormalAreaDetails(area) {
  const items = area.details || [];
  if (!items.length) {
    return '';
  }

  let body = '';
  items.forEach(function(item) {
    const matchLabel = item.matchType === 'possible'
      ? '商品別未填，僅依件號比對'
      : (area.matchMode === 'product_type'
        ? '商品別一致'
        : '有商品別資料');
    const layerText = item.layer && item.layer !== '未填'
      ? item.layer + '層'
      : '層別未填';
    body += `
      <article class="detail-card abnormal-detail-card">
        <h4 class="detail-title">
          ${escapeHtml(item.floor || '未填')}・${escapeHtml(layerText)}　${escapeHtml(formatNumber(item.quantity))} pcs
        </h4>
        ${infoList([
          ['案件編號', item.caseNo || '無'],
          ['比對方式', matchLabel],
          ['商品別', item.productType || '未填'],
          ['異常情況', item.situation || '無'],
          ['原台車', item.originalCart || '無'],
          ['處理階段', item.stage || '無'],
          ['最終處理', item.finalResolution || '尚未決定'],
          ['上架狀態', item.shelvingStatus || '無'],
          ['最後更新', item.updatedAt || '無']
        ])}
      </article>
    `;
  });

  const possibleText = Number(area.possibleQuantity || 0) > 0
    ? `；其中 ${formatNumber(area.possibleQuantity)} pcs 僅依件號比對`
    : '';
  return detailsBlock(
    '異常區案件明細',
    `共 ${formatNumber(area.caseCount)} 件、${formatNumber(area.totalQuantity)} pcs${possibleText}`,
    body
  );
}

function openCaseDetails(items, title, subtitle) {
  let body = '';
  if (!items.length) {
    body = '<div class="empty">沒有未上架資料</div>';
  } else {
    items.forEach(function(item) {
      body += `
        <article class="detail-card">
          <h4 class="detail-title">
            ${escapeHtml(item.PRODUCT_TYPE || '')} /
            ${escapeHtml(item.PART_NO || '')}
          </h4>
          ${infoList([
            ['台車號', item.CARTNO || '無'],
            ['上架數量', `${formatNumber(item.OPENQTY)} pcs`],
            ['庫位', item.LOCATION || '無'],
            ['發票號碼', item.INVOICE_NO || '無'],
            ['上架序號', item.BIN_SEQNO || '無'],
            ['案件序號', item.CASE_SERNO || '無'],
            ['最後更新', item.MTDT || '無']
          ])}
        </article>
      `;
    });
  }
  return detailsBlock(title, subtitle, body);
}

function suspenseDetails(items, title, subtitle) {
  let body = '';
  if (!items.length) {
    body = '<div class="empty">沒有暫存資料</div>';
  } else {
    items.forEach(function(item) {
      body += `
        <article class="detail-card">
          <h4 class="detail-title">
            ${escapeHtml(item['F/C'] || '')} /
            ${escapeHtml(stripApostrophe(item['零件件號']) || '')}
          </h4>
          ${infoList([
            ['發貨單號', item['發貨單號'] || '無'],
            ['暫存日期', item['暫存日期'] || '無'],
            ['商品別', item['F/C'] || '無'],
            ['暫存數量', `${formatNumber(item['數量'])} pcs`]
          ])}
        </article>
      `;
    });
  }
  return detailsBlock(title, subtitle, body);
}

function pickAbnormalDetails(items, subtitle) {
  let body = '';

  if (!items.length) {
    body = '<div class="empty">沒有倉缺資料</div>';
  } else {
    items.forEach(function(item, index) {
      body += `
        <article class="detail-card">
          <h4 class="detail-title">
            貼紙 ${index + 1}
          </h4>

          ${infoList([
            ['索引碼', item.indexKey || '無'],
            ['據點', item.strongholdId || '無'],
            ['數量', `${formatNumber(item.quantity)} pcs`]
          ])}
        </article>
      `;
    });
  }

  return detailsBlock(
    '倉缺明細',
    subtitle,
    body
  );
}

function abnormalGroupsDetails(
  groups,
  title,
  subtitle,
  showPositions
) {
  let body = '';
  if (!groups.length) {
    body = `<div class="empty">沒有${escapeHtml(title.replace('明細', ''))}資料</div>`;
  } else {
    groups.forEach(function(item) {
      const rows = [
        ['ObjectId', item.objectId || '無'],
        ['資料筆數', formatNumber(item.count)],
        ['缺少數量', `${formatNumber(item.quantity)} pcs`]
      ];
      if (showPositions) {
        rows.splice(2, 0, [
          '儲位數',
          `${formatNumber(item.storageCount)} 個`
        ]);
        rows.push([
          '儲位',
          (item.positions || []).join('、') || '無'
        ]);
      }
      body += `
        <article class="detail-card">
          <h4 class="detail-title">${escapeHtml(item.objectId || '')}</h4>
          ${infoList(rows)}
        </article>
      `;
    });
  }
  return detailsBlock(title, subtitle, body);
}

function detailsBlock(title, subtitle, body) {
  return `
    <details>
      <summary>
        <span>
          ${escapeHtml(title)}
          <span class="summary-sub">${escapeHtml(subtitle)}</span>
        </span>
      </summary>
      <div class="detail-body">${body}</div>
    </details>
  `;
}

function metric(label, value, color, wide) {
  const colorClass = color === 'blue' ? '' : color;
  const wideClass = wide ? ' wide' : '';
  return `
    <div class="metric ${colorClass}${wideClass}">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </div>
  `;
}
function infoList(rows) {
  return `
    <div class="info-list">
      ${rows.map(function(row) {
        return `
          <div class="info-label">${escapeHtml(row[0])}</div>
          <div class="info-value">${escapeHtml(row[1])}</div>
        `;
      }).join('')}
    </div>
  `;
}

function formatSizes(sizes) {
  if (!sizes.length) {
    return '無';
  }
  return sizes.map(function(item) {
    const prefix = sizes.length > 1 && item.FRCDPARTNO
      ? item.FRCDPARTNO + '：'
      : '';
    return (
      prefix +
      `${item['深_單'] || 0} × ${item['寬_單'] || 0} × ` +
      `${item['高_單'] || 0}，${item['重量_單'] || 0}`
    );
  }).join('；');
}

function renderUpdateStatus(data) {
  const status = data || {};
  document.getElementById('latestTime').textContent =
    '最新更新：' + (status.latestDisplay || '尚無紀錄');
  const stateElement = document.getElementById('updateState');
  stateElement.textContent = '● ' + (status.label || '狀態未知');
  stateElement.className =
    'status-line ' + (status.status || 'unknown');
}

function openUpdateModal() {
  const status = state.updateStatus || { sheets: [] };
  const sheets = status.sheets || [];
  let html = '';

  if (status.differenceHours !== null &&
      status.differenceHours !== undefined) {
    html += `
      <div class="warning-note">
        最新與最舊資料相差 ${escapeHtml(formatNumber(status.differenceHours))} 小時。
        判斷標準為不超過 2 小時，且所有來源資料皆有更新紀錄。
      </div>
    `;
  }

  if (!sheets.length) {
    html += '<div class="empty">尚無更新紀錄</div>';
  } else {
    sheets.forEach(function(item) {
      html += `
        <article class="detail-card">
          ${infoList([
            ['工作表', item.sheet],
            ['更新時間', item.displayTime || '尚無紀錄']
          ])}
        </article>
      `;
    });
  }

  document.getElementById('updateDetails').innerHTML = html;
  updateModal.classList.add('show');
  updateModal.setAttribute('aria-hidden', 'false');
}

function closeUpdateModal() {
  updateModal.classList.remove('show');
  updateModal.setAttribute('aria-hidden', 'true');
}

function setLoading(loading) {
  state.loading = loading;
  searchButton.disabled = loading || state.locked;
  searchButton.textContent = loading ? '查詢中…' : '查詢';
}

function requestedProductType(value) {
  const text = String(value || '')
    .trim()
    .replace(/^['’]+/, '')
    .toUpperCase();
  if (/^[A-Z]_/.test(text)) {
    return text.charAt(0);
  }
  if (/^[A-Z]\d/.test(text)) {
    return text.charAt(0);
  }
  return '';
}

// 零件卡的「複製」：商品別_件號（例如 A_5212502470；沒有商品別時只複製件號）。先用 Clipboard API；不支援或被拒時改用隱藏 textarea＋execCommand。
async function copyText(text) {
  if (!text) {
    return;
  }
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (error) {
    ok = false;
  }
  if (!ok) {
    ok = legacyCopy(text);
  }
  showToast(ok ? `已複製 ${text}` : `無法自動複製，請手動記下：${text}`);
}

function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.fontSize = '16px';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (error) {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    toast.classList.remove('show');
  }, 1800);
}

function showMessage(text, type) {
  message.textContent = text || '';
  message.className = 'message' + (type ? ' ' + type : '');
}

function formatNumber(value) {
  const number = Number(
    String(value === undefined || value === null ? 0 : value)
      .replace(/,/g, '')
  );
  if (!Number.isFinite(number)) {
    return '0';
  }
  return number.toLocaleString('zh-TW', {
    maximumFractionDigits: 2
  });
}

function stripApostrophe(value) {
  return String(value || '').replace(/^['’]+/, '');
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
