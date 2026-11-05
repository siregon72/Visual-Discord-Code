'use strict';

const { normalize, createReceipt, observeReceipt } = require('./src/shared/message-receipt');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
const MAX_MESSAGE_LENGTH = 2000;
const DELAYED_RECEIPT = 'Discord 전송 확인이 늦어지고 있습니다. 확인되면 자동으로 입력창이 다시 열립니다.';

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
async function transmitMessage({ request, wc, readSnapshot, readSendSnapshot = readSnapshot, callAdapter, focus,
  isCurrent = () => true, isFocused = () => wc?.isFocused?.() !== false, wait = delay, now = Date.now, timeoutMs = 10000 }) {
  if (!validRequest(request)) return { ok: false, error: '메시지는 올바른 대화에 1~2,000자로 입력해주세요.' };

  const { route, text } = request;
  const startedAt = now();
  const deadline = startedAt + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000);
  let insertionAttempted = false, submitted = false, receipt = null;
  const uncertain = error => ({ ok: false, uncertain: true, error, submitted, ...(submitted && receipt ? { receipt } : {}) });
  const checkCurrent = () => {
    if (!isCurrent() || wc?.isDestroyed?.() || now() >= deadline) throw new Error('Operation no longer current');
  };
  const readyComposer = value => value?.ok === true && value.focused === true &&
    value.route === route && !value.hasDialog && value.canSend !== false && value.routeReady !== false;
  const nativeFocusReady = value => isFocused() && value?.documentFocused !== false;

  try {
    checkCurrent();
    const before = await readSendSnapshot();
    checkCurrent();
    if (before?.route !== route || before.canSend !== true || before.routeReady === false || before.hasDialog || normalize(before.draftText)) {
      return { ok: false, error: '대화가 바뀌었거나 원래 입력창에 작성 중인 내용이 있습니다.' };
    }
    receipt = createReceipt({ route, text, startedAt, rows: before.rows });
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
    let inserted;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt) { await wait(20); checkCurrent(); }
      inserted = await callAdapter('composerState', route);
      checkCurrent();
      if (!readyComposer(inserted) || (normalize(inserted.text) === normalize(text) && nativeFocusReady(inserted))) break;
      // A renderer can expose the empty/partial insertion briefly. Wait only
      // while it is still the same editor, including native focus settling.
      // activeElement alone stays set after a window blurs; require the window
      // and document to remain focused for this deliberate submission.
      if (!normalize(text).startsWith(normalize(inserted.text))) break;
    }
    if (!readyComposer(inserted) || normalize(inserted.text) !== normalize(text)) {
      return uncertain('입력 상태가 변경되었습니다. 원래 화면의 작성 내용을 확인해주세요.');
    }
    if (!nativeFocusReady(inserted)) return uncertain('앱 창의 포커스가 바뀌어 전송하지 않았습니다. 원래 화면에 남은 작성 내용을 확인해주세요.');

    // Deliver once to the guarded editor in its document. Native key routing to
    // an offscreen WebContentsView can drop Enter even while focus flags are true.
    // A bridge failure can occur after delivery, so never retry or fall back.
    submitted = true;
    const delivery = await callAdapter('submitComposer', route, text);
    if (delivery?.dispatched === false) {
      submitted = false;
      return uncertain(delivery.error || '입력 상태가 바뀌어 전송하지 않았습니다. 원래 화면의 작성 내용을 확인해주세요.');
    }
    checkCurrent();
    if (delivery?.ok !== true || delivery.dispatched !== true) return uncertain(delivery?.error || DELAYED_RECEIPT);

    for (let attempt = 0; attempt < 50; attempt++) {
      if (attempt) { await wait(attempt === 1 ? 50 : attempt === 2 ? 100 : 200); checkCurrent(); }
      const current = await readSendSnapshot();
      checkCurrent();
      const observed = observeReceipt(receipt, current, now());
      if (observed.status === 'changed') break;
      if (observed.status === 'failed') {
        return uncertain('Discord에서 전송 실패가 표시되었습니다. 원래 화면에서 확인해주세요.');
      }
      if (observed.status === 'ambiguous') {
        return uncertain('전송된 메시지를 구분하지 못했습니다. 원래 화면에서 확인해주세요.');
      }
      // Return the evidence even for an immediate acknowledgement. The code
      // view coordinates it with earlier submissions so one late row cannot
      // confirm two consecutive messages containing identical text.
      if (observed.status === 'confirmed') return { ok: true, pending: false, receipt, confirmedRowId: observed.row.id };
      // Discord has consumed this one deliberate submission, so release the
      // native composer for the next message. This acknowledges handoff only:
      // the code view retains the receipt/text and verifies delivery in the
      // background. Never take this path for an unknown dispatch, stale room,
      // unreadable draft, or a failure/ambiguity observed above.
      if (current.routeReady === true && current.canSend === true && current.loggedIn !== false && !current.hasDialog &&
          typeof current.draftText === 'string' && !normalize(current.draftText)) {
        return { ok: true, pending: true, receipt };
      }
    }
    return uncertain(DELAYED_RECEIPT);
  } catch {
    if (submitted && isCurrent() && !wc?.isDestroyed?.()) return uncertain(DELAYED_RECEIPT);
    return insertionAttempted
      ? uncertain('전송 결과를 확인하지 못했습니다. 원래 화면에서 작성 내용과 전송 여부를 확인해주세요.')
      : { ok: false, error: '연결 상태가 바뀌었거나 입력창을 확인하지 못했습니다. 전송하지 않았습니다.' };
  }
}

module.exports = { transmitMessage, normalize };
