#!/bin/bash

# RabbitMQ Topology Verification Script
# Verifies all exchanges, queues, and bindings exist in the spraycount vhost

set -e

RABBITMQ_HOST="${RABBITMQ_HOST:-localhost}"
RABBITMQ_PORT="${RABBITMQ_PORT:-15672}"
RABBITMQ_USER="${RABBITMQ_USER:-guest}"
RABBITMQ_PASS="${RABBITMQ_PASS:-guest}"
VHOST="spraycount"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Helper function to check HTTP response
check_resource() {
  local resource_type=$1
  local resource_name=$2
  local endpoint=$3
  
  response=$(curl -s -w "\n%{http_code}" -u "$RABBITMQ_USER:$RABBITMQ_PASS" \
    "http://$RABBITMQ_HOST:$RABBITMQ_PORT/api/$endpoint")
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n-1)
  
  if [ "$http_code" = "200" ]; then
    echo -e "${GREEN}✓${NC} $resource_type: $resource_name"
    ((PASSED++))
    return 0
  else
    echo -e "${RED}✗${NC} $resource_type: $resource_name (HTTP $http_code)"
    ((FAILED++))
    return 1
  fi
}

echo "=========================================="
echo "RabbitMQ Topology Verification"
echo "=========================================="
echo "Host: $RABBITMQ_HOST:$RABBITMQ_PORT"
echo "VHost: $VHOST"
echo ""

# Check RabbitMQ is accessible
echo "Checking RabbitMQ connectivity..."
if ! curl -s -f -u "$RABBITMQ_USER:$RABBITMQ_PASS" \
  "http://$RABBITMQ_HOST:$RABBITMQ_PORT/api/overview" > /dev/null 2>&1; then
  echo -e "${RED}✗ Cannot connect to RabbitMQ at $RABBITMQ_HOST:$RABBITMQ_PORT${NC}"
  exit 1
fi
echo -e "${GREEN}✓ RabbitMQ is accessible${NC}"
echo ""

# Verify Exchanges
echo "Verifying Exchanges..."
check_resource "Exchange" "detection.events" "exchanges/$VHOST/detection.events"
check_resource "Exchange" "health" "exchanges/$VHOST/health"
check_resource "Exchange" "dlx.spraycount" "exchanges/$VHOST/dlx.spraycount"
echo ""

# Verify Queues
echo "Verifying Queues..."
check_resource "Queue" "spindle.entry" "queues/$VHOST/spindle.entry"
check_resource "Queue" "spindle.exit" "queues/$VHOST/spindle.exit"
check_resource "Queue" "health.camera" "queues/$VHOST/health.camera"
check_resource "Queue" "health.model" "queues/$VHOST/health.model"
check_resource "Queue" "health.esp32" "queues/$VHOST/health.esp32"
check_resource "Queue" "dlq.spraycount" "queues/$VHOST/dlq.spraycount"
echo ""

# Verify Bindings (via queue details which include bindings)
echo "Verifying Bindings..."
verify_binding() {
  local queue_name=$1
  local expected_source=$2
  local expected_routing_key=$3
  
  response=$(curl -s -u "$RABBITMQ_USER:$RABBITMQ_PASS" \
    "http://$RABBITMQ_HOST:$RABBITMQ_PORT/api/queues/$VHOST/$queue_name")
  
  if echo "$response" | grep -q "\"source\":\"$expected_source\""; then
    if echo "$response" | grep -q "\"routing_key\":\"$expected_routing_key\""; then
      echo -e "${GREEN}✓${NC} Binding: $expected_source -> $queue_name ($expected_routing_key)"
      ((PASSED++))
      return 0
    fi
  fi
  
  echo -e "${RED}✗${NC} Binding: $expected_source -> $queue_name ($expected_routing_key)"
  ((FAILED++))
  return 1
}

verify_binding "spindle.entry" "detection.events" "entry.count"
verify_binding "spindle.exit" "detection.events" "exit.count"
verify_binding "health.camera" "health" "camera.#"
verify_binding "health.model" "health" "model.#"
verify_binding "health.esp32" "health" "esp32.#"
verify_binding "dlq.spraycount" "dlx.spraycount" "#"
echo ""

# Verify Queue Arguments (DLX and TTL)
echo "Verifying Queue Arguments..."
verify_queue_arg() {
  local queue_name=$1
  local arg_name=$2
  local expected_value=$3
  
  response=$(curl -s -u "$RABBITMQ_USER:$RABBITMQ_PASS" \
    "http://$RABBITMQ_HOST:$RABBITMQ_PORT/api/queues/$VHOST/$queue_name")
  
  if echo "$response" | grep -q "\"$arg_name\":$expected_value"; then
    echo -e "${GREEN}✓${NC} Queue Arg: $queue_name.$arg_name = $expected_value"
    ((PASSED++))
    return 0
  else
    echo -e "${RED}✗${NC} Queue Arg: $queue_name.$arg_name = $expected_value"
    ((FAILED++))
    return 1
  fi
}

verify_queue_arg "spindle.entry" "x-dead-letter-exchange" "\"dlx.spraycount\""
verify_queue_arg "spindle.exit" "x-dead-letter-exchange" "\"dlx.spraycount\""
verify_queue_arg "health.camera" "x-message-ttl" "30000"
verify_queue_arg "health.model" "x-message-ttl" "30000"
verify_queue_arg "health.esp32" "x-message-ttl" "30000"
echo ""

# Summary
echo "=========================================="
echo "Verification Summary"
echo "=========================================="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All topology checks passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ Some topology checks failed!${NC}"
  exit 1
fi
