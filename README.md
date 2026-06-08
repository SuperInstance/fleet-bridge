# 🌉 Fleet Bridge

**A2A dual-transport message bridge for the SuperInstance cognitive fleet**

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![SuperInstance](https://img.shields.io/badge/SuperInstance-Fleet-purple)](https://github.com/SuperInstance)

---

Unified message routing between **I2I bottle drops** (file-based inter-agent messaging) and **t-minus WebSocket cues** (real-time temporal dispatch). Fleet Bridge watches both channels, maintains a route table, and can forward messages across transports — making it the central nervous system of the fleet.

---

## Quick Start

```bash
git clone https://github.com/SuperInstance/fleet-bridge
cd fleet-bridge
npm install
npm start
```

## What It Solves

Distributed cognitive agents communicate through different transport mechanisms. Some agents use the I2I bottle protocol (async, file-based, durable) while others use t-minus WebSocket cues (real-time, temporal). Fleet Bridge:

- **Unifies** both transports under a single routing layer
- **Forwards** messages across transports when agents live on different channels
- **Health-monitors** all connections with configurable thresholds
- **Loads** default routes from a declarative route table

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Fleet Bridge                      │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────────────────┐    ┌─────────────────────┐  │
│  │  I2I Bottle         │    │  t-minus WebSocket   │  │
│  │  Transport          │    │  Transport           │  │
│  │  (file-based)       │    │  (real-time)         │  │
│  └────────┬────────────┘    └──────────┬──────────┘  │
│           │                             │            │
│           └──────────┬──────────────────┘            │
│                      │                               │
│              ┌───────┴────────┐                      │
│              │   Route Table  │                      │
│              │   (declarative)│                      │
│              └───────┬────────┘                      │
│                      │                               │
│              ┌───────┴────────┐                      │
│              │ Health Monitor │                      │
│              └────────────────┘                      │
└─────────────────────────────────────────────────────┘
```

### Module Map

```
src/
├── index.js              Entry point — exports all components
├── fleet-bridge.js       FleetBridge — unified router + forwarder
├── i2i-transport.js      I2I bottle transport (file-based)
├── tminus-transport.js   t-minus WebSocket transport
├── route-table.js        Declarative route table
├── health-monitor.js     Connection health monitoring
└── fleet-bridge-cli.js   CLI runner
```

## CLI Usage

```bash
# Start the bridge with default config
npx fleet-bridge

# With custom vessel directory
npx fleet-bridge --vessel-dir /path/to/vessels

# With custom WebSocket URL
npx fleet-bridge --ws-url ws://localhost:8765/ws
```

## API

```js
const { FleetBridge } = require('fleet-bridge');

const bridge = new FleetBridge({
  vesselDir: '/path/to/i2i-vessel',
  wsUrl: 'ws://localhost:8765/ws',
  agentId: 'my-bridge',
  pollIntervalMs: 5000,
  forwarding: true
});

await bridge.init();
await bridge.start();

// Status
const status = bridge.status();
console.log(status);

// Clean shutdown
await bridge.shutdown();
```

## Related Projects

- [⏱️ tminus-dispatcher](https://github.com/SuperInstance/tminus-dispatcher) — Temporal heartbeat for agent coordination
- [🔌 tminus-client](https://github.com/SuperInstance/tminus-client) — Client SDK + CLI
- [🧮 constraint-tminus-bridge](https://github.com/SuperInstance/constraint-tminus-bridge) — Cognitive constraint networks
- [🧠 composite-headspace](https://github.com/SuperInstance/composite-headspace) — Dual-shell parallel reasoning
- [📡 i2i-bottle-agent](https://github.com/SuperInstance/i2i-bottle-agent) — Inter-agent bottle protocol

## License

MIT

---

*Part of the [SuperInstance Fleet](https://github.com/SuperInstance) — The crab inherits the shell. The forge shapes the steel.*
