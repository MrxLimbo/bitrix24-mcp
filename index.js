import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL;
if (!WEBHOOK) { console.error("❌ Нужна BITRIX_WEBHOOK_URL"); process.exit(1); }

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
  "1": "🆕 Новая", "2": "🔄 В работе", "3": "⏳ В ожидании",
  "4": "✅ Завершена", "5": "⏸️ Отложена", "6": "❌ Просрочена",
};

const PRIORITY = { "0": "низкий", "1": "средний", "2": "🔴 высокий" };

const server = new McpServer({ name: "bitrix24-ocp", version: "2.0.0" });

// ── 1. Создать задачу ──────────────────────────────────────────────────────
server.tool("create_task",
  "Создать задачу в Bitrix24 с чек-листом, дедлайном и ответственным.",
  {
    title:          z.string().describe("Название задачи"),
    description:    z.string().optional().describe("Описание"),
    responsible_id: z.number().optional().describe("ID ответственного"),
    deadline:       z.string().optional().describe("Дедлайн YYYY-MM-DD"),
    priority:       z.enum(["0","1","2"]).optional().describe("0-низкий 1-средний 2-высокий"),
    checklist:      z.array(z.string()).optional().describe("Пункты чек-листа"),
    group_id:       z.number().optional().describe("ID проекта/группы"),
  },
  async ({ title, description, responsible_id, deadline, priority, checklist, group_id }) => {
    const fields = { TITLE: title, GROUP_ID: group_id || 290 };
    if (description)    fields.DESCRIPTION   = description;
    if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;
    if (deadline)       fields.DEADLINE       = deadline + "T23:59:00+06:00";
    if (priority)       fields.PRIORITY       = priority;

    const result = await bx("tasks.task.add", { fields });
    const taskId = result.task?.id;

    if (checklist?.length && taskId) {
      for (const item of checklist) {
        await bx("tasks.task.checklist.add", {
          taskId, fields: { TITLE: item, PARENT_ID: 0, IS_COMPLETE: "N" }
        });
      }
    }
    return { content: [{ type: "text",
      text: `✅ Задача создана!\nID: ${taskId} | ${title}${checklist?.length ? `\nЧек-лист: ${checklist.length} пунктов` : ""}` }] };
  }
);

// ── 2. Дашборд руководителя ────────────────────────────────────────────────
server.tool("manager_dashboard",
  "Полный дашборд для руководителя — все задачи всех сотрудников отдела ОЦП по проектам и статусам. Показывает кто что делает, что просрочено, что критично.",
  {
    group_id: z.number().optional().describe("ID проекта для фильтра (290 = ОЦП). Без фильтра — все проекты."),
  },
  async ({ group_id }) => {
    const filter = {};
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE","GROUP_ID","CREATED_BY"],
      order: { PRIORITY: "DESC", DEADLINE: "ASC" },
    });

    const tasks = result.tasks || [];
    if (!tasks.length) return { content: [{ type: "text", text: "Задач нет" }] };

    const now = new Date();
    const overdue   = tasks.filter(t => t.deadline && new Date(t.deadline) < now && t.status !== "4");
    const highPrio  = tasks.filter(t => t.priority === "2" && t.status !== "4");
    const inProgress = tasks.filter(t => t.status === "2");
    const newTasks  = tasks.filter(t => t.status === "1");
    const done      = tasks.filter(t => t.status === "4");

    const fmt = (t) => {
      const dl = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
      const pr = t.priority === "2" ? " 🔴" : "";
      return `  [${t.id}] ${t.title}${pr}${dl}`;
    };

    let text = `📊 ДАШБОРД ОЦП — всего задач: ${tasks.length}\n${"═".repeat(44)}\n\n`;

    if (overdue.length) {
      text += `🚨 ПРОСРОЧЕНО (${overdue.length}):\n${overdue.map(fmt).join("\n")}\n\n`;
    }
    if (highPrio.length) {
      text += `🔴 ВЫСОКИЙ ПРИОРИТЕТ (${highPrio.length}):\n${highPrio.map(fmt).join("\n")}\n\n`;
    }
    text += `🔄 В РАБОТЕ (${inProgress.length}):\n${inProgress.length ? inProgress.map(fmt).join("\n") : "  —"}\n\n`;
    text += `🆕 НОВЫЕ (${newTasks.length}):\n${newTasks.length ? newTasks.map(fmt).join("\n") : "  —"}\n\n`;
    text += `✅ ЗАВЕРШЕНЫ (${done.length})\n`;

    return { content: [{ type: "text", text }] };
  }
);

