#!/usr/bin/env bash
# Plan v3 U9a — CI grep gate for legacy types and redact副本漂移检测。
#
# Phase A 期间 SCAN_MODE=warn（命中只 warn 不 fail）；Phase B (U9c) 改 fail。
#
# Detects:
#   - Legacy domain types not yet removed (Phase A 期间 backfill 模块允许)
#   - responseMode:"full" / topologyFullAllowed 字符串（U4b 后应消失）
#   - redact 函数定义的多副本（防 U2b 抽出后 Node/TS 端再次散落）
#
# Excludes:
#   - 测试 / fixture / spike code
#   - 既有 backfill 模块（Phase A 期间合法持有 canonical 副本）
#   - 文档目录（plan/brainstorm 引用历史命名）

set -euo pipefail

SCAN_MODE="${SCAN_MODE:-warn}"

LEGACY_PATTERN='IntermediateTopology|CanonicalTsnProjectV0|intermediateToCanonicalProject|canonicalTopologyToIntermediate|responseMode\s*:\s*"full"|topologyFullAllowed'

LEGACY_HITS=$(git grep -nE "$LEGACY_PATTERN" -- \
    'src/' 'src-node/' \
    ':(exclude)*.test.*' \
    ':(exclude)*.spec.*' \
    ':(exclude)src/test/*' \
    ':(exclude)src-tauri/src/topology_backfill*' \
    ':(exclude)tmp/*' \
    || true)

# Redact 副本检测：模块名称定义出现次数（>1 表明 U2b 抽出后又新增散落定义）。
REDACT_DEFS=$(git grep -lnE '^[[:space:]]*(pub )?(fn redact_secrets|fn redact_error|fn redact_token_like_word|function redactSecrets|function redactError)' -- \
    'src/' 'src-node/' 'src-tauri/' \
    ':(exclude)src-tauri/src/redaction.rs' \
    ':(exclude)*.test.*' \
    ':(exclude)*.spec.*' \
    ':(exclude)tmp/*' \
    || true)

EXIT_CODE=0
LEGACY_COUNT=$(printf "%s" "$LEGACY_HITS" | grep -c '^' || true)
REDACT_COUNT=$(printf "%s" "$REDACT_DEFS" | grep -c '^' || true)

if [ "$LEGACY_COUNT" -gt 0 ]; then
    echo ""
    echo "[legacy types] $LEGACY_COUNT hits:"
    printf "%s\n" "$LEGACY_HITS"
    EXIT_CODE=1
fi

if [ "$REDACT_COUNT" -gt 0 ]; then
    echo ""
    echo "[redact drift] $REDACT_COUNT files redefining redact functions outside src-tauri/src/redaction.rs:"
    printf "%s\n" "$REDACT_DEFS"
    EXIT_CODE=1
fi

if [ "$EXIT_CODE" -eq 0 ]; then
    echo "OK: no legacy types or redact drift detected."
    exit 0
fi

if [ "$SCAN_MODE" = "warn" ]; then
    echo ""
    echo "⚠️  Phase A warning (SCAN_MODE=warn): CI passes; will fail in Phase B (U9c)."
    exit 0
fi

echo ""
echo "❌ Phase B grep gate failed (SCAN_MODE=fail)."
exit 1
