#!/usr/bin/env bats
#
# What scripts/ci-attest.sh runs, and what it must not disturb while running it
# (R1.1, R1.6, R2.1).
#
# The four jobs GitHub never dispatches on a release PR are `build` from ci.yml
# and `gitleaks`, `osv-scan`, `npm-audit` from security.yml. They must be run
# from the repository's own workflow files — a modified copy would attest
# something other than what CI would do — and the run must leave the checkout as
# it found it, lockfile included.
#
# `act`, `gh` and the container runtime are replaced by doubles first on PATH
# that record their arguments (R5.3).

HEAD_SHA=1111111111111111111111111111111111111111

setup() {
  # Where the doubles live, and the fact that they come first on PATH, is the
  # harness's business — scripts/tests/harness.bats is where that property is
  # asserted. The doubles written into that directory below stay here: they are
  # richer than stub_bin, answering from fixtures and branching on the outcome a
  # test asked for.
  # shellcheck source=/dev/null
  source "$BATS_TEST_DIRNAME/helpers/stubs.bash"
  stubs_init
  STUB="$STUB_DIR"

  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci-attest.sh"
  FIX="$BATS_TEST_TMPDIR/fixtures"
  WORK="$BATS_TEST_TMPDIR/work"
  GH_LOG="$BATS_TEST_TMPDIR/gh.log"
  ACT_LOG="$BATS_TEST_TMPDIR/act.log"
  mkdir -p "$FIX"
  : >"$GH_LOG"
  : >"$ACT_LOG"
  export FIX GH_LOG ACT_LOG

  write_gh_stub
  write_act_stub
  write_runtime_stubs

  make_repo
  fixtures_open_release_pr
}

# Test double for the GitHub CLI: records the call — including a payload passed
# on stdin — and answers from a fixture. A status publication is recorded, never
# sent.
write_gh_stub() {
  cat >"$STUB/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "$*" in *--input*) cat >>"$GH_LOG" ;; esac

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
  list) emit "$FIX/pr-list.json" ;;
  view) emit "$FIX/pr-view.json" ;;
  *) exit 0 ;;
  esac
  ;;
