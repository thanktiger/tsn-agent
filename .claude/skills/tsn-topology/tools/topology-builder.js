#!/usr/bin/env node
// topology-builder.js
// 中间表示 -> topology.json + topo_feature.json + data-server.json + mac-forwarding-table.json
// 详细规则: docs/rules.md
//
// 用法:
//   作为库:  const { build } = require('./topology-builder')
//   作为 CLI: cat intermediate.json | node topology-builder.js
//             --help     打印用法
//             stdout JSON: {topology_text, topo_feature_text, data_server_text, mac_forwarding_table_text, display_names}
//             stderr JSON (失败时): {ok:false, stage:'build', error:{type,message}}
//             exit 0 = ok, 1 = build error, 2 = usage/IO error

'use strict';

// ---- 类型常量 ----

const NODE_TYPES = new Set(['switch', 'networkcard', 'server']);
const SPEED_ENUM = new Set([10, 100, 1000, 10000]);

const CLASSPATH = {
  switch: 'Q.Graphs.exchanger2',
  networkcard: 'Q.Graphs.node',
  server: 'Q.Graphs.server',
};

const DISPLAY_PREFIX = {
  switch: 'SW',
  networkcard: 'ES',
  server: 'PC',
};

// data-server.json 字段默认值 (跟 project1225 实测一致, 不是 nodeFormModal 表单默认)
// server 类型字段子集只 4 个 (json/id/src_imac/display_name/node_type), 不填扩展字段
const NODE_FIELD_DEFAULTS = {
  switch:      { buffer_num: 8, queue_num: 3, port_count: 4 },
  networkcard: { buffer_num: 8, queue_num: 3, port_count: 1 },
  server:      null,
};

// 安全上界 (防 DoS 与 MAC 派生溢出)
const MAX_NODE_ID = 0xffff;       // 65535
const MAX_PORT    = 0xffff;
const MAX_NODES   = 1024;
const MAX_LINKS   = 4096;

// ---- MAC / IP 派生 ----

