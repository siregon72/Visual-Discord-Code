'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const base = path.join(__dirname, '..');
const routeA = '/channels/@me/123';
const routeB = '/channels/@me/456';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function snapshot(route = routeA) {
  return {
    loggedIn: true, route, title: route === routeA ? '테스트 친구' : '다른 친구', guildName: 'direct',
    guilds: [{ id:'home', key:'guild:home', name:'direct' }],
    channels: [
      { id:'123', key:'route:' + routeA, route:routeA, name:'테스트 친구', group:'direct', kind:'dm' },
      { id:'456', key:'route:' + routeB, route:routeB, name:'다른 친구', group:'direct', kind:'dm' }
    ],
    rows: [{ id:'100', author:'테스트 친구', text:'<img src=x onerror=alert(1)> 실제 스냅샷', time:'2026-11-03T12:00:00Z', own:false, media:[] }],
    canSend:true, hasDialog:false, draftText:''
  };
}

function makeUI({ initialSnapshot = snapshot() } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(base, 'live.html'), 'utf8'), { url:'https://local.test/live.html', runScripts:'outside-only', pretendToBeVisual:true });
  const callbacks = {};
  const sends = [];
  const opens = [];
  const actions = [];
  const history = [];
  dom.window.HTMLElement.prototype.scrollTo = function(...args) { this.scrollTop = typeof args[0] === 'object' ? args[0].top : args[1]; };
  dom.window.vdc = {
    onSnapshot(fn) { callbacks.snapshot = fn; return () => {}; },
    onState(fn) { callbacks.state = fn; return () => {}; },
    action: async value => { actions.push(value); return true; }, connect: async () => true,
    openConversation: async key => { opens.push(key); return {ok:true}; },
    pageHistory: async request => { history.push(request); return {ok:true}; },
    sendMessage: payload => new Promise((resolve, reject) => sends.push({ payload, resolve, reject }))
  };
  for (const script of dom.window.document.querySelectorAll('script[src]')) {
    dom.window.eval(fs.readFileSync(path.join(base, script.getAttribute('src')), 'utf8'));
  }
  callbacks.state({ mode:'code', connected:true, busy:false, error:'', loginRequired:false });
  callbacks.snapshot(initialSnapshot);
  const input = dom.window.document.getElementById('message-input');
  const type = text => { input.value = text; input.dispatchEvent(new dom.window.Event('input', {bubbles:true})); };
  const submit = () => dom.window.document.getElementById('composer').dispatchEvent(new dom.window.Event('submit', {bubbles:true, cancelable:true}));
  return {dom,callbacks,sends,opens,actions,history,input,type,submit};
}

test('real snapshot renders as safe code and real Explorer filenames', async () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    assert.ok(document.getElementById('code-content').textContent.includes('<img src=x onerror=alert(1)> 실제 스냅샷'));
    assert.equal(document.getElementById('code-content').querySelector('img'), null);
    assert.ok(document.getElementById('tree').textContent.includes('테스트 친구.tsx'));
    assert.ok(document.getElementById('tree').textContent.includes('다른 친구.tsx'));
    assert.equal(document.getElementById('composer-area').hidden, false);
    assert.equal(ui.input.disabled, false);
  } finally { ui.dom.window.close(); }
});

test('IME confirmation does not send and a pending send cannot be submitted twice', async () => {
  const ui = makeUI();
  try {
    const win = ui.dom.window;
    const message = '입력 중 "따옴표" <Panel value={1} />\n다음 줄 \\ 경로';
    ui.type(message);
    ui.input.dispatchEvent(new win.CompositionEvent('compositionstart'));
    ui.input.dispatchEvent(new win.KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true, cancelable:true}));
    assert.equal(ui.sends.length, 0);
    ui.input.dispatchEvent(new win.CompositionEvent('compositionend'));
    ui.submit(); ui.submit();
    assert.equal(ui.sends.length, 1);
    assert.equal(ui.sends[0].payload.route, routeA);
    assert.equal(ui.sends[0].payload.text, message);
    ui.sends[0].resolve({ok:true});
    await tick();
    assert.equal(ui.input.value, '');
  } finally { ui.dom.window.close(); }
});

test('failed and uncertain sends preserve the draft instead of claiming success', async () => {
  const ui = makeUI();
  try {
    ui.type('보관할 내용'); ui.submit();
    ui.sends[0].resolve({ok:false,error:'연결 오류',uncertain:true});
    await tick();
    assert.equal(ui.input.value, '보관할 내용');
    assert.ok(ui.dom.window.document.body.textContent.includes('연결 오류'));
    assert.equal(ui.sends.length, 1);
  } finally { ui.dom.window.close(); }
});

test('a late send receipt cannot erase a draft in another conversation', async () => {
  const ui = makeUI();
  try {
    ui.type('첫 대화에 보내는 내용'); ui.submit();
    ui.callbacks.snapshot(snapshot(routeB));
    ui.type('두 번째 대화의 초안');
    ui.sends[0].resolve({ok:true});
    await tick();
    assert.equal(ui.input.value, '두 번째 대화의 초안');
    assert.equal(ui.sends[0].payload.route, routeA);
  } finally { ui.dom.window.close(); }
});

