'use strict';

/**
 * Route Table — Maps agent IDs to transport protocols.
 * Agents can be registered as using 'i2i', 'tminus', or 'both' transport.
 */
class RouteTable {
  /**
   * @param {string} [defaultTransport='i2i'] - Default transport type for new agents
   */
  constructor(defaultTransport = 'i2i') {
    this.defaultTransport = defaultTransport;
    /** @type {Map<string, { transport: string, meta: object }>} */
    this._agents = new Map();
  }

  /**
   * Register an agent with a transport type.
   * @param {string} agentId
   * @param {string} transport - 'i2i', 'tminus', or 'both'
   * @param {object} [meta={}] - Optional metadata (description, capabilities, etc.)
   */
  register(agentId, transport, meta = {}) {
    if (!['i2i', 'tminus', 'both'].includes(transport)) {
      throw new Error(`RouteTable: invalid transport "${transport}". Must be i2i, tminus, or both`);
    }
    this._agents.set(agentId.toLowerCase(), { transport, meta, registered: new Date().toISOString() });
    console.log(`[FleetBridge:RouteTable] Registered ${agentId} → ${transport}`);
  }

  /**
   * Remove an agent from the route table.
   * @param {string} agentId
   * @returns {boolean} true if agent was registered
   */
  deregister(agentId) {
    const key = agentId.toLowerCase();
    const existed = this._agents.has(key);
    if (existed) {
      const entry = this._agents.get(key);
      this._agents.delete(key);
      console.log(`[FleetBridge:RouteTable] Deregistered ${agentId} (was ${entry.transport})`);
    }
    return existed;
  }

  /**
   * Resolve which transport to use for a given agent.
   * @param {string} agentId
   * @returns {string|null} 'i2i', 'tminus', 'both', or null if not found
   */
  resolve(agentId) {
    const entry = this._agents.get(agentId.toLowerCase());
    return entry ? entry.transport : null;
  }

  /**
   * Get the full entry for an agent.
   * @param {string} agentId
   * @returns {{ transport: string, meta: object, registered: string }|null}
   */
  get(agentId) {
    return this._agents.get(agentId.toLowerCase()) || null;
  }

  /**
   * List all registered agents.
   * @returns {Array<{ agentId: string, transport: string, meta: object, registered: string }>}
   */
  list() {
    const result = [];
    for (const [agentId, entry] of this._agents) {
      result.push({ agentId, ...entry });
    }
    return result;
  }

  /**
   * Get the set of unique transport types in use.
   * @returns {string[]}
   */
  getTransports() {
    const types = new Set();
    for (const entry of this._agents.values()) {
      if (entry.transport === 'both') {
        types.add('i2i');
        types.add('tminus');
      } else {
        types.add(entry.transport);
      }
    }
    return [...types];
  }

  /**
   * Get all agents using a specific transport.
   * @param {string} transport
   * @returns {Array<string>}
   */
  getByTransport(transport) {
    const agents = [];
    for (const [agentId, entry] of this._agents) {
      if (entry.transport === transport || entry.transport === 'both') {
        agents.push(agentId);
      }
    }
    return agents;
  }

  /**
   * Load defaults for the fleet.
   */
  loadDefaults() {
    this.register('oracle2', 'i2i', { description: 'Oracle2 — ARM64 fleet coordinator' });
    this.register('forgemaster', 'i2i', { description: 'Forgemaster — x86_64 build/reflex agent' });
    this.register('oracle1', 'tminus', { description: 'Oracle1 — deprecated, tminus legacy' });
    this.register('bridge-engineer', 'tminus', { description: 'Bridge Engineer — fleet-commander' });
    return this;
  }

  /**
   * Clear all entries.
   */
  clear() {
    this._agents.clear();
    console.log('[FleetBridge:RouteTable] Cleared all entries');
  }
}

module.exports = { RouteTable };
