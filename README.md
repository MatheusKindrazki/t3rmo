<p align="center">
  <img src="docs/logo.png" alt="T3RMO" width="360" />
</p>

<p align="center">
  Termo competitivo em tempo real. Uma sala, <b>a mesma palavra</b>, o mesmo
  segundo, centenas de pessoas. Acertos, tentativas, velocidade e sequência compõem a pontuação.
</p>

<p align="center">
  <a href="https://t3rmo.com"><b>jogar em t3rmo.com</b></a>
</p>

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

Pontua-se por **palavra acertada**, **nº de tentativas**, **tempo** e — nos
híbridos — **quantas palavras** você fechou. A tabela ordena por pontos → menos
tentativas → mais palavras → menos tempo.

A velocidade **não** é só desempate: um acerto relâmpago em `n+1` tentativas
pode passar um acerto lento em `n`. Mas isso é limitado por construção — a
velocidade sobe você **um** degrau de tentativa, nunca dois:

```
ATTEMPT_STEP (600)  <  SPEED_MAX (700)                 (cruza UM degrau)
SPEED_MAX (700) + STREAK_MAX (300)  <  2 × ATTEMPT_STEP (1200)   (nunca dois)
```

Ou seja: um acerto no gongo em `n` ainda bate o melhor acerto possível em `n+2`
(instantâneo, sequência máxima), e um acerto perfeito (mínimo de tentativas)
mantém seu bônus e continua difícil de passar. `assertScoringBounds()` prova as
duas metades em **todos** os formatos, inclusive em cada degrau do MISTO, e roda
no start de cada isolate.

> Antes, tentativas eram absolutas (`ATTEMPT_STEP > SPEED_MAX + STREAK_MAX`): 2
> sempre batia 3, tempo só desempatava dentro do mesmo número. O dono pediu o
> blend — velocidade cruzando um degrau — e o único número que mudou foi o
> `SPEED_MAX` (250 → 700). O resto do balanço (e a compressão do MISTO) sobreviveu.

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
pnpm arena                                   # 20 bots · MISTO · 4 rodadas · produção
pnpm arena --bots 20 --mode termo            # rápida
pnpm arena --bots 40 --mode quarteto --rounds 2
pnpm arena:local                             # contra o dev server
pnpm arena --no-wait                         # não espera humano entrar
pnpm arena --start-in 30                     # segundos de folga depois que você entra
pnpm arena --bots 400 --start-at 9500      # só começa quando 9500 conectarem (medição de carga)
```

Ele imprime o link e **segura a frota até você aparecer**, porque duas coisas
tornam isso manualmente chato e fácil de errar:

1. A sala é reservada no servidor via POST, que devolve uma credencial privada para o anfitrião. `new=1` não cria salas. Os clientes de teste enviam Origin e protocolo v2.
2. Salas de amigos começam apenas por comando do anfitrião. Treinos solo começam após o ingresso autenticado.

Os limites públicos agora também valem para as ferramentas: até 48 bots por execução/origem e 64 sockets por IP em uma sala. Medições maiores exigem uma política de staging separada e autorizada; não remova os limites de produção para obter números maiores.

Carga pura, sem humano:

```bash
node tools/loadtest.mjs --n 20 --rounds 1          # local
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
| **produção (borda real)** | **10000** | **conecta 9987/10000, 0 recusas na conexão — mas o palpite satura: RTT p95 7,4 s, 287 pings perdidos. Um DO não serve 10k jogando.** |

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
- **Uma sala não serve 10.000 jogando — medido na borda real.** Um Durable
  Object aceita as 10k conexões (9987/10000, lag do cliente 6 ms), mas o caminho
  do palpite satura muito antes: a fila do objeto chegou a RTT p95 **7,4 s** e
  **287 pings ficaram sem resposta** — perdeu mensagens, não só atrasou. O teto
  da sala (`ROOM_MAX`) é **1500** por isso: bem abaixo de onde a fila começa a
  subir. Servir 10k de verdade exige **sharding** — a sala repartida entre
  vários objetos com um só dono da resposta e da tabela. Não é opcional para o
  cenário do streamer, e é a próxima frente.
- **Reconexão preserva o jogo — inclusive através de um deploy.** Um celular
  que bloqueia, troca de rede ou vai para segundo plano cai e volta com os
  palpites intactos. O estado é gravado em storage por credencial de sessão **a cada
  palpite** (write-through), não só quando o socket cai: um deploy reinicia o
  Durable Object sem disparar `webSocketClose`, então a única coisa que
  sobrevive a um release é uma escrita feita durante o jogo. `matchId` garante
  que um registro de uma partida anterior não devolva placar velho numa nova.
  A janela em memória segura 120 s; a durável, até a próxima partida ou expiração da sala em 24 horas.

## Security and experience update (protocol v2)

The current source reserves rooms behind the POST rate limiter, authenticates host/reconnect authority with a server-issued per-room capability, and never trusts a caller-supplied clientId. Capabilities are stored hashed on the server and in per-tab sessionStorage on the client. The public code remains an address, not a credential.

- Per-IP creation/entry rate limits; 64 concurrent sockets per source IP per room; 1500 room cap unchanged.
- Every command has a 2 KiB size limit, schema validation and a hibernation-preserved 60-message/10-second socket budget. Normal guesses/pages retain their action-specific limits.
- Same-origin browser handshake required. Automated clients explicitly send Origin; this is a browser-origin control, not a replacement for capability authorization.
- Host has a 30-second absence grace before a connected participant succeeds them. A never-connected creator also gets a finite grace.
- Host can revoke a participant session from lobby or the paginated ranking during play. A fresh anonymous browser can still return: this is session removal, not proof of a permanent human ban.
- Rooms expire after 24 hours, identities are bounded to 6000 per room lifetime, and server exceptions are not returned verbatim.
- Phase receipts survive reconnect; stats deduplicate by room/match/round. New matches use fresh seeds; training is stored separately from competitive stats.
- Static/API responses have tested CSP, no-referrer, nosniff, frame restrictions and HSTS without includeSubDomains/preload.

Read [the implementation receipt and migration plan](docs/lobby-security-delivery.md) before release. Protocol v1 rooms are explicitly retired rather than allowing insecure legacy identity adoption. This source change has not been deployed by this task.

## Licença

MIT — veja [LICENSE](LICENSE).
