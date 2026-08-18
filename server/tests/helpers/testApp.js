const { createApp } = require('../../src/server');
const gatewayService = require('../../src/services/gatewayService');

if (gatewayService.name !== 'razorpay' || typeof gatewayService.gateway.reset !== 'function') {
  throw new Error(
    'Tests require GATEWAY_ADAPTER=mock (set in .env / TEST_DATABASE_URL setup) so gatewayService.gateway is a MockGatewayAdapter'
  );
}

function buildTestApp() {
  return createApp();
}

/** The live MockGatewayAdapter instance the app under test is wired to. */
const mockGateway = gatewayService.gateway;

module.exports = { buildTestApp, mockGateway };