test('login and blocked composer states do not permit live sends', async () => {
  const ui = makeUI();
  try {
    ui.type('전송 금지');
    ui.callbacks.snapshot({...snapshot(),canSend:false,hasDialog:true});
    ui.submit();
    assert.equal(ui.sends.length, 0);
    ui.callbacks.snapshot({...snapshot(),loggedIn:false,canSend:false,rows:[],channels:[]});
    ui.submit();
    assert.equal(ui.sends.length, 0);
  } finally { ui.dom.window.close(); }
});

test('temporary navigation loading retains drafts while an explicit reset clears them', () => {
  const ui = makeUI();
  try {
    ui.type('연결 중에도 보관');
    ui.callbacks.snapshot({...snapshot(),loggedIn:false,canSend:false,rows:[],channels:[]});
    ui.callbacks.snapshot(snapshot());
    assert.equal(ui.input.value,'연결 중에도 보관');
    ui.callbacks.snapshot({...snapshot(),reset:true,loggedIn:false,canSend:false,rows:[],channels:[]});
    ui.callbacks.snapshot(snapshot());
    assert.equal(ui.input.value,'');
    assert.equal(ui.dom.window.document.querySelectorAll('.folder-title').length,1,'home is not duplicated as another direct folder');
  } finally { ui.dom.window.close(); }
});

test('React string data and attachment names stay inert and preview the matching media', () => {
  const ui = makeUI();
  try {
    const text = '"</span><img src=x onerror=alert(1)> <Panel value={1} />\n다음 줄 \\ ${value} & `template`';
    const media = [
      {name:'첫 파일 "><svg onload=alert(1)>.png',type:'image',url:'https://cdn.discordapp.com/attachments/1/2/first.png'},
      {name:'두 번째 "파일".png',type:'image',url:'https://media.discordapp.net/attachments/1/2/second.png'}
    ];
    ui.callbacks.snapshot({...snapshot(),rows:[{...snapshot().rows[0],author:'친구" onmouseover="alert(1)',text,media}]});
    const document = ui.dom.window.document;
    const code = document.getElementById('code-content');
    assert.ok(code.textContent.includes(JSON.stringify(text)), 'message is displayed as an intact quoted string');
    assert.equal(code.querySelector('img, svg, script, iframe'), null, 'message markup cannot create DOM elements');
    assert.equal(code.querySelector('[onmouseover], [onerror]'), null, 'sender metadata cannot inject event attributes');
    const attachments = [...code.querySelectorAll('.code-media')];
    assert.equal(attachments.length, media.length);
    for (const [index, attachment] of attachments.entries()) {
      assert.equal(attachment.dataset.row, '0');
      assert.equal(attachment.dataset.media, String(index));
      assert.ok(attachment.textContent.includes(JSON.stringify(media[index].name)));
      attachment.dispatchEvent(new ui.dom.window.MouseEvent('mouseover', {bubbles:true}));
      assert.equal(document.getElementById('preview-image').src, media[index].url);
      assert.equal(document.getElementById('preview-name').textContent, media[index].name);
      assert.equal(document.getElementById('media-preview').hidden, false);
      attachment.dispatchEvent(new ui.dom.window.MouseEvent('mouseout', {bubbles:true}));
      assert.equal(document.getElementById('media-preview').hidden, true);
    }
    assert.equal(ui.sends.length, 0);
  } finally { ui.dom.window.close(); }
});

test('loading older history or receiving a new message does not rewrite existing React snippets', () => {
  const ui = makeUI();
  try {
    const entry = (id, text, own, minute) => ({id,author:own?'나':'테스트 친구',text,own,time:`2026-11-03T12:${minute}:00Z`,media:[]});
    const rows = [entry('200','먼저 보인 내용',false,'10'),entry('201','작성한 "답장"',true,'11')];
    const snippet = id => [...ui.dom.window.document.querySelectorAll(`.code-block[data-message-id="${id}"] .code-text`)].map(line => line.textContent).join('\n');
    ui.callbacks.snapshot({...snapshot(),rows});
    const initial = rows.map(row => snippet(row.id));
    assert.ok(initial.every(Boolean), 'each message has a stable source block');
    ui.callbacks.snapshot({...snapshot(),rows:[entry('199','이전 대화',false,'09'),...rows,entry('202','새로 도착한 내용',false,'12')]});
    assert.deepEqual(rows.map(row => snippet(row.id)), initial);
    const orderedBlocks = [...ui.dom.window.document.querySelectorAll('.code-block[data-message-id]')].map(block => block.dataset.messageId);
    assert.deepEqual(orderedBlocks, ['199','200','201','202'], 'code preserves conversation chronology');
  } finally { ui.dom.window.close(); }
});

