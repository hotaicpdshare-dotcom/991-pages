const state = {
  updateStatus: null,
  requestId: 0,
  submittedKeyword: '',
  loading: false,
  partData: null,
  found: false,
  activeProductType: '',
  activeVersion: null
};

const form = document.getElementById('searchForm');
const keywordInput = document.getElementById('keyword');
const searchButton = document.getElementById('searchButton');
const message = document.getElementById('message');
const result = document.getElementById('result');
const updateButton = document.getElementById('updateButton');
const updateModal = document.getElementById('updateModal');
const modalClose = document.getElementById('modalClose');

form.addEventListener('submit', function(event) {
  event.preventDefault();
  runSearch();
});

keywordInput.addEventListener('input', function() {
  this.value = this.value.toUpperCase();
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

initializeDirectSearch();

async function initializeDirectSearch() {
  try {
    await loadUpdateStatus();
  } catch (error) {
    renderUpdateStatus({
      status: 'unknown',
      label: '資料尚未發布',
      latestDisplay: '尚未更新',
      sheets: []
    });
    showMessage(errorMessage(error), 'error');
  }
}

async function runSearch() {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    showMessage('請輸入台車號或零件號碼', 'error');
    keywordInput.focus();
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
    renderResult(data);
  } catch (error) {
    if (requestId !== state.requestId) {
      return;
    }
    setLoading(false);
    showMessage(errorMessage(error), 'error');
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
  state.activeVersion = active;
  state.updateStatus = active.updateStatus || {
    status: 'unknown',
    label: '狀態未知',
    latestDisplay: '未知',
    sheets: []
  };
  renderUpdateStatus(state.updateStatus);
  return active;
}

async function readPrecomputedResult(keyword) {
  const active = state.activeVersion || await loadUpdateStatus();
  const normalized = normalizeLookupKey(keyword);
  const lookupHash = await sha256Hex(normalized);
  const releaseBase =
    `data/releases/${encodeURIComponent(active.version)}`;
  const lookupResponse = await fetch(
    `${releaseBase}/lookup/${lookupHash.slice(0, 2)}.json`,
    { cache: 'force-cache' }
  );
  if (lookupResponse.status === 404) {
    return buildNotFoundResult(keyword, normalized);
  }
  if (!lookupResponse.ok) {
    throw new Error(`索引讀取失敗：HTTP ${lookupResponse.status}`);
  }
  const lookupBucket = await lookupResponse.json();
  const recordId = String(lookupBucket[lookupHash] || '');

  if (!recordId) {
    return buildNotFoundResult(keyword, normalized);
  }
  if (!/^[a-f0-9]{64}$/.test(recordId)) {
    throw new Error('查詢索引內容異常');
  }
  const resultResponse = await fetch(
    `${releaseBase}/records/${recordId.slice(0, 2)}.json`,
    { cache: 'force-cache' }
  );
  if (!resultResponse.ok) {
    throw new Error('查詢結果不存在，請稍後再試');
  }
  const resultBucket = await resultResponse.json();
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

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
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

  let html = `
    <article class="hero-card">
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
  searchButton.disabled = loading;
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
