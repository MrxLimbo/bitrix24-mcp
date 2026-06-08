# Bitrix24 MCP Server

Claude AI агент для Bitrix24 — создание задач, чек-листов, сообщений и дашборд статусов.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `create_task` | Создать задачу с чек-листом, дедлайном, ответственным |
| `list_tasks` | Список задач с фильтром по статусу |
| `task_dashboard` | Все задачи по статусам — для руководителя |
| `get_task` | Детали конкретной задачи |
| `send_message` | Написать сообщение сотруднику |

## Деплой на Railway

### 1. Загрузи код на GitHub
Создай репозиторий `bitrix24-mcp` и загрузи все файлы.

### 2. Задеплой на Railway
1. Зайди на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo → выбери `bitrix24-mcp`
3. После деплоя: Settings → Variables → добавь:
   ```
   BITRIX_WEBHOOK_URL = https://crm.redpetroleum.kg/rest/3046/6e927b4b7zmtt352/
   ```
4. Redeploy (Railway попросит сам)
5. Скопируй URL вида: `https://bitrix24-mcp-xxx.railway.app`

### 3. Подключи в Claude
1. claude.ai → Settings → Integrations → Add custom connector
2. Name: `Bitrix24`
3. URL: `https://bitrix24-mcp-xxx.railway.app/sse`
4. Сохрани

## Проверка

Открой в браузере: `https://bitrix24-mcp-xxx.railway.app/health`
Должно вернуть: `{"status":"ok","service":"bitrix24-mcp","tools":5}`

## Использование в Claude

После подключения просто пиши:
- "Создай задачу для Жалынбека — подготовить отчёт до пятницы"
- "Покажи все задачи в работе"
- "Дай дашборд по всем задачам"
- "Напиши Урмату что задача готова"