test('decorative titlebar and rail controls stay inactive when connection state changes', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    ui.actions.length = 0;
    ui.callbacks.state({mode:'code',busy:false,canBack:true,canForward:true});
    const controls = document.querySelectorAll('.menubar button, .navigation-controls button, .title-search button, .title-search input, .layout-controls button, .activity button:not(#explorer-toggle)');
    for (const control of controls) {
      assert.equal(control.disabled, true, control.id);
      assert.equal(control.tabIndex, -1, control.id);
      control.click();
      control.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
    }
    assert.deepEqual(ui.actions, []);
    assert.deepEqual(ui.opens, []);
    assert.equal(document.getElementById('command-menu'), null);
    assert.equal(document.getElementById('sidebar').classList.contains('is-hidden'), false);
    assert.equal(ui.input.disabled, false, 'the real message composer stays usable');
    document.getElementById('explorer-toggle').click();
    assert.equal(document.getElementById('sidebar').classList.contains('is-hidden'), true);
    document.getElementById('window-close').click();
    assert.deepEqual(ui.actions, ['close'], 'window controls retain their action');
  } finally { ui.dom.window.close(); }
});

test('backend transitions and read errors disable sends while preserving the local draft', () => {
  const ui = makeUI();
  try {
    ui.type('끊겨도 보관할 초안');
    for (const [key, value] of [['sending',true], ['opening',true], ['clearing',true], ['busy',true], ['ready',false], ['error','읽기 실패']]) {
      ui.callbacks.state({sending:false,opening:false,clearing:false,busy:false,ready:true,error:'',[key]:value});
      assert.equal(ui.input.disabled, true, key);
      ui.submit();
      assert.equal(ui.sends.length, 0);
      assert.equal(ui.input.value, '끊겨도 보관할 초안');
    }
    ui.callbacks.state({sending:false,opening:false,clearing:false,busy:false,ready:true,error:''});
    ui.callbacks.snapshot(null);
    assert.equal(ui.input.disabled, true);
    ui.callbacks.snapshot({...snapshot(),route:'',loggedIn:false,canSend:false,rows:[],channels:[]});
    assert.equal(ui.input.value, '끊겨도 보관할 초안');
    ui.callbacks.snapshot(snapshot());
    assert.equal(ui.input.disabled, false);
    assert.equal(ui.input.value, '끊겨도 보관할 초안');
  } finally { ui.dom.window.close(); }
});

test('malformed snapshot entries cannot crash the view or create actionable forged routes', () => {
  const ui = makeUI();
  try {
    const good = snapshot();
    ui.callbacks.snapshot({...good,
      channels:[null,42,{},...good.channels,good.channels[0],{...good.channels[0],route:'/channels/@me/999',key:'javascript:evil'}],
      guilds:[null,{},'bad',{id:'100',key:'guild:100',name:'테스트 서버'}],
      rows:[null,'bad',{}, {...good.rows[0],media:[null,42,{name:'document.pdf',type:'file'}]},good.rows[0]]
    });
    const document = ui.dom.window.document;
    assert.equal(document.querySelectorAll('.file-row.subfile').length,2);
    assert.equal(document.querySelectorAll('.code-block[data-message-id="100"]').length,1);
    assert.equal(ui.input.disabled,false);
    ui.callbacks.snapshot({...good,route:'https://evil.test/channels/@me/123',canSend:true});
    assert.equal(ui.input.disabled,true);
    ui.submit(); assert.equal(ui.sends.length,0);
  } finally { ui.dom.window.close(); }
});

test('an old session send receipt cannot erase a new session draft or release its send gate', async () => {
  for (const staleResult of [{ok:true},{ok:false,uncertain:true,error:'이전 계정 오류'}]) {
    const ui = makeUI();
    try {
      ui.type('같은 내용'); ui.submit();
      ui.callbacks.snapshot({...snapshot(),reset:true,loggedIn:false,canSend:false,route:'/login',rows:[],channels:[]});
      ui.callbacks.snapshot(snapshot());
      ui.type('같은 내용'); ui.submit();
      assert.equal(ui.sends.length,2);
      ui.sends[0].resolve(staleResult); await tick();
      assert.equal(ui.input.value,'같은 내용');
      assert.equal(ui.input.disabled,true,'the new send remains pending');
      assert.equal(ui.dom.window.document.getElementById('inline-status').hidden,true);
      ui.sends[1].resolve({ok:true}); await tick();
      assert.equal(ui.input.value,'');
      assert.equal(ui.input.disabled,false);
    } finally { ui.dom.window.close(); }
  }
});

test('IPC send rejection preserves text and requires verification before another send', async () => {
  const ui = makeUI();
  try {
    ui.type('보내던 내용'); ui.submit();
    ui.sends[0].reject(new Error('renderer bridge disconnected')); await tick();
    assert.equal(ui.input.value,'보내던 내용');
    assert.equal(ui.input.disabled,true);
    ui.submit(); assert.equal(ui.sends.length,1);
    assert.ok(ui.dom.window.document.querySelector('.acknowledge'));
  } finally { ui.dom.window.close(); }
});

test('a draft edited away and back to the sent text is not cleared by a late acknowledgement', async () => {
  const ui = makeUI();
  try {
    ui.type('반복해서 쓸 내용'); ui.submit();
    ui.callbacks.snapshot(snapshot(routeB));
    ui.callbacks.snapshot(snapshot());
    ui.type('새로 수정한 내용');
    ui.type('반복해서 쓸 내용');
    ui.sends[0].resolve({ok:true}); await tick();
    assert.equal(ui.input.value,'반복해서 쓸 내용');
  } finally { ui.dom.window.close(); }
});

