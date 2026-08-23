#!/usr/bin/env bash
#
# Attest a locally-run CI suite onto the open release PR.
#
# Release PRs are opened by release-please from a branch it owns, and the
# pull_request workflows do not run on them: the checks a reviewer expects are
# not red, they are absent. This script runs those jobs locally and publishes
# the outcome as commit statuses on the PR head, so what was verified is
# recorded on the PR instead of living in someone's terminal.
#
# Takes no argument. The repository comes from the git remote — the same file
# ships in two repositories, so nothing here may name one — and the PR and its
# head SHA come from the repository itself, never from an argument.
#
# Requires an authenticated GitHub CLI and a running container runtime
# (docker or podman). See docs/RELEASES.md.

set -euo pipefail

PENDING_LABEL="autorelease: pending"
USAGE='usage: scripts/ci-attest.sh [--waive "<reason>"]'

bad() {
  printf 'FAIL  %s\n' "$1" >&2
}

warn() {
  printf 'WARN  %s\n' "$1" >&2
}

fail() {
  bad "$1"
  exit 1
}

pass() {
  printf 'ok    %s\n' "$1"
}

# act prints one line per step outcome, shaped
#   [CI/Build] X  Failure - Main Run tests
# with Pre/Post for the phases around it. Real output is coloured and act 0.2.89
# has no flag to turn that off, so the escape sequences come off before anything
# is matched — otherwise a step name would arrive wrapped in bytes no pattern
# expects. The 'Main ' phase marker is dropped because it says nothing; 'Pre'
# and 'Post' stay, because which side of the step failed is a real distinction.
failing_steps() {
  sed -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$1" |
    sed -n 's/.*Failure  *-  *//p' |
    sed -e 's/^Main //'
}

# The steps a local runner is known not to reproduce, and why. Each entry stands
# for exactly one action, and the list stays this short deliberately: a pattern
# broad enough to catch an unrelated step would turn a real defect into
# something waivable, which is the one failure mode this classification exists
# to prevent. Anything unmatched is a genuine failure.
#
# The list below is calibrated against a real run, not against expectation. The
# first two entries were predicted before anything ran; when the four jobs were
# actually executed against release PR #50, both predictions turned out to be
# wrong — harden-runner detects a non-GitHub runner and degrades to a no-op
# rather than failing, and setup-node reports "npm cache is not found" and
# carries on. They stay because degrading gracefully today is not a promise to
# keep doing so. The last three are what genuinely failed, each identified by
# the error it printed rather than by a guess.
environmental_reason() {
  case $1 in
  *harden-runner* | *"Harden the runner"* | *"Harden Runner"*)
    printf '%s' "step-security/harden-runner audits egress from a GitHub-hosted runner and has no equivalent outside that infrastructure"
    ;;
  *setup-node* | *"Use Node.js"* | *"Setup Node.js"*)
    printf '%s' 'actions/setup-node with cache: "npm" reads and writes the GitHub-hosted cache service, which act does not provide'
    ;;
  *"Upload artifact"*)
    # Measured: "::error::Unable to get the ACTIONS_RUNTIME_TOKEN env variable".
    printf '%s' "uploading an artifact needs ACTIONS_RUNTIME_TOKEN, which only a GitHub-hosted runner is issued"
    ;;
  *"Upload to code-scanning"*)
    # Measured: "::error::Not Found - .../rest/actions/workflow-runs".
    printf '%s' "the code-scanning API attaches a SARIF result to a workflow run, and a local run has no run to attach it to"
    ;;
  *"Error troubleshooter"*)
    # A diagnostic step osv-scanner-reusable runs only after an earlier step
    # failed. It is a consequence, never a cause — and it cannot launder a real
    # defect through, because the step that actually broke is in the same list
    # and would not match anything here, which makes the whole job a failure.
    printf '%s' "osv-scanner's diagnostic step, reached only because an upload above it could not run locally"
    ;;
  *) return 1 ;;
  esac
}

# Several steps of one job can fail; the summary needs them on one line.
join_steps() {
  local joined
  joined=$(printf '%s; ' "$@")
  printf '%s' "${joined%; }"
}

# A waiver is a deliberate, attributable act: the reason travels with the status
# so a later reader can tell why a check was let through. '--waive' with no
# reason is a mistake, not a waiver, and is rejected before anything is
# published.
NO_REASON="--waive needs a reason.
      $USAGE
      The reason is published with the status, so it is what tells a later
      reader why a check was waived."

