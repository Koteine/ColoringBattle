# Telegram Coloring Battle

Легковесная Telegram WebApp игра-бродилка на 100 клеток для небольшой аудитории до 50 игроков.

## Стек

- Frontend: HTML, CSS, Vanilla JS.
- Backend: Node.js без Express и других HTTP-фреймворков.
- Database: встроенный `node:sqlite` (`DatabaseSync`) и файл SQLite.

## Быстрый старт

```bash
npm start
```

По умолчанию сервер слушает `http://localhost:3000` и хранит базу в `./game.sqlite`.

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `PORT` | Порт HTTP-сервера, по умолчанию `3000`. |
| `DB_PATH` | Путь к SQLite-файлу, по умолчанию `./game.sqlite`. |
| `BOT_TOKEN` | Токен Telegram-бота для проверки `initData`. В production обязателен. |
| `ADMIN_TG_IDS` | Список Telegram ID админов через запятую для первичного назначения роли `admin`. |
| `DEV_AUTH` | Если `1`, разрешает локальный вход через `?tg_id=...&username=...` без Telegram. |

## Локальная проверка без Telegram

```bash
DEV_AUTH=1 ADMIN_TG_IDS=100 npm start
```

- Игрок: `http://localhost:3000/?tg_id=200&username=player`
- Админ: `http://localhost:3000/?tg_id=100&username=admin`

## Основные API

Все игровые endpoint'ы читают Telegram WebApp `initData` из заголовка `X-Telegram-Init-Data`. Для локальной разработки при `DEV_AUTH=1` можно передавать `tg_id` и `username` в query string.

- `GET /api/me` — регистрация/проверка пользователя, возврат состояния игрока.
- `POST /api/roll` — бросок кубика, движение по полю, выдача нового задания.
- `POST /api/submit` — сдача работы по активному заданию.
- `GET /api/admin/pending-users` — список заявок на вход.
- `POST /api/admin/users/:id/approve` — одобрение игрока.
- `POST /api/admin/tasks/:historyId/approve` — одобрение сданной работы.
- `POST /api/admin/tasks/:historyId/reject` — отклонение с комментарием.
- `GET /api/admin/submissions` — лента работ на проверке.
- `POST /api/admin/reset` — глобальный сброс прогресса и истории.