test('an authenticated account reset renders the new snapshot and clears previous account drafts', () => {
  const ui = makeUI();
  try {
    ui.type('이전 계정의 비공개 초안');
    const changed = {...snapshot(routeB),reset:true,channels:[snapshot(routeB).channels[1]],rows:[{...snapshot().rows[0],id:'new-account-message',text:'새 계정의 내용'}]};
    ui.callbacks.snapshot(changed);
    assert.equal(ui.input.value,'');
    assert.equal(ui.dom.window.document.querySelectorAll('.file-row.subfile').length,1);
    assert.ok(ui.dom.window.document.getElementById('code-content').textContent.includes('새 계정의 내용'));
    ui.callbacks.snapshot(snapshot());
    assert.equal(ui.input.value,'','draft from the previous account is not restored');
  } finally { ui.dom.window.close(); }
});

test('a conversation visit keeps history woven and appends both message directions as compact lines', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const fresh = new Date(Date.now() + 1000).toISOString();
    const outgoing = { ...historical, id: '101', author: '나', text: '새로 보낸 내용', time: fresh, own: true };
    const incoming = { ...historical, id: '102', text: '새로 받은 내용', time: fresh, own: false };
    const block = id => document.querySelector(`.code-block[data-message-id="${id}"]`);
    assert.equal(document.querySelectorAll('.live-message').length, 0);
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, outgoing, incoming] });
    assert.ok(block('100') && !block('100').classList.contains('live-message'));
    assert.deepEqual([...document.querySelectorAll('.new-messages .live-message')].map(element => element.dataset.messageId), ['101', '102']);
    for (const id of ['101', '102']) assert.equal(block(id).querySelectorAll('.code-row').length, 1);
    assert.ok(block('101').querySelector('.change-marker.sent'));
    assert.ok(block('102').querySelector('.change-marker.received'));

    ui.callbacks.snapshot(snapshot(routeB));
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, outgoing, incoming] });
    assert.equal(document.querySelectorAll('.live-message').length, 0, 'revisiting treats every currently loaded row as history again');
    assert.ok(['100', '101', '102'].every(id => block(id)));
  } finally { ui.dom.window.close(); }
});

test('older prepended and virtualized history does not enter the new-message section', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const older = { ...historical, id: '90', text: '이전에 있던 내용', time: '2026-11-03T11:00:00Z' };
    const live = { ...historical, id: '101', text: '방금 온 내용', time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, live] });
    ui.callbacks.snapshot({ ...snapshot(), rows: [older, historical, live] });
    assert.equal(document.querySelector('.code-block[data-message-id="90"]').classList.contains('live-message'), false);
    assert.deepEqual([...document.querySelectorAll('.live-message')].map(element => element.dataset.messageId), ['101']);

    ui.callbacks.snapshot({ ...snapshot(), rows: [{ ...older, id: '80' }, older] });
    assert.equal(document.querySelectorAll('.live-message').length, 0, 'an unrelated older virtualized window remains history');
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, live] });
    assert.deepEqual([...document.querySelectorAll('.live-message')].map(element => element.dataset.messageId), ['101'], 'returning a previously live row preserves its classification within the visit');
  } finally { ui.dom.window.close(); }
});

test('initial empty loading and a later read gap do not misclassify historical messages', () => {
  const ui = makeUI({ initialSnapshot: { ...snapshot(), rows: [], routeReady: false, canSend: false } });
  try {
    const document = ui.dom.window.document;
    const first = { ...snapshot().rows[0], time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), routeReady: true, rows: [first] });
    assert.equal(document.querySelectorAll('.live-message').length, 0, 'the first usable snapshot establishes history even after an empty loading snapshot');
    const live = { ...first, id: '101', text: '이후 들어온 내용', time: new Date(Date.now() + 2000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), routeReady: true, rows: [first, live] });
    assert.ok(document.querySelector('.live-message[data-message-id="101"]'));
    ui.callbacks.snapshot({ ...snapshot(), route: '', loggedIn: false, routeReady: false, canSend: false, rows: [], channels: [] });
    ui.callbacks.snapshot({ ...snapshot(), routeReady: true, rows: [first, live] });
    assert.ok(document.querySelector('.live-message[data-message-id="101"]'), 'transient read gaps do not start a new visit');
    assert.equal(document.querySelector('.code-block[data-message-id="100"]').classList.contains('live-message'), false);
  } finally { ui.dom.window.close(); }
});