waive_reason=""
while [ $# -gt 0 ]; do
  case $1 in
  --waive)
    waive_reason=${2:-}
    [ -n "$waive_reason" ] || fail "$NO_REASON"
    shift 2
    ;;
  --waive=*)
    waive_reason=${1#*=}
    [ -n "$waive_reason" ] || fail "$NO_REASON"
    shift
    ;;
  -h | --help)
    printf '%s\n' "$USAGE"
    exit 0
    ;;
  *) fail "unknown argument '$1'.
      $USAGE" ;;
  esac
done
[ -z "$waive_reason" ] || pass "waiving with reason: $waive_reason"

command -v gh >/dev/null 2>&1 ||
  fail "GitHub CLI (gh) is not installed."
gh auth status >/dev/null 2>&1 ||
  fail "GitHub CLI is not authenticated. Run 'gh auth login'."

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) ||
  fail "cannot work out which GitHub repository this is. Run from a checkout."
pass "repository: $repo"

# Resolve the target before touching the container runtime: with no release PR
# there is nothing to attest, and starting a job would be work thrown away.
rows=$(gh pr list --repo "$repo" --state open --label "$PENDING_LABEL" \
  --json number,headRefOid,title --jq '.[] | [.number, .headRefOid, .title] | @tsv')
count=$(printf '%s\n' "$rows" | grep -c . || true)

if [ "$count" -eq 0 ]; then
  fail "no open release PR labelled '$PENDING_LABEL'.
      There is nothing to attest: only that PR's head commit can carry these
      statuses. Run scripts/release-preflight.sh to see what state the release
      is in."
fi
if [ "$count" -gt 1 ]; then
  fail "$count open release PRs, expected exactly one:
