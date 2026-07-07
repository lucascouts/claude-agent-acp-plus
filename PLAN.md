# PLAN — Fork do `claude-agent-acp` (e Zed) para paridade com o harness da extensão VSCode

> Pesquisa executada em 2026-07-01 (3 agentes em paralelo: código do adaptador, protocolo ACP + código do Zed, inventário do harness VSCode). Versões analisadas: `claude-agent-acp` 0.54.1 · ACP 1.2.0 · Zed `main` `d0802abdec` (2026-07-01) · extensão VSCode 2.1.198.

## Objetivo

Fork de https://github.com/agentclientprotocol/claude-agent-acp para restaurar o `AskUserQuestion` no Zed e aproximar a experiência do Claude Code no Zed da extensão oficial do VSCode (`anthropic.claude-code`). Fork do Zed é aceitável se necessário.

## TL;DR — diagnóstico

**Não é preciso reimplementar o `AskUserQuestion` — ele já voltou ao adaptador upstream.**

1. O adaptador desligou o tool em 2026-01-15 (PR #245 — motivo declarado: `request_permission` confunde pergunta com fluxo de segurança) e o **reintroduziu em 2026-06-09 (v0.43.0, PR #756)** via *form elicitation* (experimental no ACP) — mas **só quando o cliente anuncia `clientCapabilities.elicitation.form`**. Sem a capability: `disallowedTools=["AskUserQuestion"]` (`src/acp-agent.ts:3304`) e o modelo nem vê o tool.
2. **O Zed estável não anuncia a capability.** A UI de elicitation foi mergeada no `main` do Zed em **2026-07-01** (PR zed#58927), atrás do feature flag server-side **`acp-beta`** (staff-only, rollout controlado por zed.dev). Nenhum release contém isso. A issue #405 do adaptador segue aberta por causa disso (zed#46776 foi fechada como *not planned*).
3. Mesmo com o flag ligado, a UI atual do Zed descarta `description`/`preview` por opção (o adaptador os envia via `_meta["_claude/askUserQuestionOption"]` desde v0.46.0), o campo de texto livre é single-line e labels truncam. No protocolo, o PR #1397 (descriptions em enum options) está aberto.

Conclusão: **fork do adaptador** dá uma versão funcional *hoje* no Zed estável (pergunta via diálogo de permissão — funciona, mas single-select e sem "Other"); **fork pequeno/médio do Zed** dá a experiência completa do VSCode.

## Matriz de paridade (harness VSCode → Zed via adaptador)

| Recurso | Zed estável hoje | Gap fecha em |
|---|---|---|
| AskUserQuestion | ❌ desligado pelo adaptador | Fase 1 (adaptador) / 2–3 (Zed) |
| Plan mode + aprovação (ExitPlanMode com opções) | ✅ | — |
| Checklist (TodoWrite/Task* → `plan` do ACP) | ✅ | — |
| Modos de permissão (default/acceptEdits/plan/dontAsk/auto/bypass) | ✅ | — |
| Modelo / effort / fast mode (session config options) | ✅ | — |
| Diffs com review, terminal, slash commands, thinking, imagens, resume/fork de sessão | ✅ | — |
| Hooks, skills, MCP, subagents, memória, output styles, /code-review | ✅ (lado SDK — o adaptador usa o preset `claude_code` do Agent SDK) | — |
| Form elicitation (multi-select, "Other", headers) | 🚧 no `main` de 2026-07-01, flag `acp-beta` staff-only | Fase 2 |
| Description/preview por opção (dialog estilo VSCode) | ❌ (protocolo: PR #1397 aberto) | Fase 3 |
| Plano como doc comentável, rewind/checkpoints estilo Claude, painel de tasks | ❌/parcial | backlog pós-Fase 3 |

Spec do `AskUserQuestion` (alvo de UI): 1–4 perguntas por chamada; 2–4 opções cada; `header` (chip ≤12 chars); `multiSelect`; "Other" com texto livre (o cliente usa o texto digitado como valor); `preview` por opção (markdown/HTML sanitizado, opt-in via `toolConfig.askUserQuestion.previewFormat`). Resposta: `answers{questionText: label | [labels] | textoLivre}`.

## Plano em fases

### Fase 0 — Setup do fork
- Clonar `agentclientprotocol/claude-agent-acp` (histórico completo) em `claude-agent-fork/`. **Atenção:** o diretório já contém `PLAN.md` e `.gitignore`, e `git clone` exige destino vazio → clonar em diretório temporário, mover o `.git/` para cá e fazer `git restore` do working tree, preservando `PLAN.md` (untracked ou commitado no fork) e mesclando `.epic` no `.gitignore` do repo.
- ~~Primeira tarefa: `.gitignore` + `.epic`~~ ✅ (feito em 2026-07-01, antes do clone — ao integrar o `.gitignore` do upstream, manter a entrada `.epic`).
- Remote `upstream` → repo original; `origin` → fork do usuário no GitHub (quando criado).
- Sem commit/push sem autorização explícita.

### Fase 1 — Fork do adaptador (funciona no Zed estável já)
Reativar o tool quando não há `elicitation.form`, com fallback via `session/request_permission` (que o Zed já renderiza como N botões empilhados — o handler de ExitPlanMode do próprio adaptador prova o padrão):

1. `src/acp-agent.ts:3304` — não colocar `AskUserQuestion` em `disallowedTools` (gate por env var do fork, ex. `ACP_ASK_USER_QUESTION_FALLBACK=1`, para minimizar drift com upstream).
2. `src/acp-agent.ts:2663-2668` (`canUseTool`) — novo caso `!elicitation.form`: handler `handleAskUserQuestionViaPermission` que, para cada pergunta de `extractAskUserQuestions(toolInput)` (`src/elicitation.ts:102`), chama `requestPermissionFromClient` sequencialmente com uma `PermissionOption` por opção (`kind:"allow_once"`, `optionId` = label, description achatada no `name`) + `reject_once` "Skip". Acumula `answers[question] = optionId` → retorna `{behavior:"allow", updatedInput:{...toolInput, answers}}`; `cancelled`/abort → `throw "Tool use aborted"`. **Manter o caso antes do branch de `bypassPermissions`** (como no upstream): pergunta não é permissão — mesmo em bypass o usuário deve responder, senão o tool executa sem `answers`.
3. Nada a fazer em render (`src/tools.ts:439-455` já trata) nem em ordenação (`ensureToolCallEmitted`, `src/acp-agent.ts:2621-2645`).
4. Ajustar testes: `src/tests/create-session-options.test.ts:571-614` e `src/tests/acp-agent.test.ts:405-450`; adicionar testes do fallback.
5. Registrar o fork como agente custom nas settings do Zed **apontando para o build local** (ex. `node <fork>/dist/index.js`) — sem publicar no npm; o Zed integra o upstream via registry ACP com pin `npx @agentclientprotocol/claude-agent-acp@0.54.1`, e o agente custom convive em paralelo. Validar a sintaxe exata de agentes custom nas settings do Zed na execução.

Limitações inerentes (motivo do PR #245): single-select, sem "Other", sem multi-select; diálogo com tom de permissão/segurança.

### Fase 2 — Fork mínimo do Zed (form completo)
Compilar o `main` (pós zed#58927) forçando o flag `acp-beta`:
- Antes de patchar, reverificar se surgiu um override local de feature flags (env/settings) — se existir, a Fase 2 dispensa fork do Zed (não encontrado no snapshot de 2026-07-01; confiança média).
- `crates/feature_flags/src/flags.rs:24-27` — `enabled_for_all()` → `true` (1 linha); ou os gates `crates/agent_servers/src/acp.rs:984-987` (capability) e `:4656` (handler `handle_create_elicitation`).
- Fixar o commit base do fork (ex.: `d0802abdec`) e rebasear deliberadamente, não a cada push do upstream.
- Com a capability anunciada, o adaptador (upstream ou fork) liga o modo completo sozinho: multi-select (checkboxes), "Other" por pergunta, headers. UI em `crates/agent_ui/src/conversation_view/elicitation.rs`.

### Fase 3 — Polish do Zed (paridade real com o dialog do VSCode)
- Renderizar `_meta["_claude/askUserQuestionOption"]` — description como linha secundária, preview expansível — em `elicitation.rs:1445-1507` (single-select) e `:1380-1437` (multi-select).
- Campo de texto multiline em vez de `Editor::single_line` (`:1354-1363`).
- Remover `.truncate()` dos labels (`:1434`, `:1504`).
- Depois: backlog dos demais gaps de UI (plano como doc comentável, checkpoints/rewind, painel de tasks, indicador de contexto).

### Fase 4 — Upstreaming (paralelo, opcional)
Apoiar o protocol PR #1397 e propor os patches das fases 2–3 ao Zed — os mantenedores estão ativos (merge da UI foi em 2026-07-01); os forks tendem a ser temporários.

## Riscos e notas de manutenção

- `src/acp-agent.ts` (5078 linhas) muda quase diariamente (0.43.0→0.54.1 em ~3 semanas). Manter o fallback como **função separada chamada de um único ponto** + gate por env var minimiza conflitos de rebase.
- Branch upstream `sd-can-use-tool-wait` (não mergeado) pode alterar a ordenação do `canUseTool` — observar.
- Elicitation ainda é `unstable_` no ACP (SDK TS 1.1.0; rust-sdk 1.0.1 feature `unstable_elicitation`) — a API pode mudar; o schema v2 do protocolo está em draft.
- Dependências pinadas do adaptador: `@agentclientprotocol/sdk` 1.1.0, `@anthropic-ai/claude-agent-sdk` 0.3.197 (Node ≥ 22).
- Build do Zed: toolchain Rust, clone grande, compilação demorada.
- Todas as referências `arquivo:linha` refletem os snapshots de 2026-07-01 (adaptador 0.54.1, Zed `d0802abdec`) — revalidar após cada rebase/bump.

## Validação por fase

- **Fase 1**: suite do adaptador (`npm test`) + novos testes do fallback; teste manual no Zed estável — prompt que force uma pergunta com opções → diálogo aparece → resposta escolhida volta ao modelo; cancelar aborta o turno sem travar a sessão; múltiplas perguntas viram diálogos sequenciais.
- **Fase 2**: build do Zed com flag forçado; `initialize` passa a anunciar `elicitation.form` (visível no log do adaptador); AskUserQuestion abre o card "Input Requested" com multi-select (checkboxes) e campo "Other" por pergunta.
- **Fase 3**: pergunta com `description`/`preview` renderiza linha secundária + preview expansível; labels longos sem truncar; campo livre multiline.

## Decisões pendentes (usuário)

1. **Estratégia**: fases 1→2→3 (recomendada) · só adaptador (fase 1) · direto ao Zed (fases 2→3).
2. **Execução**: setup + implementação · só setup · aguardar.

## Referências

- Adaptador: https://github.com/agentclientprotocol/claude-agent-acp — PRs/issues: #245 (disable), #756 (elicitation, v0.43.0), #774, #779 (`_meta` description/preview), issue #405 (aberta)
- Zed: https://github.com/zed-industries/zed — PR #58927 (elicitation UI, merged 2026-07-01, flag `acp-beta`), issue #46776 (closed not_planned)
- Protocolo: https://agentclientprotocol.com/rfds/elicitation.md · PR #1397 (descriptions em enum options) · https://github.com/agentclientprotocol/rust-sdk (crate `agent-client-protocol` 1.0.1)
- Registry ACP (como o Zed lança o adaptador): https://github.com/agentclientprotocol/registry (`claude-acp/agent.json`, pin 0.54.1 via npx)
- Harness VSCode (alvo de paridade): https://code.claude.com/docs/en/vs-code · https://code.claude.com/docs/en/agent-sdk/user-input · https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code
