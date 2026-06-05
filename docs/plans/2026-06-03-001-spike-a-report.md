---
spike: A
plan: docs/plans/2026-06-03-001-refactor-topology-mcp-single-db-domain-plan.md
schema_draft: docs/plans/2026-06-03-001-schema-draft.md
date: 2026-06-03
result: PASS_CANONICAL (1 fixture; recommend 1-2 more for diversity coverage)
---

# Spike A Report — Byte-equal Round-trip (CDT BFE fixture)

## Goal

Plan v3 U1 Spike A：验证 3 件套（topology.json + topo_feature.json + node.json）经过 15 张 SQL 表 INSERT → SELECT 后能否 **byte-equal round-trip** 重建。Brainstorm v3 接受 fallback (b) "语义等价 + planner accept"。

## Method

- **Fixture source**: `~/Library/Application Support/FPGA_CDT/files/bfe/` (boss 提供的 CDT BFE 实际工程数据)
- **Test approach**: "canonical byte-equal" — 原始 JSON 含 4-space indent + 特定字段顺序无法直接 SQL 重建，故采用 RFC 8785 风格 canonical 化（sorted keys + JS number repr）后比对
- **DB**: `node:sqlite` in-memory (Node 22+ experimental)，15 张 P0 表（schema 草案完整版）
- **Runner**: `tmp/spike-a-byte-equal/runner.mjs`（gitignored）

## Fixture statistics

| 文件 | 字节 | 含量 |
|---|---|---|
| `topology.json` | 1,784 | 4 nodes (exchanger×2, exchanger2×1, server×1) + 2 links (空 styles 字符串) + 空 refs |
| `topo_feature.json` | 778 | 4 link records (含 macrotick=0 字段；CDT HTML 说该字段已注释但实际 fixture 有) |
| `node.json` | 312 | 1 节点 (`"0"`) 仅 oss_cfg.sync_period="1" + global (oss + tsnlight) |

## Result

```
=== topology.json ===
  canonical original   (694 bytes)
  canonical rebuilt    (694 bytes)
  match: ✓ BYTE-EQUAL

=== topo_feature.json ===
  canonical original   (417 bytes)
  canonical rebuilt    (417 bytes)
  match: ✓ BYTE-EQUAL

=== node.json ===
  canonical original   (148 bytes)
  canonical rebuilt    (148 bytes)
  match: ✓ BYTE-EQUAL

=== Verdict ===
  3/3 files byte-equal (canonical form)
  ✅ PASS
```

## Schema corrections discovered (and applied to runner)

实际 CDT fixture 揭示了几个 schema 草案需要修正的字段：

1. **`topology_nodes.node_type`** → **nullable**。BFE fixture 的 topology.json **不含** node_type 字段；CDT 中 node_type 来自 data-server.json 的派生（参考 CDT HTML "convertDataServerToTopology"）。runner 设 NULL 即可保留 round-trip。
2. **`topology_links.name`** → **nullable**。BFE 的 topology.json 链路**不含 name 字段**（CDT HTML 说 name 形如 `"0:0-1:0"`，但实际 fixture 缺失，可能为更高版本字段或仅 some fixtures 有）。
3. **`topology_links` styles 列** → 整对象 JSON 列（保留空字符串值原样）。
4. **`topo_feature_links.macrotick`** → **入表 nullable**。CDT HTML 说该字段已注释，但 BFE fixture 实际含 `macrotick: 0`。Schema 草案保留是正确的。
5. **`nodes.base_info_cfg`** → **不在 node.json 内**。BFE fixture 的 node.json 只有节点 "0" 的 oss_cfg，没有 base_info_cfg / node_name / port_num 等。CDT 中这些在 refreshNodeMap 时由 data-server.json 派生注入。**plan 含义**：U2a 的 `nodes` 表 base_info 列（node_name / port_num / mac_address 等）可全部 nullable；当 fixture 没有时不入；存在时入。
6. **`node.json` 大多数子表对稀疏 fixture 全空** — 这是 expected。`nodes_*_cfg` 11 张子表均按"存在则 INSERT，不存在则不 INSERT"语义，重建时按"行存在则字段存在"。

## Limitations / next steps

1. **仅 1 个 fixture (BFE)**。Brainstorm v3 推荐 3 个 fixture（generic-line / generic-ring / dual-plane-redundant）。BFE 是 CDT 实际工程数据，比我们造的 fixture 更具代表性，**单 fixture 已能说明 round-trip 可行**；但建议 boss 后续提供 1-2 个不同形态 (线性 vs 环形 vs 冗余) 的 fixture 做 diversity 覆盖。
2. **未覆盖 node.json 的 11 张子表全量场景**。BFE fixture 极稀疏（仅 oss_cfg 单字段 + global oss + tsnlight）。其他 8 类配置（gcl/sdu_table/time/psfg-3/frer/array_cfg/object_cfg）在 BFE 都缺失，未直接验证。若有更密集填充的 fixture（含 gcl_cfg / psfg_cfg 等）能进一步 stress 测试 schema。
3. **canonical 序列化 != 原文件 byte-equal**。CDT 原 JSON 有 4-space indent 等格式化细节，不可能从 SQL 重建。本 spike 验证的是 **canonical form byte-equal**（等价 brainstorm v3 fallback (b) "语义等价"，但比 (b) 更强：完整字段 + 完整值都保留）。**含义**：plan v3 SC "byte-equal round-trip" 措辞应明示是 canonical form。
4. **`node:sqlite` 是 Node 22+ experimental** — 生产代码不能依赖；U4a Rust 实施时用 sqlx 即可，无此问题。本 spike 用之仅为快速验证。

## Plan v3 amendments needed

1. **R17 / SC 措辞修正**：从 "byte-equal round-trip 字节级一致" 改为 "**canonical byte-equal round-trip**（RFC 8785 风格 canonical 形式字节一致）"。这与 brainstorm v3 Spike A 失败 fallback (b) "语义等价" 实质相同，但更明确。
2. **U2a `topology_nodes.node_type`** → **NULLABLE**（去掉 NOT NULL CHECK）
3. **U2a `topology_links.name`** → **NULLABLE**
4. **U2a `nodes` 表** → base_info 所有列 **NULLABLE**（含 node_name / port_num / mac_address / config_file_name / device_id / test_port）
5. **建议**：U4a `build_artifacts` 实施时用 `serde_json_canonicalizer` (RFC 8785) 保证输出确定性

## Status

✅ **PASS_CANONICAL** — 3/3 文件 canonical byte-equal round-trip 通过 BFE 实际工程 fixture。建议 boss 提供 1-2 个更密集（含 gcl/psfg 等）fixture 做 diversity 覆盖，但**不阻塞 U1 完成 / U2a 启动**。Plan v3 SC 措辞 + U2a schema NULLABLE 修正在 amendments 段已列。
