const express = require('express');
const webhookController = require('../controllers/webhookController');

const router = express.Router();

router.post('/razorpay', webhookController.razorpay);

module.exports = router;
