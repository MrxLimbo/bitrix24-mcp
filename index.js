import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

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

const PROJECTS = {
  "redpay":            { id: 80,  name: "RedPay" },
  "ред пэй":           { id: 80,  name: "RedPay" },
  "redmarket":         { id: 328, name: "RedMarket" },
  "ред маркет":        { id: 328, name: "RedMarket" },
  "маркет":            { id: 328, name: "RedMarket" },
  "railcar":           { id: 293, name: "RedLogist" },
  "redlogist":         { id: 293, name: "RedLogist" },
  "ред логист":        { id: 293, name: "RedLogist" },
  "логистика":         { id: 293, name: "RedLogist" },
  "redpro":            { id: 282, name: "RedPro" },
  "ред про":           { id: 282, name: "RedPro" },
  "база данных":       { id: 284, name: "База данных ОРН" },
  "орн":               { id: 284, name: "База данных ОРН" },
  "оптимум":           { id: 309, name: "Оптимум" },
  "optimum":           { id: 309, name: "Оптимум" },
  "кц":                { id: 316, name: "КЦ и запросы" },
  "кц и запросы":      { id: 316, name: "КЦ и запросы" },
  "контакт центр":     { id: 316, name: "КЦ и запросы" },
  "айыл банк":         { id: 323, name: "Айыл банк" },
  "айылбанк":          { id: 323, name: "Айыл банк" },
  "pos":               { id: 323, name: "Айыл банк (POS)" },
  "альфа":             { id: 311, name: "Альфа" },
  "alpha":             { id: 311, name: "Альфа" },
  "zero":              { id: 330, name: "Zero RP" },
  "зеро":              { id: 330, name: "Zero RP" },
  "намба":             { id: 319, name: "QR Намба" },
  "namba":             { id: 319, name: "QR Намба" },
  "qr":                { id: 319, name: "QR Намба" },
  "smart control":     { id: 290, name: "Smart Control" },
  "смарт":             { id: 290, name: "Smart Control" },
  "смарт контрол":     { id: 290, name: "Smart Control" },
  "оцп":               { id: 290, name: "ОЦП / Smart Control" },
};

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
  "Полный дашборд для руководителя — все задачи всех сотрудников отдела ОЦП по проектам и статусам.",
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
    const overdue    = tasks.filter(t => t.deadline && new Date(t.deadline) < now && t.status !== "4");
    const highPrio   = tasks.filter(t => t.priority === "2" && t.status !== "4");
    const inProgress = tasks.filter(t => t.status === "2");
    const newTasks   = tasks.filter(t => t.status === "1");
    const done       = tasks.filter(t => t.status === "4");

    const fmt = (t) => {
      const dl = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
      const pr = t.priority === "2" ? " 🔴" : "";
      return `  [${t.id}] ${t.title}${pr}${dl}`;
    };

    let text = `📊 ДАШБОРД ОЦП — всего задач: ${tasks.length}\n${"═".repeat(44)}\n\n`;
    if (overdue.length)   text += `🚨 ПРОСРОЧЕНО (${overdue.length}):\n${overdue.map(fmt).join("\n")}\n\n`;
    if (highPrio.length)  text += `🔴 ВЫСОКИЙ ПРИОРИТЕТ (${highPrio.length}):\n${highPrio.map(fmt).join("\n")}\n\n`;
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
      order: { ACTIVITY_DATE: "DESC" },
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

    for (const [st, list] of Object.entries(groups)) {
      text += `${st} (${list.length})\n`;
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
      t.groupId      ? `Проект (group_id): ${t.groupId}` : null,
      t.responsibleId ? `Ответственный ID: ${t.responsibleId}` : null,
      t.createdBy     ? `Постановщик ID: ${t.createdBy}` : null,
      t.description   ? `Описание: ${t.description}` : null,
      t.deadline      ? `Дедлайн: ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : null,
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: lines }] };
  }
);

// ── 6. Обновить задачу ─────────────────────────────────────────────────────
server.tool("update_task",
  "Изменить статус, приоритет, дедлайн или ответственного у существующей задачи.",
  {
    task_id:        z.number().describe("ID задачи"),
    status:         z.enum(["1","2","3","4","5"]).optional(),
    priority:       z.enum(["0","1","2"]).optional(),
    deadline:       z.string().optional().describe("Новый дедлайн YYYY-MM-DD"),
    responsible_id: z.number().optional(),
  },
  async ({ task_id, status, priority, deadline, responsible_id }) => {
    const fields = {};
    if (status)         fields.STATUS         = status;
    if (priority)       fields.PRIORITY       = priority;
    if (deadline)       fields.DEADLINE       = deadline + "T23:59:00+06:00";
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
  "Найти сотрудника по имени или фамилии и получить его ID.",
  { name: z.string().describe("Имя или фамилия сотрудника") },
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
  "Получить список всех активных сотрудников компании с их ID.",
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

// ── 10. Найти проект по названию ───────────────────────────────────────────
server.tool("find_project",
  "Найти проект/группу в Bitrix24 по названию.",
  { name: z.string().describe("Название проекта или его часть") },
  async ({ name }) => {
    const search = name.toLowerCase().trim();
    const known = PROJECTS[search];
    if (known) return { content: [{ type: "text", text: `✅ Найден: ${known.name} | GROUP_ID: ${known.id}` }] };

    const partial = Object.entries(PROJECTS).find(([key]) => key.includes(search) || search.includes(key));
    if (partial) return { content: [{ type: "text", text: `✅ Найден: ${partial[1].name} | GROUP_ID: ${partial[1].id}` }] };

    const list = [...new Set(Object.values(PROJECTS).map(p => `ID:${p.id} | ${p.name}`))].join("\n");
    return { content: [{ type: "text", text: `Проект "${name}" не найден.\n\nИзвестные проекты:\n${list}` }] };
  }
);

// ── 11. Сводка по проекту ──────────────────────────────────────────────────
server.tool("get_project_summary",
  "Полная сводка по проекту — открытые задачи, недавно закрытые, статус.",
  {
    group_id:  z.number().describe("ID проекта"),
    days_back: z.number().optional().describe("За сколько дней смотреть закрытые задачи (по умолчанию 7)"),
  },
  async ({ group_id, days_back = 7 }) => {
    const [openResult, closedResult] = await Promise.all([
      bx("tasks.task.list", {
        filter: { GROUP_ID: group_id, "!STATUS": "4" },
        select: ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
        order: { PRIORITY: "DESC", DEADLINE: "ASC" },
      }),
      bx("tasks.task.list", {
        filter: {
          GROUP_ID: group_id,
          STATUS: "4",
          ">=CLOSED_DATE": new Date(Date.now() - days_back * 86400000).toISOString().split("T")[0],
        },
        select: ["ID","TITLE","RESPONSIBLE_ID","CLOSED_DATE"],
        order: { CLOSED_DATE: "DESC" },
      }),
    ]);

    const open   = openResult.tasks   || [];
    const closed = closedResult.tasks || [];
    const now    = new Date();
    const overdue = open.filter(t => t.deadline && new Date(t.deadline) < now);
    const high    = open.filter(t => t.priority === "2");

    let text = `📁 ПРОЕКТ ID:${group_id}\n${"═".repeat(40)}\n\n`;
    text += `📊 Открытых: ${open.length} | Просрочено: ${overdue.length} | Высокий приоритет: ${high.length}\n\n`;

    if (overdue.length) {
      text += `🚨 ПРОСРОЧЕНО:\n`;
      overdue.forEach(t => { text += `  [${t.id}] ${t.title} · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}\n`; });
      text += "\n";
    }
    if (high.length) {
      text += `🔴 ВЫСОКИЙ ПРИОРИТЕТ:\n`;
      high.forEach(t => { text += `  [${t.id}] ${t.title}\n`; });
      text += "\n";
    }

    text += `🔄 ВСЕ ОТКРЫТЫЕ (${open.length}):\n`;
    open.length
      ? open.forEach(t => {
          const dl = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
          const pr = t.priority === "2" ? " 🔴" : "";
          text += `  [${t.id}] ${t.title}${pr}${dl} — ${STATUS[t.status] || t.status}\n`;
        })
      : (text += "  Нет открытых задач\n");

    text += `\n✅ ЗАКРЫТО ЗА ${days_back} ДНЕЙ (${closed.length}):\n`;
    closed.length
      ? closed.forEach(t => {
          const dt = t.closedDate ? new Date(t.closedDate).toLocaleDateString("ru-RU") : "—";
          text += `  [${t.id}] ${t.title} · закрыта ${dt}\n`;
        })
      : (text += "  Нет закрытых задач за период\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── 12. Добавить комментарий ───────────────────────────────────────────────
server.tool("add_task_comment",
  "Добавить комментарий к существующей задаче в Bitrix24.",
  {
    task_id: z.number().describe("ID задачи"),
    comment: z.string().describe("Текст комментария"),
  },
  async ({ task_id, comment }) => {
    await bx("task.commentitem.add", { TASK_ID: task_id, fields: { POST_MESSAGE: comment } });
    return { content: [{ type: "text", text: `✅ Комментарий добавлен к задаче #${task_id}` }] };
  }
);

