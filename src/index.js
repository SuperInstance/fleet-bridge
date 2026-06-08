'use strict';

/**
 * Fleet A2A Bridge — Entry Point
 *
 * Exports all components for programmatic use.
 * When run directly, dispatches to the CLI.
 */

const { FleetBridge } = require('./fleet-bridge');
const { I2IBottleTransport, BOTTLE_TYPES } = require('./i2i-transport');
const { TminusTransport } = require('./tminus-transport');
const { RouteTable } = require('./route-table');
const { HealthMonitor } = require('./health-monitor');
const cli = require('./fleet-bridge-cli');

module.exports = {
  FleetBridge,
  I2IBottleTransport,
  TminusTransport,
  RouteTable,
  HealthMonitor,
  BOTTLE_TYPES
};

// CLI dispatch when run directly
if (require.main === module) {
  cli.run(process.argv).catch(err => {
    console.error(`[FleetBridge] Fatal: ${err.message}`);
    process.exit(1);
  });
}
