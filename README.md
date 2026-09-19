# TERMO ARENA

Termo competitivo em tempo real. Uma sala, **a mesma palavra**, o mesmo segundo,
mil pessoas ou mais. Quem resolve em **menos tentativas** fica na frente.

Quatro formatos, cada um com uma palavra a mais e uma tentativa a mais:

| modo | palavras | tentativas | relógio |
|---|---|---|---|
| TERMO | 1 | 6 | 2:30 |
| DUETO | 2 | 7 | 3:00 |
| TRIETO | 3 | 8 | 3:30 |
| QUARTETO | 4 | 9 | 4:00 |

Um palpite é gasto em **todos** os tabuleiros ao mesmo tempo — é isso que separa
DUETO de jogar dois Termos lado a lado.

## Como se pontua

A regra que o jogador ouve é "menos tentativas fica na frente". Com mil pessoas
essa regra sozinha produz empate em massa — em TERMO a tabela inteira encosta em
3 tentativas — então o relógio desempata. O risco é o relógio desempatar **mais
do que empate**, e é por isso que a dominância aqui é estrutural, não um ajuste
de número:

```
ATTEMPT_STEP (600)  >  SPEED_MAX (250) + STREAK_MAX (300)
```

Uma tentativa a mais custa mais do que todos os desempates do jogo conseguem
devolver. Quem fechou em `n` não pode ser ultrapassado, naquela rodada, por
alguém que precisou de `n+1` — não importa quão rápido foi nem que sequência
carregava. `assertAttemptsDominate()` prova isso nos quatro modos e roda no
start de cada isolate.

> A primeira versão deste arquivo tinha `280 < 450` e violava a promessa em
> silêncio: acertar em 3 instantaneamente batia acertar em 2. O teste pegou.

Ordem da tabela: pontos → menos palpites → mais palavras → menos tempo.

## Arquitetura

```
navegador ──ws──> Worker ──> Durable Object (1 por sala)
                    │              ├── estado autoritativo da rodada
                    └── assets     ├── avaliação dos palpites
                                   └── frame agregado a 2 Hz
```

**Por que Durable Object.** Mil jogadores numa sala é um problema de fan-out, não
de lógica. Um DO por sala dá estado autoritativo de thread única sem Redis e sem
sticky sessions, e a WebSocket Hibernation API segura os sockets sem pagar
compute ocioso.

**O frame agregado é a peça central.** Transmitir a cada palpite seriam ~66
mensagens de entrada por segundo vezes mil destinatários — 66 mil envios por
segundo. Em vez disso as mutações se acumulam e saem como no máximo dois frames
por segundo, com só o topo da tabela mais agregados. Medido: **531 B por frame**.
A posição exata de cada jogador viaja num sufixo pessoal colado por `String`
sobre o frame já serializado, então mil destinatários custam mil concatenações
pequenas em vez de mil `JSON.stringify`.

Frame é **pulado** quando nada mudou. O cliente roda o próprio cronômetro a
partir do `deadline` e de um offset de relógio estimado por ping/pong, então sala
parada custa zero banda.

**Hibernação apaga a memória do objeto.** Qualquer coisa guardada só num `Map`
some quando a sala fica quieta entre rodadas. Por isso o estado de cada jogador
vive no próprio socket (`serializeAttachment`) e a sala se reconstrói de
`getWebSockets()` ao acordar. Os tiles não são guardados — são recalculados dos
palpites, o que mantém cada attachment muito abaixo do teto de 2 KB.

**A resposta nunca chega ao cliente antes do fim da rodada.** Avaliação inteira
no DO; o navegador recebe só o padrão de cores. O dicionário de validação
(20.756 palavras) também é server-only: um palpite já custa um round trip, então
validar no cliente não pouparia nada além do caminho de erro.

## Palavras

- **Validação** — 20.756 palavras de 5 letras. Generoso de propósito: aceitar uma
  palavra rara por engano não custa nada, recusar uma palavra real custa a rodada
  ao jogador. Fontes: lista de lemas (`pythonprobr/palavras`) + formas flexionadas
  do corpus de frequência (`hermitdave/FrequencyWords`, pt-br, freq ≥ 20). Só os
  lemas recusariam `TINHA`, `PODIA`, `POSSO`.
- **Respostas** — 779 palavras curadas à mão, com acento para a revelação, piso de
  frequência 65. O dicionário raspado tem `onom.`, `bibl.` e `betsi`: perder uma
  rodada para uma palavra que você nunca viu é o jeito mais rápido de matar uma
  sala competitiva.
- Acento é ponte, não barreira: digita-se `acucar`, revela-se `AÇÚCAR`.

## Rodando

```bash
pnpm install
pnpm words                 # regenera o dicionário empacotado
node --test packages/core/test/core.test.ts

pnpm --filter @arena/web build
pnpm --filter @arena/server dev        # wrangler, porta 8787

# em outro terminal, o cliente com hot reload:
pnpm --filter @arena/web dev
```

Carga:

```bash
node tools/loadtest.mjs --n 1000 --mode termo --rounds 1
```

Os bots são solvers de verdade — filtram candidatos contra o feedback recebido e
fecham em 3 a 5 tentativas. Bot que manda lixo nunca termina, nunca pontua e
nunca move a tabela, então o frame ficaria trivialmente pequeno e o teste não
provaria nada.

## Deploy

```bash
pnpm build
cd apps/server && npx wrangler deploy
```

O Worker serve o cliente e a API no mesmo domínio; não há segundo serviço.

## Limites conhecidos

- **Um DO por sala ordena a tabela inteira a cada tick sujo.** Mil jogadores é
  `n log n` ≈ 10 mil comparações a 2 Hz — irrelevante. Dez mil numa sala só
  passaria a pesar; a saída seria hub + shards, e o ponto de corte ainda **não
  foi medido**.
- **Ranking é por sala e por partida.** Não há conta, ELO persistente nem
  temporada — o placar zera quando a partida acaba.
- **Sem proteção anti-bot além do cooldown de 200 ms por socket.** Uma sala
  pública grande precisaria de mais que isso.
