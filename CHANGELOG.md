# Changelog

## [0.6.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.5.2...v0.6.0) (2026-08-07)


### Features

* port upstream v0.65.0 — provider-neutral ACP goal extension ([0f4fd18](https://github.com/lucascouts/claude-agent-acp-plus/commit/0f4fd181579edf06d383df0b008e4ba7faf76682))

## [0.5.2](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.5.1...v0.5.2) (2026-08-06)


### Bug Fixes

* **permissions:** keep the Always Allow scope visible in the option label ([e931b06](https://github.com/lucascouts/claude-agent-acp-plus/commit/e931b06d58b60d39d2f5d2bdabc4672473870a41))

## [0.5.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.5.0...v0.5.1) (2026-08-05)


### Bug Fixes

* **deps:** resolve 7 advisories via security overrides ([#40](https://github.com/lucascouts/claude-agent-acp-plus/issues/40)) ([c7cb7a7](https://github.com/lucascouts/claude-agent-acp-plus/commit/c7cb7a73c50795cdb21d209d08c3663db0dbed3a))

## [0.5.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.4.0...v0.5.0) (2026-08-01)


### Features

* prune the fallback and sync upstream v0.64.0 (port from fork) ([f0b30f9](https://github.com/lucascouts/claude-agent-acp-plus/commit/f0b30f9d6f3c9c22aa41e874f9503e8b70309c43))

  **`ACP_ASKUSERQUESTION_FALLBACK` no longer exists.** The AskUserQuestion
  permission fallback is gone entirely — the module, its two suites, and all
  four wiring sites, which return to upstream's own wording. It was added when
  Zed gated `elicitation.form` behind its acp-beta flag; Zed now advertises form
  elicitation unconditionally, so the code was unreachable in the only client
  that consumed it. Setting the variable has no effect, because nothing reads
  it. A client that does **not** advertise form elicitation no longer sees the
  AskUserQuestion tool at all — upstream's stance.

  Upstream v0.64.0 closes a five-release gap (v0.59.0 → v0.64.0). The
  user-visible win is upstream #894: session creation and model switching lose
  a ~15 s stall.


### Bug Fixes

* **deps:** pin brace-expansion to 5.0.8 to clear GHSA-mh99-v99m-4gvg ([38b8de3](https://github.com/lucascouts/claude-agent-acp-plus/commit/38b8de316799df5bb2358b73a8b7d99e493f39e1))
* **rewind:** report link-safety refusals instead of claiming full success (port from fork) ([10ac37a](https://github.com/lucascouts/claude-agent-acp-plus/commit/10ac37ad2dd56bd13448e7753eec1c2bdc878dc6))

  SDK 0.3.220 added `RewindFilesResult.skippedLinks`, a count of tracked files
  the SDK did **not** restore — a symlink, hard link or other non-regular file
  sits at the tracked path, the parent directory no longer resolves where it
  pointed, or the backup could not be safely read. The adapter ignored it, so
  `/rewind <n>` reported the same unqualified success whether every file was
  restored or half of them were silently refused. It now says so: `1 file was` /
  `N files were left unchanged for link safety.` A rewind that refused nothing
  is byte-identical to before.


### Security

* the project's own ReDoS fix is reverted, superseded upstream ([f0b30f9](https://github.com/lucascouts/claude-agent-acp-plus/commit/f0b30f9d6f3c9c22aa41e874f9503e8b70309c43))

  The polynomial-ReDoS rewrite shipped in 0.4.0 (CWE-1333, in subagent trailer
  stripping) is removed in favour of upstream's own fix in v0.60.0
  (agentclientprotocol/claude-agent-acp#879); our report, issue #893, is closed.
  The vulnerability remains fixed — the implementation is now upstream's rather
  than ours, which is what keeps `src/tools.ts` byte-identical to upstream and
  out of every future sync's conflict set.

  **Two observable behaviours change, both conservative — upstream truncates
  less:**

  - `<usage>` stripping now anchors on the **last** opening marker rather than
    the first. A report that merely quotes `<usage>` earlier in its text keeps
    that quote, instead of having everything from it onward removed.
  - The `agentId:` trailer must now occupy a **whole final line** to be
    stripped. A report mentioning `agentId:` mid-line keeps that text, where the
    previous implementation located the trailer from the last `(` and truncated
    there.

  A fork-owned test suite pins both divergences so a future sync cannot silently
  reintroduce the old semantics.

## [0.4.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.3.0...v0.4.0) (2026-07-19)


### Features

* port upstream v0.59.0 (configurable LLM providers, subagent fixes) ([#14](https://github.com/lucascouts/claude-agent-acp-plus/issues/14)) ([dd7dc4d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dd7dc4d6a9c0aa54db4b438d46c378770e8e28e5))


### Security

* remove polynomial ReDoS (CWE-1333) in subagent trailer stripping ([#14](https://github.com/lucascouts/claude-agent-acp-plus/issues/14)) ([dd7dc4d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dd7dc4d6a9c0aa54db4b438d46c378770e8e28e5))

  The `<usage>` / `agentId:` trailer patterns inherited from upstream v0.59.0
  were tail-anchored but not start-anchored, so the engine retried from every
  position — O(n²) on text repeating an opening token, which a subagent can
  echo verbatim into the `tool_result` its report is parsed from. Rewritten
  with index matching (constant-time on the same input), semantics verified
  identical against the original on 200k randomized cases.

## [0.3.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.2.0...v0.3.0) (2026-07-11)


### Features

* sync with upstream claude-agent-acp v0.58.1 ([84e291f](https://github.com/lucascouts/claude-agent-acp-plus/commit/84e291f8151ea222f8f445b7abfadb3a9b8633a9))

## [0.2.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.1.1...v0.2.0) (2026-07-08)


### Features

* parity round 2 (port from fork) ([217011a](https://github.com/lucascouts/claude-agent-acp-plus/commit/217011a55b120735235600a83ab422ce26821473))

## [0.1.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.1.0...v0.1.1) (2026-07-08)


### Miscellaneous Chores

* **package:** describe the fork's value in the npm listing ([05cf597](https://github.com/lucascouts/claude-agent-acp-plus/commit/05cf59794f7ae365d83d063acbab001bf1409eaa))

## 0.1.0 (2026-07-08)

Initial release of `@lucascouts/claude-agent-acp-plus`, rebased on upstream
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
v0.57.0.

### Highlights

- Refusal-fallback consent dialog inherited from upstream v0.55.0.
- AskUserQuestion permission fallback (multiSelect → checkbox).
- Dynamic agent name derived from package.json.
- Dependencies at latest workable versions: all devDependencies at registry
  latest; runtime SDKs kept at the upstream v0.57.0 pins after breakage
  attribution.