// ── 13. Прочитать комментарии ──────────────────────────────────────────────
server.tool("get_task_comments",
  "Получить комментарии к задаче — что обсуждали, какие были решения.",
  { task_id: z.number().describe("ID задачи") },
  async ({ task_id }) => {
    const result = await bx("task.commentitem.getList", { TASK_ID: task_id });
    const comments = Array.isArray(result)
      ? result
      : result && typeof result === "object" ? Object.values(result) : [];
    if (!comments.length) return { content: [{ type: "text", text: "Комментариев нет" }] };

    const lines = comments.map(c => {
      const date   = c.POST_DATE ? new Date(c.POST_DATE).toLocaleDateString("ru-RU") : "—";
      const author = c.AUTHOR_ID ? `ID:${c.AUTHOR_ID}` : "—";
      return `[${date}] ${author}\n${c.POST_MESSAGE || "—"}`;
    }).join("\n\n─────\n\n");

    return { content: [{ type: "text", text: `Комментарии к задаче #${task_id} (${comments.length}):\n\n${lines}` }] };
  }
);

// ── 14. Добавить пункт в чеклист ───────────────────────────────────────────
server.tool("add_checklist_item",
  "Добавить новый пункт в чек-лист уже существующей задачи.",
  {
    task_id: z.number().describe("ID задачи"),
    item:    z.string().describe("Текст пункта чек-листа"),
  },
  async ({ task_id, item }) => {
    await bx("tasks.task.checklist.add", {
      taskId: task_id,
      fields: { TITLE: item, PARENT_ID: 0, IS_COMPLETE: "N" },
    });
    return { content: [{ type: "text", text: `✅ Пункт добавлен в чек-лист задачи #${task_id}: "${item}"` }] };
  }
);

