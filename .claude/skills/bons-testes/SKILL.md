---
name: bons-testes
description: O que é um bom teste no juntos (Go em internal/, React em web/). Use ao escrever, revisar ou limpar testes.
---

# Bons testes

Um teste existe para travar um comportamento que alguém nota quando quebra.
Antes de escrever, diga qual mudança no código faria ele falhar. Se não há
nenhuma plausível, não escreva.

## Regras

- **Comportamento pela interface pública.** Chame a função exportada, o
  handler HTTP, o componente montado. Não leia estado interno, não conte
  chamadas de função privada, não dependa de classe CSS.
- **Um teste por comportamento.** Se outro teste já passa pelo mesmo caminho
  com o mesmo tipo de entrada, não duplique. Variações do mesmo comportamento
  viram linhas de uma tabela.
- **Nome que lê como frase.** `recusa senha errada depois de cinco tentativas`,
  `TestJoin/ticket vencido é recusado`. Nada de `works`, `test1`, `handles case`.
- **Sem mock do que é real e barato.** Redis é `miniredis.RunT(t)`; HTTP é
  `httptest`; storage é `localStorage` do setup. Mock só na borda cara ou
  externa: rede de verdade, R2, worker, relay MoQ, câmera.
- **Sem sleep.** Go: `testing/synctest` ou `require.Eventually`. Web:
  `vi.useFakeTimers()` + `advanceTimersByTimeAsync`, ou `waitFor`/`findBy*`.
- **Sem snapshot gigante.** Afirme o que importa; snapshot só para saída pequena
  e estável.
- **Sem assert trivial.** "Renderiza sem quebrar", constante igual a constante e
  teste do próprio mock não contam.
- **Código removido leva o teste junto.** Teste de componente que não existe
  mais é apagado, não consertado.

## Go

- Table-driven com `t.Run(tt.name, ...)`; `require` do testify, criado dentro
  do subteste.
- `require.ErrorIs` para erro embrulhado; `(expected, actual)` nessa ordem.
- Um `_test.go` por arquivo de código, na mesma ordem das funções.
- Segurança não sai na limpeza: senha, ticket, porta, rate limit, fuzz,
  autorização de palco, capability.

## Web

- Testing Library por papel e rótulo: `getByRole('button', { name: 'Entrar' })`,
  `getByLabelText('Seu nome')`. `querySelector` só quando não há papel.
- `fireEvent`/`userEvent` como a pessoa faria; afirme o que ela vê ou o que
  sai pelo socket/fetch.
- Textos em pt-BR, que é o idioma padrão nos testes.
