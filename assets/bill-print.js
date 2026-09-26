/* Sulthan's — the printed bill.
   A thermal printer is a browser print job with a page box a few centimetres
   wide, no margins to speak of, and one font. So the receipt is built as its
   own little document and printed from a hidden iframe: printing the counter
   screen itself would carry the app's dark ground, its web fonts and its
   layout into a roll of 58mm paper.

   Widths are set once per device and remembered, because a device is wired to
   one printer and staff should not be choosing paper sizes mid-rush. 'share'
   skips paper entirely and hands the same bill to WhatsApp as text, which is
   what parcel customers ask for. */
(function () {
  const KEY = 'sul.counter.print.v1';
  const BOX = {
    '80mm': { page: '80mm auto', pad: '2mm 3mm', body: 11, head: 15, mono: 10.5 },
    '58mm': { page: '58mm auto', pad: '1.5mm 2mm', body: 9.5, head: 12.5, mono: 9 },
    'a5':   { page: 'A5', pad: '12mm 14mm', body: 12, head: 20, mono: 11.5 },
  };

  const width = () => {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  };
  const setWidth = w => {
    try { localStorage.setItem(KEY, w); } catch (e) {}
  };

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = n => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const when = t => new Date(t || Date.now()).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  /* bill:  the row bill_print returned (no, total, cgst, lines, …)
     house: the restaurant row — name, address, phone, gstin, fssai, footer
     meta:  {table, staff, mode, split, payments, copy, guest, mobile} */
  function receiptHtml(bill, house, meta, size) {
    const b = BOX[size] || BOX['80mm'];
    const h = house || {}, m = meta || {};
    const narrow = size === '58mm';
    const lines = (bill.lines || []).map(l => {
      const net = (Number(l.amount) || 0) - (Number(l.discount) || 0);
      return `<tr>
        <td style="padding:1px 0;vertical-align:top">${esc(l.name)}${
          Number(l.discount) ? `<div style="font-size:${b.mono - 1.5}px;opacity:.75">less ${money(l.discount)}</div>` : ''}</td>
        <td style="padding:1px 0;text-align:center;white-space:nowrap">${l.qty}</td>
        ${narrow ? '' : `<td style="padding:1px 0;text-align:right;white-space:nowrap">${money(l.price)}</td>`}
        <td style="padding:1px 0;text-align:right;white-space:nowrap">${money(net)}</td>
      </tr>`;
    }).join('');

    const row = (label, value, bold) => `<tr>
      <td style="padding:1px 0${bold ? ';font-weight:700' : ''}">${esc(label)}</td>
      <td style="padding:1px 0;text-align:right;white-space:nowrap${bold ? ';font-weight:700' : ''}">${value}</td></tr>`;

    const tax = Number(bill.cgst) + Number(bill.sgst);
    const pays = (m.payments || []).map(p =>
      row(p.mode.toUpperCase() + (p.ref ? ' ' + p.ref : ''), money(p.amount))).join('');
    const splits = (m.split && m.split.parts || []).map(p =>
      row(p.label, money(p.amount))).join('');

    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(bill.no || 'Bill')}</title>
<style>
  @page { size: ${b.page}; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: ${b.pad}; width: 100%;
         font-family: ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace;
         font-size: ${b.body}px; line-height: 1.35; color: #000; background: #fff;
         -webkit-print-color-adjust: exact; }
  table { width: 100%; border-collapse: collapse; }
  .c { text-align: center; }
  .rule { border-top: 1px dashed #000; margin: 3px 0; }
  .solid { border-top: 1.5px solid #000; margin: 3px 0; }
  .sm { font-size: ${b.mono - 1}px; }
  h1 { font-size: ${b.head}px; margin: 0 0 1px; letter-spacing: .04em; font-family: Georgia, "Times New Roman", serif; }
</style></head><body>
  <div class="c">
    <h1>${esc(h.legal_name || h.name || "Sulthan's")}</h1>
    ${h.address ? `<div class="sm">${esc(h.address)}</div>` : ''}
    ${h.phone ? `<div class="sm">${esc(h.phone)}</div>` : ''}
    ${h.gstin ? `<div class="sm">GSTIN ${esc(h.gstin)}</div>` : ''}
    ${h.fssai ? `<div class="sm">FSSAI ${esc(h.fssai)}</div>` : ''}
  </div>
  <div class="solid"></div>
  <table class="sm">
    <tr><td>Bill</td><td style="text-align:right">${esc(bill.no || '—')}</td></tr>
    <tr><td>${m.table && /^U/.test(m.table) ? 'Parcel' : 'Table'}</td>
        <td style="text-align:right">${esc(m.table || '—')}</td></tr>
    <tr><td>Date</td><td style="text-align:right">${esc(when(bill.printed_at))}</td></tr>
    ${m.staff ? `<tr><td>Cashier</td><td style="text-align:right">${esc(m.staff)}</td></tr>` : ''}
    ${m.guest ? `<tr><td>Customer</td><td style="text-align:right">${esc(m.guest)}</td></tr>` : ''}
    ${m.mobile ? `<tr><td>Mobile</td><td style="text-align:right">${esc(m.mobile)}</td></tr>` : ''}
  </table>
  <div class="rule"></div>
  <table>
    <thead><tr class="sm">
      <th style="text-align:left">Item</th><th>Qty</th>
      ${narrow ? '' : '<th style="text-align:right">Rate</th>'}
      <th style="text-align:right">Amount</th>
    </tr></thead>
    <tbody>${lines}</tbody>
  </table>
  <div class="rule"></div>
  <table>
    ${row('Subtotal', money(bill.gross))}
    ${Number(bill.discount) ? row('Discount' + (bill.discount_note ? ' · ' + bill.discount_note : ''), '-' + money(bill.discount)) : ''}
    ${Number(bill.discount) ? row('Taxable value', money(bill.taxable)) : ''}
    ${Number(bill.service) ? row('Service charge', money(bill.service)) : ''}
    ${Number(bill.pack) ? row('Packing', money(bill.pack)) : ''}
    ${Number(bill.dlv) ? row('Delivery', money(bill.dlv)) : ''}
    ${tax ? row('CGST', money(bill.cgst)) + row('SGST', money(bill.sgst)) : ''}
    ${Number(bill.rounding) ? row('Round off', (Number(bill.rounding) > 0 ? '+' : '') + money(bill.rounding)) : ''}
  </table>
  <div class="solid"></div>
  <table style="font-size:${b.head - 3}px">${row('TOTAL', money(bill.total), true)}</table>
  ${splits ? `<div class="rule"></div><div class="sm">Split</div><table class="sm">${splits}</table>` : ''}
  ${pays ? `<div class="rule"></div><table class="sm">${pays}</table>` : ''}
  <div class="rule"></div>
  <div class="c sm">
    ${h.bill_footer ? `<div>${esc(h.bill_footer)}</div>` : '<div>Thank you. Please visit again.</div>'}
    ${m.copy ? `<div style="margin-top:2px">${esc(m.copy)}</div>` : ''}
  </div>
</body></html>`;
  }

  /* Printed from a detached iframe, and the iframe is kept until afterprint
     fires: removing it on a timer raced the print dialog on Android, which
     cancelled the job the moment the node went away. */
  /* iOS Safari will not print from an iframe — contentWindow.print() returns
     without opening anything, which reads as a dead button. There a real tab
     is the only thing that prints, and it is also the guest's way out when no
     printer is paired: the system sheet offers Save to Files or AirDrop. */
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function printWindow(html) {
    const w = window.open('', '_blank');
    if (!w) return null;
    w.document.open(); w.document.write(html); w.document.close();
    const go = () => { try { w.focus(); w.print(); } catch (e) { console.warn('[print]', e.message); } };
    setTimeout(go, 350);
    return w;
  }

  function print(bill, house, meta, size) {
    const html = receiptHtml(bill, house, meta, size || width() || '80mm');
    if (IOS && printWindow(html)) return null;
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:420px;height:800px;border:0;opacity:0';
    document.body.appendChild(f);
    const doc = f.contentDocument;
    doc.open(); doc.write(html); doc.close();
    const go = () => {
      try {
        f.contentWindow.focus();
        f.contentWindow.print();
      } catch (e) { console.warn('[print]', e.message); }
    };
    let gone = false;
    const drop = () => { if (gone) return; gone = true; setTimeout(() => f.remove(), 400); };
    f.contentWindow.addEventListener('afterprint', drop);
    // Safari on iOS never fires afterprint from an iframe, so the node is swept
    // on a long timer as well — long enough that the dialog is done with it.
    setTimeout(drop, 20000);
    if (doc.readyState === 'complete') setTimeout(go, 60); else f.onload = () => setTimeout(go, 60);
    return f;
  }

  /* The same bill as text, for WhatsApp or the share sheet. Fixed-width
     columns would wrap on a phone, so this is plain lines. */
  function asText(bill, house, meta) {
    const h = house || {}, m = meta || {};
    const out = [(h.legal_name || h.name || "Sulthan's")];
    if (h.phone) out.push(h.phone);
    out.push('', 'Bill ' + (bill.no || '—') + '  ·  ' + (m.table || '—'), when(bill.printed_at));
    if (m.guest || m.mobile) out.push([m.guest, m.mobile].filter(Boolean).join('  ·  '));
    out.push('');
    (bill.lines || []).forEach(l => {
      out.push(l.qty + ' x ' + l.name + '  ' + money((Number(l.amount) || 0) - (Number(l.discount) || 0)));
    });
    out.push('', 'Subtotal ' + money(bill.gross));
    if (Number(bill.discount)) out.push('Discount -' + money(bill.discount));
    if (Number(bill.service)) out.push('Service ' + money(bill.service));
    if (Number(bill.pack)) out.push('Packing ' + money(bill.pack));
    if (Number(bill.dlv)) out.push('Delivery ' + money(bill.dlv));
    if (Number(bill.cgst)) out.push('CGST ' + money(bill.cgst) + '  SGST ' + money(bill.sgst));
    if (Number(bill.rounding)) out.push('Round off ' + money(bill.rounding));
    out.push('TOTAL ' + money(bill.total));
    (m.payments || []).forEach(p => out.push(p.mode.toUpperCase() + ' ' + money(p.amount)));
    if (h.bill_footer) out.push('', h.bill_footer);
    return out.join('\n');
  }

  async function share(bill, house, meta) {
    const text = asText(bill, house, meta);
    if (navigator.share) {
      try { await navigator.share({ title: 'Bill ' + (bill.no || ''), text }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    const mob = (meta && meta.mobile || '').replace(/\D/g, '');
    const to = mob.length >= 10 ? (mob.length === 10 ? '91' + mob : mob) : '';
    window.open('https://wa.me/' + to + '?text=' + encodeURIComponent(text), '_blank');
    return 'whatsapp';
  }

  /* A KOT is not a bill: no money on it, big type, and the station's name at
     the top so the person reading it knows the ticket is theirs. */
  function kotHtml(kot, meta, size) {
    const b = BOX[size] || BOX['80mm'];
    const m = meta || {};
    return `<!doctype html><html><head><meta charset="utf-8"><title>KOT ${kot.no || ''}</title>
<style>
  @page { size: ${b.page}; margin: 0; }
  body { margin: 0; padding: ${b.pad}; font-family: ui-monospace, Menlo, monospace;
         font-size: ${b.body + 1.5}px; line-height: 1.4; color: #000; background: #fff; }
  table { width: 100%; border-collapse: collapse; }
  .rule { border-top: 1px dashed #000; margin: 3px 0; }
  .c { text-align: center; }
  h1 { font-size: ${b.head}px; margin: 0; letter-spacing: .06em; }
  td { padding: 2px 0; vertical-align: top; }
</style></head><body>
  <div class="c"><h1>${esc(m.station || 'KITCHEN')}</h1>
    <div style="font-size:${b.mono}px">KOT #${esc(kot.no || '')} · ${esc(when(kot.created_at))}</div></div>
  <div class="rule"></div>
  <table style="font-size:${b.head - 4}px">
    <tr><td>${m.table && /^U/.test(m.table) ? 'PARCEL' : 'TABLE'}</td>
        <td style="text-align:right;font-weight:700">${esc(m.table || '—')}</td></tr>
  </table>
  <div class="rule"></div>
  <table>${(kot.items || []).map(i => `<tr>
      <td style="width:2.2em;font-weight:700">${i.qty}</td>
      <td>${esc(i.name)}${i.note ? `<div style="font-size:${b.mono}px">— ${esc(i.note)}</div>` : ''}</td>
    </tr>`).join('')}</table>
  ${kot.note ? `<div class="rule"></div><div>Note: ${esc(kot.note)}</div>` : ''}
  ${m.staff ? `<div class="rule"></div><div style="font-size:${b.mono}px">Punched by ${esc(m.staff)}</div>` : ''}
</body></html>`;
  }

  function printKot(kot, meta, size) {
    const html = kotHtml(kot, meta, size || width() || '80mm');
    if (IOS && printWindow(html)) return null;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:420px;height:800px;border:0;opacity:0';
    document.body.appendChild(f);
    const doc = f.contentDocument;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { try { f.contentWindow.print(); } catch (e) {} }, 80);
    setTimeout(() => f.remove(), 20000);
  }

  window.BILL_PRINT = { receiptHtml, print, asText, share, kotHtml, printKot, width, setWidth, money, when };
})();
