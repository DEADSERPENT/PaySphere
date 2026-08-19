(function () {
  const card = document.getElementById('checkout-card');
  const cardDefault = document.getElementById('card-default');
  const cardSuccess = document.getElementById('card-success');
  const cardFailure = document.getElementById('card-failure');

  const form = document.getElementById('checkout-form');
  const payButton = document.getElementById('pay-button');
  const payButtonLabel = payButton.querySelector('.pay-btn-label');
  const statusEl = document.getElementById('status');
  const orderIdInput = document.getElementById('orderId');
  const amountInput = document.getElementById('amount');
  const quickAmounts = document.querySelectorAll('.chip');

  const successAmountEl = document.getElementById('success-amount');
  const successOrderIdInput = document.getElementById('success-order-id');
  const failureMessageEl = document.getElementById('failure-message');
  const failureOrderIdInput = document.getElementById('failure-order-id');
  const doneButton = document.getElementById('done-button');
  const retryButton = document.getElementById('retry-button');

  function newOrderReference() {
    return `DEMO-${Date.now()}`;
  }

  orderIdInput.value = newOrderReference();

  function formatRupees(amountInRupees) {
    return `₹${amountInRupees.toFixed(2)}`;
  }

  function updatePayButtonLabel() {
    const amountInRupees = parseFloat(amountInput.value);
    payButtonLabel.textContent = Number.isFinite(amountInRupees) ? `Pay ${formatRupees(amountInRupees)}` : 'Pay now';
  }

  quickAmounts.forEach((chip) => {
    chip.addEventListener('click', () => {
      amountInput.value = chip.dataset.amount;
      quickAmounts.forEach((c) => c.classList.toggle('is-active', c === chip));
      updatePayButtonLabel();
    });
  });

  amountInput.addEventListener('input', () => {
    const current = amountInput.value;
    quickAmounts.forEach((c) => c.classList.toggle('is-active', c.dataset.amount === current));
    updatePayButtonLabel();
  });

  updatePayButtonLabel();

  // Copy-to-clipboard for every read-only order-reference field (the default
  // form's field plus the one shown on the success/failure panels).
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target || !target.value) return;
      try {
        await navigator.clipboard.writeText(target.value);
        btn.classList.add('is-copied');
        setTimeout(() => btn.classList.remove('is-copied'), 1200);
      } catch (err) {
        console.warn('Copy to clipboard failed:', err);
      }
    });
  });

  function showFace(face) {
    cardDefault.hidden = face !== 'default';
    cardSuccess.hidden = face !== 'success';
    cardFailure.hidden = face !== 'failure';
    card.classList.toggle('is-success', face === 'success');
    card.classList.toggle('is-failure', face === 'failure');
  }

  function showStatus(kind, message) {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = message;
  }

  function clearStatus() {
    statusEl.className = 'status';
    statusEl.textContent = '';
  }

  function setLoading(isLoading) {
    payButton.disabled = isLoading;
    payButton.classList.toggle('is-loading', isLoading);
  }

  function showSuccessFace({ amountInRupees, orderId }) {
    successAmountEl.textContent = formatRupees(amountInRupees);
    successOrderIdInput.value = orderId;
    showFace('success');
  }

  function showFailureFace({ message, orderId }) {
    failureMessageEl.textContent = message || "We couldn't complete this payment.";
    failureOrderIdInput.value = orderId || '';
    showFace('failure');
  }

  function resetToDefaultFace() {
    showFace('default');
    clearStatus();
    setLoading(false);
    orderIdInput.value = newOrderReference();
    amountInput.value = '10.00';
    quickAmounts.forEach((c) => c.classList.remove('is-active'));
    updatePayButtonLabel();
  }

  doneButton.addEventListener('click', resetToDefaultFace);
  retryButton.addEventListener('click', () => {
    showFace('default');
    clearStatus();
    setLoading(false);
  });

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
            await verifyPayment(payment.paymentId, {
              gatewayOrderId: response.razorpay_order_id,
              gatewayPaymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            });
            setLoading(false);
            showSuccessFace({ amountInRupees, orderId });
          } catch (err) {
            setLoading(false);
            showFailureFace({ message: `Payment could not be verified: ${err.message}`, orderId });
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
        reportPaymentFailure(payment.paymentId, response.error);
        setLoading(false);
        showFailureFace({ message: description, orderId });
      });

      showStatus('info', 'Opening Razorpay checkout…');
      razorpayCheckout.open();
    } catch (err) {
      showStatus('error', err.message);
      setLoading(false);
    }
  });
})();
