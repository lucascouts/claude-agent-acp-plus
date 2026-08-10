# shellcheck shell=bash
#
# Test doubles for the shell suite (R5.3).
#
# Every file under scripts/tests/ depends on one property: `gh` and `act` must
# resolve to a double and never to the real binary. A suite that reaches the
# network or starts a container has stopped being a test. This helper is the
# single place that property is implemented, and scripts/tests/harness.bats is
# where it is asserted.
#
#   stubs_init            creates a stub directory and puts it first on PATH,
#                         exporting STUB_DIR and STUB_LOG.
#   stub_bin NAME [EXIT]  installs an executable NAME that records
#                         "NAME <args>" in STUB_LOG and exits EXIT (default 0).
#   stub_calls NAME       prints the recorded invocations of NAME.
#
# Both paths hang off BATS_TEST_TMPDIR, which bats creates fresh for every
# test, so one test's recordings cannot reach the next one.
#
# This file is sourced, not executed, so it deliberately sets no shell options:
# `set -e`/`set -u` here would silently change how the test that sourced it
# behaves. Each function reports its own errors instead.

# Creates the stub directory, empties the recording log, and puts the directory
# first on PATH. Safe to call more than once within a test.
stubs_init() {
  local base="${BATS_TEST_TMPDIR:-}"
  if [ -z "$base" ]; then
    base=$(mktemp -d "${TMPDIR:-/tmp}/stubs.XXXXXX") || {
      printf 'stubs_init: could not create a scratch directory\n' >&2
      return 1
    }
  fi

  STUB_DIR="$base/stub-bin"
  STUB_LOG="$base/stub-calls.log"
  mkdir -p "$STUB_DIR" || {
    printf 'stubs_init: could not create %s\n' "$STUB_DIR" >&2
    return 1
  }
  : >"$STUB_LOG" || {
    printf 'stubs_init: could not create %s\n' "$STUB_LOG" >&2
    return 1
  }
  export STUB_DIR STUB_LOG

  # First, not merely present: a double that loses a race with the real binary
  # is worse than no double at all.
  case ":$PATH:" in
  ":$STUB_DIR:"*) ;;
  *) PATH="$STUB_DIR:$PATH" ;;
  esac
  export PATH
  # Bash flushes its command hash on a PATH assignment; say so explicitly, so a
  # binary that was already resolved this test still lands on the double.
  hash -r 2>/dev/null || true
}

# Installs an executable NAME in STUB_DIR that appends "NAME <args>" to STUB_LOG
# and exits EXIT (default 0).
#
# The log path is baked into the stub rather than read from its environment, so
# a stub always records into the log of the test that created it, even when the
# code under test runs it with a sanitised environment.
stub_bin() {
  local name="${1:-}" code="${2:-0}" target

  if [ -z "$name" ] || [ "$name" != "${name##*/}" ]; then
    printf 'stub_bin: expected a bare command name, got %s\n' "${name:-<empty>}" >&2
    return 1
  fi
  case $code in
  '' | *[!0-9]*)
    printf 'stub_bin: expected an exit status between 0 and 255, got %s\n' "$code" >&2
    return 1
    ;;
  esac
  if [ "$code" -gt 255 ]; then
    printf 'stub_bin: expected an exit status between 0 and 255, got %s\n' "$code" >&2
    return 1
  fi
  if [ -z "${STUB_DIR:-}" ] || [ -z "${STUB_LOG:-}" ]; then
    printf 'stub_bin: call stubs_init before installing a stub\n' >&2
    return 1
  fi

  target="$STUB_DIR/$name"
  {
    printf '#!/usr/bin/env bash\n'
    printf '__stub_name=%q\n' "$name"
    printf '__stub_log=%q\n' "$STUB_LOG"
    # The command line is recorded, never the response: an assertion can then
    # only pass when the code under test really passed that argument.
    cat <<'STUB'
printf '%s\n' "${__stub_name}${*:+ $*}" >>"$__stub_log"
STUB
    printf 'exit %d\n' "$code"
  } >"$target" || {
    printf 'stub_bin: could not write %s\n' "$target" >&2
    return 1
  }
  chmod +x "$target" || {
    printf 'stub_bin: could not make %s executable\n' "$target" >&2
    return 1
  }
}

# Prints the recorded invocations of NAME, one per line, oldest first. Prints
# nothing — and still succeeds — when NAME was never called.
stub_calls() {
  local name="${1:-}" line

  if [ -z "$name" ]; then
    printf 'stub_calls: expected a command name\n' >&2
    return 1
  fi
  if [ -z "${STUB_LOG:-}" ] || [ ! -f "$STUB_LOG" ]; then
    return 0
  fi

  # Matched on the whole first field, so `npm` never reports `npm-audit`'s
  # calls. A read loop rather than grep: a name is a literal here, not a
  # pattern, and nothing has to be escaped for it to stay one.
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
    "$name" | "$name "*) printf '%s\n' "$line" ;;
    esac
  done <"$STUB_LOG"
}
