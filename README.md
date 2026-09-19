# T3RMO

Termo competitivo em tempo real. Uma sala, **a mesma palavra**, o mesmo segundo,
centenas de pessoas. Quem resolve em **menos tentativas** fica na frente.

**No ar:** [t3rmo.com](https://t3rmo.com) · espelho sem DNS: `t3rmo.follow.workers.dev`

| formato | palavras | tentativas | relógio |
|---|---|---|---|
| TERMO | 1 | 6 | 2:30 |
| DUETO | 2 | 7 | 3:00 |
| TRIETO | 3 | 8 | 3:30 |
| QUARTETO | 4 | 9 | 4:00 |
| **MISTO** | a escada, uma rodada de cada | | 1:30 → 3:30 |

Um palpite é gasto em **todos** os tabuleiros ao mesmo tempo — é isso que separa
DUETO de jogar dois Termos lado a lado. No MISTO a partida sobe degrau a degrau
(TERMO → DUETO → TRIETO → QUARTETO) e recomeça de baixo depois do quarto.

## Como se pontua

A regra que o jogador ouve é "menos tentativas fica na frente". Com mil pessoas
essa regra sozinha produz empate em massa — em TERMO a tabela inteira encosta em
3 tentativas — então o relógio desempata. O risco é o relógio desempatar **mais
do que empate**, e por isso a dominância é estrutural, não um ajuste de número:

```
ATTEMPT_STEP (600)  >  SPEED_MAX (250) + STREAK_MAX (300)
```

Uma tentativa a mais custa mais do que todos os desempates juntos conseguem
devolver. Quem fechou em `n` não pode ser ultrapassado, naquela rodada, por
alguém que precisou de `n+1` — não importa quão rápido foi nem que sequência
carregava. `assertAttemptsDominate()` prova isso em **todos** os formatos,
inclusive em cada degrau do MISTO, e roda no start de cada isolate.

> A primeira versão tinha `280 < 450` e violava a promessa em silêncio: acertar
> em 3 instantaneamente batia acertar em 2. O teste pegou.

### O problema que o MISTO cria

Toda a disparidade entre modos vivia numa **única expressão**: `words = solved *
1000`. Um QUARTETO impecável valia ~7.500 contra ~4.500 de um TERMO, então numa
partida escalonada a última rodada decidiria a mesa sozinha e as três primeiras
virariam aquecimento.

`ModeConfig` ganhou um `bounty` — o que a rodada paga pelo conjunto inteiro — e
o termo vira `bounty * solved / boards`. Para os quatro formatos fixos o bounty
é `1000 × boards`, o que torna a expressão **byte-idêntica** à anterior (provado
por teste sobre todo o espaço de entrada). Os degraus do MISTO pagam
`1000/1250/1500/1750`: o QUARTETO vale ~15% a mais que o TERMO, não 63%.

Ordem da tabela: pontos → menos palpites → mais palavras → menos tempo.

## Arquitetura

```
navegador ──ws──> Worker ──> Durable Object (1 por sala)
                    │              ├── estado autoritativo da rodada
                    └── assets     ├── avaliação dos palpites
                                   └── frame agregado, cadência adaptativa
```

**Por que Durable Object.** Milhares numa sala é problema de fan-out, não de
lógica. Um DO por sala dá estado autoritativo single-thread sem Redis e sem
sticky sessions, e a WebSocket Hibernation API segura os sockets sem pagar
compute ocioso.

**O frame agregado é a peça central.** Transmitir a cada palpite seriam ~66
mensagens de entrada por segundo vezes mil destinatários. Em vez disso as
mutações se acumulam e saem num frame só, serializado **uma vez**, com a posição
pessoal colada por `String` — mil destinatários custam mil concatenações
pequenas em vez de mil `JSON.stringify`. A cadência cai conforme a sala cresce
(`tickMsFor`), e o frame é **pulado** quando nada mudou: o cliente roda o próprio
cronômetro a partir do `deadline`.

**Hibernação apaga a memória do objeto.** O estado de cada jogador vive no
próprio socket (`serializeAttachment`) e a sala se reconstrói de
`getWebSockets()` ao acordar. Os tiles não são guardados — são recalculados.

**A resposta nunca chega ao cliente antes do fim da rodada.** O dicionário de
validação (20.756 palavras) também é server-only: um palpite já custa um round
trip, então validar no cliente não pouparia nada além do caminho de erro.

## Palavras

- **Validação** — 20.756 palavras de 5 letras, generoso de propósito: aceitar uma
  rara por engano não custa nada, recusar uma real custa a rodada ao jogador.
  Lemas (`pythonprobr/palavras`) + formas flexionadas do corpus de frequência
  (`hermitdave/FrequencyWords`, freq ≥ 20). Só os lemas recusariam `TINHA`.
- **Respostas** — 779 curadas à mão, com acento para a revelação, piso de
  frequência 65. O dicionário raspado tem `onom.` e `betsi`.
- Acento é ponte: digita-se `acucar`, revela-se `AÇÚCAR`.

## Testar com bots

Uma sala de teste com gente dentro, em um comando:

```bash
pnpm arena                                   # 400 bots · MISTO · 4 rodadas · produção
pnpm arena --bots 50 --mode termo            # rápida
pnpm arena --bots 1000 --mode quarteto --rounds 2
pnpm arena:local                             # contra o dev server
pnpm arena --no-wait                         # não espera humano entrar
pnpm arena --start-in 30                     # segundos de folga depois que você entra
```

Ele imprime o link e **segura a frota até você aparecer**, porque duas coisas
tornam isso manualmente chato e fácil de errar:

1. Uma sala só é **real** quando o socket que a abre manda `?new=1`. Sem isso o
   servidor a trata como sala-fantasma e a página de entrada recusa — a defesa
   contra código digitado errado dispara no seu próprio teste.
2. O servidor **começa sozinho 30 s depois do segundo jogador**. Rampando 400
   bots, a partida já está rodando antes de você abrir o link. O `arena` consulta
   `/info` até um humano chegar, em vez de chutar um atraso.

Carga pura, sem humano:

```bash
node tools/loadtest.mjs --n 3000 --rounds 1          # local
node tools/fleetwatch.mjs                            # status ao vivo, outro terminal
```

Os bots são **solvers de verdade** — filtram candidatos contra o feedback e
fecham em 3 a 5 tentativas. Bot que manda lixo nunca termina, nunca pontua e
nunca move a tabela, então o frame ficaria trivialmente pequeno e o teste não
provaria nada. O harness é multiprocesso (coordenador + workers), conta sockets
derrubados, e diz **de que lado** foi o gargalo — cliente ou servidor.

> A versão anterior do harness **não rastreava `onclose`**: a 6000 sockets o
> servidor derrubava todos e o relatório ainda imprimia "0 falhas". Qualquer
> número medido antes disso era cego a quedas.

### Medido

| onde | sockets | resultado |
|---|---|---|
| produção (Cloudflare) | 400 | 400/400, 0 quedas |
| local (`wrangler dev`) | 1000 | 0 quedas · frame 604 B · tick p95 504 ms · palpite p95 7 ms |
| local | 3000 | 0 recusas · palpite p95 61 ms (era 310 antes de tirar um sort por palpite) |
| local | 5000 | 0 quedas · 4997/5000 fecharam |
| local | 10000 | **não alcançado** — o `wrangler dev` recusa upgrade em ~6.300 |

## Rodando

```bash
pnpm install
pnpm words                                   # regenera o dicionário empacotado
node --test packages/core/test/core.test.ts

pnpm --filter @arena/web build
pnpm --filter @arena/server dev              # wrangler
pnpm --filter @arena/web dev                 # cliente com hot reload, outro terminal
```

## Deploy

Push na `main` publica sozinho (`.github/workflows/deploy.yml`): typecheck,
testes, build, `wrangler deploy`, e um teste de fumaça que **cria uma sala de
verdade** em produção — um passo verde do wrangler só diz que o upload
funcionou. Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Manual, quando precisar: `cd apps/server && npx wrangler deploy`.

O Worker serve o cliente e a API no mesmo domínio; não há segundo serviço.
Apex e `www` são `custom_domain`. ⚠️ Declarar um hostname que a Cloudflare não
pode assumir faz **todo** o lote de gatilhos falhar, não só aquela rota, e deixa
o apex meio-ligado respondendo 522.

## Limites conhecidos

- **Ranking é por sala e por partida.** Sem conta, sem ELO persistente, sem
  temporada — o placar zera quando a partida acaba. O progresso individual é
  `localStorage`, por navegador.
- **10.000 numa sala não foi provado.** O maior teste limpo é 5.000 local e 400
  em produção. Um DO é single-thread, e onde ele para na borda real **não foi
  medido**.
- **Um `1006` não diagnosticado.** Sob tráfego sustentado, o dev server local
  derruba **todos** os sockets de uma vez. Reproduzido a 60, 300, 800 e 5000
  bots; nunca em execuções curtas. Não é hibernação e não é o harness. Se
  acontecer em produção, é a sala inteira caindo junta.

## Não use isto num stream grande ainda

O cenário "streamer põe o código no ar para 10 mil espectadores" **não está
coberto**. O que falta não é capacidade, é defesa:

- **`POST /api/rooms` é aberto, sem auth e sem rate limit.** Cada chamada pode
  materializar um Durable Object. Um script cria milhões, e a conta é sua.
- **Nada limita jogadores por sala nem sockets por pessoa.** O cooldown de 200 ms
  é **por socket** — não limita quem abre vários.
- **A trapaça mais óbvia é gratuita.** Nada amarra um jogador a um socket: abra
  uma conexão descartável, queime as tentativas dela para descobrir a palavra, e
  jogue perfeito na principal.
- **Nome é quase livre** — 16 caracteres sem normalização, sem filtro de
  homoglifo, e nada impede alguém de usar o nome do streamer.
- **Não existe moderação.** Sem kick, sem ban, sem report, ao vivo.
