'use strict';

// Compare Discord's rendered text without changing the text inserted for the user.
const normalize = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\uFEFF]/g, '').trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
const MAX_MESSAGE_LENGTH = 2000;
const ACK_CLOCK_TOLERANCE_MS = 2000;

function messageTime(row) {
  const explicit = typeof row.time === 'string' ? Date.parse(row.time) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  // Discord's rendered row ID carries its server timestamp even when a grouped
  // message has no visible time element. Ignore non-native/local pending IDs.
  const snowflake = String(row.id || '').match(/(?:^|[-_])(\d{16,20})$/)?.[1];
  if (!snowflake) return null;
  return Number(BigInt(snowflake) >> 22n) + 1420070400000;
}

function validRequest(request) {
  return !!request && typeof request.text === 'string' && !!request.text.trim() &&
    request.text.length <= MAX_MESSAGE_LENGTH && typeof request.route === 'string' && CHAT_ROUTE.test(request.route);
}

/**
 * One deliberate send, never an automatic retry.
 * The caller must hold its send gate until this settles. In particular, do not race
 * insertText against a timer: the insertion could complete after a gate is released.
 * Adapter/snapshot reads are bounded by the host, while isCurrent invalidates an
 * operation when its window, guest, account or navigation generation changes.
 */
async function transmitMessage({ request, wc, readSnapshot, callAdapter, focus,
  isCurrent = () => true, wait = delay, now = Date.now, timeoutMs = 10000 }) {
  if (!validRequest(request)) return { ok: false, error: '메시지는 올바른 대화에 1~2,000자로 입력해주세요.' };

  const { route, text } = request;
  const startedAt = now();
  const deadline = startedAt + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000);
  let insertionAttempted = false;
  const uncertain = error => ({ ok: false, uncertain: true, error });
  const checkCurrent = () => {
    if (!isCurrent() || wc?.isDestroyed?.() || now() >= deadline) throw new Error('Operation no longer current');
  };
  const readyComposer = value => value?.ok === true && value.focused === true &&
    value.route === route && !value.hasDialog && value.canSend !== false && value.routeReady !== false;

  try {
    checkCurrent();
    const before = await readSnapshot();
    checkCurrent();
    if (before?.route !== route || before.canSend !== true || before.routeReady === false || before.hasDialog || normalize(before.draftText)) {
      return { ok: false, error: '대화가 바뀌었거나 원래 입력창에 작성 중인 내용이 있습니다.' };
    }
    const existing = new Set((Array.isArray(before.rows) ? before.rows : []).map(row => row?.id).filter(Boolean));
    const ready = await callAdapter('focusComposer', route);
    checkCurrent();
    if (ready?.ok !== true || ready.route !== route) return { ok: false, error: ready?.error || 'Discord 입력창을 먼저 확인해주세요.' };

    await focus();
    checkCurrent();
    const empty = await callAdapter('composerState', route);
    checkCurrent();
    if (!readyComposer(empty) || normalize(empty.text)) return { ok: false, error: '원래 화면의 입력창을 확인해주세요.' };

    // Once insertion starts its outcome may be unknown, even if insertText rejects.
    insertionAttempted = true;
    await wc.insertText(text);
    checkCurrent();
    await wait(60);
    checkCurrent();
    const inserted = await callAdapter('composerState', route);
    checkCurrent();
    if (!readyComposer(inserted) || normalize(inserted.text) !== normalize(text)) {
      return uncertain('입력 상태가 변경되었습니다. 원래 화면의 작성 내용을 확인해주세요.');
    }

    // Windows/Electron needs all three events. Emit exactly one complete sequence.
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    const pendingIds = new Set(), unrelatedConfirmedIds = new Set();
    for (let attempt = 0; attempt < 40; attempt++) {
      await wait(200);
      checkCurrent();
      const current = await readSnapshot();
      checkCurrent();
      if (current?.route !== route) break;
      const observedAt = now();
      const candidates = (Array.isArray(current.rows) ? current.rows : []).filter(row => row?.id &&
        !existing.has(row.id) && row.own === true && normalize(row.text) === normalize(text)).map(row => ({ row, time: messageTime(row) })).filter(({ time }) =>
        time === null || (time >= startedAt - ACK_CLOCK_TOLERANCE_MS && time <= observedAt + ACK_CLOCK_TOLERANCE_MS));
      if (candidates.some(({ row }) => row.failed)) {
        return uncertain('Discord에서 전송 실패가 표시되었습니다. 원래 화면에서 확인해주세요.');
      }
      const pending = candidates.filter(({ row }) => row.pending);
      if (pending.length > 1) return uncertain('전송된 메시지를 구분하지 못했습니다. 원래 화면에서 확인해주세요.');
      if (pending.length) {
        pendingIds.add(pending[0].row.id);
        // Sending can scroll a virtualized history view to recent messages. A
        // different already-confirmed row beside our pending one is not its receipt.
        for (const { row } of candidates) if (!row.pending) unrelatedConfirmedIds.add(row.id);
        continue;
      }
      const confirmed = candidates.filter(({ row }) => !unrelatedConfirmedIds.has(row.id));
      if (confirmed.length > 1) return uncertain('전송된 메시지를 구분하지 못했습니다. 원래 화면에서 확인해주세요.');
      if (confirmed.length === 1) {
        const { row, time } = confirmed[0];
        // A pending row may receive a server ID on completion. Its replacement
        // needs fresh timestamp evidence; an undated historical row cannot prove it.
        if (pendingIds.size && !pendingIds.has(row.id) && time === null) continue;
        if (!normalize(current.draftText)) return { ok: true };
      }
    }
    return uncertain('전송 여부를 아직 확인하지 못했습니다. 대화나 원래 화면을 확인한 뒤 다시 보내세요.');
  } catch {
    return insertionAttempted
      ? uncertain('전송 결과를 확인하지 못했습니다. 원래 화면에서 작성 내용과 전송 여부를 확인해주세요.')
      : { ok: false, error: '연결 상태가 바뀌었거나 입력창을 확인하지 못했습니다. 전송하지 않았습니다.' };
  }
}

module.exports = { transmitMessage, normalize };
