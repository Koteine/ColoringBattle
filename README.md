# Telegram Coloring Battle

Легковесная Telegram WebApp игра-бродилка на 100 ячеек для деплоя на Amvera.

## Стек

- Frontend: `public/index.html` + `public/script.js`, Vanilla JS.
- Backend: Node.js + Express.
- Database: SQLite через `sqlite3`.
- Uploads: Multer, изображения сохраняются в постоянном хранилище Amvera.

## Amvera: обязательные настройки деплоя

В репозитории зафиксирован `amvera.yml`, чтобы Amvera не использовала старую кэшированную команду запуска:

```yaml
meta:
  environment: node
  toolchain:
    name: npm
    version: 20

run:
  command: npm start
  containerPort: 8080
  persistenceMount: /data
```

Что проверить в панели Amvera после пуша:

1. **Конфигурация / Runtime**: окружение `Node.JS Server`, пакетный менеджер `npm`, Node.js `20` или выше.
2. **Команда запуска**: `npm start`. Не указывать `node`, `/app/node` или `scriptName: node` — это приводит к ошибке `Cannot find module '/app/node'`.
3. **Порт контейнера**: `8080`, потому что сервер слушает `process.env.PORT || 8080`.
4. **Постоянное хранилище**: примонтировать в `/data`, чтобы SQLite и загруженные изображения не терялись после пересборки.
5. **Очистка старой сборки**: запустить пересборку без кэша/с очисткой кэша в панели Amvera. Если кнопки очистки нет, поменять любую настройку runtime или сделать новый push с этим `amvera.yml`, затем запустить полную пересборку.
6. **Telegram Web App URL**: в BotFather обновить URL кнопки/меню Web App на актуальный домен Amvera. Старый домен Railway не берется из этого репозитория: в коде нет абсолютных ссылок на Railway, поэтому редирект обычно остается в настройках Telegram-бота или в переменных/секретах панели.

## Amvera: переменные окружения

| Переменная | Назначение |
| --- | --- |
| `PORT` | Порт сервера. Если Amvera задает свой `PORT`, приложение использует его; иначе слушает `8080`. |
| `ADMIN_TG_IDS` | Дополнительные Telegram ID администраторов через запятую, например `123,456`. Владелец `341995937` всегда остается администратором. |

После изменения переменных окружения в панели Amvera обязательно выполните **Restart** или новую пересборку/деплой, иначе уже запущенный Node.js-процесс не увидит новые значения `process.env`.

## Persistent paths

Все динамические данные хранятся в `/data`:

- База данных: `/data/database.json` (SQLite-файл в persistent volume; старая `/data/game.db` копируется автоматически при первом запуске новой версии).
- Загруженные изображения: `/data/uploads`.
- Express раздает изображения по URL `/uploads/<file>`.

Папка `/data/uploads` создается автоматически при старте сервера.

## Запуск локально

```bash
npm install
npm start
```

## Локальная проверка

Для теста вне Telegram можно открыть страницу с query-параметрами:

- Игрок: `http://localhost:8080/?tg_id=200&username=player`
- Админ: `http://localhost:8080/?tg_id=000&username=admin`

## API

- `GET /api/me/:tg_id?username=...` — регистрация/получение состояния игрока.
- `POST /api/roll` — бросок кубика и выдача задания.
- `POST /api/submit` — поэтапная обязательная загрузка двух фото работы через `multipart/form-data`: `photo_before`, затем `photo_after` (`work_image` оставлен как legacy-алиас для Фото ПОСЛЕ).
- `GET /api/check-status/:tg_id` — polling статуса последней сдачи.
- `GET /api/admin/pending-users?admin_tg_id=...` — заявки на вход.
- `POST /api/admin/approve-user` — одобрение игрока.
- `GET /api/admin/submissions?admin_tg_id=...` — нерешенные работы.
- `POST /api/admin/approve-submission` — одобрение работы и разморозка кубика.
- `POST /api/admin/reject-submission` — отклонение работы с комментарием.
- `POST /api/admin/reset-round` — сброс текущего раунда.
- `POST /api/admin/global-reset` — глобальный сброс прогресса и истории.