$rows"
fi
# Split the single row by hand rather than with `read`: tab counts as IFS
# whitespace, so `read` folds a run of tabs into one delimiter and an empty
# field would silently shift the others, making the check below quote a value
# it never examined.
pr_number=${rows%%$'\t'*}
row_tail=${rows#*$'\t'}
head_sha=${row_tail%%$'\t'*}
pr_title=${row_tail#*$'\t'}

# A status attaches to one commit, so the SHA is read off the PR rather than
# accepted as an argument: a hand-typed SHA can be stale or belong to another
# branch, and the attestation would then describe a commit nobody is merging.
case $head_sha in
"" | *[!0-9a-f]*)
  fail "release PR #$pr_number has no usable head SHA ('$head_sha').
      Expected the 40 hex characters of a commit, from the PR's headRefOid."
  ;;
esac
pass "release PR #$pr_number at ${head_sha:0:7} ($pr_title)"

# The head commit has to be in this checkout before any job runs, because one of
# the jobs reads history rather than files: gitleaks derives its scan range from
# this SHA as `<sha>^..<sha>`. With the object missing that range does not
# resolve, and gitleaks does not treat it as fatal — it scans zero bytes and
# still prints "no leaks found". Published, that is a green secret scan over a
# scan that read nothing, which is worse than a red one: a red gets looked at.
#
# Release PR branches live on the remote and are rarely fetched locally, so this
# is the normal case rather than the exceptional one. The pull ref is used
# because GitHub always serves it, whereas fetching a bare SHA depends on the
# server allowing reachable-SHA1-in-want. Fetching writes objects into .git and
# leaves the working tree alone, which is what R1.6 is about; the fingerprint
# below still measures that rather than trusting it.
#
# The result is verified rather than inferred from the exit status: a fetch that
# reported success but left the object absent would be the same defect wearing a
# different face.
if ! git cat-file -e "$head_sha^{commit}" 2>/dev/null; then
  git fetch --quiet origin "refs/pull/$pr_number/head" 2>/dev/null ||
    git fetch --quiet origin "$head_sha" 2>/dev/null ||
    true
fi
git cat-file -e "$head_sha^{commit}" 2>/dev/null ||
  fail "the release PR's head commit ${head_sha:0:7} is not in this checkout, and
      fetching it from 'origin' did not bring it in.
      The jobs would then run against a commit range that does not resolve:
      gitleaks scans zero bytes, reports 'no leaks found', and that would be
      published as a green secret scan over nothing scanned. Bring the commit in
      and run this again:
        git fetch origin refs/pull/$pr_number/head
      Nothing was published."
pass "head commit ${head_sha:0:7} is in this checkout"

# Probe the runtime instead of trusting that the binary exists: a stopped daemon
# looks exactly like a working one until a job is already running, and it fails
# then. Either runtime will do — act drives both.
container_runtime=""
for candidate in docker podman; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" info >/dev/null 2>&1; then
    container_runtime=$candidate
    break
  fi
done
[ -n "$container_runtime" ] ||
  fail "no container runtime answered: tried 'docker info' and 'podman info'.
      Every job runs in a container, so nothing can be attested until the
      Docker (or Podman) daemon is running. Nothing was published."
pass "container runtime: $container_runtime"

command -v act >/dev/null 2>&1 ||
  fail "act is not installed.
      The jobs run through act, the local GitHub Actions runner, so there is no
      way to reproduce them without it. Nothing was published."

# Run from the top of the checkout: act resolves both the workflow files and the
# workspace relative to where it is invoked, and the tree fingerprint below has
# to cover the whole repository rather than whichever directory the caller
# happened to be standing in.
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail "not inside a git checkout, so there are no workflow files to run."
cd "$repo_root" || fail "cannot enter the repository root '$repo_root'."

# ── The four checks a release PR never gets ─────────────────────────────────
#
# One row per job: the id act runs, the workflow file that declares it, and the
# job's `name:` — the check name GitHub would show, and so the context each
# status is published under. Fields are separated by '|' rather than a tab
# because '|' is not IFS whitespace: `read` cannot fold two separators into one
# and shift the fields silently, the way it would with tabs.
JOBS=(
  "build|.github/workflows/ci.yml|Build"
  "gitleaks|.github/workflows/security.yml|Secret scan (gitleaks)"
  "osv-scan|.github/workflows/security.yml|Dependency scan (OSV-Scanner)"
  "npm-audit|.github/workflows/security.yml|npm audit"
)

# Refuse before starting a single container when a workflow file is not here:
# half an attestation is worse than none, because the checks that did run would
# read as the whole story.
unattestable=""
for row in "${JOBS[@]}"; do
  IFS='|' read -r job_id workflow check_name <<<"$row"
  [ -f "$workflow" ] || unattestable="$unattestable
      $check_name — $workflow is not in this repository"
done
[ -z "$unattestable" ] || fail "these checks cannot be attested here:$unattestable
      The workflow file is what act runs; without it there is nothing to
      reproduce. Nothing was published."

# Everything this run writes goes here, never inside the checkout (R1.6).
scratch=$(mktemp -d) || fail "cannot create a temporary directory."
trap 'rm -rf "$scratch"' EXIT

# Both workflows are filtered on `pull_request: branches: [main]`, so act needs
# an event carrying a base ref — without one the jobs are filtered out before a
# step runs, and an empty run would look like a pass. The default branch comes
# off the remote when git knows it.
#
# `repository` is here because an action reads it. GitHub's own event payload
# always carries it, and gitleaks-action dereferences
# `eventJSON.repository.owner.login` unguarded: with the key absent it died on
# "Cannot read properties of undefined (reading 'owner')" — a crash produced by
# this payload rather than by anything under test, which would have been
# published as a failing secret scan. Synthesising a payload means owing it the
# fields the real one has.
base_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || base_ref=""
base_ref=${base_ref#origin/}
[ -n "$base_ref" ] || base_ref=main
printf '{"number":%s,"pull_request":{"number":%s,"head":{"sha":"%s"},"base":{"ref":"%s"}},"repository":{"name":"%s","full_name":"%s","owner":{"login":"%s","name":"%s"},"default_branch":"%s"}}\n' \
  "$pr_number" "$pr_number" "$head_sha" "$base_ref" \
  "${repo#*/}" "$repo" "${repo%%/*}" "${repo%%/*}" "$base_ref" >"$scratch/event.json"

# R1.6 says the checkout must come out as it went in. `npm ci` runs inside the
# container and act copies the workspace rather than mounting it — only
# -b/--bind would mount it, and it is not passed — but that is a claim about
# act's defaults. This measures it instead of trusting it.
tree_fingerprint() {
  local lockfile=absent modules=absent
  [ ! -f package-lock.json ] || lockfile=$(sha256sum package-lock.json | cut -d' ' -f1)
  [ ! -e node_modules ] || modules=present
  printf 'package-lock.json %s\nnode_modules %s\n' "$lockfile" "$modules"
  git status --porcelain
}
tree_before=$(tree_fingerprint)

# Outcomes are collected rather than acted on one by one: every job runs even
# after one fails, so a single pass says what the whole PR is worth. The four
# arrays stay index-aligned — checks[i] is the check name, outcomes[i] its
# verdict — which is what the summary below and the publication step read back.
checks=()
outcomes=()
details=()
unreproduced=()
exit_code=0

for row in "${JOBS[@]}"; do
  IFS='|' read -r job_id workflow check_name <<<"$row"
  checks+=("$check_name")
  log="$scratch/$job_id.log"
  printf '\n----- %s (job %s of %s) -----\n' "$check_name" "$job_id" "$workflow"

  # The repository's own workflow file, never a copy: a copy would attest
  # something other than what GitHub runs. Output is teed so a run of several
  # minutes is not silent, and kept so the failing step can be read back.
  rc=0
  act pull_request \
    --workflows "$workflow" \
    --job "$job_id" \
    --eventpath "$scratch/event.json" 2>&1 | tee "$log" || rc=$?

  if [ "$rc" -eq 0 ]; then
    pass "$check_name: success"
    outcomes+=(success)
    details+=("passed locally through act")
    continue
  fi

  steps=$(failing_steps "$log")
  # act can stop before reaching a step at all — an unparsable workflow, an
  # image it could not pull. Nothing there identifies a gap in the runner, so it
  # is reported as a failure rather than quietly waived through.
  [ -n "$steps" ] || steps="act exited $rc before reaching a step"

  gap_steps=()
  defect_steps=()
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    if reason=$(environmental_reason "$step"); then
      gap_steps+=("$step")
      unreproduced+=("$check_name — $step: $reason")
    else
      defect_steps+=("$step")
    fi
  done <<<"$steps"

  # One genuine failure decides the job even when a gap failed beside it: a
  # defect must never become waivable because an unreproducible step happened to
  # fail in the same run.
  if [ "${#defect_steps[@]}" -gt 0 ]; then
    detail=$(join_steps "${defect_steps[@]}")
    bad "$check_name: failure at $detail"
    outcomes+=(failure)
    details+=("$detail")
    exit_code=1
    continue
  fi

  detail=$(join_steps "${gap_steps[@]}")
  outcomes+=(environmental)
  details+=("$detail")
  if [ -n "$waive_reason" ]; then
    warn "$check_name: not reproduced at $detail — waived: $waive_reason"
  else
    # R2.1: a gap is not a pass. It exits non-zero and names the step.
    bad "$check_name: not reproduced at $detail"
    exit_code=1
  fi
done

tree_after=$(tree_fingerprint)
[ "$tree_before" = "$tree_after" ] || fail "the run modified the working tree, which it must not (R1.6).
      Before:
$tree_before
      After:
$tree_after
      Inspect it with 'git status' and restore it before trusting any result
      above: a check that ran against a mutated checkout attests nothing."

# ── Publication ─────────────────────────────────────────────────────────────
#
# Nothing goes out until every job has run and the tree guard above has held: a
# status is a claim about this commit, and a run that mutated the checkout has
# no claim to make. Publishing here rather than inside the job loop also means a
# run that dies half way leaves no half-attestation behind.
#
# The outcome decides the publication, and the whole decision is this table:
#
#   outcome        waiver   state     published   exit
#   success        -        success   yes         0
#   failure        -        failure   yes         non-zero   R1.3
#   environmental  no       -         no          non-zero   R2.4  absent, not green
#   environmental  yes      success   yes         0          R2.3  reason in description
#
# GitHub caps a status description at 140 characters and truncates the rest.
DESC_LIMIT=140

# One call, one status, one line. The fields ride on the command line rather
# than in a payload piped to --input, so a publication is a single auditable
# line in a shell history, a log, or a `set -x` trace.
publish_status() {
  local context=$1 state=$2 description=$3
  # Truncate here rather than let the server do it: what the PR shows is then
  # exactly what this run decided to say, cap included.
  [ "${#description}" -le "$DESC_LIMIT" ] ||
    description="${description:0:$((DESC_LIMIT - 3))}..."
  gh api "repos/$repo/statuses/$head_sha" \
    --method POST \
    -f "state=$state" \
    -f "context=$context" \
    -f "description=$description" >/dev/null
}

# The context must be the job's `name:` to the character: GitHub keys a check by
# its context, and release-preflight.sh looks the four names up verbatim. A
# misspelling does not error anywhere — it publishes a status nobody reads.
# Hence "$check_name" below, straight from the JOBS table, never a re-typing.
#
# Every description says where the result came from. These statuses sit on the
# PR beside GitHub's own and look identical there; they are not the same thing.
# The wording is ASCII only, which keeps the 140-character budget arithmetic
# honest — a multi-byte dash costs three of those characters, not one.
published=()
withheld=()

# Whether a waiver was given is part of what identifies a row of the table, not
# a condition tested inside one: keyed on 'outcome:waiver', each branch below is
# one row, and no branch hides another.
waiver_given=no
[ -z "$waive_reason" ] || waiver_given=yes

for i in "${!checks[@]}"; do
  check_name=${checks[i]}
  state=""
  description=""
  note=""

  case "${outcomes[i]}:$waiver_given" in
  success:*)
    state=success
    description="Self-attested: ran locally through act; every step passed here."
    ;;
  failure:*)
    state=failure
    # No form of the word "success" belongs in a failing status: the description
    # is the line a reviewer skims, and it must not soften the state beside it.
    description="Self-attested: ran locally through act; failed at: ${details[i]}"
    ;;
  environmental:yes)
    state=success
    note=" — waived: $waive_reason"
    # R2.3: the reason leads, so even a description truncated at the cap still
    # carries the thing that justifies the check being green at all.
    description="Waived: $waive_reason; not reproduced locally at: ${details[i]}"
    ;;
  environmental:no)
    # R2.4: no status whatsoever. An absent check reads as "not verified", which
    # is exactly true; a green one would be a claim nobody can support.
    withheld+=("$check_name — not reproduced locally at ${details[i]}; no waiver given")
    continue
    ;;
  *)
    # Unreachable while the job loop sets only those three outcomes; here so an
    # outcome added later fails loudly instead of publishing something arbitrary.
    withheld+=("$check_name — unclassified outcome '${outcomes[i]}'")
    exit_code=1
    continue
    ;;
  esac

  if publish_status "$check_name" "$state" "$description"; then
    published+=("$check_name: $state$note")
  else
    # Keep going: the remaining checks are still worth publishing, and the
    # non-zero exit says the attestation as a whole is incomplete.
    bad "could not publish the '$check_name' status to ${head_sha:0:7}."
    withheld+=("$check_name — gh refused to publish the '$state' status")
    exit_code=1
  fi
