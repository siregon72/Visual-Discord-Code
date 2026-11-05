'use strict';

// Shared by the native sender and the code view so a delayed receipt uses the
// same evidence as an immediate one. This module only examines rendered data.
((factory) => {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else globalThis.VDCSendReceipt = factory();
})(() => {
  const normalize = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\uFEFF]/g, '').trim();
  const ACK_CLOCK_TOLERANCE_MS = 2000;

  function renderedText(value) {
    const protectedText = [];
    const protect = text => '\u0000' + (protectedText.push(text) - 1) + '\u0000';
    let text = normalize(value)
      .replace(/```[^\n`]*\n([\s\S]*?)\n?```/g, (_match, content) => protect(content))
      .replace(/(`+)([^`]+?)\1/g, (_match, _ticks, content) => protect(content))
      .replace(/\\([\\*_~|`])/g, (_match, escaped) => protect(escaped));
    // Only paired formatting that Discord removes from rendered text is
    // accepted. Plain punctuation and unmatched delimiters remain significant.
    for (let pass = 0; pass < 3; pass++) {
      text = text.replace(/(\*\*|__|~~|\|\|)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
        .replace(/(?<!\*)\*(?![\s*])(\S(?:[^*]*?\S)?)\*(?!\*)/g, '$1')
        .replace(/(^|[\s(])_(\S(?:[^_]*?\S)?)_(?=$|[\s).,!?])/g, '$1$2');
    }
    return normalize(text.replace(/\u0000(\d+)\u0000/g, (_match, index) => protectedText[Number(index)] ?? _match));
  }

  function matchesText(rendered, submitted) {
    return normalize(rendered) === normalize(submitted) || normalize(rendered) === renderedText(submitted);
  }

  function messageTime(row) {
    const explicit = typeof row.time === 'string' ? Date.parse(row.time) : NaN;
    if (Number.isFinite(explicit)) return explicit;
    const snowflake = String(row.id || '').match(/(?:^|[-_])(\d{16,20})$/)?.[1];
    return snowflake ? Number(BigInt(snowflake) >> 22n) + 1420070400000 : null;
  }

  function createReceipt({ route, text, startedAt, rows }) {
    return { route, text, startedAt, existingIds: (Array.isArray(rows) ? rows : []).map(row => row?.id).filter(Boolean), pendingIds: [], unrelatedConfirmedIds: [] };
  }

  function observeReceipt(receipt, current, observedAt = Date.now()) {
    if (!receipt || current?.route !== receipt.route) return { status: 'changed' };
    if (receipt.terminal) return { status: receipt.terminal };
    if (current.routeReady === false || current.hasDialog) return { status: 'waiting' };
    const existing = new Set(receipt.existingIds), pendingIds = new Set(receipt.pendingIds), unrelated = new Set(receipt.unrelatedConfirmedIds);
    const candidates = (Array.isArray(current.rows) ? current.rows : []).filter(row => row?.id &&
      !existing.has(row.id) && row.own === true && matchesText(row.text, receipt.text)).map(row => ({ row, time: messageTime(row) })).filter(({ time }) =>
      time === null || (time >= receipt.startedAt - ACK_CLOCK_TOLERANCE_MS && time <= observedAt + ACK_CLOCK_TOLERANCE_MS));
    const terminal = status => { receipt.terminal = status; return { status }; };
    if (candidates.some(({ row }) => row.failed)) return terminal('failed');
    const pending = candidates.filter(({ row }) => row.pending);
    if (pending.length > 1) return terminal('ambiguous');
    if (pending.length) {
      pendingIds.add(pending[0].row.id);
      // A confirmed row revealed beside the pending send is historical evidence,
      // not a receipt for that send, even if virtualization hid it beforehand.
      for (const { row } of candidates) if (!row.pending) unrelated.add(row.id);
      receipt.pendingIds = [...pendingIds];
      receipt.unrelatedConfirmedIds = [...unrelated];
      return { status: 'pending' };
    }
    const confirmed = candidates.filter(({ row }) => !unrelated.has(row.id));
    if (confirmed.length > 1) return terminal('ambiguous');
    if (confirmed.length === 1) {
      const { row, time } = confirmed[0];
      // Replacing a local pending ID requires a fresh server timestamp. An
      // undated row coming into view cannot establish that relationship.
      if (pendingIds.size && !pendingIds.has(row.id) && time === null) return { status: 'waiting' };
      if (!normalize(current.draftText)) return { status: 'confirmed', row };
    }
    return { status: 'waiting' };
  }

  return { normalize, renderedText, matchesText, messageTime, createReceipt, observeReceipt };
});
