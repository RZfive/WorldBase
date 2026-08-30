#!/bin/bash
set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
HARNESS_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$HARNESS_ROOT"

echo "🦀 WorldBase P0 骨架测试"
echo

# 检查 API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ ANTHROPIC_API_KEY 未设置"
    echo "请运行: export ANTHROPIC_API_KEY=sk-ant-..."
    exit 1
fi

echo "✅ API key 已设置"
echo

# 构建
echo "📦 构建..."
cargo build --quiet
echo "✅ 构建成功"
echo

# 测试 help
echo "📖 测试 --help..."
./target/debug/worldbase --help
echo

# 测试对话 (简单测试，不依赖工具)
echo "💬 测试对话..."
echo "发送: 'Say hello in Chinese'"
./target/debug/worldbase chat "Say hello in Chinese" | head -20

echo
echo "✅ P0 骨架测试通过！"
