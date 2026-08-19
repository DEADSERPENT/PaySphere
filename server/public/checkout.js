(function () {
  const form = document.getElementById('checkout-form');
  const payButton = document.getElementById('pay-button');
  const payButtonLabel = payButton.querySelector('.pay-btn-label');
  const statusEl = document.getElementById('status');
  const orderIdInput = document.getElementById('orderId');
  const amountInput = document.getElementById('amount');
  const quickAmounts = document.querySelectorAll('.chip');

  orderIdInput.value = `DEMO-${Date.now()}`;

  quickAmounts.forEach((chip) => {
    chip.addEventListener('click', () => {
      amountInput.value = chip.dataset.amount;
      quickAmounts.forEach((c) => c.classList.toggle('is-active', c === chip));
    });
  });

  amountInput.addEventListener('input', () => {
    const current = amountInput.value;
    quickAmounts.forEach((c) => c.classList.toggle('is-active', c.dataset.amount === current));
  });

  function showStatus(kind, message) {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = message;
  }

  function setLoading(isLoading) {
    payButton.disabled = isLoading;
    payButton.classList.toggle('is-loading', isLoading);
    payButtonLabel.textContent = isLoading ? 'Processing…' : 'Pay now';
  }

  async function fetchConfig() {
    const res = await fetch('/api/v1/config');
    if (!res.ok) throw new Error('Failed to load checkout configuration');
    return res.json();
  }

  async function createPayment({ orderId, amountInPaise, currency }) {
    const res = await fetch('/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${orderId}-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ orderId, amount: amountInPaise, currency }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body.error && body.error.message) || 'Failed to create payment');
    return body;
  }

  async function verifyPayment(paymentId, { gatewayOrderId, gatewayPaymentId, signature }) {
    const res = await fetch(`/api/v1/payments/${paymentId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayOrderId, gatewayPaymentId, signature }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body.error && body.error.message) || 'Verification failed');
    return body;
  }

  // Best-effort audit trail only -- this is a client-reported signal, never
  // authoritative, so a failure here must never block showing the user
  // their error message (which is why callers don't await/surface errors
  // from this beyond a console warning).
  function reportPaymentFailure(paymentId, error) {
    fetch(`/api/v1/payments/${paymentId}/report-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: error && error.code,
        description: error && error.description,
        gatewayPaymentId: error && error.metadata && error.metadata.payment_id,
      }),
    }).catch((err) => console.warn('Failed to report payment failure to PaySphere:', err));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setLoading(true);
    showStatus('info', 'Creating order…');

    try {
      const config = await fetchConfig();
      if (!config.razorpayKeyId) {
        throw new Error('Server has no Razorpay key configured');
      }

      const amountInRupees = parseFloat(amountInput.value);
      const amountInPaise = Math.round(amountInRupees * 100);
      const orderId = orderIdInput.value;
      const currency = 'INR';

      const payment = await createPayment({ orderId, amountInPaise, currency });

      const options = {
        key: config.razorpayKeyId,
        amount: amountInPaise,
        currency,
        order_id: payment.gatewayOrderId,
        name: 'PaySphere Demo',
        description: `Order ${orderId}`,
        handler: async function handleCheckoutSuccess(response) {
          showStatus('info', 'Verifying payment…');
          try {
            const verified = await verifyPayment(payment.paymentId, {
              gatewayOrderId: response.razorpay_order_id,
              gatewayPaymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            });
            showStatus('success', `Payment successful — thank you! Order ${orderId} is confirmed.`);
          } catch (err) {
            showStatus('error', `Payment could not be verified: ${err.message}`);
          } finally {
            setLoading(false);
          }
        },
        modal: {
          ondismiss: function handleModalDismiss() {
            showStatus('error', 'Checkout was cancelled.');
            setLoading(false);
          },
        },
        theme: { color: '#ff6b4a' },
      };

      const razorpayCheckout = new Razorpay(options);
      razorpayCheckout.on('payment.failed', function handlePaymentFailed(response) {
        const description = (response.error && response.error.description) || 'Payment failed';
        showStatus('error', description);
        setLoading(false);
        reportPaymentFailure(payment.paymentId, response.error);
      });

      showStatus('info', 'Opening Razorpay checkout…');
      razorpayCheckout.open();
    } catch (err) {
      showStatus('error', err.message);
      setLoading(false);
    }
  });
})();