function hex2(n) {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

function deriveMac(nodeId) {
  const hi = (nodeId >> 8) & 0xff;
  const lo = nodeId & 0xff;
  return `00:00:23:00:${hex2(hi)}:${hex2(lo)}`;
}

function deriveIp(nodeId) {
  const hi = (nodeId >> 8) & 0xff;
  const lo = nodeId & 0xff;
  return `192.168.${hi}.${lo}`;
}

// ---- 坐标布局 ----

function isFiniteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasCoordinateField(node) {
  return Object.prototype.hasOwnProperty.call(node, 'x')
    || Object.prototype.hasOwnProperty.call(node, 'y');
}

function readExplicitPosition(node) {
  if (!hasCoordinateField(node)) return undefined;
  if (!isFiniteCoordinate(node.x) || !isFiniteCoordinate(node.y)) {
    throw new Error(`节点 ${node.node_id} 的 x/y 坐标必须同时为有限数字`);
  }
  return { x: Math.round(node.x), y: Math.round(node.y) };
}

function sortLinksForLayout(links) {
  return [...links].sort((a, b) => {
    if (a.src !== b.src) return a.src - b.src;
    if (a.dst !== b.dst) return a.dst - b.dst;
    if (a.src_port !== b.src_port) return a.src_port - b.src_port;
    return a.dst_port - b.dst_port;
  });
}

function computeDefaultLayout(nodes, links) {
  const positions = new Array(nodes.length);
  const idxByNodeId = new Map(nodes.map((n, i) => [n.node_id, i]));
  const switches = nodes.filter((n) => n.node_type === 'switch');

  if (switches.length === 0) {
    nodes.forEach((node, index) => {
      positions[idxByNodeId.get(node.node_id)] = { x: 80 + index * 160, y: 220 };
    });
    return positions;
  }

  const switchIds = new Set(switches.map((n) => n.node_id));
  const switchOrdinalById = new Map();
  const switchXById = new Map();

  switches.forEach((node, index) => {
    const x = 80 + 300 * index;
    switchOrdinalById.set(node.node_id, index + 1);
    switchXById.set(node.node_id, x);
    positions[idxByNodeId.get(node.node_id)] = { x, y: 220 };
  });

  const attachmentByNodeId = new Map();
  for (const link of sortLinksForLayout(links)) {
    const srcIsSwitch = switchIds.has(link.src);
    const dstIsSwitch = switchIds.has(link.dst);
    if (srcIsSwitch === dstIsSwitch) continue;

    const switchId = srcIsSwitch ? link.src : link.dst;
    const otherId = srcIsSwitch ? link.dst : link.src;
    const otherIndex = idxByNodeId.get(otherId);
    const otherNode = nodes[otherIndex];
    if (!otherNode || otherNode.node_type === 'switch') continue;

    const existingSwitchId = attachmentByNodeId.get(otherId);
    if (existingSwitchId === undefined
      || switchOrdinalById.get(switchId) < switchOrdinalById.get(existingSwitchId)) {
      attachmentByNodeId.set(otherId, switchId);
    }
  }

  const attachedBySwitch = new Map(switches.map((n) => [n.node_id, []]));
  const unattached = [];

  for (const node of nodes) {
    if (node.node_type === 'switch') continue;
    const switchId = attachmentByNodeId.get(node.node_id);
    if (switchId !== undefined && attachedBySwitch.has(switchId)) {
      attachedBySwitch.get(switchId).push(node);
    } else {
      unattached.push(node);
    }
  }

  for (const sw of switches) {
    const attachedNodes = attachedBySwitch
      .get(sw.node_id)
      .sort((a, b) => a.node_id - b.node_id);
    const count = attachedNodes.length;
    const switchX = switchXById.get(sw.node_id);

    attachedNodes.forEach((node, index) => {
      const hostIndex = index + 1;
      const yOffset = hostIndex % 2 === 0 ? 390 : 70;
      const xJitter = (hostIndex - Math.ceil(count / 2)) * 62;
      positions[idxByNodeId.get(node.node_id)] = {
        x: switchX + xJitter,
        y: yOffset,
      };
    });
  }

  unattached
    .sort((a, b) => a.node_id - b.node_id)
    .forEach((node, index) => {
      positions[idxByNodeId.get(node.node_id)] = { x: 80 + 160 * index, y: 520 };
    });

  return positions;
}

function computePositions(nodes, links) {
  const defaultPositions = computeDefaultLayout(nodes, links);
  return nodes.map((node, index) => readExplicitPosition(node) ?? defaultPositions[index]);
}

// ---- MAC 转发表 ----

function buildAdjacency(sortedNodes, sortedLinks) {
  const adj = new Map(sortedNodes.map((n) => [n.node_id, []]));
  for (const l of sortedLinks) {
    adj.get(l.src).push({ node_id: l.dst, out_port: l.src_port });
    adj.get(l.dst).push({ node_id: l.src, out_port: l.dst_port });
  }
  for (const edges of adj.values()) {
    edges.sort((a, b) => {
      if (a.node_id !== b.node_id) return a.node_id - b.node_id;
      return a.out_port - b.out_port;
    });
  }
  return adj;
}

function findFirstEgressPort(startNodeId, destinationNodeId, adj) {
  const seen = new Set([startNodeId]);
  const queue = [{ node_id: startNodeId, first_port: undefined }];

  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const edge of adj.get(cur.node_id) || []) {
      if (seen.has(edge.node_id)) continue;
      const firstPort = cur.node_id === startNodeId ? edge.out_port : cur.first_port;
      if (edge.node_id === destinationNodeId) return firstPort;
      seen.add(edge.node_id);
      queue.push({ node_id: edge.node_id, first_port: firstPort });
    }
  }

  return undefined;
}

function buildMacForwardingTable(sortedNodes, sortedLinks, displayNames, imacByNodeId) {
  const displayNameByNodeId = new Map(sortedNodes.map((n, i) => [n.node_id, displayNames[i]]));
  const adj = buildAdjacency(sortedNodes, sortedLinks);
  const entries = [];

  for (const sw of sortedNodes.filter((n) => n.node_type === 'switch')) {
    for (const dst of sortedNodes) {
      if (dst.node_id === sw.node_id) continue;

      const egressPort = findFirstEgressPort(sw.node_id, dst.node_id, adj);
      if (egressPort === undefined) continue;

      entries.push({
        switch_node: sw.node_id,
        switch_imac: imacByNodeId.get(sw.node_id),
        switch_name: displayNameByNodeId.get(sw.node_id),
        destination_node: dst.node_id,
        destination_imac: imacByNodeId.get(dst.node_id),
        destination_mac: deriveMac(dst.node_id),
        destination_name: displayNameByNodeId.get(dst.node_id),
        egress_port: egressPort,
      });
    }
  }

  return {
    version: '1.0',
    entries,
  };
}

// ---- 输入校验 ----

function isUInt16(x) {
  return Number.isInteger(x) && x >= 0 && x <= MAX_NODE_ID;
}