// ── 3. Задачи сотрудника ───────────────────────────────────────────────────
server.tool("employee_tasks",
  "Показать все задачи конкретного сотрудника — что в работе, что просрочено, загрузка.",
  {
    responsible_id: z.number().describe("ID сотрудника в Bitrix24"),
    status: z.enum(["all","active","done"]).optional().describe("all/active/done"),
  },
  async ({ responsible_id, status }) => {
    const filter = { RESPONSIBLE_ID: responsible_id };
    if (status === "active") filter["!STATUS"] = "4";
    if (status === "done")   filter.STATUS = "4";

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","PRIORITY","DEADLINE","GROUP_ID"],
      order: { STATUS: "ASC", DEADLINE: "ASC" },
    });

    const tasks = result.tasks || [];
    if (!tasks.length) return { content: [{ type: "text", text: "Задач нет" }] };

    const now = new Date();
    let text = `👤 Задачи сотрудника ID:${responsible_id} — всего: ${tasks.length}\n\n`;

    const groups = {};
    tasks.forEach(t => {
      const s = STATUS[t.status] || t.status;
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    for (const [status, list] of Object.entries(groups)) {
      text += `${status} (${list.length})\n`;
      list.forEach(t => {
        const dl = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
        const overdue = t.deadline && new Date(t.deadline) < now && t.status !== "4" ? " ⚠️" : "";
        text += `  [${t.id}] ${t.title}${dl}${overdue}\n`;
      });
      text += "\n";
    }

    return { content: [{ type: "text", text }] };
  }
);

// ── 4. Список задач ────────────────────────────────────────────────────────
server.tool("list_tasks",
  "Получить список задач с фильтрами по статусу, приоритету или проекту.",
  {
    status:   z.enum(["all","new","in_progress","waiting","completed","deferred"]).optional(),
    priority: z.enum(["0","1","2"]).optional().describe("0-низкий 1-средний 2-высокий"),
    group_id: z.number().optional().describe("ID проекта"),
  },
  async ({ status, priority, group_id }) => {
    const statusMap = { new:1, in_progress:2, waiting:3, completed:4, deferred:5 };
    const filter = {};
    if (status && status !== "all") filter.STATUS = statusMap[status];
    if (priority) filter.PRIORITY = priority;
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
      order: { PRIORITY: "DESC", ACTIVITY_DATE: "DESC" },
    });

    const tasks = result.tasks || [];
    if (!tasks.length) return { content: [{ type: "text", text: "Задач нет" }] };

    const lines = tasks.map(t => {
      const pr = t.priority === "2" ? " 🔴" : "";
      const dl = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
      return `[${t.id}] ${t.title}${pr}\n  ${STATUS[t.status] || t.status}${dl}`;
    }).join("\n\n");

    return { content: [{ type: "text", text: `Задачи (${tasks.length}):\n\n${lines}` }] };
  }
);

