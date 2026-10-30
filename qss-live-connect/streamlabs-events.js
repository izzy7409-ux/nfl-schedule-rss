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
  function membershipPrice(message) {
    // Memberships may contain a count rather than a monetary amount.
    // Only display a price when Streamlabs supplies formatted currency.
    const formatted = message.displayString || message.display_string || message.amountDisplayString || message.formatted_amount || message.formattedAmount;
    return formatted && /[$€£¥₹₩₽₺₴₪₦₱฿₫]|\b[A-Z]{3}\b/.test(String(formatted)) ? text(formatted, 20) : '';
  }
  function giftCount(message) {
    const candidates = [message.gifted_memberships, message.giftMembershipsCount, message.gift_count, message.quantity, message.count, message.amount];
    for (const candidate of candidates) {
      const count = Number(candidate);
      if (Number.isSafeInteger(count) && count > 0) return count;
    }
    return Array.isArray(message.children) && message.children.length ? message.children.length : null;
  }
  function items(event, clock) {
    if (!event || typeof event !== 'object') return [];
    const scope = text(event.for, 40), type = text(event.type, 30).toLowerCase();
    const messages = Array.isArray(event.message) ? event.message : [event.message];
    const result = [];
    messages.forEach(function(message, index) {
      if (!message || typeof message !== 'object' || message.isTest || message.isPreview || message.repeat) return;
      const memberType = ['subscription', 'sponsor', 'member', 'membership'].includes(type);
      const gift = scope === 'youtube_account' && (type === 'membershipgift' || memberType && Boolean(message.gifter));
      const name = text(gift && (message.gifter_display_name || message.gifter) || message.display_name || message.displayName || message.from_display_name || message.name || message.from, 40);
      if (!name) return;
      let kind, label, value;
      if (scope === 'youtube_account' && type === 'follow') {
        kind = 'subscriber'; label = 'NEW SUB'; value = 'SUBSCRIBED';
      } else if (gift) {
        kind = 'membership'; label = 'GIFTED MEMBERS';
        const count = type === 'membershipgift' ? giftCount(message) : 1, price = membershipPrice(message);
        if (price) { value = price; if (count) label = 'GIFTED ×' + count; }
        else value = count ? count + (count === 1 ? ' GIFT' : ' GIFTS') : 'GIFTED';
      } else if (scope === 'youtube_account' && memberType) {
        kind = 'membership'; label = 'NEW MEMBER';
        const months = Number(message.months);
        value = membershipPrice(message) || (Number.isFinite(months) && months > 0 ? months + (months === 1 ? ' MONTH' : ' MONTHS') : 'MEMBER');
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
  function createReceiver(send) {
    let pending = Promise.resolve();
    return function(payload) {
      const next = pending.catch(function() {}).then(function() { return send(payload); });
      pending = next;
      return next;
    };
  }
  return { items, createReceiver };
});
