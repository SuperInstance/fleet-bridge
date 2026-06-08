'use strict';

const path = require('path');
const fs = require('fs');
const { FleetBridge } = require('./fleet-bridge');

const VESSEL_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');

/**
 * Parse a JSON file argument (shard file path).
 */
function loadShard(shardArg) {
  if (!shardArg) return {};
  try {
    // Try as inline JSON first
    return JSON.parse(shardArg);
  } catch (_) {
    // Try as file path
    try {
      return JSON.parse(fs.readFileSync(shardArg, 'utf8'));
    } catch (err) {
      console.error(`[FleetBridge:CLI] Cannot parse shard: ${err.message}`);
      return {};
    }
  }
}

function printHelp() {
  console.log(`
Fleet Bridge — Agent-to-Agent communication bridge

USAGE:
  fleet-bridge.js <command> [options]

COMMANDS:
  start                   Start the bridge daemon (watches both I2I and t-minus)
  send <to> <type>        Send a message to an agent
    [shard.json]            Optional shard payload (inline JSON or file path)
    
  beachcomb               Scan I2I harbor for incoming bottles
  
  status                  Show bridge status, route table, and health
  
  register <agentId>      Register an agent with a transport
    <transport>             Transport type: i2i | tminus | both
    [meta.json]             Optional metadata (inline JSON or file path)
  
  deregister <agentId>    Remove an agent from the route table
  
  heartbeat <agentId>     Send a manual heartbeat for an agent
  
  help                    Show this help message

EXAMPLES:
  fleet-bridge.js start
  fleet-bridge.js send oracle2 TASK '{"artifacts":{"code":"ok"},"reasoning":["test"],"blockers":[]}'
  fleet-bridge.js beachcomb
  fleet-bridge.js status
  fleet-bridge.js register forgemaster i2i '{"description":"x86_64 build agent"}'
`);
}

async function cmdStart() {
  const bridge = new FleetBridge({
    vesselDir: VESSEL_DIR,
    agentId: 'bridge',
    pollIntervalMs: 5000
  });

  bridge.init();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[FleetBridge:CLI] Shutting down...');
    bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[FleetBridge:CLI] Terminated');
    bridge.stop();
    process.exit(0);
  });

  await bridge.start();
  console.log('[FleetBridge:CLI] Bridge daemon running. Press Ctrl+C to stop.');

  // Keep alive
  return new Promise(() => {});
}

function cmdSend(to, type, shardArg) {
  const bridge = new FleetBridge({ vesselDir: VESSEL_DIR });
  bridge.init();

  const shard = loadShard(shardArg);
  const result = bridge.send(to, type, shard);
  console.log('[FleetBridge:CLI] Send result:', JSON.stringify(result, null, 2));
}

function cmdBeachcomb() {
  const bridge = new FleetBridge({ vesselDir: VESSEL_DIR });
  bridge.init();

  const bottles = bridge.beachcomb();
  if (bottles.length === 0) {
    console.log('[FleetBridge:CLI] No bottles in harbor');
    return;
  }
  console.log(`[FleetBridge:CLI] Found ${bottles.length} bottles:`);
  for (const b of bottles) {
    console.log(`  - ${b.id || 'unknown'} | ${b.type} | ${b.from} → ${b.to} | ${b.timestamp}`);
  }
}

function cmdStatus() {
  const bridge = new FleetBridge({ vesselDir: VESSEL_DIR });
  bridge.init();
  const status = bridge.status();
  console.log(JSON.stringify(status, null, 2));
}

function cmdRegister(agentId, transport, metaArg) {
  if (!agentId || !transport) {
    console.error('[FleetBridge:CLI] Usage: fleet-bridge.js register <agentId> <i2i|tminus|both> [meta.json]');
    process.exit(1);
  }

  const bridge = new FleetBridge({ vesselDir: VESSEL_DIR });
  bridge.init();
  const meta = loadShard(metaArg);
  bridge.registerAgent(agentId, transport, meta);
  console.log(`[FleetBridge:CLI] Registered: ${agentId} → ${transport}`);
}

function cmdDeregister(agentId) {
  if (!agentId) {
    console.error('[FleetBridge:CLI] Usage: fleet-bridge.js deregister <agentId>');
    process.exit(1);
  }

  const bridge = new FleetBridge({ vesselDir: VESSEL_DIR });
  bridge.init();
  bridge.routes.deregister(agentId);
  bridge.health.deregister(agentId);
  console.log(`[FleetBridge:CLI] Deregistered: ${agentId}`);
}

function cmdHeartbeat(agentId) {
  if (!agentId) {
    console.error('[FleetBridge:CLI] Usage: fleet-bridge.js heartbeat <agentId>');
    process.exit(1);
  }

  const bridge = new FleetBridge({ vesselDir: VESSEL_DIR });
  bridge.init();
  bridge.health.heartbeat(agentId);
  console.log(`[FleetBridge:CLI] Heartbeat recorded for: ${agentId}`);
}

/**
 * CLI entry point. Dispatch commands.
 */
async function run(argv) {
  const cmd = argv[2];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'start':
      await cmdStart();
      break;
    case 'send':
      cmdSend(argv[3], argv[4], argv[5]);
      break;
    case 'beachcomb':
      cmdBeachcomb();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'register':
      cmdRegister(argv[3], argv[4], argv[5]);
      break;
    case 'deregister':
      cmdDeregister(argv[3]);
      break;
    case 'heartbeat':
      cmdHeartbeat(argv[3]);
      break;
    default:
      console.error(`[FleetBridge:CLI] Unknown command: "${cmd}". Run 'fleet-bridge.js help' for usage.`);
      process.exit(1);
  }
}

module.exports = { run, printHelp };