api)
  case "$*" in
  *statuses/*) printf '{"state":"recorded"}\n' ;;
  *pulls*) emit "$FIX/pr-list.json" ;;
  *) printf '{}\n' ;;
  esac
  ;;
*) exit 0 ;;
esac
SH
  chmod +x "$STUB/gh"
}

# Stands in for the local runner: records every invocation and reports the
# outcome the test asked for. No container is started.
write_act_stub() {
  cat >"$STUB/act" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$ACT_LOG"

if [ -n "${ACT_RUNTIME_DOWN:-}" ]; then
  printf 'Error: failed to connect to docker daemon: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' >&2
  exit 1
fi

job=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
  -j | --job) job="${args[i + 1]}" ;;
  esac
done

# A step the local runner cannot reproduce: harden-runner has no equivalent
# outside GitHub's infrastructure.
if [ -n "${ACT_ENV_FAIL_JOB:-}" ] && [ "$job" = "$ACT_ENV_FAIL_JOB" ]; then
  printf '[%s] Run Main Harden the runner (Audit all outbound calls)\n' "$job"
  printf '[%s] Failure - Main Harden the runner (Audit all outbound calls)\n' "$job"
  printf "Error: Job '%s' failed\n" "$job" >&2
  exit 1
fi

# A step that failed on its own merits.
if [ -n "${ACT_FAIL_JOB:-}" ] && [ "$job" = "$ACT_FAIL_JOB" ]; then
  printf '[%s] Run Main npm run test:run\n' "$job"
  printf '[%s] Failure - Main npm run test:run\n' "$job"
  printf "Error: Job '%s' failed\n" "$job" >&2
  exit 1
fi

printf '[%s] Success - Main Run tests\n' "${job:-list}"
exit 0
SH
  chmod +x "$STUB/act"
}

write_runtime_stubs() {
  local bin
  for bin in docker podman; do
    cat >"$STUB/$bin" <<'SH'
#!/usr/bin/env bash
if [ -n "${ACT_RUNTIME_DOWN:-}" ]; then
  printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' >&2
  exit 1
fi
printf 'Server Version: 29.7.2\n'
exit 0
SH
    chmod +x "$STUB/$bin"
  done
}

fixtures_open_release_pr() {
  printf '%s\n' '{"nameWithOwner":"acme/widget"}' >"$FIX/repo.json"
  printf '%s\n' "[{\"number\":77,\"title\":\"chore(main): release 0.8.0\",\"headRefName\":\"release-please--branches--main\",\"headRefOid\":\"$HEAD_SHA\",\"labels\":[{\"name\":\"autorelease: pending\"}]}]" >"$FIX/pr-list.json"
  printf '%s\n' "{\"number\":77,\"title\":\"chore(main): release 0.8.0\",\"headRefName\":\"release-please--branches--main\",\"headRefOid\":\"$HEAD_SHA\",\"state\":\"OPEN\"}" >"$FIX/pr-view.json"
}

# A checkout shaped like the two repositories this script ships in: its own
# workflows, a lockfile, and a remote that is neither of theirs.
make_repo() {
  mkdir -p "$WORK/.github/workflows" "$WORK/scripts"
  cat >"$WORK/.github/workflows/ci.yml" <<'YML'
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: step-security/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920
      - name: Use Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          cache: "npm"
      - name: Run tests
        run: npm run test:run
YML
  cat >"$WORK/.github/workflows/security.yml" <<'YML'
name: Security
on:
  pull_request:
    branches: [main]
jobs:
  gitleaks:
    name: Secret scan (gitleaks)
    runs-on: ubuntu-latest
  osv-scan:
    name: Dependency scan (OSV-Scanner)
    runs-on: ubuntu-latest
  npm-audit:
    name: npm audit
    runs-on: ubuntu-latest
YML
  printf '%s\n' '{"name":"widget","version":"0.8.0"}' >"$WORK/package.json"
  printf '%s\n' '{"name":"widget","lockfileVersion":3}' >"$WORK/package-lock.json"
  if [ -f "$SCRIPT" ]; then
    cp "$SCRIPT" "$WORK/scripts/ci-attest.sh"
    chmod +x "$WORK/scripts/ci-attest.sh"
  fi
  git -C "$WORK" init -q
  git -C "$WORK" remote add origin https://github.com/acme/widget.git
  git -C "$WORK" add -A
  git -C "$WORK" -c user.email=test@example.com -c user.name=test commit -qm "fixture"
  # The head of a release PR is a commit that exists. Deriving HEAD_SHA from the
  # fixture rather than inventing one keeps that true here too, which is what lets
  # the script require the object locally before it attests anything against it.
  HEAD_SHA=$(git -C "$WORK" rev-parse HEAD)
  export HEAD_SHA
  return 0
}

require_script() {
  if [ ! -f "$WORK/scripts/ci-attest.sh" ]; then
    printf 'expected scripts/ci-attest.sh to exist\n' >&2
    return 1
  fi
}

attest() {
  (cd "$WORK" && bash scripts/ci-attest.sh "$@")
}

published_statuses() {
  grep -F 'statuses/' "$GH_LOG" || true
}

# The recorded publication for one check, if there is one.
status_for() {
  published_statuses | grep -F "$1" || true
}

@test "runs the four pull_request jobs through act" {
  require_script

  run attest
  [ "$status" -eq 0 ]
  grep -qE -- '(-j|--job)[= ]+build([[:space:]]|$)' "$ACT_LOG"
  grep -qE -- '(-j|--job)[= ]+gitleaks([[:space:]]|$)' "$ACT_LOG"
  grep -qE -- '(-j|--job)[= ]+osv-scan([[:space:]]|$)' "$ACT_LOG"
  grep -qE -- '(-j|--job)[= ]+npm-audit([[:space:]]|$)' "$ACT_LOG"
  grep -q 'pull_request' "$ACT_LOG"
}

@test "uses the repository's own workflow files, writing no modified copy" {
  require_script

  run attest
  [ "$status" -eq 0 ]
  # Whenever a workflow path is passed, it is the repository's own.
  ! grep -oE -- '(-W|--workflows)[= ]+[^ ]+' "$ACT_LOG" | grep -qv '\.github/workflows'
  # And nothing new was left behind next to them.
  [ "$(find "$WORK/.github/workflows" -maxdepth 1 -type f | wc -l)" -eq 2 ]
}

@test "leaves the working tree unmodified" {
  require_script
  local before after
  before=$(sha256sum "$WORK/package-lock.json" | cut -d' ' -f1)

  run attest
  [ "$status" -eq 0 ]

  after=$(sha256sum "$WORK/package-lock.json" | cut -d' ' -f1)
  [ "$before" = "$after" ]
  [ ! -d "$WORK/node_modules" ]
  [ -z "$(git -C "$WORK" status --porcelain)" ]
}

@test "exits zero when all four jobs succeed" {
  require_script

  run attest
  [ "$status" -eq 0 ]
}

@test "exits non-zero and names the failing step when a job fails" {
  require_script
  export ACT_FAIL_JOB=build

  run attest
  [ "$status" -ne 0 ]
  [[ "$output" == *"Build"* || "$output" == *"build"* ]]
  [[ "$output" == *"npm run test:run"* ]]
}
