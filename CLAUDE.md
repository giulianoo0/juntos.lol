# CLAUDE.md — juntos (ss)

## Interface

A base visual vem do lawcore: a skill `lawcore-design-eng`
(`~/projects/lawcore/.claude/worktrees/main/.claude/skills/lawcore-design-eng`).
Ignore a `lawcore-flat`.

Todo menu, seletor e popover abre como o spring popover do lawcore: nasce do
gatilho em escala 0 com desfoque e assenta com a mola (`--ease-spring-pop`,
600 ms), e fecha com `--ease-spring-settle` (360 ms). As outras animações
seguem a mesma física.

### Sem subdescrição

Nada de linha de apoio embaixo de título, item de menu, opção, botão ou campo, e
nada de parágrafo explicativo ao pé de formulário ou painel: "Monitor, janela ou
aba" sob "Tela", "Cada palco tem o próprio play" sob o título do menu, "Você pode
entrar sem câmera…" sob o botão. O rótulo se explica sozinho; se não se explica,
troque o rótulo ou ponha uma dica (tooltip) no ícone. Placeholder também não vira
explicação. Vale para estado de pessoa em lista: o ícone diz que está mudo, não
escreva "Microfone desligado" embaixo do nome.
