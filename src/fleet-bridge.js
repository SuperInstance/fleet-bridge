'use strict';

const path = require('path');
const { I2IBottleTransport } = require('./i2i-transport');
const { TminusTransport } = require('./tminus-transport');
const { RouteTable } = require('./route-table');
const { HealthMonitor } = require('./health-monitor');

/**
 * FleetBridge — Unified message routing with dual transport.
 * Bridges I2I bottle system (file-based) and t-minus WebSocket cues.
 * Watches both channels and can forward messages between them.
 */
class FleetBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.vesselDir] - Path to the I2I vessel directory
   * @param {string} [opts.wsUrl] - WebSocket URL for t-minus dispatcher
   * @param {string} [opts.agentId='bridge'] - This bridge's agent ID
   * @param {number} [opts.pollIntervalMs=5000] - I2I bottle poll interval
   * @param {number} [opts.heartbeatThresholdMs=60000] - Health monitor threshold
   * @param {boolean} [opts.forwarding=true] - Enable cross-transport forwarding
   */
  constructor(opts = {}) {
    this.agentId = opts.agentId || 'bridge';
    this.vesselDir = opts.vesselDir || path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');
    this.wsUrl = opts.wsUrl || 'ws://localhost:8765/ws';
    this.pollIntervalMs = opts.pollIntervalMs || 5000;
    this.forwarding = opts.forwarding !== false;

    // Sub-components
    this.i2i = new I2IBottleTransport({
      vesselDir: this.vesselDir,
      agentId: this.agentId
    });

    this.tminus = new TminusTransport(this.wsUrl);

    this.routes = new RouteTable();
    this.routes.loadDefaults();

    this.health = new HealthMonitor({
      checkInterval: Math.max(this.pollIntervalMs * 2, 10000),
      heartbeatThreshold: opts.heartbeatThresholdMs || 60000
    });

    // Internal state
    this._running = false;
    this._i2iWatcher = null;
    this._statusTimer = null;

    // Cross-transport forward handler references
    this._onI2IBottle = null;
    this._onTminusCue = null;
  }

  /**
   * Initialize: create vessel dirs, load defaults, set up handlers.
   */
  init() {
    this.i2i.init();

    // Register bridge itself in route table
    this.routes.register(this.agentId, 'both', { description: 'FleetBridge — A2A bridge daemon' });

    // Register known fleet agents in health monitor
    for (const entry of this.routes.list()) {
      this.health.register(entry.agentId, entry.transport);
    }

    console.log(`[FleetBridge] ✅ Initialized (agent: ${this.agentId}, vessel: ${this.vesselDir}, ws: ${this.wsUrl})`);
    return this;
  }

  /**
   * Start the bridge daemon — watch both channels.
   */
  async start() {
    if (this._running) {
      console.warn('[FleetBridge] Already running');
      return;
    }
    this._running = true;

    // Start health monitor
    this.health.start();

    // Configure health death/revive handlers
    this.health.onDeath((nodeId, node) => {
      console.warn(`[FleetBridge] ⚠ Node death detected: ${nodeId}`);
    });
    this.health.onRevive((nodeId, node) => {
      console.log(`[FleetBridge] ❤️ Node revived: ${nodeId}`);
    });

    // 1. Watch I2I harbor for incoming bottles
    this._i2iWatcher = this.i2i.watch((bottle) => {
      this._handleIncomingI2I(bottle);
    }, this.pollIntervalMs);

    // 2. Connect t-minus WebSocket
    try {
      await this.tminus.connect();
      console.log('[FleetBridge] ✅ Connected to t-minus dispatcher');
      this.health.heartbeat('tminus-dispatcher');
    } catch (err) {
      console.warn(`[FleetBridge] ⚠ T-minus connection failed (will retry in background): ${err.message}`);
    }

    // 3. Set up t-minus cue handler
    this._onTminusCue = (cue) => {
      this._handleIncomingTminus(cue);
    };
    this.tminus.onCue(this._onTminusCue);

    // 4. Send periodic heartbeat bottles
    this._statusTimer = setInterval(() => {
      if (this._running) {
        this._sendHeartbeat();
      }
    }, Math.max(this.pollIntervalMs * 6, 30000));

    console.log(`[FleetBridge] 🚀 Daemon started (forwarding: ${this.forwarding})`);
  }

  /**
   * Stop the bridge daemon gracefully.
   */
  stop() {
    this._running = false;

    if (this._i2iWatcher) {
      this._i2iWatcher.stop();
      this._i2iWatcher = null;
    }

    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = null;
    }

    this.tminus.disconnect();
    this.health.stop();

    console.log('[FleetBridge] 🛑 Daemon stopped');
  }

  /**
   * Send a message to an agent, auto-routing via the appropriate transport.
   * @param {string} to - Target agent ID
   * @param {string} type - Message type (e.g. 'TASK', 'STATUS', 'CUE')
   * @param {object} payload - Message content (or shard for I2I)
   * @returns {boolean|object} Result of the send
   */
  send(to, type, payload = {}) {
    const transport = this.routes.resolve(to);
    if (!transport) {
      console.warn(`[FleetBridge] Unknown route for "${to}", using i2i default`);
    }

    const useI2I = !transport || transport === 'i2i' || transport === 'both';
    const useTminus = transport === 'tminus' || transport === 'both';

    const results = {};

    if (useI2I) {
      results.i2i = this.i2i.sendBottle(to, type, {
        artifacts: payload.artifacts || payload,
        reasoning: payload.reasoning || [],
        blockers: payload.blockers || []
      });
    }

    if (useTminus) {
      results.tminus = this.tminus.sendCue(this.agentId, to, type, payload);
    }

    this.health.heartbeat(this.agentId);
    return results;
  }

  /**
   * Beachcomb I2I harbor for incoming bottles.
   * @returns {Array<object>} Bottles found
   */
  beachcomb() {
    const bottles = this.i2i.beachcomb();
    this.health.heartbeat(this.agentId);
    return bottles;
  }

  /**
   * Get full status snapshot.
   * @returns {object}
   */
  status() {
    return {
      agentId: this.agentId,
      running: this._running,
      vesselDir: this.vesselDir,
      wsUrl: this.wsUrl,
      forwarding: this.forwarding,
      routes: this.routes.list(),
      health: this.health.status(),
      bottles: this.i2i.listBottles(),
      tminusConnected: this.tminus.isConnected()
    };
  }

  /**
   * Register an agent in the route table and health monitor.
   */
  registerAgent(agentId, transport, meta = {}) {
    this.routes.register(agentId, transport, meta);
    this.health.register(agentId, transport);
  }

  // ---- Internal ----

  /**
   * Handle an incoming I2I bottle from harbor/.
   * If forwarding is on and the sender/receiver uses tminus, forward as a WS cue.
   */
  _handleIncomingI2I(bottle) {
    this.health.heartbeat(bottle.from || 'unknown');

    if (!this.forwarding) return;

    const senderTransport = this.routes.resolve(bottle.from);
    const targetTransport = this.routes.resolve(bottle.to);

    // Forward to tminus if: target is tminus, or sender already uses tminus, or bidirectional needed
    const shouldForwardToTminus = targetTransport === 'tminus' || targetTransport === 'both' ||
                                  senderTransport === 'tminus' || senderTransport === 'both';

    if (shouldForwardToTminus && this.tminus.isConnected()) {
      this.tminus.sendCue(
        bottle.from || this.agentId,
        bottle.to || 'fleet',
        bottle.type || 'BOTTLE',
        bottle.shard || bottle
      );
      console.log(`[FleetBridge] 🔁 Forwarded I2I bottle → t-minus: ${bottle.type} ${bottle.from} → ${bottle.to}`);
    }
  }

  /**
   * Handle an incoming t-minus cue.
   * If forwarding is on and the target uses I2I, drop a bottle.
   */
  _handleIncomingTminus(cue) {
    this.health.heartbeat(cue.from || 'tminus');

    if (!this.forwarding) return;

    const targetTransport = cue.to ? this.routes.resolve(cue.to) : null;

    // Forward to I2I if target is i2i or both
    const shouldForwardToI2I = targetTransport === 'i2i' || targetTransport === 'both';

    if (shouldForwardToI2I && cue.from && cue.to) {
      this.i2i.sendBottle(
        cue.to,
        cue.type || 'CUE',
        {
          artifacts: cue.payload || {},
          reasoning: cue.payload?.reasoning || [],
          blockers: []
        },
        { _origin: 'tminus-forward', _originalTimestamp: cue.timestamp }
      );
      console.log(`[FleetBridge] 🔁 Forwarded t-minus cue → I2I bottle: ${cue.type} ${cue.from} → ${cue.to}`);
    }
  }

  /**
   * Send a periodic heartbeat bottle to signal bridge liveness.
   */
  _sendHeartbeat() {
    const routes = this.routes.list();
    this.i2i.sendBottle('fleet', 'STATUS', {
      artifacts: {
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        routes: routes.length,
        aliveNodes: this.health.aliveNodes().length
      },
      reasoning: ['Periodic fleet heartbeat'],
      blockers: []
    });
    this.health.heartbeat(this.agentId);
  }
}

module.exports = { FleetBridge };
