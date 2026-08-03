#!/usr/bin/env bash
set -e

echo "=== CyFHIR Neo4j Auto-Seeder Starting ==="

EXPRESS_URL="${CYFHIR_EXPRESS_URL:-http://cyfhir-express:3001}"
BUNDLES_DIR="${BUNDLES_DIR:-/data/synthea-bundles}"
FHIR_SERVER_URL="${FHIR_SERVER_URL:-http://172.16.12.230:8012/fhir}"

echo "Waiting for CyFHIR Express service at ${EXPRESS_URL} to become healthy..."
until curl -s "${EXPRESS_URL}/docs" > /dev/null 2>&1 || curl -s "${EXPRESS_URL}/" > /dev/null 2>&1; do
  echo "CyFHIR Express not ready yet. Waiting 5 seconds..."
  sleep 5
done

echo "CyFHIR Express is UP!"

# Mode 1: Load all resources from upstream FHIR Server if FHIR_SERVER_URL is defined
if [ -n "$FHIR_SERVER_URL" ]; then
  echo "Found FHIR_SERVER_URL=${FHIR_SERVER_URL}. Triggering /api/LoadAllResources..."
  RESPONSE=$(curl -s -X POST "${EXPRESS_URL}/api/LoadAllResources" \
    -H "Content-Type: application/json" \
    -d "{\"fhirBaseUrl\":\"${FHIR_SERVER_URL}\"}")
  
  echo "Response from LoadAllResources: ${RESPONSE}"
  echo "=== Auto-Seeding from FHIR Server Completed! ==="
# Mode 2: Fallback to local Synthea JSON bundles if available
elif [ -d "$BUNDLES_DIR" ]; then
  echo "Loading local Synthea bundles from ${BUNDLES_DIR}..."
  count=0
  for file in "$BUNDLES_DIR"/*.json; do
    if [ -f "$file" ]; then
      filename=$(basename "$file")
      echo "[Seeding $count] Loading bundle: ${filename}..."
      curl -s -X POST "${EXPRESS_URL}/api/Bundle" \
        -H "Content-Type: application/json" \
        -d @"$file" > /dev/null || echo "Warning: Failed to load ${filename}"
      count=$((count + 1))
    fi
  done
  echo "=== Auto-Seeding from Local Bundles Completed Successfully! Total Bundles Loaded: ${count} ==="
else
  echo "Warning: Neither FHIR_SERVER_URL nor BUNDLES_DIR available for seeding."
fi
