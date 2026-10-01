'use strict';

class AppError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const err = (status, code) => (message) => new AppError(status, code, message);

const errors = {
  malformedRequest: err(400, 'malformed_request'),
  missingIdempotencyKey: err(400, 'missing_idempotency_key'),
  unauthenticated: err(401, 'unauthenticated'),
  forbidden: err(403, 'forbidden'),
  notFound: err(404, 'not_found'),
  idempotencyKeyReuse: err(409, 'idempotency_key_reuse'),
  emailTaken: err(409, 'email_taken'),
  tableUnavailable: err(409, 'table_unavailable'),
  cutoffPassed: err(409, 'cutoff_passed'),
  reservationCancelled: err(409, 'reservation_cancelled'),
  validationFailed: err(422, 'validation_failed'),
  notOnSlotGrid: err(422, 'not_on_slot_grid'),
  outsideOpeningHours: err(422, 'outside_opening_hours'),
  partyExceedsCapacity: err(422, 'party_exceeds_capacity'),
  invalidLocalTime: err(422, 'invalid_local_time'),
  combinationNotAllowed: err(422, 'combination_not_allowed'),
};

function toEnvelope(e) {
  return { error: { code: e.code, message: e.message } };
}

module.exports = { AppError, errors, toEnvelope };
