(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QSSStreamlabsEvents = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  function amount(message, micros) {
    const formatted = message.displayString || message.display_string || message.amountDisplayString || message.formatted_amount || message.formattedAmount;
    if (formatted) return text(formatted, 30);
    const raw = message.amount;
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw))) return '';
    const value = Number(raw) / (micros ? 1000000 : 1), currency = text(message.currency || 'USD', 3).toUpperCase();
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value); }
    catch { return value.toFixed(2) + (currency ? ' ' + currency : ''); }
  }
  function items(event, clock) {
    if (!event || typeof event !== 'object') return [];
    const scope = text(event.for, 40), type = text(event.type, 30).toLowerCase();
    const messages = Array.isArray(event.message) ? event.message : [event.message];
    const result = [];
    messages.forEach(function(message, index) {
      if (!message || typeof message !== 'object') return;
      const name = text(message.name || message.display_name || message.displayName || message.from, 40);
      if (!name) return;
      let kind, label, value;
      if (scope === 'youtube_account' && type === 'follow') {
        kind = 'subscriber'; label = 'NEW SUB'; value = 'SUBSCRIBED';
      } else if (scope === 'youtube_account' && ['subscription', 'sponsor', 'member', 'membership'].includes(type)) {
        kind = 'membership'; label = 'NEW MEMBER';
        const months = Number(message.months);
        value = Number.isFinite(months) && months > 0 ? months + (months === 1 ? ' MONTH' : ' MONTHS') : 'MEMBER';
      } else if (scope === 'youtube_account' && ['superchat', 'supersticker'].includes(type)) {
        kind = 'superchat'; label = type === 'supersticker' ? 'SUPER STICKER' : 'SUPERCHAT'; value = amount(message, true);
      } else if ((!scope || scope === 'streamlabs') && type === 'donation') {
        kind = 'donation'; label = 'DONATION'; value = amount(message, false);
      } else return;
      const stamp = message.createdAt || message.publishedAt || message.created_at || '';
      const unique = message._id || (event.event_id ? event.event_id + ':' + index : [scope, type, message.id || name, stamp, value, index].join(':'));
      result.push({ kind, label, name, value, eventId: text(unique, 220), createdAt: stamp || (clock ? clock() : Date.now()) });
    });
    return result;
  }
  return { items };
});
