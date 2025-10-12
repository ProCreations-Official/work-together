#!/bin/bash

# Test script to verify Claude CLI works in non-interactive mode
# This helps diagnose hanging issues

echo "Testing Claude CLI in non-interactive mode..."
echo "================================================"
echo ""

# Test 1: Basic -p flag test
echo "Test 1: Basic prompt with -p flag"
echo "Command: claude -p 'Say hello' --permission-mode bypassPermissions"
echo "Timeout: 30 seconds"
echo ""

timeout 30s claude -p "Say hello" --permission-mode bypassPermissions

if [ $? -eq 124 ]; then
    echo "❌ FAILED: Command timed out after 30 seconds"
    echo "This confirms the hanging issue exists"
else
    echo "✅ PASSED: Command completed successfully"
fi

echo ""
echo "================================================"
echo ""

# Test 2: Check Claude CLI version
echo "Test 2: Claude CLI version"
claude --version || echo "Could not get version"

echo ""
echo "================================================"
echo ""

# Test 3: Check authentication status
echo "Test 3: Authentication check"
if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "✅ ANTHROPIC_API_KEY is set"
else
    echo "⚠️  ANTHROPIC_API_KEY is not set, will use CLI login"
fi

echo ""
echo "Test complete!"
echo ""
echo "If Test 1 timed out, the issue is with Claude CLI itself,"
echo "not with the work-together code. Possible solutions:"
echo "  1. Update Claude CLI: npm install -g @anthropic-ai/claude-code"
echo "  2. Try re-authenticating: claude logout && claude login"
echo "  3. Check for known issues: https://github.com/anthropics/claude-code/issues"