test('compact multiline text remains inert and media preview retains its original snapshot index', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const older = { ...historical, id: '90', text: '더 이전 내용', time: '2026-11-03T11:00:00Z' };
    const text = '첫 줄 "</span><img src=x onerror=alert(1)>"\n둘째 줄 <Panel /> \\ ${draft}';
    const media = [
      { name: 'first "><svg onload=alert(1)>.png', type: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/live-first.png' },
      { name: 'second.png', type: 'image', url: 'https://media.discordapp.net/attachments/1/2/live-second.png' }
    ];
    const fresh = new Date(Date.now() + 1000).toISOString();
    const outgoing = { ...historical, id: '101', text: '앞에 온 메시지', own: true, time: fresh };
    const incoming = { ...historical, id: '102', text, time: fresh, media };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, outgoing, incoming] });
    ui.callbacks.snapshot({ ...snapshot(), rows: [older, historical, outgoing, incoming] });
    const block = document.querySelector('.new-messages .live-message[data-message-id="102"]');
    assert.ok(block);
    assert.equal(block.querySelectorAll('.code-row').length, 1);
    assert.ok(block.textContent.includes(JSON.stringify(text)));
    assert.equal(block.querySelector('img, svg, script, iframe'), null);
    assert.equal(block.querySelector('[onerror], [onload]'), null);
    const attachments = [...block.querySelectorAll('.code-media')];
    assert.equal(attachments.length, media.length);
    attachments.forEach((attachment, index) => {
      assert.equal(attachment.dataset.row, '3');
      assert.equal(attachment.dataset.media, String(index));
      attachment.dispatchEvent(new ui.dom.window.MouseEvent('mouseover', { bubbles: true }));
      assert.equal(document.getElementById('preview-image').src, media[index].url);
      assert.equal(document.getElementById('preview-name').textContent, media[index].name);
      assert.equal(document.getElementById('media-preview').hidden, false);
      attachment.dispatchEvent(new ui.dom.window.MouseEvent('mouseout', { bubbles: true }));
    });
    assert.equal(ui.sends.length, 0);
  } finally { ui.dom.window.close(); }
});

test('a live pending message stays compact when Discord replaces its ID with an older server timestamp', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const pending = { ...historical, id: 'local-pending-1', author: '나', text: '확인 중인 메시지', own: true, pending: true,
      time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, pending] });
    assert.ok(document.querySelector('.live-message[data-message-id="local-pending-1"]'));
    const confirmed = { ...pending, id: 'confirmed-1', pending: false, time: new Date(Date.now() - 5000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, confirmed] });
    const block = document.querySelector('.new-messages .live-message[data-message-id="confirmed-1"]');
    assert.ok(block, 'a recent pending-to-confirmed replacement retains live classification despite server clock skew');
    assert.equal(block.querySelectorAll('.code-row').length, 1);
    assert.equal(document.querySelector('.code-block[data-message-id="local-pending-1"]'), null);
  } finally { ui.dom.window.close(); }
});

test('untimed rows use an observed append boundary and do not promote untimed prepended history', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const older = { ...historical, id: 'untimed-old', text: '시간 없는 과거', time: '' };
    const appended = { ...historical, id: 'untimed-new', text: '시간 없는 새 내용', time: '' };
    ui.callbacks.snapshot({ ...snapshot(), rows: [older, historical, appended] });
    assert.equal(document.querySelector('.code-block[data-message-id="untimed-old"]').classList.contains('live-message'), false);
    assert.ok(document.querySelector('.new-messages .live-message[data-message-id="untimed-new"]'));
  } finally { ui.dom.window.close(); }
});

test('a ready empty conversation accepts its first subsequent message as a compact live line', () => {
  const ui = makeUI({ initialSnapshot: { ...snapshot(), rows: [], routeReady: true, canSend: true } });
  try {
    const first = { ...snapshot().rows[0], id: 'first-message', time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [first], routeReady: true });
    const block = ui.dom.window.document.querySelector('.new-messages .live-message[data-message-id="first-message"]');
    assert.ok(block);
    assert.equal(block.querySelectorAll('.code-row').length, 1);
  } finally { ui.dom.window.close(); }
});

test('an account reset discards the previous visit live IDs even when the route and message ID are reused', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const live = { ...historical, id: '101', text: '현재 계정의 새 내용', time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, live] });
    assert.ok(document.querySelector('.live-message[data-message-id="101"]'));
    const changed = { ...live, text: '새 계정에 이미 있던 내용' };
    ui.callbacks.snapshot({ ...snapshot(), reset: true, rows: [changed] });
    assert.equal(document.querySelectorAll('.live-message').length, 0);
    assert.ok(document.querySelector('.code-block[data-message-id="101"]').textContent.includes(changed.text));
    const next = { ...changed, id: '102', text: '계정 변경 후 받은 내용', time: new Date(Date.now() + 2000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [changed, next] });
    assert.deepEqual([...document.querySelectorAll('.live-message')].map(element => element.dataset.messageId), ['102']);
  } finally { ui.dom.window.close(); }
});

test('ancient repeated text cannot steal the live status of a pending-to-final replacement', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const pending = { ...historical, id: 'local-pending', text: '반복할 수 있는 내용', own: true, pending: true, time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, pending] });
    const ancient = { ...pending, id: 'ancient-repeat', pending: false, time: new Date(Date.now() - 3600000).toISOString() };
    const confirmed = { ...pending, id: 'confirmed-repeat', pending: false, time: new Date(Date.now() - 5000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [ancient, historical, confirmed] });
    assert.equal(document.querySelector('.code-block[data-message-id="ancient-repeat"]').classList.contains('live-message'), false);
    assert.ok(document.querySelector('.live-message[data-message-id="confirmed-repeat"]'));
  } finally { ui.dom.window.close(); }
});