// ── 15. Отчёт по просроченным ──────────────────────────────────────────────
server.tool("overdue_report",
  "Показать все просроченные задачи по всем сотрудникам.",
  { group_id: z.number().optional().describe("ID проекта для фильтра") },
  async ({ group_id }) => {
    const filter = { "<=DEADLINE": new Date().toISOString(), "!STATUS": "4" };
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","RESPONSIBLE_ID","DEADLINE","GROUP_ID"],
      order: { DEADLINE: "ASC" },
    });

    const tasks = result.tasks || [];
    if (!tasks.length) return { content: [{ type: "text", text: "✅ Просроченных задач нет!" }] };

    const byUser = {};
    tasks.forEach(t => {
      const uid = t.responsibleId || "?";
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(t);
    });

    let text = `🚨 ПРОСРОЧЕННЫЕ — всего: ${tasks.length}\n${"═".repeat(40)}\n\n`;
    for (const [uid, list] of Object.entries(byUser)) {
      text += `👤 Ответственный ID:${uid} (${list.length} задач)\n`;
      list.forEach(t => {
        const days = Math.floor((Date.now() - new Date(t.deadline)) / 86400000);
        text += `  [${t.id}] ${t.title} · просрочено на ${days} дн.\n`;
      });
      text += "\n";
    }

    return { content: [{ type: "text", text }] };
  }
);