function validateIntermediate(im) {
  if (!im || typeof im !== 'object') throw new Error('intermediate 必须是对象');
  if (!Array.isArray(im.nodes) || im.nodes.length === 0)
    throw new Error('intermediate.nodes 必须是非空数组');
  if (!Array.isArray(im.links)) throw new Error('intermediate.links 必须是数组');

  if (im.nodes.length > MAX_NODES)
    throw new Error(`节点数 ${im.nodes.length} 超过上限 ${MAX_NODES}`);
  if (im.links.length > MAX_LINKS)
    throw new Error(`链路数 ${im.links.length} 超过上限 ${MAX_LINKS}`);

  if (im.imac_base !== undefined && !isUInt16(im.imac_base))
    throw new Error(`imac_base 必须是 [0, ${MAX_NODE_ID}] 范围整数, 实际: ${im.imac_base}`);

  const nodeIds = new Set();
  for (const n of im.nodes) {
    if (!isUInt16(n.node_id))
      throw new Error(`节点 node_id 必须是 [0, ${MAX_NODE_ID}] 范围整数: ${JSON.stringify(n)}`);
    if (nodeIds.has(n.node_id))
      throw new Error(`节点 node_id 重复: ${n.node_id}`);
    nodeIds.add(n.node_id);
    if (!NODE_TYPES.has(n.node_type))
      throw new Error(`非法 node_type: ${n.node_type} (允许 ${[...NODE_TYPES].join('|')})`);
    if (hasCoordinateField(n)) {
      readExplicitPosition(n);
    }
  }

  for (const l of im.links) {
    for (const k of ['src', 'src_port', 'dst', 'dst_port', 'speed']) {
      if (typeof l[k] !== 'number' || !Number.isInteger(l[k]))
        throw new Error(`link 字段 ${k} 必须是整数: ${JSON.stringify(l)}`);
    }
    if (l.src_port < 0 || l.src_port > MAX_PORT)
      throw new Error(`link.src_port 越界 [0, ${MAX_PORT}]: ${l.src_port}`);
    if (l.dst_port < 0 || l.dst_port > MAX_PORT)
      throw new Error(`link.dst_port 越界 [0, ${MAX_PORT}]: ${l.dst_port}`);
    if (!nodeIds.has(l.src))
      throw new Error(`link 引用不存在的 src node_id: ${l.src}`);
    if (!nodeIds.has(l.dst))
      throw new Error(`link 引用不存在的 dst node_id: ${l.dst}`);
    if (l.src === l.dst)
      throw new Error(`link 不支持自环 (src == dst == ${l.src})`);
    if (!SPEED_ENUM.has(l.speed))
      throw new Error(`link speed 非法: ${l.speed} (允许 ${[...SPEED_ENUM].join('|')})`);
  }
}

// ---- 派生 display_name (扫描用户已指定, 自动占用 counter, 最终唯一性检查) ----

function deriveDisplayNames(nodes) {
  // Step 1: 扫描用户给出的 display_name, 提取占用的序号
  const usedSerials = {}; // prefix -> Set<int>
  for (const n of nodes) {
    if (!n.display_name) continue;
    const prefix = DISPLAY_PREFIX[n.node_type];
    if (!usedSerials[prefix]) usedSerials[prefix] = new Set();
    // 解析 "<prefix><n>" 形式
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(n.display_name);
    if (m) usedSerials[prefix].add(parseInt(m[1], 10));
  }

  // Step 2: 给未指定的节点分配最小可用序号
  const names = [];
  const seen = new Set();
  for (const n of nodes) {
    if (n.display_name) {
      names.push(n.display_name);
      continue;
    }
    const prefix = DISPLAY_PREFIX[n.node_type];
    if (!usedSerials[prefix]) usedSerials[prefix] = new Set();
    let serial = 0;
    while (usedSerials[prefix].has(serial)) serial += 1;
    usedSerials[prefix].add(serial);
    names.push(`${prefix}${serial}`);
  }

  // Step 3: 唯一性最终检查 (用户给出的可能跨类型撞名)
  for (const name of names) {
    if (seen.has(name))
      throw new Error(`display_name 冲突: ${name} 被多次使用`);
    seen.add(name);
  }
  return names;
}

// ---- 主入口 build() ----