test('a pending message settled under the same ID leaves no identity hint for later history', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const pending = { ...historical, id: 'stable-pending', text: '같은 내용', own: true, pending: true, time: new Date(Date.now() + 1000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, pending] });
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, { ...pending, pending: false }] });
    const older = { ...pending, id: 'older-same-text', pending: false, time: new Date(Date.now() - 5000).toISOString() };
    ui.callbacks.snapshot({ ...snapshot(), rows: [historical, older] });
    assert.equal(document.querySelector('.code-block[data-message-id="older-same-text"]').classList.contains('live-message'), false);
    assert.equal(document.querySelectorAll('.live-message').length, 0);
  } finally { ui.dom.window.close(); }
});

test('Explorer name mode updates filenames, tab and path together without changing drafts or live message classification', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const toggle = document.getElementById('file-names-toggle');
    const rows = [...snapshot().rows, { ...snapshot().rows[0], id: '101', text: '현재 방문의 새 메시지', time: new Date(Date.now() + 1000).toISOString() }];
    ui.callbacks.snapshot({ ...snapshot(), rows });
    ui.type('변경 중에도 보존할 초안');
    const liveBefore = document.querySelector('.live-message[data-message-id="101"]').textContent;
    const file = route => [...document.querySelectorAll('.file-row.subfile')].find(element => element.dataset.focusKey === route);
    const originalName = file(routeA).querySelector('.filename').textContent;
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    const alias = file(routeA).querySelector('.filename').textContent;
    assert.notEqual(alias, originalName);
    assert.match(alias, /\.(?:jsx|tsx)$/);
    assert.equal(document.getElementById('tab-label').textContent, alias);
    assert.ok(document.getElementById('breadcrumb').textContent.endsWith(alias));
    assert.ok(file(routeA).getAttribute('aria-label').includes(alias));
    assert.ok(!file(routeA).getAttribute('aria-label').includes('테스트 친구'));
    assert.equal(document.querySelectorAll('.file-row.subfile').length, 2, 'the mode toggle does not collapse folders');
    assert.equal(ui.input.value, '변경 중에도 보존할 초안');
    assert.equal(document.querySelector('.live-message[data-message-id="101"]').textContent, liveBefore);
    assert.equal(ui.sends.length, 0);
    assert.equal(ui.opens.length, 0);
    toggle.click();
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(file(routeA).querySelector('.filename').textContent, originalName);
    assert.equal(document.getElementById('tab-label').textContent, originalName);
    assert.ok(document.getElementById('breadcrumb').textContent.endsWith(originalName));
    assert.equal(ui.input.value, '변경 중에도 보존할 초안');
    assert.ok(document.querySelector('.live-message[data-message-id="101"]'));
  } finally { ui.dom.window.close(); }
});

test('an aliased conversation still opens its original route and selects the matching tab', async () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    document.getElementById('file-names-toggle').click();
    const file = route => [...document.querySelectorAll('.file-row.subfile')].find(element => element.dataset.focusKey === route);
    const alias = file(routeB).querySelector('.filename').textContent;
    assert.notEqual(alias, file(routeA).querySelector('.filename').textContent);
    file(routeB).click();
    await tick();
    assert.deepEqual(ui.opens, ['route:' + routeB]);
    ui.callbacks.snapshot(snapshot(routeB));
    assert.equal(document.getElementById('tab-label').textContent, alias);
    assert.ok(document.getElementById('breadcrumb').textContent.endsWith(alias));
    assert.equal(file(routeB).getAttribute('aria-current'), 'page');
    assert.ok(file(routeB).getAttribute('aria-label').includes(alias));
    assert.equal(ui.sends.length, 0);
  } finally { ui.dom.window.close(); }
});