// ── 16. Загрузка сотрудников ───────────────────────────────────────────────
server.tool("workload_report",
  "Показать загрузку каждого сотрудника — сколько задач у кого, кто перегружен.",
  { group_id: z.number().optional().describe("ID проекта для фильтра") },
  async ({ group_id }) => {
    const filter = { "!STATUS": "4" };
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
      order: { ACTIVITY_DATE: "DESC" },
    });

    const tasks  = result.tasks || [];
    const now    = new Date();
    const byUser = {};

    tasks.forEach(t => {
      const uid = t.responsibleId || "?";
      if (!byUser[uid]) byUser[uid] = { total: 0, high: 0, overdue: 0 };
      byUser[uid].total++;
      if (t.priority === "2") byUser[uid].high++;
      if (t.deadline && new Date(t.deadline) < now) byUser[uid].overdue++;
    });

    const sorted = Object.entries(byUser).sort((a, b) => b[1].total - a[1].total);

    let text = `📊 ЗАГРУЗКА — активных задач: ${tasks.length}\n${"═".repeat(40)}\n\n`;
    sorted.forEach(([uid, data]) => {
      const bar = "█".repeat(Math.min(data.total, 10));
      text += `👤 ID:${uid} ${bar} ${data.total} задач`;
      if (data.overdue) text += ` | ⚠️ просрочено: ${data.overdue}`;
      if (data.high)    text += ` | 🔴 высокий: ${data.high}`;
      text += "\n";
    });

    return { content: [{ type: "text", text }] };
  }
);

// ── 17. Читать переписку в коллабе ────────────────────────────────────────
server.tool("get_collab_chat",
  "Прочитать последние сообщения из чата коллаба/рабочей группы в Bitrix24.",
  {
    group_id: z.number().describe("ID коллаба/рабочей группы"),
    limit:    z.number().optional().describe("Количество последних сообщений (по умолчанию 20)"),
  },
  async ({ group_id, limit = 20 }) => {
    const chatInfo = await bx("im.chat.get", { DIALOG_ID: `SG${group_id}` });
    const chatId = chatInfo?.id || chatInfo?.ID;
    if (!chatId) return { content: [{ type: "text", text: `Чат для коллаба ID:${group_id} не найден` }] };

    const result = await bx("im.message.getList", { CHAT_ID: chatId, LAST_N: limit });

    const messages = Array.isArray(result?.messages)
      ? result.messages
      : result?.messages ? Object.values(result.messages) : [];

    if (!messages.length) return { content: [{ type: "text", text: "Сообщений нет" }] };

    const lines = messages.map(m => {
      const date   = m.DATE ? new Date(m.DATE).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
      const author = m.AUTHOR_ID ? `ID:${m.AUTHOR_ID}` : "—";
      const text   = m.MESSAGE || m.TEXT || "—";
      return `[${date}] ${author}:\n${text}`;
    }).join("\n\n");

    return { content: [{ type: "text", text: `💬 Чат коллаба ID:${group_id} (последние ${messages.length}):\n${"─".repeat(36)}\n\n${lines}` }] };
  }
);

// ── 18. Удалить задачу ────────────────────────────────────────────────────
server.tool("delete_task",
  "Удалить задачу из Bitrix24 по её ID. Внимание: действие необратимо.",
  { task_id: z.number().describe("ID задачи для удаления") },
  async ({ task_id }) => {
    await bx("tasks.task.delete", { taskId: task_id });
    return { content: [{ type: "text", text: `✅ Задача #${task_id} удалена` }] };
  }
);

// ── Bot Client IDs ─────────────────────────────────────────────────────────
const BOT_CLIENTS = {
  "7358": "9c6yjlcm53b4ixr0v32gbuqz79zgw5ud",
  "7360": "ugjk1pbwylqhngmj7abkxstdv3pc94lr",
};

// ── Anthropic Client ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOT_SYSTEM = `Ты AI-ассистент Red Petroleum встроенный в Bitrix24. Тебя зовут Red AI.
Ты помогаешь сотрудникам работать с задачами и проектами.

Что ты умеешь:
- Показывать задачи сотрудников и проектов
- Создавать задачи
- Показывать статусы проектов (RedPay, RedMarket, RedLogist, RedPro, Оптимум, КЦ, Альфа и др.)
- Анализировать загрузку команды
- Показывать просроченные задачи

