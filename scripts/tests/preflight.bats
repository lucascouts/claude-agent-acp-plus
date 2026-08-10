#!/usr/bin/env bats
#
# Decision-branch coverage for scripts/release-preflight.sh (R5.1).
#
# The script talks to GitHub only through `gh`. Every test replaces `gh` with a
# double placed first on PATH: it records the arguments it was called with and
# answers from JSON fixtures, so no network call is made and no container is
# started (R5.3). The double evaluates the script's own `--jq` program with the
# real `jq`, so the assertions exercise the script's query, not a paraphrase of
# it.
#
# The four checks a release PR must carry are named exactly as the workflows
# declare them, because that string is what appears in statusCheckRollup.

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
# Test double for the GitHub CLI: records the call, answers from a fixture.
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
auth) exit "${GH_AUTH_EXIT:-0}" ;;
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
release) exit "${GH_RELEASE_EXIT:-1}" ;;
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

# The preflight is a read-only inspection (R3.4). Anything that would build,
# test, scan or start a container is replaced by a recorder, so a test can prove
# it was never reached.
write_forbidden_stubs() {
  local bin
  for bin in npm npx act docker podman; do
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
  printf '%s\n' '{"body":"## 0.8.0\n\n* a fix\n\n(https://github.com/acme/widget/compare/v0.7.0...v0.8.0)"}' >"$FIX/pr-body.json"
  rollup "$(check_run Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' SUCCESS)" \
    "$(check_run 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(check_run 'npm audit' SUCCESS)"
}

check_run() {
  printf '{"__typename":"CheckRun","name":"%s","status":"COMPLETED","conclusion":"%s"}' "$1" "$2"
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

@test "refuses when there is no open release PR" {
  printf '%s\n' '[]' >"$FIX/pr-open.json"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"no open release PR"* ]]
}

@test "refuses when a merged release PR is still labelled pending" {
  printf '%s\n' '[{"number":49}]' >"$FIX/pr-merged.json"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"#49"* ]]
  [[ "$output" == *"jammed"* ]]
}

@test "refuses when release-please intends a tag other than vX.Y.Z" {
  printf '%s\n' '{"body":"(https://github.com/acme/widget/compare/widget-v0.7.0...widget-v0.8.0)"}' >"$FIX/pr-body.json"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"widget-v0.8.0"* ]]
}

@test "refuses when the tag it would create already exists" {
  export GH_RELEASE_EXIT=0

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"v0.8.0 already exists"* ]]
}

@test "refuses when the PR title, package.json and manifest disagree" {
  printf '%s\n' '{"version":"0.7.9"}' >"$FIX/pkg.json"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"mismatch"* ]]
}

@test "refuses when a required check is missing, naming every missing check" {
  rollup "$(check_run Build SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Secret scan (gitleaks)"* ]]
  [[ "$output" == *"Dependency scan (OSV-Scanner)"* ]]
  [[ "$output" == *"npm audit"* ]]
}

@test "refuses when a required check failed" {
  rollup "$(check_run Build SUCCESS)" \
    "$(check_run 'Secret scan (gitleaks)' FAILURE)" \
    "$(check_run 'Dependency scan (OSV-Scanner)' SUCCESS)" \
    "$(check_run 'npm audit' SUCCESS)"

  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"Secret scan (gitleaks)"* ]]
}

@test "accepts when all four required checks succeeded" {
  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ready to release 0.8.0"* ]]
  [ ! -s "$FORBIDDEN_LOG" ]
}
