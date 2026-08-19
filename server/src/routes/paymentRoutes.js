const express = require('express');
const paymentController = require('../controllers/paymentController');
const {
  validateCreatePayment,
  validateVerifyPayment,
  validateReportFailure,
  requireIdempotencyKey,
} = require('../middleware/validation');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

router.post(
  '/',
  requireIdempotencyKey,
  validateCreatePayment,
  idempotency('create_payment'),
  paymentController.create
);

router.get('/:paymentId', paymentController.get);

router.post('/:paymentId/verify', validateVerifyPayment, paymentController.verify);

router.post('/:paymentId/report-failure', validateReportFailure, paymentController.reportFailure);

module.exports = router;
