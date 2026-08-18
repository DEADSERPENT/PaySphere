const crypto = require('node:crypto');
const env = require('../config/env');
const ids = require('../lib/ids');
const metrics = require('../lib/metrics');
const logger = require('../lib/logger');
const idempotencyRepository = require('../repositories/idempotencyRepository');
const { IdempotencyKeyConflictError, IdempotencyInProgressError } = require('../domain/errors');

/**
 * Canonicalizes the fields of the request body that determine "is this the
 * same logical request" so that field order or incidental whitespace in the
 * JSON body doesn't produce a spurious hash mismatch.
 */
function hashRequest(body) {
  const canonical = {
    orderId: body.orderId,
    amount: body.amount,
    currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : body.currency,
    customerReference: body.customerReference || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Enforces the idempotency invariant from spec section 11: the same
 * Idempotency-Key can only ever produce one outcome for the given scope.
 *
 *  - First request for a key: claims the key (DB unique constraint decides
 *    the race winner if two requests arrive concurrently), attaches
 *    req.idempotency for the controller to complete/release, and proceeds.
 *  - Repeat request, same payload, key already COMPLETED: replays the
 *    stored response verbatim without re-running any side effect.
 *  - Repeat request, same key, still IN_PROGRESS and recently claimed (a
 *    concurrent duplicate): rejected with 409 rather than left to race the
 *    in-flight request.
 *  - Repeat request, same key, IN_PROGRESS but older than
 *    idempotencyInProgressTimeoutMs: the original claimant is presumed
 *    crashed (spec section 14 "Worker crash"/section 16 "persist retry
 *    state"), so the key is reclaimed and the request proceeds as if it
 *    were the first attempt.
 *  - Same key, materially different payload, against a COMPLETED record:
 *    rejected with 422 rather than silently returning an unrelated payment
 *    (spec section 11).
 */
function attachIdempotencyContext(req, recordId) {
  req.idempotency = {
    recordId,
    complete: (status, payload) =>
      idempotencyRepository.complete(null, recordId, {
        paymentIntentId: payload && payload.paymentId,
        responseStatus: status,
        responsePayload: payload,
      }),
    release: () => idempotencyRepository.release(null, recordId),
  };
}

function idempotency(scope) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.header('Idempotency-Key');
    const requestHash = hashRequest(req.body || {});
    const recordId = ids.idempotencyRecordId();
    const expiresAt = new Date(Date.now() + env.idempotencyTtlHours * 60 * 60 * 1000);

    try {
      const { claimed, record } = await idempotencyRepository.claim(null, {
        id: recordId,
        scope,
        idempotencyKey: key,
        requestHash,
        expiresAt,
      });

      if (claimed) {
        attachIdempotencyContext(req, recordId);
        return next();
      }

      if (record.status === 'COMPLETED') {
        if (record.request_hash !== requestHash) {
          metrics.idempotencyConflict();
          logger.warn({ scope, key }, 'Idempotency-Key reused with a different request payload');
          return next(
            new IdempotencyKeyConflictError('Idempotency-Key was already used with a different request payload')
          );
        }
        metrics.idempotencyReplay();
        return res.status(record.response_status).json(record.response_payload);
      }

      // status === 'IN_PROGRESS': the earlier claimant may have crashed
      // before completing or releasing it. Attempt to reclaim only if it's
      // older than the in-flight timeout -- a genuinely concurrent request
      // still gets 409 rather than racing the in-flight attempt.
      const staleCutoff = new Date(Date.now() - env.idempotencyInProgressTimeoutMs);
      if (new Date(record.created_at) < staleCutoff) {
        const reclaimed = await idempotencyRepository.reclaimStale(null, {
          scope,
          idempotencyKey: key,
          requestHash,
          expiresAt,
          staleBefore: staleCutoff,
        });
        if (reclaimed) {
          logger.warn({ scope, key }, 'Reclaimed an abandoned in-progress idempotency key');
          attachIdempotencyContext(req, reclaimed.id);
          return next();
        }
      }

      return next(
        new IdempotencyInProgressError('A request with this Idempotency-Key is already being processed')
      );
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { idempotency, hashRequest };