function build(intermediate) {
  validateIntermediate(intermediate);

  const imacBase = intermediate.imac_base ?? 100;
  const sortedNodes = [...intermediate.nodes].sort(
    (a, b) => a.node_id - b.node_id
  );

  // 按 sorted 顺序分配 imac, 算 position
  const imacByNodeId = new Map();
  sortedNodes.forEach((n, i) => imacByNodeId.set(n.node_id, imacBase + i));

  const positions = computePositions(sortedNodes, intermediate.links);
  const displayNames = deriveDisplayNames(sortedNodes);

  // ---- 构造 topology.nodes (canonical key 顺序) ----
  const topoNodes = sortedNodes.map((n, i) => {
    const imac = imacByNodeId.get(n.node_id);
    const node = {};
    node.imac = imac;
    node.sync_name = String(n.node_id);
    node.x = positions[i].x;
    node.y = positions[i].y;
    node.sync_type = { _classPath: CLASSPATH[n.node_type] };
    node.node_type = n.node_type;
    return node;
  });

  // ---- 构造 topology.links (canonical key 顺序) ----
  const sortedLinks = [...intermediate.links].sort((a, b) => {
    if (a.src !== b.src) return a.src - b.src;
    if (a.src_port !== b.src_port) return a.src_port - b.src_port;
    if (a.dst !== b.dst) return a.dst - b.dst;
    return a.dst_port - b.dst_port;
  });

  const topoLinks = sortedLinks.map((l) => {
    const link = {};
    link.name = `${l.src}:${l.src_port}-${l.dst}:${l.dst_port}`;
    link.styles = {
      leftLabel: String(l.src_port),
      rightLabel: String(l.dst_port),
      speed: l.speed,
    };
    link.imac = imacByNodeId.get(l.src);
    link.addr = imacByNodeId.get(l.dst);
    return link;
  });

  const topology = {
    node: { nodes: topoNodes, links: topoLinks },
    refs: {},
  };

  // ---- 构造 topo_feature (跳过含 server 的边) ----
  const nodeTypeById = new Map(sortedNodes.map((n) => [n.node_id, n.node_type]));
  const topoFeature = [];
  let linkId = 0;

  for (const l of sortedLinks) {
    const srcType = nodeTypeById.get(l.src);
    const dstType = nodeTypeById.get(l.dst);
    // 规则: 跳过含 server 的边 (docs/rules.md §6.3)
    if (srcType === 'server' || dstType === 'server') continue;

    // forward
    topoFeature.push({
      link_id: linkId++,
      src_node: l.src,
      src_port: l.src_port,
      dst_node: l.dst,
      dst_port: l.dst_port,
      speed: l.speed,
      st_queues: 3,
    });
    // reverse
    topoFeature.push({
      link_id: linkId++,
      src_node: l.dst,
      src_port: l.dst_port,
      dst_node: l.src,
      dst_port: l.src_port,
      speed: l.speed,
      st_queues: 3,
    });
  }

  // ---- 构造 data-server.json (Qunee 拓扑图工具的主源格式) ----
  const dataServer = buildDataServer(
    sortedNodes,
    sortedLinks,
    displayNames,
    positions,
    imacByNodeId,
    imacBase
  );

  const macForwardingTable = buildMacForwardingTable(
    sortedNodes,
    sortedLinks,
    displayNames,
    imacByNodeId
  );

  return { topology, topoFeature, dataServer, macForwardingTable, displayNames, imacByNodeId };
}

// ---- data-server.json 构造 ----

// 每条 Q.Edge 的 bindingUIs 模板 (Qunee 渲染端口标签的位置/字体元数据)
function buildBindingUIs(srcPort, dstPort) {
  const LABEL_FONT = 'normal 12px Verdana,helvetica,arial,sans-serif';
  return [
    {
      ui: {
        _className: 'Q.LabelUI',
        json: {
          $position: { horizontalPosition: 'l', verticalPosition: 'b' },
          $anchorPosition: { horizontalPosition: 'l', verticalPosition: 'b' },
          $offsetX: 10,
          $font: LABEL_FONT,
          data: String(srcPort),
        },
      },
      bindingProperties: {
        bindingProperty: 'data',
        property: 'leftLabel',
        propertyType: 1,
        target: {},
      },
    },
    {
      ui: {
        _className: 'Q.LabelUI',
        json: {
          $position: { horizontalPosition: 'r', verticalPosition: 'b' },
          $anchorPosition: { horizontalPosition: 'r', verticalPosition: 'b' },
          $offsetX: -10,
          $font: LABEL_FONT,
          data: String(dstPort),
        },
      },
      bindingProperties: {
        bindingProperty: 'data',
        property: 'rightLabel',
        propertyType: 1,
        target: {},
      },
    },
  ];
}

