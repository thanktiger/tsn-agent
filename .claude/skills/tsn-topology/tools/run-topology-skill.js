#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build, toCanonicalJson } = require('./topology-builder.js');

const skillDir = path.resolve(__dirname, '..');
const targetDir = process.env.TSN_AGENT_SKILL_OUTPUT_DIR;
const intermediatePath = process.argv[2];

if (!intermediatePath || !targetDir) {
  process.stderr.write('Usage: TSN_AGENT_SKILL_OUTPUT_DIR=<dir> node tools/run-topology-skill.js <intermediate.json>\n');
  process.exit(2);
}

fs.mkdirSync(targetDir, { recursive: true });

let built;
try {
  const intermediate = JSON.parse(fs.readFileSync(intermediatePath, 'utf8'));
  const { topology, topoFeature, dataServer, macForwardingTable, displayNames } = build(intermediate);
  built = {
    topology_text: toCanonicalJson(topology),
    topo_feature_text: toCanonicalJson(topoFeature),
    data_server_text: toCanonicalJson(dataServer),
    mac_forwarding_table_text: toCanonicalJson(macForwardingTable),
    display_names: displayNames,
  };
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    stage: 'build',
    error: {
      type: error?.name || 'Error',
      message: error?.message || String(error),
    },
  }, null, 2)}\n`);
  process.exit(1);
}

const files = {
  'topology.json': built.topology_text,
  'topo_feature.json': built.topo_feature_text,
  'data-server.json': built.data_server_text,
  'mac-forwarding-table.json': built.mac_forwarding_table_text,
};

for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(targetDir, name), `${content.trim()}\n`, 'utf8');
}

runChecked('validate-topology.js', [
  path.join(targetDir, 'topology.json'),
  path.join(targetDir, 'topo_feature.json'),
]);
runChecked('validate-mac-forwarding-table.js', [
  path.join(targetDir, 'topology.json'),
  path.join(targetDir, 'mac-forwarding-table.json'),
]);

process.stdout.write(JSON.stringify({
  ok: true,
  target_dir: targetDir,
  files: Object.keys(files),
  display_names: built.display_names ?? [],
}, null, 2));
process.stdout.write('\n');

function runChecked(toolName, args) {
  const result = spawnSync(process.execPath, [path.join(skillDir, 'tools', toolName), ...args], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${toolName} failed\n`);
    process.exit(result.status || 1);
  }

  return result.stdout;
}
