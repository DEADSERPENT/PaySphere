const webhookService = require('../services/webhookService');
const { asyncHandler } = require('../middleware/errorHandler');

const razorpay = asyncHandler(async (req, res) => {
  const signature = req.header('x-razorpay-signature');
  const eventId = req.header('x-razorpay-event-id');
  const result = await webhookService.handleRazorpayWebhook({ rawBody: req.rawBody, signature, eventId });
  res.status(200).json({ status: result.status });
});

module.exports = { razorpay };
