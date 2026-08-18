const express = require('express');
const paymentController = require('../controllers/paymentController');
const { validateCreatePayment, validateVerifyPayment, requireIdempotencyKey } = require('../middleware/validation');
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

module.exports = router;
