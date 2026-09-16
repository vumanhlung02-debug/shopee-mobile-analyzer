(function () {
  'use strict';

  const APP_ID = 'scm-mobile-analyzer';
  const API_ORIGIN = 'https://affiliate.shopee.vn';
  const PAGE_SIZE = 100;
  const MAX_API_PAGES = 20;
  const MIN_SPLIT_SECONDS = 60 * 60;
  const SUPPORTED_HOST_RE = /(^|\.)affiliate\.shopee\.vn$/i;
  const state = {
    days: 7,
    orders: [],
    clicks: [],
    loading: false,
    error: '',
  };

  if (window.__SCM_MOBILE_ANALYZER_LOADED__) {
    const existing = document.getElementById(APP_ID);
    if (existing) existing.remove();
  }
  window.__SCM_MOBILE_ANALYZER_LOADED__ = true;

  const money = (value) =>
    new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
      maximumFractionDigits: 0,
    }).format(Number(value) || 0);

  const intFmt = (value) => (Number(value) || 0).toLocaleString('vi-VN');
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));

  function toTs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value > 946684800000 ? value : value * 1000;
    const raw = String(value).trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) {
      const num = Number(raw);
      return num > 946684800000 ? num : num * 1000;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function numberValue(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    let raw = String(value).replace(/₫|đ|VND|\s/g, '');
    if (raw.includes(',') && raw.includes('.')) {
      raw = raw.lastIndexOf(',') > raw.lastIndexOf('.')
        ? raw.replace(/\./g, '').replace(',', '.')
        : raw.replace(/,/g, '');
    } else if ((raw.match(/,/g) || []).length === 1 && /,\d{1,2}$/.test(raw)) {
      raw = raw.replace(',', '.');
    } else {
      raw = raw.replace(/[,.](?=\d{3}(\D|$))/g, '');
    }
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeMoney(value) {
    const num = numberValue(value);
    if (num >= 100000) return num / 100000;
    if (num > 1000) return num / 100;
    return num;
  }

  function firstValue(source, keys) {
    for (const key of keys) {
      if (source && source[key] !== undefined && source[key] !== null && String(source[key]).trim() !== '') {
        return source[key];
      }
    }
    return '';
  }

  function cleanSub(value) {
    const text = String(value || '').trim();
    return text || '----';
  }

  function splitSub(value) {
    const sub = cleanSub(value);
    if (sub === '----') return ['', '', '', '', ''];
    const parts = sub.split('-');
    return [parts[0] || '', parts[1] || '', parts[2] || '', parts[3] || '', parts[4] || ''];
  }

  function joinSub(parts) {
    return cleanSub([parts.sub_id1, parts.sub_id2, parts.sub_id3, parts.sub_id4, parts.sub_id5].map((x) => String(x || '').trim()).join('-'));
  }

  function isCancelled(status) {
    const text = String(status || '').toUpperCase();
    return text === '3' || text.includes('CANCEL') || text.includes('HỦY') || text.includes('HUY');
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dayLabel(key) {
    const parts = key.split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}` : key;
  }

  function buildRange(days) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - (Math.max(1, days) - 1));
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      startSec: Math.floor(start.getTime() / 1000),
      endSec: Math.floor(end.getTime() / 1000),
    };
  }

  function isSupportedPage() {
    return SUPPORTED_HOST_RE.test(location.hostname);
  }

  async function fetchJson(path) {
    if (!isSupportedPage()) {
      throw new Error('Hãy mở trang affiliate.shopee.vn, đăng nhập Shopee Affiliate, rồi chạy bookmarklet tại chính trang đó.');
    }
    const response = await fetch(`${API_ORIGIN}${path}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Chưa đăng nhập Shopee Affiliate hoặc phiên đăng nhập đã hết hạn.');
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (_) {
        detail = '';
      }
      throw new Error(`Shopee trả lỗi HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    let json;
    try {
      json = await response.json();
    } catch (_) {
      throw new Error('Shopee trả dữ liệu không phải JSON. Hãy tải lại trang Shopee Affiliate rồi chạy lại.');
    }
    if (json && json.code !== undefined && json.code !== 0) {
      throw new Error(json.msg || json.message || `Shopee trả lỗi code ${json.code}`);
    }
    return json;
  }

  function extractList(payload) {
    const data = payload && payload.data ? payload.data : payload || {};
    return data.list || data.data || data.rows || data.items || [];
  }

  function extractTotal(payload, fallback) {
    const data = payload && payload.data ? payload.data : payload || {};
    return Number(data.total_count || data.total || data.count || fallback || 0) || 0;
  }

  async function fetchPaged(pathBuilder, label) {
    const all = [];
    let total = Infinity;
    for (let page = 1; page <= MAX_API_PAGES && (page - 1) * PAGE_SIZE < total; page++) {
      setStatus(`Đang tải ${label} trang ${page}...`);
      const payload = await fetchJson(pathBuilder(page));
      const list = extractList(payload);
      total = extractTotal(payload, list.length);
      all.push(...list);
      if (!list.length || list.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return {
      items: all,
      total,
      hitPageLimit: all.length < total && all.length >= PAGE_SIZE * MAX_API_PAGES,
    };
  }

  async function fetchWindowed(range, pathBuilder, label, depth = 0) {
    const result = await fetchPaged((page) => pathBuilder(page, range), label);
    const span = range.endSec - range.startSec;
    if (result.hitPageLimit && span > MIN_SPLIT_SECONDS && depth < 12) {
      const midSec = Math.floor((range.startSec + range.endSec) / 2);
      const left = await fetchWindowed({ startSec: range.startSec, endSec: midSec }, pathBuilder, `${label} A`, depth + 1);
      const right = await fetchWindowed({ startSec: midSec + 1, endSec: range.endSec }, pathBuilder, `${label} B`, depth + 1);
      return left.concat(right);
    }
    return result.items;
  }

  function normalizeOrderContainer(container, index) {
    const orders = Array.isArray(container.orders)
      ? container.orders
      : Array.isArray(container.items)
        ? [container]
        : [];
    const rows = [];
    orders.forEach((order, orderIndex) => {
      const items = Array.isArray(order.items) ? order.items : [];
      const context = { ...container, ...order };
      const rawSub = firstValue(context, ['utm_content', 'sub_id', 'SubID', 'subId']);
      let subParts;
      if (rawSub && String(rawSub).includes('-')) {
        const p = splitSub(rawSub);
        subParts = { sub_id1: p[0], sub_id2: p[1], sub_id3: p[2], sub_id4: p[3], sub_id5: p[4] };
      } else {
        subParts = {
          sub_id1: rawSub || '',
          sub_id2: firstValue(context, ['click_id', 'clickId']),
          sub_id3: firstValue(context, ['product_type']),
          sub_id4: firstValue(context, ['internal_source']),
          sub_id5: firstValue(context, ['indirect_source']),
        };
      }
      const gmvDirect = numberValue(firstValue(context, ['gmv', 'order_gmv', 'actual_order_value', 'order_value']));
      const itemGmv = items.reduce((sum, item) => sum + numberValue(firstValue(item, ['actual_amount', 'order_value', 'item_gmv', 'item_price'])), 0);
      const directCommission = firstValue(context, [
        'estimated_total_commission_with_mcn',
        'affiliate_net_commission',
        'estimated_total_commission',
        'total_commission',
        'commission_amount',
        'payout_amount',
      ]);
      const itemCommission = items.reduce((sum, item) => sum + normalizeMoney(item.item_commission) + normalizeMoney(item.capped_brand_commission), 0);
      const statusRaw = String(firstValue(context, ['display_order_status', 'order_status', 'shopee_order_status', 'conversion_status', 'status']));
      rows.push({
        id: firstValue(context, ['order_sn', 'order_id', 'orderId', 'checkout_id']) || `${index}-${orderIndex}`,
        subId: joinSub(subParts),
        subParts,
        purchaseTs: toTs(firstValue(context, ['purchase_time', 'order_time', 'created_at', 'checkout_complete_time'])),
        gmv: gmvDirect > 100000 ? gmvDirect / 100000 : gmvDirect || (itemGmv > 100000 ? itemGmv / 100000 : itemGmv),
        commission: normalizeMoney(directCommission) || itemCommission,
        cancelled: isCancelled(statusRaw),
        status: isCancelled(statusRaw) ? 'Đã hủy' : (statusRaw || 'Không rõ'),
        product: firstValue(items[0] || context, ['item_name', 'name', 'product_name']) || '',
      });
    });
    return rows;
  }

  function normalizeClick(row) {
    return {
      clickId: firstValue(row, ['click_id', 'Click ID', 'clickId']) || '',
      subId: cleanSub(firstValue(row, ['sub_id', 'SubID', 'subId', 'utm_content'])),
      clickTs: toTs(firstValue(row, ['click_time', 'click_time_ts', 'time', 'Click Time'])),
    };
  }

  async function loadData() {
    state.loading = true;
    state.error = '';
    render();
    try {
      const range = buildRange(state.days);
      const orderRaw = await fetchWindowed(
        range,
        (page, part) => `/api/v3/report/list?page_size=${PAGE_SIZE}&page_num=${page}&purchase_time_s=${part.startSec}&purchase_time_e=${part.endSec}&version=1`,
        'chuyển đổi',
      );
      const clickRaw = await fetchWindowed(
        range,
        (page, part) => `/api/v1/click_report/list?click_time_s=${part.startSec}&click_time_e=${part.endSec}&page_num=${page}&page_size=${PAGE_SIZE}`,
        'click',
      );
      state.orders = orderRaw.flatMap(normalizeOrderContainer).filter((order) => order.purchaseTs);
      state.clicks = clickRaw.map(normalizeClick).filter((click) => click.clickTs);
      state.loading = false;
      setStatus(`Đã tải ${intFmt(state.orders.length)} đơn và ${intFmt(state.clicks.length)} click.`);
      render();
    } catch (error) {
      state.loading = false;
      state.error = error.message || String(error);
      render();
    }
  }

  function summarize() {
    const bySub = new Map();
    const byDay = new Map();
    const days = [];
    const range = buildRange(state.days);
    for (let ts = range.start.getTime(); ts <= range.end.getTime(); ts += 86400000) {
      const key = dayKey(ts);
      days.push(key);
      byDay.set(key, { day: key, orders: 0, clicks: 0, gmv: 0, commission: 0, cancelled: 0 });
    }

    state.orders.forEach((order) => {
      const sub = order.subId;
      if (!bySub.has(sub)) bySub.set(sub, { subId: sub, orders: 0, clicks: 0, gmv: 0, commission: 0, cancelled: 0 });
      const target = bySub.get(sub);
      target.orders += 1;
      target.gmv += order.gmv || 0;
      target.commission += order.commission || 0;
      if (order.cancelled) target.cancelled += 1;
      const d = byDay.get(dayKey(order.purchaseTs));
      if (d) {
        d.orders += 1;
        d.gmv += order.gmv || 0;
        d.commission += order.commission || 0;
        if (order.cancelled) d.cancelled += 1;
      }
    });

    state.clicks.forEach((click) => {
      const sub = click.subId;
      if (!bySub.has(sub)) bySub.set(sub, { subId: sub, orders: 0, clicks: 0, gmv: 0, commission: 0, cancelled: 0 });
      bySub.get(sub).clicks += 1;
      const d = byDay.get(dayKey(click.clickTs));
      if (d) d.clicks += 1;
    });

    const subRows = [...bySub.values()].sort((a, b) => (b.commission - a.commission) || (b.orders - a.orders) || (b.clicks - a.clicks));
    const dayRows = days.map((key) => byDay.get(key));
    const total = subRows.reduce((sum, row) => {
      sum.orders += row.orders;
      sum.clicks += row.clicks;
      sum.cancelled += row.cancelled;
      sum.gmv += row.gmv;
      sum.commission += row.commission;
      return sum;
    }, { orders: 0, clicks: 0, cancelled: 0, gmv: 0, commission: 0 });
    return { total, subRows, dayRows };
  }

  function rangeText() {
    const range = buildRange(state.days);
    const format = (date) => `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    return `${format(range.start)} - ${format(range.end)}`;
  }

  function lastLoadText() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function metricCard(label, value, tone, subText) {
    return `
      <div class="scm-metric ${tone || 'orange'}">
        <div class="scm-metric-label">${esc(label)}</div>
        <div class="scm-metric-value">${esc(value)}</div>
        ${subText ? `<div class="scm-metric-sub">${esc(subText)}</div>` : ''}
      </div>
    `;
  }

  function styles() {
    return `
      #${APP_ID}{position:fixed;inset:16px 10px 10px 10px;z-index:2147483647;font-family:Arial,"Segoe UI",sans-serif;color:#f8fafc}
      #${APP_ID} *{box-sizing:border-box}
      #${APP_ID} .scm-panel{background:#191511;border:1px solid #3a2d25;border-radius:18px;box-shadow:0 18px 54px rgba(0,0,0,.45);overflow:hidden;max-height:calc(100vh - 26px);display:flex;flex-direction:column}
      #${APP_ID} .scm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:#1d1814;border-bottom:1px solid #332821}
      #${APP_ID} .scm-brand{display:flex;align-items:center;gap:9px;min-width:0}
      #${APP_ID} .scm-dot{width:10px;height:10px;border-radius:50%;background:#ff7625;box-shadow:0 0 12px rgba(255,118,37,.65);flex:0 0 auto}
      #${APP_ID} .scm-title{font-size:17px;font-weight:800;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${APP_ID} .scm-pill{border:1px solid #3b2e27;background:#211b17;border-radius:8px;color:#bdb5ad;padding:4px 8px;font-size:12px}
      #${APP_ID} .scm-head-actions{display:flex;gap:8px;flex:0 0 auto}
      #${APP_ID} .scm-icon{border:1px solid #3b2e27;background:#211b17;color:#d8d2cc;border-radius:10px;width:36px;height:34px;font-size:20px;line-height:1}
      #${APP_ID} .scm-body{padding:0 12px 12px;overflow:auto;background:#17130f}
      #${APP_ID} .scm-nav{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0 -12px 12px;border-bottom:1px solid #332821;background:#1c1713}
      #${APP_ID} .scm-tab{border:0;border-bottom:3px solid transparent;background:transparent;color:#8f8780;padding:12px 4px 10px;font-size:16px;font-weight:800}
      #${APP_ID} .scm-tab.active{color:#ff7a28;border-color:#ff7a28}
      #${APP_ID} .scm-note{border:1px solid #3c2f27;border-left:5px solid #ff7a28;background:#1d1814;border-radius:12px;padding:12px 12px;margin-bottom:12px;color:#eee4dc;font-size:14px;line-height:1.42}
      #${APP_ID} .scm-status{border:1px solid #31442f;border-left:5px solid #20b056;background:#1b2119;border-radius:12px;padding:10px 12px;margin-bottom:12px;color:#a8e8b2;font-size:15px;font-weight:800}
      #${APP_ID} .scm-status small{display:block;color:#92c99b;font-weight:500;margin-top:4px}
      #${APP_ID} .scm-error{background:#331b1b;color:#ffd0d0;border:1px solid #6a2b2b;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:14px}
      #${APP_ID} .scm-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
      #${APP_ID} select,#${APP_ID} button{font:inherit}
      #${APP_ID} select{width:100%;border:1px solid #3d352f;background:#120f0d;color:#f4eee8;border-radius:10px;padding:10px 12px;font-size:15px}
      #${APP_ID} .scm-actions{display:grid;grid-template-columns:1.2fr .7fr .65fr;gap:8px;margin-bottom:12px}
      #${APP_ID} .scm-load{border:0;background:#ff691d;color:#fff;border-radius:10px;padding:11px 8px;font-weight:900;font-size:15px}
      #${APP_ID} .scm-copy{border:0;background:#2b241e;color:#f7eee6;border-radius:10px;padding:11px 8px;font-weight:800;font-size:14px}
      #${APP_ID} .scm-prev{border:1px solid #ff7a28;background:#201711;color:#ff9a5f;border-radius:10px;padding:10px 8px;font-weight:800;font-size:14px}
      #${APP_ID} .scm-range{text-align:center;color:#ded6ce;font-weight:800;font-size:15px;margin:4px 0 12px}
      #${APP_ID} .scm-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px}
      #${APP_ID} .scm-metric{min-height:78px;border-radius:12px;padding:10px 8px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
      #${APP_ID} .scm-metric-label{font-size:13px;font-weight:800;opacity:.9;margin-bottom:6px}
      #${APP_ID} .scm-metric-value{font-size:21px;font-weight:900;line-height:1.05;word-break:break-word}
      #${APP_ID} .scm-metric-sub{font-size:12px;opacity:.82;margin-top:5px}
      #${APP_ID} .orange{background:linear-gradient(180deg,#ff8a14,#fb6518)}
      #${APP_ID} .green{background:linear-gradient(180deg,#1fac55,#169245)}
      #${APP_ID} .blue{background:linear-gradient(180deg,#458cf5,#3579e8)}
      #${APP_ID} .teal{background:linear-gradient(180deg,#25b7b0,#1d9c98)}
      #${APP_ID} .pink{background:linear-gradient(180deg,#ed4aa5,#df3996)}
      #${APP_ID} .cyan{background:linear-gradient(180deg,#25bdd3,#1da6bb)}
      #${APP_ID} .yellow{background:linear-gradient(180deg,#ffe749,#ffd62e);color:#453b12}
      #${APP_ID} .scm-table-tabs{display:flex;gap:8px;margin:10px 0 0}
      #${APP_ID} .scm-table-tab{border:1px solid #3d352f;background:#211b17;color:#d9d1ca;border-radius:9px;padding:8px 10px;font-weight:800}
      #${APP_ID} .scm-table-tab.active{background:#ff7625;color:#fff;border-color:#ff7625}
      #${APP_ID} .scm-table-wrap{overflow:auto;border:1px solid #312822;border-radius:12px;margin-top:8px;max-height:260px}
      #${APP_ID} table{width:100%;border-collapse:collapse;font-size:12px;background:#17130f}
      #${APP_ID} th,#${APP_ID} td{border-bottom:1px solid #302720;padding:8px;text-align:left;white-space:nowrap;color:#eee4dc}
      #${APP_ID} th{background:#211b17;position:sticky;top:0;color:#ffb17f;z-index:1}
      #${APP_ID} code{color:#ff83b5}
      #${APP_ID} .scm-view{display:block}
      #${APP_ID} .scm-placeholder{border:1px dashed #4a3c33;border-radius:14px;padding:18px;color:#cfc6be;background:#1b1612;line-height:1.45}
      #${APP_ID} .scm-foot{display:flex;justify-content:space-between;border-top:1px solid #332821;color:#8f8780;padding:10px 14px;background:#1d1814;font-size:12px}
      #${APP_ID} .scm-hidden{display:none}
      @media (min-width:720px){#${APP_ID}{left:auto;width:520px;right:18px;top:18px;bottom:18px}}
      @media (max-width:390px){
        #${APP_ID}{inset:8px 6px 8px 6px}
        #${APP_ID} .scm-title{font-size:15px}
        #${APP_ID} .scm-metric-value{font-size:18px}
        #${APP_ID} .scm-actions{grid-template-columns:1fr}
      }
    `;
  }

  function render() {
    let root = document.getElementById(APP_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = APP_ID;
      (document.body || document.documentElement).appendChild(root);
    }
    const { total, subRows, dayRows } = summarize();
    const acceptedCommission = total.commission * 0.9902;
    const avgOrder = total.orders ? total.gmv / total.orders : 0;
    const commissionPerClick = total.clicks ? total.commission / total.clicks : 0;
    const statusText = state.orders.length || state.clicks.length
      ? `Đã tải ${intFmt(state.orders.length)} chuyển đổi`
      : 'Chưa tải báo cáo';
    const statusTime = state.orders.length || state.clicks.length ? `Lúc ${lastLoadText()}` : 'Bấm Tải báo cáo để lấy dữ liệu';
    const wrongPageWarning = !isSupportedPage()
      ? '<div class="scm-error">Bạn đang không ở trang affiliate.shopee.vn. Mở Shopee Affiliate, đăng nhập, rồi bấm bookmarklet lại.</div>'
      : '';
    root.innerHTML = `
      <style>${styles()}</style>
      <div class="scm-panel">
        <div class="scm-head">
          <div class="scm-brand">
            <span class="scm-dot"></span>
            <div class="scm-title">Thống kê Shopee</div>
            <span class="scm-pill">affiliate</span>
          </div>
          <div class="scm-head-actions">
            <button class="scm-icon" type="button" title="Trợ giúp">?</button>
            <button class="scm-icon" type="button" title="Giao diện">☀</button>
            <button class="scm-icon scm-close" id="scmClose" type="button" title="Đóng">×</button>
          </div>
        </div>
        <div class="scm-body">
          <div class="scm-nav">
            <button class="scm-tab active" data-view="report" type="button">Báo cáo</button>
            <button class="scm-tab" data-view="links" type="button">Chuyển link</button>
            <button class="scm-tab" data-view="settings" type="button">Cấu hình</button>
          </div>
          <div id="scmViewReport" class="scm-view">
            <div class="scm-note">"Thực nhận" là tiền sau khi trừ phí MCN và phí dịch vụ 0,98%. Đơn Shopee đánh dấu hủy / không hợp lệ đã bị loại khỏi số liệu hoa hồng. Muốn xem 7 hoặc 30 ngày: chọn bên trái rồi bấm Tải báo cáo.</div>
            ${wrongPageWarning}
            <div class="scm-status" id="scmStatus">${state.loading ? 'Đang gọi API Shopee Affiliate...' : esc(statusText)}<small>${esc(state.loading ? 'Vui lòng giữ trang này mở trong lúc tải.' : statusTime)}</small></div>
            ${state.error ? `<div class="scm-error">${esc(state.error)}</div>` : ''}
            <div class="scm-controls">
              <select id="scmDays" aria-label="Khoảng thời gian">
                <option value="1"${state.days === 1 ? ' selected' : ''}>Hôm nay</option>
                <option value="2"${state.days === 2 ? ' selected' : ''}>Hôm qua + hôm nay</option>
                <option value="7"${state.days === 7 ? ' selected' : ''}>7 ngày gần nhất</option>
                <option value="14"${state.days === 14 ? ' selected' : ''}>14 ngày gần nhất</option>
                <option value="30"${state.days === 30 ? ' selected' : ''}>30 ngày gần nhất</option>
                <option value="90"${state.days === 90 ? ' selected' : ''}>90 ngày gần nhất</option>
              </select>
              <select aria-label="Lọc Sub ID">
                <option>Tất cả Sub ID</option>
                ${subRows.slice(0, 80).map((row) => `<option>${esc(row.subId)}</option>`).join('')}
              </select>
            </div>
            <div class="scm-actions">
              <button class="scm-load" id="scmLoad" type="button">${state.loading ? 'Đang tải...' : 'Tải báo cáo'}</button>
              <button class="scm-copy" id="scmCopy" type="button">Chép tóm tắt</button>
              <button class="scm-prev" type="button">So kỳ trước</button>
            </div>
            <div class="scm-range">Ngày: ${esc(rangeText())}</div>
            <div class="scm-metrics">
              ${metricCard('Tổng GMV', money(total.gmv), 'orange', total.gmv ? '▲ so kỳ trước' : '')}
              ${metricCard('Tổng hoa hồng', money(total.commission), 'orange', total.commission ? '▲ so kỳ trước' : '')}
              ${metricCard('Thực nhận', money(acceptedCommission), 'green', 'đã trừ phí 0,98%')}
              ${metricCard('Đơn hàng', intFmt(total.orders), 'orange', total.orders ? '▲ so kỳ trước' : '')}
              ${metricCard('Giá trị TB/đơn', money(avgOrder), 'orange')}
              ${metricCard('Lượt click', intFmt(total.clicks), 'blue')}
              ${metricCard('Hoa hồng/click', money(commissionPerClick), 'teal')}
              ${metricCard('Đơn video', '0', 'pink', '0đ')}
              ${metricCard('Đơn live', '0', 'cyan', '0đ')}
              ${metricCard('Đơn MXH', intFmt(total.orders), 'yellow', money(total.commission))}
            </div>
            <div class="scm-table-tabs">
              <button class="scm-table-tab active" data-tab="sub" type="button">Theo SubID</button>
              <button class="scm-table-tab" data-tab="day" type="button">Theo ngày</button>
            </div>
            <div id="scmTabSub" class="scm-table-wrap">
              <table>
                <thead><tr><th>SubID</th><th>Click</th><th>Đơn</th><th>HH</th><th>GMV</th><th>Hủy</th></tr></thead>
                <tbody>${subRows.length ? subRows.slice(0, 80).map((row) => `<tr><td><code>${esc(row.subId)}</code></td><td>${intFmt(row.clicks)}</td><td>${intFmt(row.orders)}</td><td>${money(row.commission)}</td><td>${money(row.gmv)}</td><td>${intFmt(row.cancelled)}</td></tr>`).join('') : '<tr><td colspan="6">Chưa có dữ liệu</td></tr>'}</tbody>
              </table>
            </div>
            <div id="scmTabDay" class="scm-table-wrap scm-hidden">
              <table>
                <thead><tr><th>Ngày</th><th>Click</th><th>Đơn</th><th>HH</th><th>GMV</th><th>Hủy</th></tr></thead>
                <tbody>${dayRows.map((row) => `<tr><td>${dayLabel(row.day)}</td><td>${intFmt(row.clicks)}</td><td>${intFmt(row.orders)}</td><td>${money(row.commission)}</td><td>${money(row.gmv)}</td><td>${intFmt(row.cancelled)}</td></tr>`).join('')}</tbody>
              </table>
            </div>
          </div>
          <div id="scmViewLinks" class="scm-view scm-hidden">
            <div class="scm-placeholder">Mục chuyển link sẽ đặt tại đây. Phiên bản này tập trung vào báo cáo hoa hồng/click trên mobile.</div>
          </div>
          <div id="scmViewSettings" class="scm-view scm-hidden">
            <div class="scm-placeholder">Cấu hình sẽ đặt tại đây. Dữ liệu hiện chỉ xử lý trên trình duyệt và không gửi ra ngoài.</div>
          </div>
        </div>
        <div class="scm-foot"><span>© Addlivetag</span><span>v0.13.0</span></div>
      </div>
    `;
    bindPanelEvents(root);
  }

  function setStatus(text) {
    const el = document.querySelector(`#${APP_ID} #scmStatus`);
    if (el) el.textContent = text;
  }

  function bindPanelEvents(root) {
    const close = root.querySelector('#scmClose');
    if (close) close.onclick = () => root.remove();
    const days = root.querySelector('#scmDays');
    if (days) days.onchange = () => {
      const value = Math.max(1, Math.min(90, parseInt(days.value, 10) || 7));
      state.days = value;
      days.value = value;
      render();
    };
    const load = root.querySelector('#scmLoad');
    if (load && !state.loading) load.onclick = loadData;
    const copy = root.querySelector('#scmCopy');
    if (copy) copy.onclick = async () => {
      const { total } = summarize();
      const text = `Shopee Affiliate ${rangeText()}\nGMV: ${money(total.gmv)}\nHoa hồng: ${money(total.commission)}\nĐơn: ${intFmt(total.orders)}\nClick: ${intFmt(total.clicks)}`;
      try {
        await navigator.clipboard.writeText(text);
        setStatus('Đã chép tóm tắt vào clipboard.');
      } catch (_) {
        setStatus(text);
      }
    };
    root.querySelectorAll('.scm-tab').forEach((tab) => {
      tab.onclick = () => {
        const target = tab.dataset.view;
        root.querySelectorAll('.scm-tab').forEach((x) => x.classList.remove('active'));
        tab.classList.add('active');
        root.querySelector('#scmViewReport').classList.toggle('scm-hidden', target !== 'report');
        root.querySelector('#scmViewLinks').classList.toggle('scm-hidden', target !== 'links');
        root.querySelector('#scmViewSettings').classList.toggle('scm-hidden', target !== 'settings');
      };
    });
    root.querySelectorAll('.scm-table-tab').forEach((tab) => {
      tab.onclick = () => {
        root.querySelectorAll('.scm-table-tab').forEach((x) => x.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        root.querySelector('#scmTabSub').classList.toggle('scm-hidden', target !== 'sub');
        root.querySelector('#scmTabDay').classList.toggle('scm-hidden', target !== 'day');
      };
    });
  }

  render();
})();
