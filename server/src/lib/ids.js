const { randomUUID } = require('node:crypto');

function prefixed(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

module.exports = {
  paymentIntentId: () => prefixed('pay'),
  paymentOrderId: () => prefixed('pord'),
  paymentAttemptId: () => prefixed('patt'),
  transactionId: () => prefixed('txn'),
  webhookEventId: () => prefixed('whk'),
  idempotencyRecordId: () => prefixed('idem'),
  stateHistoryId: () => prefixed('hist'),
  requestId: () => prefixed('req'),
};
