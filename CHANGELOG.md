# Changelog

## 0.1.0

Initial release of `@lucascouts/claude-agent-acp-plus`, a fork of
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
that ports features from the Claude Code VS Code extension to ACP clients
(like Zed) for a friendlier experience.

- AskUserQuestion checkbox (multiSelect) parity: `multiSelect` maps to an ACP
  form field of `type: "array"` with `items.anyOf`, plus per-question "Other"
  option and descriptions.

Forked from upstream `claude-agent-acp` v0.54.1. See the upstream repository
for the history prior to this fork.
