#!/usr/bin/env bats
#
# The test harness itself: scripts/tests/helpers/stubs.bash (R5.3).
#
# Every other file in this suite depends on one property — that `gh` and `act`
# resolve to doubles and never to the real binaries. If that wiring silently
# breaks, the suite stops being a test and starts making network calls and
# starting containers. So the wiring is asserted rather than assumed.
#
# Contract:
#   stubs_init            creates a stub directory and puts it first on PATH,
#                         exporting STUB_DIR and STUB_LOG.
#   stub_bin NAME [EXIT]  installs an executable NAME that records
#                         "NAME <args>" in STUB_LOG and exits EXIT (default 0).
#   stub_calls NAME       prints the recorded invocations of NAME.

setup() {
  HELPER="$BATS_TEST_DIRNAME/helpers/stubs.bash"
  if [ ! -f "$HELPER" ]; then
    printf 'expected the stub harness at scripts/tests/helpers/stubs.bash\n' >&2
    return 1
  fi
  # shellcheck source=/dev/null
  source "$HELPER"
  ORIGINAL_PATH="$PATH"
}

teardown() {
  PATH="${ORIGINAL_PATH:-$PATH}"
}

@test "stubs_init puts its own directory first on PATH" {
  stubs_init
  [ -d "$STUB_DIR" ]
  [ "${PATH%%:*}" = "$STUB_DIR" ]
}

@test "a stubbed gh shadows the real GitHub CLI" {
  stubs_init
  stub_bin gh
  [ "$(command -v gh)" = "$STUB_DIR/gh" ]
}

@test "a stubbed act shadows the real local runner" {
  stubs_init
  stub_bin act
  [ "$(command -v act)" = "$STUB_DIR/act" ]
}

@test "a stub records the arguments it was called with" {
  stubs_init
  stub_bin gh
  [ -z "$(stub_calls gh)" ]

  gh pr view 77 --json statusCheckRollup

  stub_calls gh | grep -qF 'pr view 77 --json statusCheckRollup'
}

@test "a stub reports the exit status it was given" {
  stubs_init
  stub_bin act 1

  run act -j build
  [ "$status" -eq 1 ]
  stub_calls act | grep -qF -- '-j build'
}

@test "stubs are per-test: one test's recordings do not leak into the next" {
  stubs_init
  stub_bin gh
  [ -z "$(stub_calls gh)" ]

  gh auth status
  [ -n "$(stub_calls gh)" ]
}
