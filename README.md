# issue-bridge

Migração de issues entre trackers (hoje GitHub → Jira Cloud) com plano revisável,
ledger de idempotência e relatório em markdown.

Arquitetura hexagonal: o núcleo (`src/core/`) não conhece GitHub nem Jira — só o
modelo intermediário e as portas. Adicionar GitLab como origem é implementar
`SourceAdapter`; adicionar Azure DevOps como destino é implementar
`TargetAdapter`. Nenhuma linha do núcleo muda.

## Instalação

```bash
npm install
npm run build
```

Requer Node 20+. Dependências de runtime: `zod`, `yaml`, `commander`.

## Uso

```bash
cp issue-bridge.example.yaml issue-bridge.yaml   # e edite

export GITHUB_TOKEN=ghp_...
export JIRA_EMAIL=bot@acme.com
export JIRA_API_TOKEN=...

issue-bridge login      # valida as duas credenciais
issue-bridge export     # extrai a origem para .issue-bridge/snapshot.json
issue-bridge analyze    # gera plano + relatório, sem escrever no destino
issue-bridge apply      # SIMULAÇÃO (sem --yes)
issue-bridge apply --yes
issue-bridge sync --yes # migra só o que mudou desde o último sync
issue-bridge report     # regera o relatório dos artefatos
issue-bridge ledger     # mapa origem → destino
```

Credenciais **nunca** ficam no YAML — só o nome da variável de ambiente. O
arquivo de configuração é feito para ser versionado.

### Fluxo recomendado

1. `analyze` até sair com código 0. Todo erro bloqueante vem com o código do
   problema e a chave de configuração que o resolve.
2. `apply` sem `--yes` para conferir o que seria escrito.
3. `apply --yes`. Se algo falhar, corrija e rode de novo: o ledger pula tudo que
   já foi criado.

### Códigos de saída

| Código | Significado |
| --- | --- |
| 0 | Sucesso |
| 1 | Executou, mas há erro bloqueante no plano ou falha de ação |
| 2 | Abortado: config, credencial ou artefato inválido |

`analyze` sair com 1 serve como gate em CI.

### Artefatos

Tudo em `.issue-bridge/` (mude com `-o`):

| Arquivo | Conteúdo |
| --- | --- |
| `snapshot.json` | Origem extraída, no modelo intermediário |
| `plan.json` | Plano ordenado de ações + diagnósticos |
| `execution.json` | Resultado de cada ação, com tentativas gastas |
| `migration-report.md` | Relatório legível |
| `ledger.json` | Mapa origem → destino |
| `sync-state.json` | Marca d'água: até quando a origem já foi lida |

## Sync incremental

`sync` lê da origem apenas o que mudou desde a última execução bem-sucedida
(`since` na API do GitHub, que filtra por data de alteração), aplica, e só então
avança a marca d'água.

- A marca gravada é o instante de **início** da extração. Item alterado durante a
  execução cai na próxima janela em vez de ser perdido — o custo é reprocessar
  alguns itens, que a idempotência do ledger absorve.
- **Simulação e falha não avançam a marca.** Avançar ali esconderia itens que
  nunca chegaram ao destino.
- `--since <iso>` sobrescreve a marca; `--full` a ignora e relê tudo.
- Apagar `sync-state.json` força releitura completa **sem** perder as
  correspondências já criadas — são registros separados de propósito.

O que `sync` **traz**: issues novas, comentários novos, mudança de status.
O que `sync` **não traz**: alteração de título, corpo, labels ou responsável de
item já migrado — o plano não tem ação de atualização, só de criação.

## Paralelismo

`execution.concurrency` (padrão 4) controla quantas ações independentes são
escritas ao mesmo tempo. O escalonador usa o `dependsOn` do plano: uma ação só
começa quando todas as dependências concluíram, e se alguma falhou, os
dependentes são descartados sem gastar tentativa.

Acima de ~8 o rate limit do destino costuma virar o gargalo (o retry absorve, mas
fica mais lento). Use `concurrency: 1` para depurar com ordem determinística — os
resultados no relatório saem sempre na ordem do plano, independente da
concorrência.

## Por que `ledger` e não `rollback`

O Jira não desfaz criação de issue de forma limpa: não há endpoint que reverta
uma migração sem deixar rastro, e apagar issues em lote destrói histórico que
pode já ter sido referenciado. Chamar o comando de `rollback` prometeria algo que
a API do destino não entrega.

O que este registro realmente faz, em ordem de importância:

1. **idempotência** — reexecutar `apply` não duplica nada;
2. **reconciliação** — resolve para onde escrever quando algo falhou no meio;
3. **auditoria** — lista o que foi criado, para uma limpeza manual se necessário.

## Limitações conhecidas

São limites reais das APIs envolvidas, não pendências de implementação:

- **Anexos** do GitHub não têm endpoint próprio: só existem como URL no markdown
  do corpo. O que estiver fora do corpo não é descoberto.
- **Hierarquia** vem de task list (`- [ ] #42`); a API de sub-issues (GraphQL)
  não é usada.
- **Transição de status** é de um passo. Workflow que exige passo intermediário
  falha na ação de transição, com a lista de transições disponíveis no erro.
- **Workflow do Jira não é introspectável** sem uma issue existente, então o
  `analyze` não consegue validar alcançabilidade de status com precisão.
- **Custom field obrigatório** precisa de valor em `mappings.fields`; sem isso o
  `analyze` bloqueia (de propósito — melhor que falhar no meio da escrita).
- **`sync` não propaga atualização** de item já migrado (ver acima): não existe
  ação de atualização no plano, só de criação.
- **ADF** cobre parágrafo, heading, código, listas, citação e marcas inline.
  Tabela e lista aninhada degradam para texto.

## Desenvolvimento

```bash
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
npm test            # vitest
npm run build
```

Nenhum teste toca a rede: origem e destino são exercitados por `HttpClient`
falso, e o pipeline completo (`src/pipeline.test.ts`) roda contra o adapter Jira
real com HTTP simulado.
