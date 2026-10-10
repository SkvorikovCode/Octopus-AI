# Octopus AI

Десктопная оболочка для кодинг-агентов. Интерфейс — Tauri 2 + React + TypeScript,
движок агента — [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) в режиме
RPC.

## Как устроено

- `src-tauri/src/omp.rs` — запускает `omp --mode rpc-ui` в папке проекта, пишет
  команды в stdin, читает кадры протокола из stdout, собирает `rpc_chunk` и
  отправляет каждый кадр в окно событием `omp-frame`.
- `src-tauri/src/keys.rs` — ключи провайдеров в системной связке ключей;
  передаются omp переменными окружения (`ANTHROPIC_API_KEY` и т. д.).
- `src/lib/omp.ts` — клиент протокола: команды с `id`, ответы, ошибки.
- `src/lib/session.ts` — превращает поток событий в ленту чата и данные плиток.
- `src/components/` — интерфейс в стиле «Гибрид».

Протокол omp: https://omp.sh/docs/rpc

## Запуск

Нужны Rust, Node.js 18+ и установленный omp:

```sh
brew install omp
npm install
npm run tauri dev
```

Если omp ещё не настроен, приложение попросит ключ API. Можно и настроить omp в
терминале: `omp`, затем `/login`.
