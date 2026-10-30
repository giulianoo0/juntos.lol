# Compartilhar tela pelo app (design)

## Por quê

Hoje não dá para compartilhar a tela pelo app desktop. E quem compartilha com o
som do sistema manda junto a voz do Discord, que volta como eco para quem está
na chamada. O grupo compartilha jogo, a tela inteira e apps, e usa bastante Mac
e Windows.

## O que é

- Compartilhar uma **tela** ou uma **janela** pelo app, com captura e
  codificação H.264 por hardware, fluido como o OBS (60 fps, pouco atraso, sem
  pesar no jogo).
- **Som por app:** a pessoa liga e desliga o som de cada app que está tocando.
  Os ícones são os reais do sistema.
- **Tudo muda ao vivo:** trocar a fonte, o som de cada app e a qualidade sem
  parar a transmissão.
- Layout escolhido: **opção A** do canvas
  (https://claude.ai/artifact/DjWEwkZuMrxSA7PMbX6GTe). É um modal com abas
  Telas/Janelas e miniaturas à esquerda, e à direita um painel "Som" com a lista
  de apps, interruptores, "Silenciar tudo"/"Ligar tudo" e a qualidade. Durante
  a transmissão vale o artboard "Durante a transmissão".

## Decidido

- Windows e Mac têm o mesmo peso; o Linux (PipeWire/Pulse) vem depois, em
  outro plano.
- Não há captura por injeção no jogo (o "game capture" do OBS), por risco de
  anti-cheat. Usamos a captura de tela e de janela do sistema.
- O próprio app do juntos nunca entra no som, porque isso devolveria a voz da
  sala.
- O Discord começa desligado.
- A transmissão continua pelo relay MoQ atual (`publishEncodedScreen`), sem
  re-encode no navegador. Quem assiste não muda nada.
- Os testes agora rodam no Windows (`ssh giuli@windows-machine`). O Mac só
  precisa compilar.

## Fica com quem implementar

- Os nomes internos, a forma das miniaturas e a taxa de atualização da lista
  de apps.
