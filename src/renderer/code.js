'use strict';
(() => {
  const { escape, readableTime } = window.VDCUI;
  function createWriter(startLine = 0) {
    let lines = startLine;
    return {
      get lines() { return lines; },
      row(html = '', marker = '', metadata = '') {
        lines += 1;
        return `<div class="code-row"${metadata ? ` title="${escape(metadata)}" aria-label="${escape(metadata)}"` : ''}><span class="line-number">${lines}</span><span class="change-marker ${marker}"></span><span class="code-text">${html || ' '}</span></div>`;
      }
    };
  }
  const codeKeywords = new Set(['import', 'from', 'export', 'default', 'const', 'let', 'return', 'if', 'else', 'type', 'interface', 'as', 'new']);
  function highlight(source) {
    // Tokenize plain source before escaping it. Message text never becomes markup.
    const tokens = /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\r\n]*|<\/?[A-Za-z][\w.]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
    let output = '', cursor = 0;
    for (const match of source.matchAll(tokens)) {
      output += escape(source.slice(cursor, match.index));
      const text = match[0];
      const following = source.slice(match.index + text.length);
      const kind = /^['"]/.test(text) ? 'string' : text.startsWith('//') ? 'comment' : codeKeywords.has(text) ? 'keyword' : /^(?:true|false|null|undefined|\d)/.test(text) || text.startsWith('<') ? 'blue' : /^\s*(?:<[^>\r\n]+>)?\s*\(/.test(following) ? 'function' : 'variable';
      output += `<span class="${kind}">${escape(text)}</span>`;
      cursor = match.index + text.length;
    }
    return output + escape(source.slice(cursor));
  }
  const filler = [
    id => [`  const options_${id} = useMemo(() => ({ limit: 50, overscan: 8 }), []);`],
    () => ['  useEffect(() => {', '    root.current?.setAttribute("data-ready", String(enabled));', '  }, [enabled]);'],
    id => [`  const handleChange_${id} = useCallback((value: string) => {`, '    setDraft(value);', '  }, []);'],
    id => [`  const normalized_${id} = useMemo(() => draft.trim(), [draft]);`],
    id => [`  const toggle_${id} = () => setEnabled(current => !current);`],
    id => [`  const styles_${id} = { display: "grid", gap: 8 } as const;`],
    id => [`  const view_${id} = <div className="content" aria-busy={!enabled} />;`],
    id => [`  const state_${id} = useMemo(() => ({`, '    ready: enabled, length: draft.length,', '  }), [enabled, draft]);']
  ];
  function messageCode(message, index, seed, level, row) {
    const id = seed.toString(36);
    const metadata = [message.author, readableTime(message.time)].filter(Boolean).join(' · ');
    const marker = message.own ? 'sent' : 'received';
    let html = '';
    const media = message.media || [];
    if (message.text || !media.length) {
      const value = JSON.stringify(String(message.text || '[첨부 또는 시스템 메시지]'));
      const variants = [
        [`  const label_${id} = ${value};`],
        [`  const item_${id}: ViewItem = {`, `    label: ${value}, enabled,`, '  };'],
        [`  const [value_${id}, setValue_${id}] = useState(${value});`],
        [`  const title_${id} = useMemo(() =>`, `    ${value},`, '  []);'],
        [`  const onSelect_${id} = useCallback(() => {`, `    setDraft(${value});`, '  }, []);'],
        [`  const content_${id} = <span title={${value}} />;`],
        [`  const resolve_${id} = () => ({`, `    value: ${value},`, '  });'],
        [`  const label_${id} = enabled ? ${value} : "";`]
      ];
      for (const line of variants[level ? seed % variants.length : 0]) {
        const carriesMessage = line.includes(value);
        html += row(highlight(line), carriesMessage ? marker : '', carriesMessage ? metadata : '');
      }
    }
    for (const [mediaIndex, item] of media.entries()) {
      const reference = `asset(${JSON.stringify(String(item.name || 'attachment'))})`;
      const button = `<button class="code-media" type="button" data-row="${index}" data-media="${mediaIndex}" aria-label="${escape(item.name || 'attachment')}">${highlight(reference)}</button>`;
      html += row(highlight(`  const resource_${id}_${mediaIndex} = `) + button + ';', marker, metadata);
    }
    if (level >= 4 || (level === 2 && seed % 5 < 3)) {
      html += row();
      const block = (seed >>> 8) % filler.length;
      for (const line of filler[block](id)) html += row(highlight(line));
      if (level === 8) for (const line of filler[(block + 3) % filler.length](id + '_detail')) html += row(highlight(line));
      html += row();
    }
    return `<div class="code-block" data-message-id="${escape(message.id || 'message-' + id)}">${html}</div>`;
  }
  function decorationSeed(message) {
    // Anchor decoration to the message, so refreshes and older history don't shuffle it.
    const key = String(message.id || `${message.author}|${message.time}|${message.text}`);
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return hash >>> 0;
  }
  function compactMessageCode(message, index, row) {
    const metadata = [message.author, readableTime(message.time)].filter(Boolean).join(' · ');
    const marker = message.own ? 'sent' : 'received';
    const media = message.media || [];
    const expressions = [];
    if (message.text || !media.length) {
      const value = JSON.stringify(String(message.text || '[첨부 또는 시스템 메시지]'));
      expressions.push(highlight(`${message.own ? 'setDraft' : 'setValue'}(${value});`));
    }
    for (const [mediaIndex, item] of media.entries()) {
      const reference = `asset(${JSON.stringify(String(item.name || 'attachment'))})`;
      expressions.push(`<button class="code-media" type="button" data-row="${index}" data-media="${mediaIndex}" aria-label="${escape(item.name || 'attachment')}">${highlight(reference)}</button>;`);
    }
    const id = message.id || 'message-' + decorationSeed(message).toString(36);
    return `<div class="code-block live-message" data-message-id="${escape(id)}">${row(expressions.join(' '), marker, metadata)}</div>`;
  }

  // Entries carry their original snapshot index so attachment previews remain aligned.
  function renderCompactMessages(entries, startLine = 0, includeHeader = false) {
    const writer = createWriter(startLine);
    let html = includeHeader ? '<div class="new-messages">' + writer.row(highlight('// New messages')) : '';
    for (const { message, index } of entries) html += compactMessageCode(message, index, writer.row);
    if (includeHeader) html += '</div>';
    return { html, lines: writer.lines };
  }
  function renderCodeDocument(snap, level = 2, liveMessageIds = new Set()) {
    const writer = createWriter();
    const row = writer.row;
    let html = '';
    const opening = [
      'import { useState, useMemo, useCallback, useEffect, useRef } from "react";',
      '',
      'type ViewItem = { label: string; enabled: boolean };',
      'const asset = (name: string) => name;',
      '',
      'export default function ConversationView() {',
      '  const [draft, setDraft] = useState("");',
      '  const [enabled, setEnabled] = useState(true);',
      '  const root = useRef<HTMLElement>(null);',
      '  const handleChange = useCallback((value: string) => {',
      '    setDraft(value);',
      '  }, []);',
      ''
    ];
    for (const line of opening) html += row(highlight(line));
    if (!snap.rows.length) {
      html += row(highlight('// ' + (snap.canSend ? '표시할 메시지가 없습니다. 아래 줄에서 대화를 시작하세요.' : '왼쪽 탐색기에서 대화 파일을 선택하세요.')));
    }
    let previousTime = null;
    const liveRows = [];
    snap.rows.forEach((message, index) => {
      if (liveMessageIds.has(message.id)) {
        liveRows.push({ message, index });
        return;
      }
      const time = new Date(message.time || '');
      if (!Number.isNaN(time.getTime())) {
        if (!previousTime || time.toDateString() !== previousTime.toDateString() || time - previousTime >= 30 * 60 * 1000) {
          html += row(highlight('  // ' + readableTime(message.time)));
        }
        previousTime = time;
      }
      html += messageCode(message, index, decorationSeed(message), level, row);
    });
    const closing = [
      '',
      '  return (',
      '    <section ref={root} className="workspace" data-ready={enabled}>',
      '      <input value={draft} onChange={event => handleChange(event.target.value)} />',
      '    </section>',
      '  );',
      '}',
      ''
    ];
    for (const line of closing) html += row(highlight(line));
    if (liveRows.length) {
      html += '<div class="new-messages">' + row(highlight('// New messages'));
      for (const { message, index } of liveRows) html += compactMessageCode(message, index, row);
      html += '</div>';
    }

    return { html, lines: writer.lines };
  }
  window.VDCUI.renderCodeDocument = renderCodeDocument;
  window.VDCUI.renderCompactMessages = renderCompactMessages;
})();