test('alias assignments survive conversation list changes and the toggle preserves collapsed folders', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const toggle = document.getElementById('file-names-toggle');
    const file = route => [...document.querySelectorAll('.file-row.subfile')].find(element => element.dataset.focusKey === route);
    toggle.click();
    const aliases = [routeA, routeB].map(route => file(route).querySelector('.filename').textContent);
    const changed = snapshot();
    const additional = { id: '999', key: 'route:/channels/@me/999', route: '/channels/@me/999', name: '새로 보인 친구', group: 'direct', kind: 'dm' };
    changed.channels = [additional, changed.channels[1], { ...changed.channels[0], name: '이름이 바뀐 친구' }];
    ui.callbacks.snapshot(changed);
    assert.deepEqual([routeA, routeB].map(route => file(route).querySelector('.filename').textContent), aliases);
    assert.ok(!aliases.includes(file(additional.route).querySelector('.filename').textContent));
    document.querySelector('.folder-toggle').click();
    assert.equal(document.querySelector('.folder-toggle').getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(document.querySelector('.folder-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelectorAll('.file-row.subfile').length, 0);
    document.querySelector('.folder-toggle').click();
    assert.equal(file(routeA).querySelector('.filename').textContent, '이름이 바뀐 친구.tsx');
    assert.equal(file(routeB).querySelector('.filename').textContent, '다른 친구.tsx');
  } finally { ui.dom.window.close(); }
});

test('compact tail appends preserve existing DOM, line numbers and original media indices', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const oldBlock = document.querySelector('.code-block[data-message-id="100"]');
    const fresh = new Date(Date.now() + 1000).toISOString();
    const first = {...historical,id:'101',text:'새 메시지',time:fresh};
    ui.callbacks.snapshot({...snapshot(),rows:[historical,first]});
    const firstBlock = document.querySelector('.live-message[data-message-id="101"]');
    assert.strictEqual(document.querySelector('.code-block[data-message-id="100"]'),oldBlock);
    const media = [
      {name:'one.png',type:'image',url:'https://cdn.discordapp.com/attachments/1/2/one.png'},
      {name:'two.png',type:'image',url:'https://media.discordapp.net/attachments/1/2/two.png'}
    ];
    const second = {...historical,id:'102',text:'두 줄\n<img onerror="evil()">',time:fresh,own:true,media};
    ui.callbacks.snapshot({...snapshot(),rows:[historical,first,second]});
    assert.strictEqual(document.querySelector('.code-block[data-message-id="100"]'),oldBlock);
    assert.strictEqual(document.querySelector('.live-message[data-message-id="101"]'),firstBlock);
    const secondBlock = document.querySelector('.live-message[data-message-id="102"]');
    assert.equal(secondBlock.querySelectorAll('.code-row').length,1);
    assert.equal(secondBlock.querySelector('img'),null);
    const attachments = [...secondBlock.querySelectorAll('.code-media')];
    assert.deepEqual(attachments.map(element => [element.dataset.row,element.dataset.media]),[['2','0'],['2','1']]);
    attachments[1].dispatchEvent(new ui.dom.window.MouseEvent('mouseover',{bubbles:true}));
    assert.equal(document.getElementById('preview-image').src,media[1].url);
    const numbers = [...document.querySelectorAll('#code-content .line-number')].map(element=>Number(element.textContent));
    assert.deepEqual(numbers,Array.from({length:numbers.length},(_,index)=>index+1));
    assert.equal(Number(document.getElementById('composer-line').textContent),numbers.length+1);
    assert.equal(document.querySelectorAll('.new-messages').length,1);
    ui.type('보존할 초안');
    document.getElementById('file-names-toggle').click();
    assert.strictEqual(document.querySelector('.code-block[data-message-id="100"]'),oldBlock,'a cosmetic alias toggle preserves the source nodes');
    assert.equal(ui.input.value,'보존할 초안');
  } finally { ui.dom.window.close(); }
});

test('history prepend, edit, delete, density and route changes fall back to a complete source update', () => {
  const ui = makeUI();
  try {
    const document = ui.dom.window.document;
    const historical = snapshot().rows[0];
    const live = {...historical,id:'101',text:'새 내용',time:new Date(Date.now()+1000).toISOString(),media:[{name:'file.png',type:'image',url:'https://cdn.discordapp.com/attachments/1/2/file.png'}]};
    ui.callbacks.snapshot({...snapshot(),rows:[historical,live]});
    const block = () => document.querySelector('.code-block[data-message-id="100"]');
    let previous = block();
    const older = {...historical,id:'90',text:'이전 내용',time:'2026-11-03T11:00:00Z'};
    ui.callbacks.snapshot({...snapshot(),rows:[older,historical,live]});
    assert.notStrictEqual(block(),previous);
    assert.equal(document.querySelector('.live-message .code-media').dataset.row,'2');
    previous = block();
    const edited = {...historical,text:'수정된 기록'};
    ui.callbacks.snapshot({...snapshot(),rows:[older,edited,live]});
    assert.notStrictEqual(block(),previous);
    assert.ok(block().textContent.includes('수정된 기록'));
    previous = block();
    ui.callbacks.snapshot({...snapshot(),rows:[older,edited]});
    assert.notStrictEqual(block(),previous);
    assert.equal(document.querySelector('.code-block[data-message-id="101"]'),null);
    assert.equal(document.querySelector('.new-messages'),null);
    previous = block();
    document.getElementById('spaces').click();
    assert.notStrictEqual(block(),previous);
    previous = block();
    ui.callbacks.snapshot({...snapshot(routeB),rows:[older,edited]});
    assert.notStrictEqual(block(),previous);
    previous = block();
    ui.callbacks.snapshot({...snapshot(routeB),rows:[older,edited],reset:true});
    assert.notStrictEqual(block(),previous);
  } finally { ui.dom.window.close(); }
});

