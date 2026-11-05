'use strict';

const normalize = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\uFEFF]/g, '').trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
const MAX_MESSAGE_LENGTH = 2000;
const DISPATCH_ERROR = '전송 요청을 전달하는 중 오류가 발생했습니다. 입력 내용은 보관됩니다.';

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
  let insertionAttempted = false, submitted = false;
  const uncertain = error => ({ ok: false, uncertain: true, error, submitted });
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
    const ready = await callAdapter('focusComposer', route);
    checkCurrent();
    if (ready?.ok !== true || ready.route !== route) return { ok: false, error: ready?.error || 'Discord 입력창이 아직 준비되지 않았습니다.' };

    await focus();
    checkCurrent();
    const empty = await callAdapter('composerState', route);
    checkCurrent();
    if (!readyComposer(empty) || normalize(empty.text)) return { ok: false, error: 'Discord 입력창 상태가 바뀌었거나 작성 중인 내용이 있습니다.' };

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
      return uncertain('입력 상태가 변경되어 전송하지 않았습니다. 입력 내용은 보관됩니다.');
    }
    if (!nativeFocusReady(inserted)) return uncertain('앱 창의 포커스가 바뀌어 전송하지 않았습니다. 입력 내용은 보관됩니다.');

    // Deliver once to the guarded editor in its document. Native key routing to
    // an offscreen WebContentsView can drop Enter even while focus flags are true.
    // A bridge failure can occur after delivery, so never retry or fall back.
    submitted = true;
    const delivery = await callAdapter('submitComposer', route, text);
    if (delivery?.dispatched === false) {
      submitted = false;
      return uncertain(delivery.error || '입력 상태가 바뀌어 전송하지 않았습니다. 입력 내용은 보관됩니다.');
    }
    checkCurrent();
    if (delivery?.ok !== true || delivery.dispatched !== true) return uncertain(delivery?.error || DISPATCH_ERROR);

    // The guarded Enter was dispatched. Delivery is checked by the user;
    // do not poll the message list or wait for Discord to clear its draft.
    return { ok: true, submitted: true };
  } catch {
    if (submitted) return uncertain(DISPATCH_ERROR);
    return insertionAttempted
      ? uncertain('입력 도중 연결 상태가 바뀌어 전송하지 않았습니다. 입력 내용은 보관됩니다.')
      : { ok: false, error: '연결 상태가 바뀌었거나 입력창을 확인하지 못했습니다. 전송하지 않았습니다.' };
  }
}

module.exports = { transmitMessage, normalize };
