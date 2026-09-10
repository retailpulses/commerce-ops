import { TicketShareDTO } from "../types.js";
import { escapeHtml, formatFileSize } from "../utils/sanitize.js";

function esc(val: string | undefined | null): string {
  if (val == null) return "—";
  return escapeHtml(String(val));
}

function formatJst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    hour12: false,
  }).format(date);
}

function renderIssueTypes(types: string[]): string {
  if (!types || types.length === 0) return esc(null);
  return types.map((t) => `<span class="tag">${esc(t)}</span>`).join("\n");
}

function renderProducts(
  products: TicketShareDTO["products"],
): string {
  if (!products || products.length === 0) {
    return `<p class="empty">${esc(null)}</p>`;
  }

  let rows = "";
  for (const p of products) {
    rows += `<tr>
      <td>${esc(p.sku)}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.variant)}</td>
      <td>${esc(p.role)}</td>
      <td>${esc(p.seller)}</td>
      <td>${esc(p.unitPrice)}</td>
    </tr>`;
  }

  return `<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>SKU</th>
          <th>商品名</th>
          <th>バリエーション</th>
          <th>役割</th>
          <th>販売者</th>
          <th>単価</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderEvidence(
  evidence: TicketShareDTO["evidence"],
  token: string,
): string {
  if (!evidence || evidence.length === 0) {
    return `<p class="empty">—</p>`;
  }

  let items = "";
  for (const e of evidence) {
    const escapedName = esc(e.fileName);
    const sizeStr = formatFileSize(e.size);
    const viewUrl = esc(`/tickets/share/${token}/evidence/${e.attachmentId}`);
    const dlUrl = esc(
      `/tickets/share/${token}/evidence/${e.attachmentId}/download`,
    );
    const previewId = `preview-${e.attachmentId}`;
    const mimeType = e.mimeType.toLowerCase();
    const preview = mimeType.startsWith("image/")
      ? `<a href="#${previewId}" class="evidence-preview-link" aria-label="${escapedName}を拡大表示"><img src="${viewUrl}" alt="${escapedName}" class="evidence-thumbnail" loading="lazy"></a>`
      : mimeType.startsWith("video/")
        ? `<a href="#${previewId}" class="evidence-preview-link" aria-label="${escapedName}を再生"><video src="${viewUrl}" class="evidence-thumbnail" muted preload="metadata"></video></a>`
        : `<a href="${viewUrl}" class="file-preview" target="_blank" rel="noopener noreferrer">ファイル</a>`;
    const lightboxMedia = mimeType.startsWith("image/")
      ? `<img src="${viewUrl}" alt="${escapedName}">`
      : mimeType.startsWith("video/")
        ? `<video src="${viewUrl}" controls preload="metadata"></video>`
        : "";
    items += `
    <div class="evidence-item">
      ${preview}
      <div class="evidence-info">
        <span class="evidence-name">${escapedName}</span>
        <span class="evidence-size">${esc(sizeStr)}</span>
        <span class="evidence-type">${esc(e.mimeType)}</span>
      </div>
      <div class="evidence-actions">
        <a href="${viewUrl}" class="btn btn-small" target="_blank" rel="noopener noreferrer">表示</a>
        <a href="${dlUrl}" class="btn btn-small">ダウンロード</a>
      </div>
    </div>`;
    if (lightboxMedia) {
      items += `<div id="${previewId}" class="lightbox" role="dialog" aria-label="${escapedName}">
        <a href="#" class="lightbox-backdrop" aria-label="閉じる"></a>
        <div class="lightbox-content">${lightboxMedia}<a href="#" class="lightbox-close">閉じる</a></div>
      </div>`;
    }
  }

  return `<div class="evidence-list">${items}</div>`;
}

export function renderTicketPage(dto: TicketShareDTO, token: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>チケット ${esc(dto.ticketNumber)} — ${esc(dto.shopName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
      background: #f5f6f8;
      color: #1a1a2e;
      line-height: 1.6;
      -webkit-text-size-adjust: 100%;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 16px; }
    .header {
      background: #1a1a2e;
      color: #fff;
      padding: 20px 16px;
      border-radius: 8px 8px 0 0;
      margin-top: 16px;
    }
    .header h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 4px; }
    .header .ticket-number { font-size: 0.875rem; opacity: 0.85; font-family: monospace; }
    .status-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(255,255,255,0.2);
      margin-top: 8px;
    }
    .card {
      background: #fff;
      border: 1px solid #e2e4e9;
      padding: 16px;
    }
    .card + .card { border-top: none; }
    .card:last-of-type { border-radius: 0 0 8px 8px; }
    .card h2 {
      font-size: 0.875rem;
      font-weight: 700;
      color: #5a5d6e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 480px) {
      .info-grid { grid-template-columns: 1fr; }
    }
    .info-item { }
    .info-label { font-size: 0.75rem; color: #8b8fa3; margin-bottom: 2px; }
    .info-value { font-size: 0.9375rem; font-weight: 500; }
    .tag {
      display: inline-block;
      background: #eef0f4;
      color: #4a4d5c;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8125rem;
      margin: 2px 4px 2px 0;
    }
    .table-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }
    th, td {
      padding: 8px 6px;
      text-align: left;
      border-bottom: 1px solid #e2e4e9;
      white-space: nowrap;
    }
    th { font-weight: 600; color: #5a5d6e; background: #f8f9fb; }
    .description { font-size: 0.9375rem; white-space: pre-wrap; word-break: break-word; }
    .empty { color: #8b8fa3; font-style: italic; }
    .evidence-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid #e2e4e9;
      flex-wrap: wrap;
      gap: 8px;
    }
    .evidence-preview-link, .file-preview {
      width: 88px;
      height: 66px;
      flex: 0 0 auto;
      border-radius: 6px;
      overflow: hidden;
      background: #eef0f4;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #4a4d5c;
      text-decoration: none;
      font-size: 0.75rem;
    }
    .evidence-thumbnail { width: 100%; height: 100%; object-fit: cover; }
    .evidence-item:last-child { border-bottom: none; }
    .evidence-info { display: flex; flex: 1 1 180px; flex-wrap: wrap; gap: 8px; align-items: baseline; }
    .evidence-name { font-weight: 500; }
    .evidence-size, .evidence-type { font-size: 0.75rem; color: #8b8fa3; }
    .evidence-actions { display: flex; gap: 8px; }
    .btn {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.8125rem;
      font-weight: 600;
      border: 1px solid transparent;
      cursor: pointer;
    }
    .btn-small { padding: 4px 10px; font-size: 0.75rem; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover { background: #2d2d4a; }
    .btn-outline { border-color: #c4c7d0; color: #4a4d5c; }
    .btn-outline:hover { background: #f5f6f8; }
    .lightbox { display: none; position: fixed; inset: 0; z-index: 100; padding: 24px; align-items: center; justify-content: center; }
    .lightbox:target { display: flex; }
    .lightbox-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.84); }
    .lightbox-content { position: relative; z-index: 1; max-width: min(960px, 95vw); max-height: 92vh; display: flex; flex-direction: column; gap: 12px; align-items: center; }
    .lightbox-content img, .lightbox-content video { max-width: 100%; max-height: 82vh; object-fit: contain; background: #000; }
    .lightbox-close { color: #fff; font-weight: 700; padding: 6px 14px; border: 1px solid #fff; border-radius: 6px; text-decoration: none; }
    .footer {
      text-align: center;
      padding: 24px 16px;
      font-size: 0.75rem;
      color: #8b8fa3;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="ticket-number">チケット番号</div>
      <h1>${esc(dto.ticketNumber)}</h1>
      <span class="status-badge">${esc(dto.status)}</span>
    </div>

    <div class="card">
      <h2>基本情報</h2>
      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">プラットフォーム</div>
          <div class="info-value">${esc(dto.platform)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">ショップ / アカウント</div>
          <div class="info-value">${esc(dto.shopName)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">外部注文ID</div>
          <div class="info-value">${esc(dto.externalOrderId)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">優先度</div>
          <div class="info-value">${esc(dto.priority)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">開始日</div>
          <div class="info-value">${esc(formatJst(dto.startedDate))}</div>
        </div>
        <div class="info-item">
          <div class="info-label">有効期限</div>
          <div class="info-value">${esc(formatJst(dto.expiry))}</div>
        </div>
      </div>
      <div class="info-item" style="margin-top:12px;">
        <div class="info-label">問題種別</div>
        <div class="info-value">${renderIssueTypes(dto.issueTypes)}</div>
      </div>
    </div>

    <div class="card">
      <h2>商品</h2>
      ${renderProducts(dto.products)}
    </div>

    <div class="card">
      <h2>販売者説明</h2>
      <div class="description">${esc(dto.sellerDescription)}</div>
    </div>

    <div class="card">
      <h2>証拠</h2>
      ${renderEvidence(dto.evidence, token)}
    </div>

    <div class="footer">
      この共有リンクの有効期限: ${esc(formatJst(dto.expiry))}
    </div>
  </div>
</body>
</html>`;
}

export function renderErrorPage(
  statusCode: number,
  message: string,
): string {
  const jpMessages: Record<number, string> = {
    400: "リクエストが無効です",
    404: "お探しのページは見つかりませんでした",
    410: "この共有リンクは期限切れです",
    429: "リクエストが多すぎます。しばらく待ってから再試行してください",
    500: "サーバーエラーが発生しました",
    502: "サービスは一時的に利用できません",
    503: "サービスは一時的に利用できません",
  };

  const jpMsg = jpMessages[statusCode] || message;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>${statusCode} — ${escapeHtml(jpMsg)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
      background: #f5f6f8;
      color: #1a1a2e;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
      padding: 24px;
    }
    .error-code { font-size: 3rem; font-weight: 700; color: #c4c7d0; }
    .error-message { font-size: 1.125rem; margin-top: 8px; color: #5a5d6e; }
  </style>
</head>
<body>
  <div>
    <div class="error-code">${statusCode}</div>
    <div class="error-message">${escapeHtml(jpMsg)}</div>
  </div>
</body>
</html>`;
}