test('history remains readable in read-only channels and when a native or uncertain draft blocks sends', async () => {
  for (const mode of ['read-only', 'native-draft', 'uncertain']) {
    const initialSnapshot = snapshot();
    if (mode === 'read-only') initialSnapshot.canSend = false;
    if (mode === 'native-draft') initialSnapshot.draftText = '원래 화면에 보관된 초안';
    const ui = makeUI({ initialSnapshot });
    try {
      if (mode === 'uncertain') {
        ui.type('결과를 확인할 초안'); ui.submit();
        ui.sends[0].resolve({ ok: false, uncertain: true });
        await tick();
      }
      assert.equal(ui.input.disabled, true, mode + ' still disables sends');
      const count = ui.sends.length;
      ui.dom.window.document.getElementById('code-scroll').dispatchEvent(new ui.dom.window.WheelEvent('wheel', { deltaY: -120 }));
      assert.equal(ui.history.length, 1, mode + ' can request earlier messages');
      assert.equal(ui.history[0].route, routeA);
      assert.equal(ui.history[0].direction, -1);
      ui.submit();
      assert.equal(ui.sends.length, count, 'paging cannot bypass the send guard');
    } finally { ui.dom.window.close(); }
  }
});

test('history ignores horizontal scrolling and zoom gestures and remains blocked during loading, dialogs and in-flight operations', async () => {
  const cases = [
    ui => ui.callbacks.state({ busy: true }),
    ui => ui.callbacks.state({ opening: true }),
    ui => ui.callbacks.state({ clearing: true }),
    ui => ui.callbacks.state({ sending: true }),
    ui => ui.callbacks.state({ ready: false }),
    ui => ui.callbacks.state({ mode: 'native' }),
    ui => ui.callbacks.state({ error: '연결 오류' }),
    ui => ui.callbacks.snapshot({ ...snapshot(), routeReady: false }),
    ui => ui.callbacks.snapshot({ ...snapshot(), hasDialog: true }),
    ui => ui.callbacks.snapshot(null),
    ui => ui.dom.window.document.getElementById('tab-home').click(),
    ui => { ui.type('확인 중인 메시지'); ui.submit(); }
  ];
  for (const block of cases) {
    const ui = makeUI();
    try {
      block(ui);
      ui.dom.window.document.getElementById('code-scroll').dispatchEvent(new ui.dom.window.WheelEvent('wheel', { deltaY: -120 }));
      assert.equal(ui.history.length, 0);
    } finally { ui.dom.window.close(); }
  }
  const ui = makeUI();
  try {
    const scroll = ui.dom.window.document.getElementById('code-scroll');
    scroll.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { deltaX: 120, deltaY: 0 }));
    assert.equal(ui.history.length, 0, 'a horizontal scroll is not a history request');
    scroll.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { deltaY: -120, ctrlKey: true }));
    assert.equal(ui.history.length, 0, 'a zoom or trackpad pinch is not a history request');
    scroll.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { deltaY: -120 }));
    scroll.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { deltaY: -120 }));
    assert.equal(ui.history.length, 1, 'only one history request can be pending');
  } finally { ui.dom.window.close(); }
});

test('attachment hover stays stable within syntax spans and releases image sources when dismissed or logged out', () => {
  const media = [{ name: 'image.png', type: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/image.png' }];
  const initialSnapshot = { ...snapshot(), rows: [{ ...snapshot().rows[0], media }] };
  const ui = makeUI({ initialSnapshot });
  try {
    const win = ui.dom.window, document = win.document;
    const attachment = document.querySelector('.code-media');
    const spans = [...attachment.querySelectorAll('span')];
    const preview = document.getElementById('media-preview'), image = document.getElementById('preview-image');
    attachment.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    assert.equal(preview.hidden, false);
    assert.equal(image.src, media[0].url);
    const changes = new win.MutationObserver(() => {});
    changes.observe(image, { attributes: true, attributeFilter: ['src'] });
    spans[0].dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: spans[1] }));
    spans[1].dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: spans[0] }));
    assert.equal(preview.hidden, false, 'moving between highlighted tokens does not hide the preview');
    assert.equal(changes.takeRecords().length, 0, 'moving within one attachment does not reload the image');
    changes.disconnect();
    attachment.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    assert.equal(preview.hidden, true);
    assert.equal(image.hasAttribute('src'), false, 'hidden previews release their image source');
    attachment.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    document.getElementById('code-scroll').dispatchEvent(new win.Event('scroll'));
    assert.equal(image.hasAttribute('src'), false);
    attachment.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    ui.callbacks.snapshot({ ...snapshot(), reset: true, loggedIn: false, route: '/login', rows: [] });
    assert.equal(preview.hidden, true);
    assert.equal(image.hasAttribute('src'), false, 'a previous account image is released on reset');
    assert.equal(document.getElementById('preview-name').textContent, '');
  } finally { ui.dom.window.close(); }
});

test('message times retain the existing Korean display across calendar boundaries and malformed values', () => {
  const ui = makeUI();
  try {
    const format = ui.dom.window.VDCUI.readableTime;
    const options = { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    for (const value of ['2026-11-03T12:00:00Z', '2026-12-31T23:59:00Z', '2027-01-01T00:00:00+09:00', '2026-06-01T12:00:00-04:00']) {
      assert.equal(format(value), new Date(value).toLocaleString('ko-KR', options));
    }
    for (const value of ['', '어제', '2026-99-99T99:99:99Z']) assert.equal(format(value), value);
    assert.equal(format(undefined), '');
  } finally { ui.dom.window.close(); }
});
