# Telegram Coloring Battle

Легковесная Telegram WebApp игра-бродилка на 100 клеток для деплоя на Railway.app.

## Стек

- Frontend: `public/index.html` + `public/script.js`, Vanilla JS.
- Backend: Node.js + Express.
- Database: SQLite через `sqlite3`.
- Uploads: Multer, изображения сохраняются в Railway Volume.

## Railway Volume paths

Все динамические данные хранятся в `/data`:

- База данных: `/data/game.db`.
- Загруженные изображения: `/data/uploads`.
- Express раздает изображения по URL `/uploads/<file>`.

Папка `/data/uploads` создается автоматически при старте сервера.

## Запуск

```bash
npm install
npm start
```

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `PORT` | Порт сервера, Railway задает автоматически. |
| `ADMIN_TG_IDS` | Telegram ID администраторов через запятую, например `123,456`. |

## Локальная проверка

Для теста вне Telegram можно открыть страницу с query-параметрами:

- Игрок: `http://localhost:3000/?tg_id=200&username=player`
- Админ: `http://localhost:3000/?tg_id=100&username=admin`, если `ADMIN_TG_IDS=100`.

## API

- `GET /api/me/:tg_id?username=...` — регистрация/получение состояния игрока.
- `POST /api/roll` — бросок кубика и выдача задания.
- `POST /api/submit` — загрузка фото работы через `multipart/form-data` поле `work_image`.
- `GET /api/check-status/:tg_id` — polling статуса последней сдачи.
- `GET /api/admin/pending-users?admin_tg_id=...` — заявки на вход.
- `POST /api/admin/approve-user` — одобрение игрока.
- `GET /api/admin/submissions?admin_tg_id=...` — нерешенные работы.
- `POST /api/admin/approve-submission` — одобрение работы и разморозка кубика.
- `POST /api/admin/reject-submission` — отклонение работы с комментарием.
- `POST /api/admin/reset` — глобальный сброс прогресса и истории.
