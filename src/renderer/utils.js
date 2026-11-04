'use strict';
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateTimeFormat = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const readableTime = value => {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value || '')) return value || '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : dateTimeFormat.format(date);
  };
  const reactIcon = '<svg class="react-icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.05"><ellipse cx="12" cy="12" rx="10" ry="3.7"/><ellipse cx="12" cy="12" rx="10" ry="3.7" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="3.7" transform="rotate(120 12 12)"/></g><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>';
  const folderChevron = '<svg class="tree-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';

  window.VDCUI = { escape, readableTime, reactIcon, folderChevron };
})();
