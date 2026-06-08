import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL;
if (!WEBHOOK) {
  console.error("❌ Нужна переменная BITRIX_WEBHOOK_URL");
  process.exit(1);
}

// ─── Вызов Bitrix24 REST API ───────────────────────────────────────────────
async function bx(method, params = {}) {
  const base = WEBHOOK.endsWith("/") ? WEBHOOK : WEBHOOK + "/";
  const res = await fetch(`${base}${method}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.result;
}

const STATUS = {
  "1": "🆕 Новая",
  "2": "🔄 В работе",
  "3": "⏳ В ожидании",
  "4": "✅ Завершена",
  "5": "⏸️ Отложена",
  "6": "❌ Просрочена",
};

// ─── MCP Сервер ────────────────────────────────────────────────────────────
const server = new McpServer({ name: "bitrix24", version: "1.0.0" });

// Инструмент 1: Создать задачу
server.tool(
  "create_task",
  "Создать задачу в Bitrix24. Можно добавить чек-лист, дедлайн и ответственного.",
  {
    title:          z.string().describe("Название задачи"),
    description:    z.string().optional().describe("Описание задачи"),
    responsible_id: z.number().optional().describe("ID ответственного сотрудника"),
    deadline:       z.string().optional().describe("Дедлайн YYYY-MM-DD"),
    checklist:      z.array(z.string()).optional().describe("Пункты чек-листа построчно"),
  },
  async ({ title, description, responsible_id, deadline, checklist }) => {
    const fields = { TITLE: title, GROUP_ID: 290 };
    if (description)    fields.DESCRIPTION  = description;
    if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;
    if (deadline)       fields.DEADLINE = deadline + "T23:59:00+06:00";

    const result = await bx("tasks.task.add", { fields });
    const taskId = result.task?.id;

    if (checklist?.length && taskId) {
      for (const item of checklist) {
        await bx("tasks.task.checklist.add", { taskId, fields: { TITLE: item } });
      }
    }

    return {
      content: [{
        type: "text",
        text: `✅ Задача создана!\nID: ${taskId} | Название: ${title}${checklist?.length ? `\nЧек-лист: ${checklist.length} пунктов` : ""}`,
      }],
    };
  }
);

// Инструмент 2: Список задач
server.tool(
  "list_tasks",
  "Получить список задач из Bitrix24 с фильтрацией по статусу или ответственному.",
  {
    status:         z.enum(["all","new","in_progress","waiting","completed","deferred"]).optional(),
    responsible_id: z.number().optional().describe("Фильтр по ID сотрудника"),
  },
  async ({ status, responsible_id }) => {
    const statusMap = { new:1, in_progress:2, waiting:3, completed:4, deferred:5 };
    const filter = {};
    if (status && status !== "all") filter.STATUS = statusMap[status];
    if (responsible_id) filter.RESPONSIBLE_ID = responsible_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","RESPONSIBLE_ID","DEADLINE"],
      order:  { ACTIVITY_DATE: "DESC" },
    });

    const tasks = result.tasks || [];
    if (!tasks.length) return { content: [{ type: "text", text: "Задач нет" }] };

    const lines = tasks.map(t =>
      `[${t.id}] ${t.title}\n  ${STATUS[t.status] || t.status}${t.deadline ? " | до " + new Date(t.deadline).toLocaleDateString("ru-RU") : ""}`
    ).join("\n\n");

    return { content: [{ type: "text", text: `Задачи (${tasks.length}):\n\n${lines}` }] };
  }
);

// Инструмент 3: Статус-дашборд для руководителя
server.tool(
  "task_dashboard",
  "Показать все задачи сгруппированные по статусам. Для руководителя — общая картина по проекту.",
  {},
  async () => {
    const result = await bx("tasks.task.list", {
      filter: {},
      select: ["ID","TITLE","STATUS","DEADLINE"],
      order:  { STATUS: "ASC" },
    });

    const tasks  = result.tasks || [];
    const groups = {};
    tasks.forEach(t => {
      const s = STATUS[t.status] || `Статус ${t.status}`;
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    let text = `📊 Дашборд задач — всего: ${tasks.length}\n${"─".repeat(36)}\n\n`;
    for (const [status, list] of Object.entries(groups)) {
      text += `${status} (${list.length})\n`;
      list.forEach(t => {
        const dl = t.deadline ? ` • до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
        text += `  [${t.id}] ${t.title}${dl}\n`;
      });
      text += "\n";
    }

    return { content: [{ type: "text", text }] };
  }
);

// Инструмент 4: Детали задачи
server.tool(
  "get_task",
  "Получить полную информацию по конкретной задаче по её ID.",
  { task_id: z.number().describe("ID задачи в Bitrix24") },
  async ({ task_id }) => {
    const result = await bx("tasks.task.get", { taskId: task_id });
    const t = result.task;
    const text = [
      `Задача #${t.id}: ${t.title}`,
      `Статус: ${STATUS[t.status] || t.status}`,
      t.description ? `Описание: ${t.description}` : null,
      t.deadline    ? `Дедлайн: ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : null,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// Инструмент 5: Написать сообщение
server.tool(
  "send_message",
  "Отправить сообщение сотруднику в личный чат Bitrix24.",
  {
    user_id: z.number().describe("ID пользователя Bitrix24"),
    message: z.string().describe("Текст сообщения"),
  },
  async ({ user_id, message }) => {
    await bx("im.message.add", { USER_ID: user_id, MESSAGE: message });
    return { content: [{ type: "text", text: `✅ Сообщение отправлено → ID:${user_id}` }] };
  }
);

// ─── Express + SSE Transport ───────────────────────────────────────────────
const app = express();
const sessions = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions[transport.sessionId] = transport;
  res.on("close", () => delete sessions[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId");
  const transport = sessions[sessionId];
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_, res) =>
  res.json({ status: "ok", service: "bitrix24-mcp", tools: 5 })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bitrix24 MCP Server запущен на порту ${PORT}`));