Отвечай коротко, по делу, на русском языке. Используй эмодзи для структуры.
Если не понял запрос — попроси уточнить.
Ты помнишь весь диалог с пользователем и можешь ссылаться на предыдущие сообщения.`;

// ── Кеш пользователей ─────────────────────────────────────────────────────
// userId → { name, lastName, position, department }
const userCache = new Map();

async function getUserInfo(userId) {
  if (!userId) return null;
  const id = String(userId);

  // Берём из кеша если есть
  if (userCache.has(id)) return userCache.get(id);

  try {
    const result = await bx("user.get", { ID: id });
    const users = Array.isArray(result) ? result : [];
    if (!users.length) return null;

    const u = users[0];
    const info = {
      name:       u.NAME       || "",
      lastName:   u.LAST_NAME  || "",
      position:   u.WORK_POSITION || "",
      department: u.UF_DEPARTMENT || "",
      fullName:   `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim(),
    };

    userCache.set(id, info);
    return info;
  } catch (e) {
    console.error("getUserInfo error:", e.message);
    return null;
  }
}

async function buildContext(message, userId) {
  const msg = message.toLowerCase();
  let context = "";

  try {
    for (const [key, proj] of Object.entries(PROJECTS)) {
      if (msg.includes(key)) {
        const result = await bx("tasks.task.list", {
          filter: { GROUP_ID: proj.id, "!STATUS": "4" },
          select: ["ID","TITLE","STATUS","DEADLINE","PRIORITY"],
          order: { PRIORITY: "DESC" },
        });
        const tasks = result.tasks || [];
        const now = new Date();
        const overdue = tasks.filter(t => t.deadline && new Date(t.deadline) < now);
        context = `Проект: ${proj.name} | Открытых: ${tasks.length} | Просрочено: ${overdue.length}\n` +
          tasks.slice(0, 15).map(t => {
            const pr = t.priority === "2" ? "🔴" : "";
            const dl = t.deadline ? ` до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
            return `[${t.id}] ${pr}${t.title}${dl} — ${STATUS[t.status] || t.status}`;
          }).join("\n");
        break;
      }
    }

    if (!context && (msg.includes("мои задач") || msg.includes("my task") || msg.includes("мои"))) {
      const result = await bx("tasks.task.list", {
        filter: { RESPONSIBLE_ID: parseInt(userId), "!STATUS": "4" },
        select: ["ID","TITLE","STATUS","DEADLINE","PRIORITY"],
        order: { ACTIVITY_DATE: "DESC" },
      });
      const tasks = result.tasks || [];
      context = `Твои задачи (${tasks.length}):\n` +
        tasks.slice(0, 15).map(t =>
          `[${t.id}] ${t.title} — ${STATUS[t.status] || t.status}`
        ).join("\n");
    }

    if (!context && (msg.includes("просроч") || msg.includes("горит") || msg.includes("overdue"))) {
      const result = await bx("tasks.task.list", {
        filter: { "<=DEADLINE": new Date().toISOString(), "!STATUS": "4" },
        select: ["ID","TITLE","STATUS","RESPONSIBLE_ID","DEADLINE"],
        order: { DEADLINE: "ASC" },
      });
      const tasks = result.tasks || [];
      context = `🚨 Просроченные задачи (${tasks.length}):\n` +
        tasks.slice(0, 15).map(t => {
          const days = Math.floor((Date.now() - new Date(t.deadline)) / 86400000);
          return `[${t.id}] ${t.title} · просрочено ${days} дн.`;
        }).join("\n");
    }
  } catch (e) {
    console.error("Context error:", e.message);
  }

  return context;
}

// ── Express + SSE ──────────────────────────────────────────────────────────
const app = express();
const sessions = {};

// ── Память диалогов ────────────────────────────────────────────────────────
// dialogId → { messages: [{role, content}], updatedAt: timestamp }
const conversationHistory = new Map();
const MAX_HISTORY = 20; // максимум сообщений на диалог (= 10 обменов)

// Чистим диалоги старше 2 часов — каждый час
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of conversationHistory) {
    if (val.updatedAt < cutoff) conversationHistory.delete(key);
  }
}, 60 * 60 * 1000);

// ── Bot endpoint ───────────────────────────────────────────────────────────
app.post("/bot", express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  res.status(200).send("OK");

  const body  = req.body;
  console.log("🤖 Bot request:", JSON.stringify(body).slice(0, 500));

  const event = body.event || body.EVENT;
  console.log("📨 Event:", event);

  if (event !== "ONIMBOTMESSAGEADD") {
    console.log("⏭️ Skipping event:", event);
    return;
  }

  const data   = body.data || body.DATA || {};
  const params = data.PARAMS || data;

  const botRaw = data.BOT;
  let botId;
  if (typeof botRaw === "object" && botRaw !== null) {
    const firstBot = Object.values(botRaw)[0];
    botId = firstBot?.BOT_ID || Object.keys(botRaw)[0];
  } else {
    botId = botRaw || data.BOT_ID || params.TO_USER_ID;
  }

  const dialogId = params.DIALOG_ID || data.DIALOG_ID;
  const userId   = params.FROM_USER_ID || params.USER_ID || data.USER_ID;
  const message  = params.MESSAGE || data.MESSAGE;

  console.log(`💬 Message from ${userId}: "${message}" | botId:${botId} dialogId:${dialogId}`);

  if (!message || !dialogId || !botId) return;

  // ── Команда сброса памяти ──────────────────────────────────────────────
  const trimmed = message.trim().toLowerCase();
  if (trimmed === "забудь" || trimmed === "/reset" || trimmed === "сброс") {
    conversationHistory.delete(dialogId);
    await bx("imbot.message.add", {
      BOT_ID:    botId,
      CLIENT_ID: BOT_CLIENTS[botId] || "",
      DIALOG_ID: dialogId,
      MESSAGE:   "🧹 Память очищена. Начинаем с чистого листа!",
    });
    return;
  }

  try {
    const [context, userInfo] = await Promise.all([
      buildContext(message, userId),
      getUserInfo(userId),
    ]);

    const userMsg = context ? `${message}\n\nДанные из Bitrix24:\n${context}` : message;

    // Персонализируем системный промпт под конкретного сотрудника
    const userLine = userInfo
      ? `\nСейчас с тобой общается: ${userInfo.fullName}${userInfo.position ? ` (${userInfo.position})` : ""}. Обращайся к нему по имени — ${userInfo.name}.`
      : "";
    const systemPrompt = BOT_SYSTEM + userLine;

    // Загружаем историю этого диалога
    const entry = conversationHistory.get(dialogId) || { messages: [], updatedAt: Date.now() };
    entry.messages.push({ role: "user", content: userMsg });
    entry.updatedAt = Date.now();

    console.log(`🧠 Calling Claude API... user:${userInfo?.fullName || userId} история:${entry.messages.length}`);

    // Вызываем Claude с полной историей и персональным промптом
    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   entry.messages,
    });

    const answer = response.content[0]?.text || "Не могу ответить, попробуй снова.";
    console.log("✅ Claude answer:", answer.slice(0, 100));

    // Сохраняем ответ в историю
    entry.messages.push({ role: "assistant", content: answer });

    // Обрезаем если слишком длинно (экономим токены)
    if (entry.messages.length > MAX_HISTORY) {
      entry.messages = entry.messages.slice(-MAX_HISTORY);
    }

    conversationHistory.set(dialogId, entry);

    await bx("imbot.message.add", {
      BOT_ID:    botId,
      CLIENT_ID: BOT_CLIENTS[botId] || "",
      DIALOG_ID: dialogId,
      MESSAGE:   answer,
    });
    console.log("📤 Message sent to Bitrix24");
  } catch (e) {
    console.error("Bot error:", e.message);
    try {
      await bx("imbot.message.add", {
        BOT_ID:    botId,
        CLIENT_ID: BOT_CLIENTS[botId] || "",
        DIALOG_ID: dialogId,
        MESSAGE:   "⚠️ Ошибка. Попробуй снова.",
      });
    } catch {}
  }
});

// ── SSE endpoint ───────────────────────────────────────────────────────────
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
  res.json({ status: "ok", service: "bitrix24-ocp-mcp", version: "5.1", tools: 18, bot: true, memory: true })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bitrix24 OCP MCP v5.1 | 18 tools | memory enabled | port ${PORT}`));