// ── 5. Детали задачи ───────────────────────────────────────────────────────
server.tool("get_task",
  "Полная информация по задаче — описание, чек-лист, статус, ответственный.",
  { task_id: z.number().describe("ID задачи") },
  async ({ task_id }) => {
    const result = await bx("tasks.task.get", { taskId: task_id });
    const t = result.task;
    const lines = [
      `Задача #${t.id}: ${t.title}`,
      `Статус: ${STATUS[t.status] || t.status}`,
      `Приоритет: ${PRIORITY[t.priority] || t.priority}`,
      t.description ? `Описание: ${t.description}` : null,
      t.deadline ? `Дедлайн: ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : null,
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: lines }] };
  }
);

// ── 6. Обновить задачу ─────────────────────────────────────────────────────
server.tool("update_task",
  "Изменить статус, приоритет, дедлайн или ответственного у существующей задачи.",
  {
    task_id:        z.number().describe("ID задачи"),
    status:         z.enum(["1","2","3","4","5"]).optional().describe("1-новая 2-в работе 3-ожидание 4-завершена 5-отложена"),
    priority:       z.enum(["0","1","2"]).optional().describe("0-низкий 1-средний 2-высокий"),
    deadline:       z.string().optional().describe("Новый дедлайн YYYY-MM-DD"),
    responsible_id: z.number().optional().describe("Новый ответственный"),
  },
  async ({ task_id, status, priority, deadline, responsible_id }) => {
    const fields = {};
    if (status)         fields.STATUS        = status;
    if (priority)       fields.PRIORITY      = priority;
    if (deadline)       fields.DEADLINE      = deadline + "T23:59:00+06:00";
    if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;

    await bx("tasks.task.update", { taskId: task_id, fields });
    return { content: [{ type: "text", text: `✅ Задача #${task_id} обновлена` }] };
  }
);

// ── 7. Написать сообщение ──────────────────────────────────────────────────
server.tool("send_message",
  "Отправить личное сообщение сотруднику в Bitrix24.",
  {
    user_id: z.number().describe("ID пользователя"),
    message: z.string().describe("Текст сообщения"),
  },
  async ({ user_id, message }) => {
    await bx("im.message.add", { USER_ID: user_id, MESSAGE: message });
    return { content: [{ type: "text", text: `✅ Сообщение отправлено → ID:${user_id}` }] };
  }
);

// ── 8. Найти пользователя ──────────────────────────────────────────────────
server.tool("find_user",
  "Найти сотрудника по имени или фамилии и получить его ID для других инструментов.",
  {
    name: z.string().describe("Имя или фамилия сотрудника"),
  },
  async ({ name }) => {
    const result = await bx("user.search", { FIND: name });
    const users = Array.isArray(result) ? result : [];
    if (!users.length) return { content: [{ type: "text", text: `Сотрудник "${name}" не найден` }] };

    const lines = users.map(u =>
      `ID: ${u.ID} | ${u.NAME} ${u.LAST_NAME} | ${u.WORK_POSITION || "—"} | ${u.EMAIL || ""}`
    ).join("\n");

    return { content: [{ type: "text", text: `Найдено (${users.length}):\n\n${lines}` }] };
  }
);

// ── 9. Список всех сотрудников ─────────────────────────────────────────────
server.tool("get_all_users",
  "Получить список всех активных сотрудников компании с их ID. Нужно чтобы знать ID для фильтрации задач.",
  {},
  async () => {
    const result = await bx("user.get", {
      filter: { ACTIVE: true },
      select: ["ID","NAME","LAST_NAME","WORK_POSITION","EMAIL"],
      order: { NAME: "ASC" },
    });
    const users = Array.isArray(result) ? result : [];
    if (!users.length) return { content: [{ type: "text", text: "Сотрудников нет" }] };

    const lines = users.map(u =>
      `ID:${u.ID} | ${u.NAME} ${u.LAST_NAME}${u.WORK_POSITION ? ` | ${u.WORK_POSITION}` : ""}`
    ).join("\n");

    return { content: [{ type: "text", text: `Сотрудники (${users.length}):\n\n${lines}` }] };
  }
);

// ── Express + SSE ──────────────────────────────────────────────────────────
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
  res.json({ status: "ok", service: "bitrix24-ocp-mcp", version: "2.1", tools: 9 })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bitrix24 OCP MCP v2.0 on port ${PORT}`));
