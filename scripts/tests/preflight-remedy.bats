#!/usr/bin/env bats
#
# What scripts/release-preflight.sh tells the maintainer, and what it must not
# do while finding out (R3.3, R3.4, R3.5).
#
# A guard that only says "no" trains people to step past it. When a check is
# missing the script has to print the command that produces it, in the same
# `FAIL  <what>\n      <remedy>` shape it already uses for its other refusals.
# It must also stay a read-only inspection: no build, no test, no scan.
#
# `gh` is replaced by a double on PATH; every binary that could build, test,
# scan or start a container is replaced by a recorder, so a test can prove none
# of them was reached (R5.3).

setup() {
  # Where the doubles live, and the fact that they come first on PATH, is the
  # harness's business — scripts/tests/harness.bats is where that property is
  # asserted. The doubles themselves stay here: the gh one answers from
  # fixtures, and the recorders below keep their own FORBIDDEN_LOG, which is
  # the file `[ ! -s "$FORBIDDEN_LOG" ]` reads.
  # shellcheck source=/dev/null
  source "$BATS_TEST_DIRNAME/helpers/stubs.bash"
  stubs_init
  STUB="$STUB_DIR"

  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/release-preflight.sh"
  FIX="$BATS_TEST_TMPDIR/fixtures"
  GH_LOG="$BATS_TEST_TMPDIR/gh.log"
  FORBIDDEN_LOG="$BATS_TEST_TMPDIR/forbidden.log"
  mkdir -p "$FIX"
  : >"$GH_LOG"
  : >"$FORBIDDEN_LOG"
  export FIX GH_LOG FORBIDDEN_LOG

  write_gh_stub
  write_forbidden_stubs

  fixtures_happy_path
}

write_gh_stub() {
  cat >"$STUB/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"

prog=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
  --jq | -q) prog="${args[i + 1]}" ;;
  esac
done

emit() {
  [ -f "$1" ] || { printf 'fixture missing: %s\n' "$1" >&2; exit 1; }
  if [ -n "$prog" ]; then jq -r "$prog" "$1"; else cat "$1"; fi
}

case "$1" in
auth) exit 0 ;;
repo) emit "$FIX/repo.json" ;;
pr)
  case "$2" in
  list)
    case "$*" in
    *"--state merged"*) emit "$FIX/pr-merged.json" ;;
    *) emit "$FIX/pr-open.json" ;;
    esac
    ;;
  view)
    case "$*" in
    *statusCheckRollup*) emit "$FIX/rollup.json" ;;
    *body*) emit "$FIX/pr-body.json" ;;
    *) emit "$FIX/pr-open.json" ;;
    esac
    ;;
  *) exit 0 ;;
  esac
  ;;
release) exit 1 ;;
api)
  case "$*" in
  *release-please-manifest*) emit "$FIX/manifest.json" ;;
  *package.json*) emit "$FIX/pkg.json" ;;
  *) printf '{}\n' ;;
  esac
  ;;
*) exit 0 ;;
esac
SH
  chmod +x "$STUB/gh"
}

write_forbidden_stubs() {
  local bin
  for bin in npm npx act docker podman node vitest eslint; do
    cat >"$STUB/$bin" <<SH
#!/usr/bin/env bash
printf '%s %s\n' "$bin" "\$*" >>"\$FORBIDDEN_LOG"
exit 0
SH
    chmod +x "$STUB/$bin"
  done
}

fixtures_happy_path() {
  printf '%s\n' '{"nameWithOwner":"acme/widget"}' >"$FIX/repo.json"
  printf '%s\n' '[]' >"$FIX/pr-merged.json"
  printf '%s\n' '[{"number":77,"title":"chore(main): release 0.8.0","headRefName":"release-please--branches--main"}]' >"$FIX/pr-open.json"
  printf '%s\n' '{"version":"0.8.0"}' >"$FIX/pkg.json"
  printf '%s\n' '{".":"0.8.0"}' >"$FIX/manifest.json"
  printf '%s\n' '{"body":"(https://github.com/acme/widget/compare/v0.7.0...v0.8.0)"}' >"$FIX/pr-body.json"
  rollup "$(status_context Build SUCCESS)" \
    "$(status_context 'Secret scan (gitleaks)' SUCCESS)" \
    "$(status_context 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(status_context 'npm audit' SUCCESS)"
}

status_context() {
  printf '{"__typename":"StatusContext","context":"%s","state":"%s"}' "$1" "$2"
}

rollup() {
  local joined
  joined=$(printf '%s,' "$@")
  printf '{"statusCheckRollup":[%s]}\n' "${joined%,}" >"$FIX/rollup.json"
}

preflight() {
  (cd "$BATS_TEST_TMPDIR" && bash "$SCRIPT")
}

@test "offers the attestation command as the remedy for a missing check" {
  rollup "$(status_context Build SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  # The remedy is the command that produces the missing checks, named as the
  # maintainer would type it.
  [[ "$output" == *"release:attest"* || "$output" == *"scripts/ci-attest.sh"* ]]
}

@test "reports a missing check in the script's own failure shape" {
  rollup "$(status_context Build SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  # Same prefixes the script already prints: 'ok    ' for a cleared step,
  # 'FAIL  ' for the refusal, remedy indented underneath.
  [[ "$output" == *"ok    "* ]]
  [[ "$output" == *"FAIL  "* ]]
  [[ "$output" == *"npm audit"* ]]
}

@test "keeps the squash-merge command in its success output" {
  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"gh pr merge 77 --squash"* ]]
  [[ "$output" == *"Ready to release 0.8.0"* ]]
}

@test "inspects only: it runs no build, test or scan" {
  run preflight
  [ "$status" -eq 0 ]
  [ ! -s "$FORBIDDEN_LOG" ]
  # Reading is all it does: no mutating gh call either.
  ! grep -qE '(^| )(pr merge|pr edit|release create|api .*(-f|--method (POST|PATCH|PUT)))' "$GH_LOG"
}
