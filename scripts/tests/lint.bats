#!/usr/bin/env bats
#
# The two shell scripts must be lint-clean, and the suite must be reachable the
# way everything else in this repository is reached — through npm (R5.4, R5.5).
#
# A test suite nobody can run from the documented entry point is a suite that
# stops being run.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  PREFLIGHT="$REPO_ROOT/scripts/release-preflight.sh"
  ATTEST="$REPO_ROOT/scripts/ci-attest.sh"
  PACKAGE_JSON="$REPO_ROOT/package.json"
}

@test "shellcheck reports no findings for release-preflight.sh" {
  run shellcheck "$PREFLIGHT"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "shellcheck reports no findings for ci-attest.sh" {
  [ -f "$ATTEST" ]

  run shellcheck "$ATTEST"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "package.json exposes the attestation script through an npm entry" {
  grep -qE '"[^"]+": *"[^"]*scripts/ci-attest\.sh' "$PACKAGE_JSON"
}

@test "package.json exposes the shell test suite through an npm entry" {
  grep -qE '"[^"]+": *"[^"]*bats[^"]*scripts/tests' "$PACKAGE_JSON"
}

@test "the existing release:preflight entry is left in place" {
  grep -qE '"release:preflight": *"[^"]*scripts/release-preflight\.sh' "$PACKAGE_JSON"
}
