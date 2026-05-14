const NodeType = {
  POOL: 'pool',
  SOURCE: 'source',
  DRAIN: 'drain',
  GATE: 'gate',
  CONVERTER: 'converter',
  REGISTER: 'register',
  DELAY: 'delay',
};

const ConnectionType = {
  RESOURCE: 'resource',
  STATE: 'state',
};

const ActivationMode = {
  AUTOMATIC: 'automatic',
  PASSIVE: 'passive',
  INTERACTIVE: 'interactive',
  STARTING: 'starting',
};

const NODE_FILL = {
  pool: '#1a3a6b',
  source: '#1a4a2a',
  drain: '#4a1a1a',
  gate: '#3a1a5a',
  converter: '#4a2a00',
  register: '#1a2a38',
  delay: '#004a4a',
};

const NODE_STROKE = {
  pool: '#4a9eff',
  source: '#4caf50',
  drain: '#ef5350',
  gate: '#ba68c8',
  converter: '#ffa726',
  register: '#78909c',
  delay: '#26c6da',
};

let _idSeq = 0;
function genId(prefix) {
  return `${prefix}_${++_idSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

class MNode {
  constructor(type, x, y) {
    this.id = genId('n');
    this.type = type;
    this.x = x;
    this.y = y;
    this.label = type.charAt(0).toUpperCase() + type.slice(1);
    this.activation = ActivationMode.AUTOMATIC;
    this.resources = 0;
    this.capacity = Infinity;
    this._initialResources = 0;

    if (type === NodeType.SOURCE) {
      this.resources = Infinity;
      this._initialResources = Infinity;
    } else if (type === NodeType.REGISTER) {
      this.value = 1;
      this.formula = '';
    } else if (type === NodeType.DELAY) {
      this.delay = 2;
      this._queue = [];
    } else if (type === NodeType.GATE) {
      this.gateMode = 'deterministic';
    }
  }

  get displayCount() {
    if (this.type === NodeType.SOURCE) return '∞';
    if (this.type === NodeType.REGISTER) return this.value;
    return this.resources;
  }

  toJSON() {
    const d = {
      id: this.id, type: this.type, x: this.x, y: this.y,
      label: this.label, activation: this.activation,
      resources: this.type === NodeType.SOURCE ? 0 : this.resources,
      capacity: this.capacity === Infinity ? null : this.capacity,
    };
    if (this.type === NodeType.GATE) d.gateMode = this.gateMode;
    if (this.type === NodeType.REGISTER) { d.value = this.value; d.formula = this.formula; }
    if (this.type === NodeType.DELAY) d.delay = this.delay;
    return d;
  }

  loadJSON(d) {
    Object.assign(this, d);
    this.capacity = d.capacity == null ? Infinity : d.capacity;
    this._initialResources = this.type === NodeType.SOURCE ? Infinity : this.resources;
    if (this.type === NodeType.SOURCE) this.resources = Infinity;
    if (this.type === NodeType.DELAY) this._queue = [];
    return this;
  }
}

class MConnection {
  constructor(sourceId, targetId, type = ConnectionType.RESOURCE) {
    this.id = genId('c');
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.type = type;
    this.rate = 1;
    this.label = '';
  }

  toJSON() {
    return { id: this.id, sourceId: this.sourceId, targetId: this.targetId,
             type: this.type, rate: this.rate, label: this.label };
  }

  loadJSON(d) { Object.assign(this, d); return this; }
}

class Diagram {
  constructor() {
    this.nodes = new Map();
    this.connections = new Map();
  }

  addNode(node) { this.nodes.set(node.id, node); return node; }

  removeNode(id) {
    this.nodes.delete(id);
    for (const [cid, c] of this.connections)
      if (c.sourceId === id || c.targetId === id) this.connections.delete(cid);
  }

  addConnection(conn) { this.connections.set(conn.id, conn); return conn; }
  removeConnection(id) { this.connections.delete(id); }

  outgoing(nodeId) {
    return [...this.connections.values()].filter(c => c.sourceId === nodeId);
  }

  incoming(nodeId) {
    return [...this.connections.values()].filter(c => c.targetId === nodeId);
  }

  toJSON() {
    return {
      nodes: [...this.nodes.values()].map(n => n.toJSON()),
      connections: [...this.connections.values()].map(c => c.toJSON()),
    };
  }

  loadJSON(data) {
    this.nodes.clear();
    this.connections.clear();
    _idSeq = Math.max(_idSeq, data._idSeq || 0);
    for (const nd of data.nodes) {
      const node = new MNode(nd.type, nd.x, nd.y);
      node.loadJSON(nd);
      this.nodes.set(node.id, node);
    }
    for (const cd of data.connections) {
      const conn = new MConnection(cd.sourceId, cd.targetId, cd.type);
      conn.loadJSON(cd);
      this.connections.set(conn.id, conn);
    }
  }
}