done

printf '\n%s #%s at %s (%s)\n' "$repo" "$pr_number" "${head_sha:0:7}" "$pr_title"
for i in "${!checks[@]}"; do
  # Set before the case, not in a catch-all branch: an outcome this does not
  # know about then shows as unclassified instead of repeating the line above.
  verdict="unclassified"
  case ${outcomes[i]} in
  success) verdict="success" ;;
  failure) verdict="failure — ${details[i]}" ;;
  environmental)
    if [ -n "$waive_reason" ]; then
      verdict="waived — not reproduced at ${details[i]}"
    else
      verdict="not reproduced — ${details[i]}"
    fi
    ;;
  esac
  printf '  %-30s %s\n' "${checks[i]}" "$verdict"
done

printf '\nCommit statuses on %s (self-attested: this machine ran the jobs):\n' "${head_sha:0:7}"
if [ "${#published[@]}" -eq 0 ]; then
  printf '  (none published)\n'
else
  printf '  - %s\n' "${published[@]}"
fi
if [ "${#withheld[@]}" -gt 0 ]; then
  printf '  Left without a status, so the check stays absent rather than green:\n'
  printf '    - %s\n' "${withheld[@]}"
fi

# R2.5: said whether or not anything failed, and whether or not a waiver was
# used — a green that skipped a step is not the same green as one that did not.
printf '\nSteps the local runner did not reproduce:\n'
if [ "${#unreproduced[@]}" -eq 0 ]; then
  printf '  (none — every step of every job ran here)\n'
else
  printf '  - %s\n' "${unreproduced[@]}"
fi
[ -z "$waive_reason" ] || [ "${#unreproduced[@]}" -gt 0 ] ||
  printf '  A waiver was given but nothing needed it: %s\n' "$waive_reason"

exit "$exit_code"