function buildDataServer(sortedNodes, sortedLinks, displayNames, positions, imacByNodeId, imacBase) {
  const datas = [];

  // Q.Node 先 (按 sync_name 数值升序, 与 topology.json 一致)
  sortedNodes.forEach((n, i) => {
    const imac = imacByNodeId.get(n.node_id);
    const node = {};
    node._className = 'Q.Node';
    node.json = {
      name: String(n.node_id),
      location: {
        _className: 'Q.Point',
        json: { x: positions[i].x, y: positions[i].y, rotate: 0 },
      },
      image: { _classPath: CLASSPATH[n.node_type] },
    };
    node.id = imac;
    node.src_imac = imac;
    node.display_name = displayNames[i];
    node.node_type = n.node_type;
    const extras = NODE_FIELD_DEFAULTS[n.node_type];
    if (extras) {
      node.buffer_num = extras.buffer_num;
      node.queue_num = extras.queue_num;
      node.mac_address = deriveMac(n.node_id);
      node.ip = deriveIp(n.node_id);
      node.port_count = extras.port_count;
    }
    datas.push(node);
  });

  // Q.Edge 后 (按 sortedLinks 顺序, id 紧接 imac 段递增)
  let edgeId = imacBase + sortedNodes.length;
  sortedLinks.forEach((l) => {
    const edge = {};
    edge._className = 'Q.Edge';
    edge.json = {
      name: `${l.src}:${l.src_port}-${l.dst}:${l.dst_port}`,
      from: { _ref: imacByNodeId.get(l.src) },
      to: { _ref: imacByNodeId.get(l.dst) },
      styles: {
        leftLabel: String(l.src_port),
        rightLabel: String(l.dst_port),
        speed: l.speed,
      },
    };
    edge.id = edgeId++;
    edge.bindingUIs = buildBindingUIs(l.src_port, l.dst_port);
    datas.push(edge);
  });

  return {
    version: '2.0',
    refs: {},
    datas,
    scale: 1,
  };
}

// ---- 序列化辅助 ----

function toCanonicalJson(obj) {
  return JSON.stringify(obj, null, 4);
}

// ---- 公共 API ----

module.exports = {
  build,
  buildMacForwardingTable,
  toCanonicalJson,
  validateIntermediate,
  deriveMac,
  deriveIp,
  CLASSPATH,
  NODE_TYPES,
  SPEED_ENUM,
  DISPLAY_PREFIX,
  MAX_NODE_ID,
  MAX_PORT,
  MAX_NODES,
  MAX_LINKS,
};

// ---- CLI 入口 ----

function printHelp() {
  process.stdout.write(
    `topology-builder — 中间表示 → topology.json + topo_feature.json + data-server.json + mac-forwarding-table.json\n\n` +
    `用法:\n` +
    `  cat intermediate.json | node topology-builder.js\n` +
    `  node topology-builder.js --help\n\n` +
    `输入 (stdin, JSON):\n` +
    `  {\n` +
    `    "nodes": [{"node_id": int, "node_type": "switch|networkcard|server", "display_name"?: str, "x"?: number, "y"?: number}],\n` +
    `    "links": [{"src": nodeId, "src_port": int, "dst": nodeId, "dst_port": int, "speed": 10|100|1000|10000}],\n` +
    `    "imac_base"?: int (默认 100)\n` +
    `  }\n\n` +
    `输出 (stdout, JSON):\n` +
    `  {\n` +
    `    "topology_text": "<canonical topology.json>",\n` +
    `    "topo_feature_text": "<canonical topo_feature.json>",\n` +
    `    "data_server_text": "<canonical data-server.json, 供 Qunee 拓扑图工具加载>",\n` +
    `    "mac_forwarding_table_text": "<canonical mac-forwarding-table.json>",\n` +
    `    "display_names": [str, ...]\n` +
    `  }\n\n` +
    `错误输出 (stderr, JSON):\n` +
    `  {"ok": false, "stage": "build", "error": {"type": str, "message": str}}\n\n` +
    `退出码:\n` +
    `  0 = 成功\n` +
    `  1 = 业务错误 (输入校验失败)\n` +
    `  2 = 用法错误 / stdin 不可用\n`
  );
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  if (process.stdin.isTTY) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        stage: 'cli',
        error: { type: 'NoStdin', message: '需 stdin 提供 JSON; 用法见 --help' },
      })}\n`
    );
    process.exit(2);
  }
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const im = JSON.parse(input);
      const { topology, topoFeature, dataServer, macForwardingTable, displayNames } = build(im);
      const out = {
        topology_text: toCanonicalJson(topology),
        topo_feature_text: toCanonicalJson(topoFeature),
        data_server_text: toCanonicalJson(dataServer),
        mac_forwarding_table_text: toCanonicalJson(macForwardingTable),
        display_names: displayNames,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          stage: 'build',
          error: { type: err.name || 'Error', message: err.message },
        })}\n`
      );
      process.exit(1);
    }
  });
}
