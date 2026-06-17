import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL;
if (!WEBHOOK) { console.error("❌ Нужна BITRIX_WEBHOOK_URL"); process.exit(1); }

// Личные вебхуки сотрудников — задачи будут создаваться от их имени
const USER_WEBHOOKS = {
  "3046": "https://crm.redpetroleum.kg/rest/3046/em7h2nchgw8zgnr4/", // Эрмек Русланов
};

async function bx(method, params = {}, userId = null) {
  const webhook = (userId && USER_WEBHOOKS[String(userId)]) || WEBHOOK;
  const base = webhook.endsWith("/") ? webhook : webhook + "/";
  const res = await fetch(`${base}${method}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.result;
}

// ── Пагинация: получить ВСЕ задачи по фильтру (не только первые 50) ─────────
async function getAllTasks(filter, select, order, userId) {
  let all = [], start = 0, page = 0;
  const MAX_PAGES = 20; // защита от бесконечного цикла (макс 1000 задач)
  while (page < MAX_PAGES) {
    const res = await bx("tasks.task.list", { filter, select, order, start }, userId);
    const batch = res?.tasks || [];
    all = all.concat(batch);
    if (batch.length < 50) break; // последняя страница
    start += 50;
    page++;
  }
  return all;
}

// ── Точный счётчик задач без загрузки данных ─────────────────────────────────
async function countTasks(filter, userId) {
  const res = await bx("tasks.task.list", {
    filter,
    select: ["ID"],
    start: 0,
  }, userId);
  // Получаем реальное количество через пагинацию
  let total = res?.tasks?.length || 0;
  let start = 50;
  while (res?.tasks?.length === 50) {
    const next = await bx("tasks.task.list", { filter, select: ["ID"], start }, userId);
    total += next?.tasks?.length || 0;
    if ((next?.tasks?.length || 0) < 50) break;
    start += 50;
    if (start > 1000) break; // защита
  }
  return total;
}

// ── Resolve userId → имя сотрудника ─────────────────────────────────────────
async function getUserName(userId) {
  if (!userId || userId === "?") return `ID:${userId}`;
  try {
    const profile = await getUserProfile(userId);
    if (profile?.name) {
      return `${profile.name}${profile.lastName ? " " + profile.lastName : ""}`;
    }
  } catch (e) { /* fallback */ }
  return `ID:${userId}`;
}

const PROJECTS = {
  "redpay":            { id: 80,  name: "RedPay" },
  "redmarket":         { id: 328, name: "RedMarket" },
  "маркет":            { id: 328, name: "RedMarket" },
  "redlogist":         { id: 293, name: "RedLogist" },
  "redpro":            { id: 282, name: "RedPro" },
  "орн":               { id: 284, name: "База данных ОРН" },
  "оптимум":           { id: 309, name: "Оптимум" },
  "кц":                { id: 316, name: "КЦ и запросы" },
  "айыл банк":         { id: 323, name: "Айыл банк (POS-терминал)" },
  "альфа":             { id: 311, name: "Альфа" },
  "zero":              { id: 330, name: "Zero RP" },
  "намба":             { id: 319, name: "QR Намба" },
  "логистика жд":      { id: 290, name: "Логистика ЖД" },
  "smart control":     { id: 290, name: "Smart Control" },

  // Новые проекты (12.06.2026)
  "осаго":             { id: 298, name: "ОСАГО" },
  "документооборот":   { id: 288, name: "Документооборот компании в системе B2B" },
  "платежное поручение": { id: 336, name: "Платёжное поручение исходящего" },
  "аренда":            { id: 338, name: "Управление арендой недвижимости (ССБН)" },
  "окс":               { id: 321, name: "Автоматизация процесса ОКС" },
  "электрозарядки":    { id: 294, name: "Электрозарядки" },
  "тендер":            { id: 283, name: "Тендер" },
  "автобаза":          { id: 267, name: "Автобаза" },
};

const BITRIX_DOMAIN = "https://crm.redpetroleum.kg";

function taskLink(taskId, groupId) {
  if (groupId) {
    return `${BITRIX_DOMAIN}/workgroups/group/${groupId}/tasks/task/view/${taskId}/`;
  }
  return `${BITRIX_DOMAIN}/company/personal/user/0/tasks/task/view/${taskId}/`;
}

const STATUS = {
  "1": "🆕 Новая",
  "2": "📋 Ждёт выполнения",   // назначена, кнопка «Начать» не нажата
  "3": "🔄 Выполняется",       // исполнитель нажал «Начать»
  "4": "👀 Ждёт контроля",     // исполнитель нажал «Завершить», ждёт одобрения постановщика
  "5": "✅ Завершена",          // постановщик одобрил, задача закрыта
  "6": "⏸️ Отложена",           // приостановлена, «Возобновить» → статус 3
  "7": "❌ Отклонена",
};

const PRIORITY = { "0": "низкий", "1": "средний", "2": "🔴 высокий" };

// Максимум задач в списке — больше = только сводка, без перечисления
const MAX_DISPLAY = 50;

function formatDate(dateStr) {
  if (!dateStr) return "";
  try { return new Date(dateStr).toLocaleDateString("ru-RU", { day:"2-digit", month:"2-digit" }); }
  catch { return ""; }
}

// Форматируем одну задачу — жёсткая строка, Haiku копирует дословно
function fmtTask(t, groupId) {
  const status  = STATUS[t.status] || `статус:${t.status}`;
  const dl      = t.deadline ? ` · до ${formatDate(t.deadline)}` : "";
  const closed  = t.closedDate ? ` · закрыта ${formatDate(t.closedDate)}` : "";
  const now     = new Date();
  const daysLate = t.deadline && new Date(t.deadline) < now && t.status !== "5"
    ? Math.floor((now - new Date(t.deadline)) / 86400000) : 0;
  const overdue = daysLate > 0 ? ` ⚠️просрочено ${daysLate}д` : "";
  const link    = taskLink(t.id, groupId || t.groupId);
  return `[${t.id}] ${t.title} · ${status}${dl}${closed}${overdue} | ${link}`;
}

// Умная сводка — топ-3 срочных + статусы + проекты
function taskSummary(tasks) {
  const now = new Date();
  // Топ-3 срочных активных
  const urgent = tasks
    .filter(t => t.deadline && t.status !== "5" && t.status !== "7")
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
    .slice(0, 3);
  // По статусам
  const byStatus = {};
  tasks.forEach(t => {
    const s = STATUS[t.status] || `статус ${t.status}`;
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  // По проектам топ-5
  const byProj = {};
  tasks.forEach(t => {
    const name = t.groupId && PROJECTS[t.groupId]
      ? (PROJECTS[t.groupId].name || `проект ${t.groupId}`)
      : t.groupId ? `группа ${t.groupId}` : "личные";
    byProj[name] = (byProj[name] || 0) + 1;
  });
  const topProj = Object.entries(byProj).sort((a,b) => b[1]-a[1]).slice(0, 5);

  let text = `📊 Найдено ${tasks.length} задач — много для одного списка.
`;
  if (urgent.length) {
    text += `
🔥 Самые срочные:
`;
    urgent.forEach(t => {
      const diff = Math.ceil((new Date(t.deadline) - now) / 86400000);
      const when = diff < 0 ? `просрочено ${Math.abs(diff)}д` : diff === 0 ? "СЕГОДНЯ!" : `через ${diff}д`;
      text += `  [${t.id}] ${t.title} · ${when} | ${taskLink(t.id, t.groupId)}
`;
    });
  }
  text += `
По статусу:
`;
  for (const [s, n] of Object.entries(byStatus)) text += `  ${s}: ${n}
`;
  if (topProj.length > 1) {
    text += `
По проектам:
`;
    for (const [p, n] of topProj) text += `  ${p}: ${n}
`;
  }
  text += `
Скажи статус или проект — покажу список.`;
  return text;
}

// Список задач до 50 — в code block чтобы Haiku копировал дословно
function fmtTaskList(tasks, title = "") {
  if (!tasks.length) return "Задач нет";
  if (tasks.length > MAX_DISPLAY) return taskSummary(tasks);
  const lines = tasks.map(t => fmtTask(t)).join("\n");
  const header = title || ("Задачи (" + tasks.length + ")");
  return header + ":\n" + lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS — общая логика для MCP и для бота (function calling)
// userId передаётся для использования личного вебхука (USER_WEBHOOKS)
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_HANDLERS = {

  create_task: async (input, userId) => {
    const { title, description, responsible_id, deadline, priority, checklist, group_id } = input;
    // group_id обязателен — не ставим дефолтный чтобы задача не попадала в чужой проект
    const fields = { TITLE: title };
    if (group_id) fields.GROUP_ID = group_id;
    if (description)    fields.DESCRIPTION   = description;
    if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;
    if (deadline)       fields.DEADLINE       = deadline + "T23:59:00+06:00";
    if (priority)       fields.PRIORITY       = priority;

    const result = await bx("tasks.task.add", { fields }, userId);
    const taskId = result.task?.id;

    if (checklist?.length && taskId) {
      for (const item of checklist) {
        await bx("tasks.task.checklist.add", {
          taskId, fields: { TITLE: item, PARENT_ID: 0, IS_COMPLETE: "N" }
        }, userId);
      }
    }
    const link = taskLink(taskId, fields.GROUP_ID);
    return `✅ Задача создана!\nID: ${taskId} | ${title}${checklist?.length ? `\nЧек-лист: ${checklist.length} пунктов` : ""}\n${link}`;
  },

  manager_dashboard: async (input, userId) => {
    const { group_id } = input;
    const filter = {};
    if (group_id) filter.GROUP_ID = group_id;

    const tasks = await getAllTasks(
      filter,
      ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE","GROUP_ID","CREATED_BY"],
      { PRIORITY: "DESC", DEADLINE: "ASC" },
      userId
    );
    if (!tasks.length) return "Задач нет";

    const now = new Date();
    const overdue    = tasks.filter(t => t.deadline && new Date(t.deadline) < now && !["5","7"].includes(t.status));
    const highPrio   = tasks.filter(t => t.priority === "2" && !["5","7"].includes(t.status));
    const inProgress = tasks.filter(t => t.status === "3"); // Выполняется
    const waiting    = tasks.filter(t => t.status === "2"); // Ждёт выполнения
    const pending    = tasks.filter(t => t.status === "4"); // Ждёт контроля
    const newTasks   = tasks.filter(t => t.status === "1");
    const done       = tasks.filter(t => t.status === "5");

    const fmt = (t) => {
      const dl = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
      const pr = t.priority === "2" ? " 🔴" : "";
      return `  [${t.id}] ${t.title}${pr}${dl} | ${taskLink(t.id, t.groupId)}`;
    };

    let text = `📊 ДАШБОРД — всего задач: ${tasks.length}\n${"═".repeat(44)}\n\n`;
    if (overdue.length)  text += `🚨 ПРОСРОЧЕНО (${overdue.length}):\n${overdue.map(fmt).join("\n")}\n\n`;
    if (highPrio.length) text += `🔴 ВЫСОКИЙ ПРИОРИТЕТ (${highPrio.length}):\n${highPrio.map(fmt).join("\n")}\n\n`;
    text += `🔄 ВЫПОЛНЯЕТСЯ (${inProgress.length}):\n${inProgress.length ? inProgress.map(fmt).join("\n") : "  —"}\n\n`;
    text += `📋 ЖДЁТ ВЫПОЛНЕНИЯ (${waiting.length}):\n${waiting.length ? waiting.map(fmt).join("\n") : "  —"}\n\n`;
    text += `👀 ЖДЁТ КОНТРОЛЯ (${pending.length}):\n${pending.length ? pending.map(fmt).join("\n") : "  —"}\n\n`;
    text += `🆕 НОВЫЕ (${newTasks.length}):\n${newTasks.length ? newTasks.map(fmt).join("\n") : "  —"}\n\n`;
    text += `✅ ЗАВЕРШЕНЫ (${done.length})\n`;
    return text;
  },

  employee_tasks: async (input, userId) => {
    const { responsible_id, status, group_id, date_from, date_to, created_by } = input;
    const filter = {};
    // Фильтр по исполнителю ИЛИ постановщику
    if (responsible_id) filter.RESPONSIBLE_ID = responsible_id;
    if (created_by)     filter.CREATED_BY = created_by;
    if (status === "active") filter["!STATUS"] = ["5","7"];
    if (status === "done") {
      filter.STATUS = "5";
      if (date_from) filter[">=CLOSED_DATE"] = date_from;
      if (date_to)   filter["<=CLOSED_DATE"] = date_to;
    }
    if (group_id) filter.GROUP_ID = group_id;

    const select = ["ID","TITLE","STATUS","PRIORITY","DEADLINE","GROUP_ID","RESPONSIBLE_ID"];
    if (status === "done") select.push("CLOSED_DATE");

    // Пагинация — получаем все задачи, не только первые 50
    const tasks = await getAllTasks(filter, select,
      status === "done" ? { CLOSED_DATE: "DESC" } : { ACTIVITY_DATE: "DESC" },
      userId
    );
    if (!tasks.length) return "Задач нет";

    const now = new Date();
    const who = created_by ? `постановщик ID:${created_by}` : `исполнитель ID:${responsible_id}`;
    const projectInfo = group_id ? ` | проект ID:${group_id}` : "";
    const dateInfo = (date_from || date_to)
      ? ` | с ${date_from || "начала"} по ${date_to || "сегодня"}`
      : "";
    let text = `👤 Задачи (${who})${projectInfo}${dateInfo} — всего: ${tasks.length}\n\n`;

    const groups = {};
    tasks.forEach(t => {
      const s = STATUS[t.status] || t.status;
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    if (tasks.length > MAX_DISPLAY) return text + taskSummary(tasks);

    for (const [st, list] of Object.entries(groups)) {
      text += "\n" + st + " (" + list.length + "):\n";
      list.forEach(t => { text += fmtTask(t) + "\n"; });
    }
    return text;
  },

  list_tasks: async (input, userId) => {
    const { status, priority, group_id } = input;
    const statusMap = { new:1, pending:2, in_progress:3, waiting:4, completed:5, deferred:6 };
    const filter = {};
    if (status && status !== "all") filter.STATUS = statusMap[status];
    if (priority) filter.PRIORITY = priority;
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE","GROUP_ID"],
      order: { PRIORITY: "DESC", ACTIVITY_DATE: "DESC" },
    }, userId);

    const tasks = result.tasks || [];
    if (!tasks.length) return "Задач нет";

    if (tasks.length > MAX_DISPLAY) return taskSummary(tasks);
    const lines = tasks.map(t => fmtTask(t)).join("\n");
    return "Задачи (" + tasks.length + "):\n" + lines;
  },

  get_task: async (input, userId) => {
    const { task_id } = input;
    const result = await bx("tasks.task.get", { taskId: task_id }, userId);
    const t = result.task;
    const lines = [
      `Задача #${t.id}: ${t.title}`,
      `Статус: ${STATUS[t.status] || t.status}`,
      `Приоритет: ${PRIORITY[t.priority] || t.priority}`,
      t.groupId       ? `Проект (group_id): ${t.groupId}`     : null,
      t.responsibleId ? `Ответственный ID: ${t.responsibleId}` : null,
      t.createdBy     ? `Постановщик ID: ${t.createdBy}`       : null,
      t.description   ? `Описание: ${t.description}`          : null,
      t.deadline      ? `Дедлайн: ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : null,
      `Ссылка: ${taskLink(t.id, t.groupId)}`,
    ].filter(Boolean).join("\n");
    return lines;
  },

  update_task: async (input, userId) => {
    const { task_id, status, priority, deadline, responsible_id, group_id, title } = input;
    const fields = {};
    if (status)         fields.STATUS         = status;
    if (priority)       fields.PRIORITY       = priority;
    if (deadline)       fields.DEADLINE       = deadline + "T23:59:00+06:00";
    if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;
    if (group_id)        fields.GROUP_ID      = group_id;
    if (title)           fields.TITLE         = title;

    await bx("tasks.task.update", { taskId: task_id, fields }, userId);
    const link = taskLink(task_id, group_id);
    return `✅ Задача #${task_id} обновлена${group_id ? `\n${link}` : ""}`;
  },

  send_message: async (input, userId) => {
    const { user_id, message } = input;
    await bx("im.message.add", { USER_ID: user_id, MESSAGE: message }, userId);
    return `✅ Сообщение отправлено → ID:${user_id}`;
  },

  find_user: async (input, userId) => {
    const { name } = input;
    const result = await bx("user.search", { FIND: name }, userId);
    const users = Array.isArray(result) ? result : [];
    if (!users.length) return `Сотрудник "${name}" не найден`;

    return `Найдено (${users.length}):\n\n` + users.map(u =>
      `ID: ${u.ID} | ${u.NAME} ${u.LAST_NAME} | ${u.WORK_POSITION || "—"} | ${u.EMAIL || ""}`
    ).join("\n");
  },

  get_all_users: async (input, userId) => {
    const result = await bx("user.get", {
      filter: { ACTIVE: true },
      select: ["ID","NAME","LAST_NAME","WORK_POSITION","EMAIL"],
      order: { NAME: "ASC" },
    }, userId);
    const users = Array.isArray(result) ? result : [];
    if (!users.length) return "Сотрудников нет";

    return `Сотрудники (${users.length}):\n\n` + users.map(u =>
      `ID:${u.ID} | ${u.NAME} ${u.LAST_NAME}${u.WORK_POSITION ? ` | ${u.WORK_POSITION}` : ""}`
    ).join("\n");
  },

  find_project: async (input) => {
    const { name } = input;
    const search = name.toLowerCase().trim();
    const known = PROJECTS[search];
    if (known) return `✅ Найден: ${known.name} | GROUP_ID: ${known.id}`;

    const partial = Object.entries(PROJECTS).find(([key]) => key.includes(search) || search.includes(key));
    if (partial) return `✅ Найден: ${partial[1].name} | GROUP_ID: ${partial[1].id}`;

    const list = [...new Set(Object.values(PROJECTS).map(p => `ID:${p.id} | ${p.name}`))].join("\n");
    return `Проект "${name}" не найден.\n\nИзвестные проекты:\n${list}`;
  },

  get_project_summary: async (input, userId) => {
    const { group_id, days_back = 7 } = input;
    const closedFilter = { GROUP_ID: group_id, STATUS: "5" };
    if (days_back > 0) {
      closedFilter[">=CLOSED_DATE"] = new Date(Date.now() - days_back * 86400000).toISOString().split("T")[0];
    }

    // Пагинация для обоих запросов — реальные данные без усечения
    const [open, closed] = await Promise.all([
      getAllTasks(
        { GROUP_ID: group_id, "!STATUS": ["5","7"] },
        ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
        { PRIORITY: "DESC", DEADLINE: "ASC" },
        userId
      ),
      getAllTasks(
        closedFilter,
        ["ID","TITLE","RESPONSIBLE_ID","CLOSED_DATE"],
        { CLOSED_DATE: "DESC" },
        userId
      ),
    ]);
    const now    = new Date();

    const overdue = open.filter(t => t.deadline && new Date(t.deadline) < now);
    const high    = open.filter(t => t.priority === "2");

    let text = `📁 ПРОЕКТ ID:${group_id}\n${"═".repeat(40)}\n\n`;
    text += `📊 Открытых задач: ${open.length} | Просрочено: ${overdue.length} | Высокий приоритет: ${high.length}\n\n`;

    if (overdue.length) {
      text += `🚨 ПРОСРОЧЕНО:\n`;
      overdue.forEach(t => { text += `  [${t.id}] ${t.title} · до ${new Date(t.deadline).toLocaleDateString("ru-RU")} | ${taskLink(t.id, group_id)}\n`; });
      text += "\n";
    }
    if (high.length) {
      text += `🔴 ВЫСОКИЙ ПРИОРИТЕТ:\n`;
      high.forEach(t => { text += `  [${t.id}] ${t.title} | ${taskLink(t.id, group_id)}\n`; });
      text += "\n";
    }

    text += `🔄 ВСЕ ОТКРЫТЫЕ (${open.length}):\n`;
    if (open.length) {
      open.forEach(t => {
        const dl  = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
        const pr  = t.priority === "2" ? " 🔴" : "";
        text += `  [${t.id}] ${t.title}${pr}${dl} — ${STATUS[t.status] || t.status} | ${taskLink(t.id, group_id)}\n`;
      });
    } else { text += "  Нет открытых задач\n"; }

    const closedLabel = days_back === 0 ? "ВСЕ ЗАКРЫТЫЕ" : `ЗАКРЫТО ЗА ${days_back} ДНЕЙ`;
    text += `\n✅ ${closedLabel} (${closed.length}):\n`;
    if (!closed.length) {
      text += "  Нет закрытых задач за период\n";
    } else if (closed.length > MAX_DISPLAY) {
      text += `  Показываю первые ${MAX_DISPLAY} из ${closed.length}:\n`;
      closed.slice(0, MAX_DISPLAY).forEach(t => {
        const dt = t.closedDate ? formatDate(t.closedDate) : "—";
        text += `  [${t.id}] ${t.title} · закрыта ${dt} | ${taskLink(t.id, group_id)}\n`;
      });
      text += `  ...ещё ${closed.length - MAX_DISPLAY} задач. Скажи период (например "за май") — покажу все.\n`;
    } else {
      closed.forEach(t => {
        const dt = t.closedDate ? formatDate(t.closedDate) : "—";
        text += `  [${t.id}] ${t.title} · закрыта ${dt} | ${taskLink(t.id, group_id)}\n`;
      });
    }

    return text;
  },

  add_task_comment: async (input, userId) => {
    const { task_id, comment } = input;
    await bx("task.commentitem.add", { TASK_ID: task_id, fields: { POST_MESSAGE: comment } }, userId);
    return `✅ Комментарий добавлен к задаче #${task_id}`;
  },

  get_task_comments: async (input, userId) => {
    const { task_id } = input;
    const result = await bx("task.commentitem.getList", { TASK_ID: task_id }, userId);
    const comments = Array.isArray(result) ? result : result && typeof result === "object" ? Object.values(result) : [];
    if (!comments.length) return "Комментариев нет";

    const lines = comments.map(c => {
      const date = c.POST_DATE ? new Date(c.POST_DATE).toLocaleDateString("ru-RU") : "—";
      const author = c.AUTHOR_ID ? `ID:${c.AUTHOR_ID}` : "—";
      return `[${date}] ${author}\n${c.POST_MESSAGE || "—"}`;
    }).join("\n\n─────\n\n");

    return `Комментарии к задаче #${task_id} (${comments.length}):\n\n${lines}`;
  },

  add_checklist_item: async (input, userId) => {
    const { task_id, item } = input;
    await bx("tasks.task.checklist.add", {
      taskId: task_id,
      fields: { TITLE: item, PARENT_ID: 0, IS_COMPLETE: "N" },
    }, userId);
    return `✅ Пункт добавлен в чек-лист задачи #${task_id}: "${item}"`;
  },

  overdue_report: async (input, userId) => {
    const { group_id, days_ahead = 0 } = input;
    const now = new Date();
    const filter = { "!STATUS": ["5","7"] };

    if (days_ahead > 0) {
      // "Почти просрочены" — дедлайн через days_ahead дней
      const future = new Date(now.getTime() + days_ahead * 86400000).toISOString().split("T")[0];
      filter[">=DEADLINE"] = now.toISOString().split("T")[0];
      filter["<=DEADLINE"] = future;
    } else {
      // Уже просрочены — дедлайн в прошлом
      filter["<=DEADLINE"] = now.toISOString();
    }
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","RESPONSIBLE_ID","DEADLINE","GROUP_ID"],
      order: { DEADLINE: "ASC" },
    }, userId);

    const tasks = result.tasks || [];
    const label = days_ahead > 0 ? `ПОЧТИ ПРОСРОЧЕНЫ (дедлайн через ${days_ahead} дн.)` : "ПРОСРОЧЕННЫЕ ЗАДАЧИ";
    if (!tasks.length) return days_ahead > 0 ? `✅ Задач с дедлайном через ${days_ahead} дней нет!` : "✅ Просроченных задач нет!";

    const byUser = {};
    tasks.forEach(t => {
      const uid = t.responsibleId || "?";
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(t);
    });

    let text = `🚨 ${label} — всего: ${tasks.length}\n${"═".repeat(40)}\n\n`;
    for (const [uid, list] of Object.entries(byUser)) {
      text += `👤 Ответственный ID:${uid} (${list.length} задач)\n`;
      list.forEach(t => {
        const deadline = new Date(t.deadline);
        const diffDays = Math.round((deadline - now) / 86400000);
        const timeLabel = diffDays < 0
          ? `просрочено на ${Math.abs(diffDays)} дн.`
          : diffDays === 0 ? "сегодня!"
          : `через ${diffDays} дн.`;
        text += `  [${t.id}] ${t.title} · ${timeLabel} (${deadline.toLocaleDateString("ru-RU")}) | ${taskLink(t.id, t.groupId)}\n`;
      });
      text += "\n";
    }
    return text;
  },

  workload_report: async (input, userId) => {
    const { group_id } = input;
    const filter = { "!STATUS": ["5","7"] };
    if (group_id) filter.GROUP_ID = group_id;

    // Пагинация — получаем все активные задачи
    const tasks = await getAllTasks(
      filter,
      ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
      { ACTIVITY_DATE: "DESC" },
      userId
    );

    const now    = new Date();
    const byUser = {};

    tasks.forEach(t => {
      const uid = t.responsibleId || "?";
      if (!byUser[uid]) byUser[uid] = { total: 0, high: 0, overdue: 0, tasks: [] };
      byUser[uid].total++;
      byUser[uid].tasks.push(t.id);
      if (t.priority === "2") byUser[uid].high++;
      if (t.deadline && new Date(t.deadline) < now) byUser[uid].overdue++;
    });

    const sorted = Object.entries(byUser).sort((a, b) => b[1].total - a[1].total);

    // Получаем имена всех ответственных
    const nameMap = {};
    await Promise.all(sorted.map(async ([uid]) => {
      nameMap[uid] = await getUserName(uid);
    }));

    let text = `📊 ЗАГРУЗКА СОТРУДНИКОВ — активных задач: ${tasks.length}\n${"═".repeat(40)}\n\n`;
    sorted.forEach(([uid, data]) => {
      const name = nameMap[uid] || `ID:${uid}`;
      const bar = "█".repeat(Math.min(data.total, 10));
      text += `👤 ${name} ${bar} ${data.total} задач`;
      if (data.overdue) text += ` | ⚠️ просрочено: ${data.overdue}`;
      if (data.high)    text += ` | 🔴 высокий: ${data.high}`;
      text += "\n";
    });
    return text;
  },

  get_collab_chat: async (input, userId) => {
    const { group_id, limit = 20 } = input;
    const chatInfo = await bx("im.chat.get", { DIALOG_ID: `SG${group_id}` }, userId);
    const chatId = chatInfo?.id || chatInfo?.ID;
    if (!chatId) return `Чат для коллаба ID:${group_id} не найден`;

    const result = await bx("im.message.getList", { CHAT_ID: chatId, LAST_N: limit }, userId);
    const messages = Array.isArray(result?.messages) ? result.messages : result?.messages ? Object.values(result.messages) : [];
    if (!messages.length) return "Сообщений нет";

    const lines = messages.map(m => {
      const date = m.DATE ? new Date(m.DATE).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
      const author = m.AUTHOR_ID ? `ID:${m.AUTHOR_ID}` : "—";
      return `[${date}] ${author}:\n${m.MESSAGE || m.TEXT || "—"}`;
    }).join("\n\n");

    return `💬 Чат коллаба ID:${group_id} (последние ${messages.length} сообщений):\n${"─".repeat(36)}\n\n${lines}`;
  },

  delete_task: async (input, userId) => {
    const { task_id } = input;
    await bx("tasks.task.delete", { taskId: task_id }, userId);
    return `✅ Задача #${task_id} удалена навсегда (без возможности восстановления)`;
  },

  restore_task: async (input, userId) => {
    const { task_id, action } = input;

    if (action === "archive") {
      // "Удаляем" мягко: статус → отложена, помечаем в названии
      const current = await bx("tasks.task.get", { taskId: task_id }, userId);
      const title = current.task?.title || "";
      if (!title.startsWith("[АРХИВ] ")) {
        await bx("tasks.task.update", {
          taskId: task_id,
          fields: { TITLE: `[АРХИВ] ${title}`, STATUS: "6" },
        }, userId);
      }
      return `📦 Задача #${task_id} помещена в архив (статус "Отложена", помечена [АРХИВ]). Можно восстановить командой "восстанови задачу ${task_id}".`;
    }

    if (action === "unarchive") {
      const current = await bx("tasks.task.get", { taskId: task_id }, userId);
      const title = (current.task?.title || "").replace(/^\[АРХИВ\]\s*/, "");
      await bx("tasks.task.update", {
        taskId: task_id,
        fields: { TITLE: title, STATUS: "2" },
      }, userId);
      return `✅ Задача #${task_id} восстановлена из архива (статус "Ждёт выполнения").\n${taskLink(task_id, current.task?.groupId)}`;
    }

    return `Укажи action: "archive" (заархивировать) или "unarchive" (восстановить)`;
  },

};

// ═══════════════════════════════════════════════════════════════════════════
// ANTHROPIC TOOLS SCHEMA — для function calling в боте
// ═══════════════════════════════════════════════════════════════════════════

const ANTHROPIC_TOOLS = [
  {
    name: "create_task",
    description: "Создать задачу в Bitrix24 с чек-листом, дедлайном и ответственным.",
    input_schema: {
      type: "object",
      properties: {
        title:          { type: "string", description: "Название задачи" },
        description:    { type: "string", description: "Описание" },
        responsible_id: { type: "number", description: "ID ответственного" },
        deadline:       { type: "string", description: "Дедлайн YYYY-MM-DD" },
        priority:       { type: "string", enum: ["0","1","2"], description: "0-низкий 1-средний 2-высокий" },
        checklist:      { type: "array", items: { type: "string" }, description: "Пункты чек-листа" },
        group_id:       { type: "number", description: "ID проекта/группы из словаря проектов" },
      },
      required: ["title"],
    },
  },
  {
    name: "manager_dashboard",
    description: "Полный дашборд — все задачи по статусам, просроченные, высокий приоритет.",
    input_schema: {
      type: "object",
      properties: { group_id: { type: "number", description: "ID проекта для фильтра (опционально)" } },
    },
  },
  {
    name: "employee_tasks",
    description: "Показать все задачи конкретного сотрудника по его ID.",
    input_schema: {
      type: "object",
      properties: {
        responsible_id: { type: "number", description: "ID исполнителя задачи" },
        created_by:     { type: "number", description: "ID постановщика — для запроса 'задачи где я постановщик'" },
        status:         { type: "string", enum: ["all","active","done"] },
        group_id:       { type: "number", description: "Фильтр по проекту (group_id)" },
        date_from:      { type: "string", description: "Дата от YYYY-MM-DD — для фильтра завершённых" },
        date_to:        { type: "string", description: "Дата до YYYY-MM-DD — для фильтра завершённых" },
      },
    },
  },
  {
    name: "list_tasks",
    description: "Список задач с фильтрами по статусу, приоритету или проекту.",
    input_schema: {
      type: "object",
      properties: {
        status:   { type: "string", enum: ["all","new","pending","in_progress","waiting","completed","deferred"] },
        priority: { type: "string", enum: ["0","1","2"] },
        group_id: { type: "number", description: "ID проекта" },
      },
    },
  },
  {
    name: "get_task",
    description: "Полная информация по задаче по её ID — описание, статус, ответственный, ссылка.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
    },
  },
  {
    name: "update_task",
    description: "Изменить статус, приоритет, дедлайн, ответственного, проект (group_id) или название у существующей задачи.",
    input_schema: {
      type: "object",
      properties: {
        task_id:        { type: "number" },
        status:         { type: "string", enum: ["1","2","3","4","5","6","7"], description: "1-новая 2-ждёт выполнения 3-выполняется 4-ждёт контроля 5-завершена 6-отложена 7-отклонена" },
        priority:       { type: "string", enum: ["0","1","2"] },
        deadline:       { type: "string", description: "YYYY-MM-DD" },
        responsible_id: { type: "number" },
        group_id:       { type: "number", description: "Новый проект/коллаб (group_id из словаря) — для переноса задачи между проектами" },
        title:          { type: "string", description: "Новое название задачи" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "send_message",
    description: "Отправить личное сообщение сотруднику в Bitrix24.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "number" },
        message: { type: "string" },
      },
      required: ["user_id", "message"],
    },
  },
  {
    name: "find_user",
    description: "Найти сотрудника по имени или фамилии, получить его ID.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_all_users",
    description: "Список всех активных сотрудников компании с их ID.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_project",
    description: "Найти проект/коллаб по названию и получить его group_id.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_project_summary",
    description: "Полная сводка по проекту — открытые/просроченные/закрытые задачи.",
    input_schema: {
      type: "object",
      properties: {
        group_id:  { type: "number" },
        days_back: { type: "number", description: "За сколько дней смотреть закрытые (по умолчанию 7, 0 = за всё время)" },
      },
      required: ["group_id"],
    },
  },
  {
    name: "add_task_comment",
    description: "Добавить комментарий к задаче.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" }, comment: { type: "string" } },
      required: ["task_id", "comment"],
    },
  },
  {
    name: "get_task_comments",
    description: "Прочитать комментарии к задаче.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
    },
  },
  {
    name: "add_checklist_item",
    description: "Добавить пункт в чек-лист существующей задачи.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" }, item: { type: "string" } },
      required: ["task_id", "item"],
    },
  },
  {
    name: "overdue_report",
    description: "Показать просроченные задачи (days_ahead=0) или почти просрочены (days_ahead=1-7).",
    input_schema: {
      type: "object",
      properties: {
        group_id:   { type: "number", description: "Опционально — фильтр по проекту" },
        days_ahead: { type: "number", description: "0 = уже просрочены (по умолчанию); 1-7 = дедлайн через N дней (почти просрочены)" },
      },
    },
  },
  {
    name: "workload_report",
    description: "Загрузка каждого сотрудника — сколько задач, просрочки, приоритеты.",
    input_schema: {
      type: "object",
      properties: { group_id: { type: "number", description: "Опционально — фильтр по проекту" } },
    },
  },
  {
    name: "get_collab_chat",
    description: "Прочитать переписку в чате коллаба (может не работать на этой версии Bitrix24).",
    input_schema: {
      type: "object",
      properties: { group_id: { type: "number" }, limit: { type: "number" } },
      required: ["group_id"],
    },
  },
  {
    name: "delete_task",
    description: "ПОЛНОСТЬЮ удалить задачу из Bitrix24 без возможности восстановления. Используй только если пользователь явно сказал 'удали навсегда' или 'без возврата'. В остальных случаях используй restore_task с action=archive.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
    },
  },
  {
    name: "restore_task",
    description: "Архивировать задачу (мягкое удаление — статус 'отложена' + пометка [АРХИВ], можно восстановить) или восстановить ранее заархивированную задачу.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        action: { type: "string", enum: ["archive", "unarchive"], description: "archive - спрятать задачу (по умолчанию для 'удали'), unarchive - вернуть из архива" },
      },
      required: ["task_id", "action"],
    },
  },
];


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
    const fields = { TITLE: title };
    if (group_id) fields.GROUP_ID = group_id;
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
    const overdue   = tasks.filter(t => t.deadline && new Date(t.deadline) < now && !["5","7"].includes(t.status));
    const highPrio  = tasks.filter(t => t.priority === "2" && !["5","7"].includes(t.status));
    const inProgress = tasks.filter(t => t.status === "3"); // Выполняется
    const waiting   = tasks.filter(t => t.status === "2"); // Ждёт выполнения
    const pendingCtrl = tasks.filter(t => t.status === "4"); // Ждёт контроля
    const newTasks  = tasks.filter(t => t.status === "1");
    const done      = tasks.filter(t => t.status === "5");

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
    text += `🔄 ВЫПОЛНЯЕТСЯ (${inProgress.length}):\n${inProgress.length ? inProgress.map(fmt).join("\n") : "  —"}\n\n`;
    text += `📋 ЖДЁТ ВЫПОЛНЕНИЯ (${waiting.length}):\n${waiting.length ? waiting.map(fmt).join("\n") : "  —"}\n\n`;
    text += `👀 ЖДЁТ КОНТРОЛЯ (${pendingCtrl.length}):\n${pendingCtrl.length ? pendingCtrl.map(fmt).join("\n") : "  —"}\n\n`;
    text += `🆕 НОВЫЕ (${newTasks.length}):\n${newTasks.length ? newTasks.map(fmt).join("\n") : "  —"}\n\n`;
    text += `✅ ЗАВЕРШЕНЫ (${done.length})\n`;

    return { content: [{ type: "text", text }] };
  }
);

// ── 3. Задачи сотрудника ───────────────────────────────────────────────────
server.tool("employee_tasks",
  "Показать все задачи конкретного сотрудника — что в работе, что просрочено, загрузка.",
  {
    responsible_id: z.number().optional().describe("ID исполнителя задачи"),
    created_by:     z.number().optional().describe("ID постановщика — задачи где этот человек создатель"),
    status:    z.enum(["all","active","done"]).optional().describe("all/active/done"),
    group_id:  z.number().optional().describe("Фильтр по проекту (group_id)"),
    date_from: z.string().optional().describe("Дата от YYYY-MM-DD — для завершённых"),
    date_to:   z.string().optional().describe("Дата до YYYY-MM-DD — для завершённых"),
  },
  async ({ responsible_id, created_by, status, group_id, date_from, date_to }) => {
    const filter = { RESPONSIBLE_ID: responsible_id };
    if (status === "active") filter["!STATUS"] = ["5","7"];
    if (status === "done") {
      filter.STATUS = "5";
      if (date_from) filter[">=CLOSED_DATE"] = date_from;
      if (date_to)   filter["<=CLOSED_DATE"] = date_to;
    }
    if (group_id) filter.GROUP_ID = group_id;

    const select = ["ID","TITLE","STATUS","PRIORITY","DEADLINE","GROUP_ID"];
    if (status === "done") select.push("CLOSED_DATE");

    const result = await bx("tasks.task.list", {
      filter,
      select,
      order: status === "done" ? { CLOSED_DATE: "DESC" } : { ACTIVITY_DATE: "DESC" },
    });

    const tasks = result.tasks || [];
    if (!tasks.length) return { content: [{ type: "text", text: "Задач нет" }] };

    const now = new Date();
    const projectInfo = group_id ? ` | проект ID:${group_id}` : "";
    const dateInfo = (date_from || date_to)
      ? ` | с ${date_from || "начала"} по ${date_to || "сегодня"}`
      : "";
    let text = `👤 Задачи ID:${responsible_id}${projectInfo}${dateInfo} — всего: ${tasks.length}\n\n`;

    const groups = {};
    tasks.forEach(t => {
      const s = STATUS[t.status] || t.status;
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    if (tasks.length > MAX_DISPLAY) {
      return { content: [{ type: "text", text: text + taskSummary(tasks) }] };
    }
    for (const [st, list] of Object.entries(groups)) {
      text += `\n${st} (${list.length}):\n`;
      list.forEach(t => { text += `${fmtTask(t)}\n`; });
      
    }
    return { content: [{ type: "text", text }] };
  }
);

// ── 4. Список задач ────────────────────────────────────────────────────────
server.tool("list_tasks",
  "Получить список задач с фильтрами по статусу, приоритету или проекту.",
  {
    status:   z.enum(["all","new","pending","in_progress","waiting","completed","deferred"]).optional(),
    priority: z.enum(["0","1","2"]).optional().describe("0-низкий 1-средний 2-высокий"),
    group_id: z.number().optional().describe("ID проекта"),
  },
  async ({ status, priority, group_id }) => {
    const statusMap = { new:1, pending:2, in_progress:3, waiting:4, completed:5, deferred:6 };
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
      t.groupId ? `Проект (group_id): ${t.groupId}` : null,
      t.responsibleId ? `Ответственный ID: ${t.responsibleId}` : null,
      t.createdBy ? `Постановщик ID: ${t.createdBy}` : null,
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
    status:         z.enum(["1","2","3","4","5","6","7"]).optional().describe("1-новая 2-ждёт выполнения 3-выполняется 4-ждёт контроля 5-завершена 6-отложена 7-отклонена"),
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

// ── 10. Найти проект по названию ──────────────────────────────────────────
server.tool("find_project",
  "Найти проект/группу в Bitrix24 по названию. Например: 'редстаф', 'railcar', 'redmarket'.",
  { name: z.string().describe("Название проекта или его часть") },
  async ({ name }) => {
    // Сначала ищем в словаре известных проектов
    const search = name.toLowerCase().trim();
    const known = PROJECTS[search];
    if (known) {
      return { content: [{ type: "text", text: `✅ Найден: ${known.name} | GROUP_ID: ${known.id}` }] };
    }
    // Частичное совпадение
    const partial = Object.entries(PROJECTS).find(([key]) => key.includes(search) || search.includes(key));
    if (partial) {
      return { content: [{ type: "text", text: `✅ Найден: ${partial[1].name} | GROUP_ID: ${partial[1].id}` }] };
    }
    // Показываем все известные проекты
    const list = [...new Set(Object.values(PROJECTS).map(p => `ID:${p.id} | ${p.name}`))].join("\n");
    return { content: [{ type: "text", text: `Проект "${name}" не найден.\n\nИзвестные проекты:\n${list}` }] };
  }
);

// ── 11. Сводка по проекту ─────────────────────────────────────────────────
server.tool("get_project_summary",
  "Полная сводка по проекту — открытые задачи, недавно закрытые, статус. Для запросов типа 'расскажи про проект редстаф'.",
  {
    group_id:  z.number().describe("ID проекта (получи через find_project)"),
    days_back: z.number().optional().describe("За сколько дней смотреть закрытые задачи (по умолчанию 7, 0 = за всё время)"),
  },
  async ({ group_id, days_back = 7 }) => {
    const closedFilter = { GROUP_ID: group_id, STATUS: "5" };
    if (days_back > 0) {
      closedFilter[">=CLOSED_DATE"] = new Date(Date.now() - days_back * 86400000).toISOString().split("T")[0];
    }
    const [openResult, closedResult] = await Promise.all([
      bx("tasks.task.list", {
        filter: { GROUP_ID: group_id, "!STATUS": ["5","7"] },  // всё кроме Завершена и Отклонена
        select: ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
        order: { PRIORITY: "DESC", DEADLINE: "ASC" },
      }),
      bx("tasks.task.list", {
        filter: closedFilter,
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
    text += `📊 Открытых задач: ${open.length} | Просрочено: ${overdue.length} | Высокий приоритет: ${high.length}\n\n`;

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
    if (open.length) {
      open.forEach(t => {
        const dl  = t.deadline ? ` · до ${new Date(t.deadline).toLocaleDateString("ru-RU")}` : "";
        const pr  = t.priority === "2" ? " 🔴" : "";
        text += `  [${t.id}] ${t.title}${pr}${dl} — ${STATUS[t.status] || t.status}\n`;
      });
    } else { text += "  Нет открытых задач\n"; }

    text += `\n✅ ${days_back === 0 ? 'ВСЕ ЗАКРЫТЫЕ' : `ЗАКРЫТО ЗА ${days_back} ДНЕЙ`} (${closed.length}):\n`;
    if (closed.length) {
      closed.forEach(t => {
        const dt = t.closedDate ? new Date(t.closedDate).toLocaleDateString("ru-RU") : "—";
        text += `  [${t.id}] ${t.title} · закрыта ${dt}\n`;
      });
    } else { text += "  Нет закрытых задач за период\n"; }

    return { content: [{ type: "text", text }] };
  }
);

// ── 12. Добавить комментарий к задаче ─────────────────────────────────────
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

// ── 13. Прочитать комментарии задачи ──────────────────────────────────────
server.tool("get_task_comments",
  "Получить комментарии к задаче — что обсуждали, какие были решения.",
  { task_id: z.number().describe("ID задачи") },
  async ({ task_id }) => {
    const result = await bx("task.commentitem.getList", { TASK_ID: task_id });
    const comments = Array.isArray(result)
      ? result
      : result && typeof result === "object"
        ? Object.values(result)
        : [];
    if (!comments.length) return { content: [{ type: "text", text: "Комментариев нет" }] };

    const lines = comments.map(c => {
      const date = c.POST_DATE ? new Date(c.POST_DATE).toLocaleDateString("ru-RU") : "—";
      const author = c.AUTHOR_ID ? `ID:${c.AUTHOR_ID}` : "—";
      return `[${date}] ${author}\n${c.POST_MESSAGE || "—"}`;
    }).join("\n\n─────\n\n");

    return { content: [{ type: "text", text: `Комментарии к задаче #${task_id} (${comments.length}):\n\n${lines}` }] };
  }
);

// ── 14. Добавить пункт в чеклист существующей задачи ──────────────────────
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

// ── 15. Отчёт по просроченным задачам ─────────────────────────────────────
server.tool("overdue_report",
  "Показать все просроченные задачи по всем сотрудникам — кто что не сделал вовремя.",
  {
    group_id:   z.number().optional().describe("ID проекта для фильтра"),
    days_ahead: z.number().optional().describe("0 = просрочены; 1-7 = почти просрочены через N дней"),
  },
  async ({ group_id, days_ahead = 0 }) => {
    const now = new Date();
    const filter = { "!STATUS": ["5","7"] };

    if (days_ahead > 0) {
      const future = new Date(now.getTime() + days_ahead * 86400000).toISOString().split("T")[0];
      filter[">=DEADLINE"] = now.toISOString().split("T")[0];
      filter["<=DEADLINE"] = future;
    } else {
      filter["<=DEADLINE"] = now.toISOString();
    }
    if (group_id) filter.GROUP_ID = group_id;

    const result = await bx("tasks.task.list", {
      filter,
      select: ["ID","TITLE","STATUS","RESPONSIBLE_ID","DEADLINE","GROUP_ID"],
      order: { DEADLINE: "ASC" },
    });

    const tasks = result.tasks || [];
    const label = days_ahead > 0 ? `ПОЧТИ ПРОСРОЧЕНЫ (через ${days_ahead} дн.)` : "ПРОСРОЧЕННЫЕ ЗАДАЧИ";
    if (!tasks.length) return { content: [{ type: "text", text: `✅ Задач нет!` }] };

    const byUser = {};
    tasks.forEach(t => {
      const uid = t.responsibleId || "?";
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(t);
    });

    let text = `🚨 ${label} — всего: ${tasks.length}\n${"═".repeat(40)}\n\n`;
    for (const [uid, list] of Object.entries(byUser)) {
      text += `👤 Ответственный ID:${uid} (${list.length} задач)\n`;
      list.forEach(t => {
        const deadline = new Date(t.deadline);
        const diffDays = Math.round((deadline - now) / 86400000);
        const timeLabel = diffDays < 0 ? `просрочено на ${Math.abs(diffDays)} дн.` : diffDays === 0 ? "сегодня!" : `через ${diffDays} дн.`;
        text += `  [${t.id}] ${t.title} · ${timeLabel} (${deadline.toLocaleDateString("ru-RU")})\n`;
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
    const filter = { "!STATUS": ["5","7"] };
    if (group_id) filter.GROUP_ID = group_id;

    const tasks = await getAllTasks(
      filter,
      ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
      { ACTIVITY_DATE: "DESC" }
    );

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

    const nameMap = {};
    await Promise.all(sorted.map(async ([uid]) => {
      nameMap[uid] = await getUserName(uid);
    }));

    let text = `📊 ЗАГРУЗКА СОТРУДНИКОВ — активных задач: ${tasks.length}
${"═".repeat(40)}

`;
    sorted.forEach(([uid, data]) => {
      const name = nameMap[uid] || `ID:${uid}`;
      const bar = "█".repeat(Math.min(data.total, 10));
      text += `👤 ${name} ${bar} ${data.total} задач`;
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
    // Получаем чат группы через DIALOG_ID = SG{group_id}
    const chatInfo = await bx("im.chat.get", { DIALOG_ID: `SG${group_id}` });
    const chatId = chatInfo?.id || chatInfo?.ID;
    if (!chatId) return { content: [{ type: "text", text: `Чат для коллаба ID:${group_id} не найден` }] };

    // Читаем сообщения
    const result = await bx("im.message.getList", {
      CHAT_ID: chatId,
      LAST_N: limit,
    });

    const messages = Array.isArray(result?.messages)
      ? result.messages
      : result?.messages
        ? Object.values(result.messages)
        : [];

    if (!messages.length) return { content: [{ type: "text", text: "Сообщений нет" }] };

    const lines = messages.map(m => {
      const date = m.DATE ? new Date(m.DATE).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
      const author = m.AUTHOR_ID ? `ID:${m.AUTHOR_ID}` : "—";
      const text = m.MESSAGE || m.TEXT || "—";
      return `[${date}] ${author}:\n${text}`;
    }).join("\n\n");

    return { content: [{ type: "text", text: `💬 Чат коллаба ID:${group_id} (последние ${messages.length} сообщений):\n${"─".repeat(36)}\n\n${lines}` }] };
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
  "7381": "qcv0l230bxtee7rr50z14a4sd5pthspu", // RedBot
};

// ── Память диалогов ─────────────────────────────────────────────────────────
const CONVERSATION_HISTORY = new Map(); // dialogId -> [{role, content}, ...]
const MAX_HISTORY = 10; // последние 10 сообщений (5 обменов)

function getHistory(dialogId) {
  return CONVERSATION_HISTORY.get(dialogId) || [];
}

function addToHistory(dialogId, role, content) {
  const history = getHistory(dialogId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  CONVERSATION_HISTORY.set(dialogId, history);
}

// ── Anthropic Client ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getBotSystem() {
  const today = new Date();
  const todayStr = today.toLocaleDateString("ru-RU", { year: "numeric", month: "long", day: "numeric" });
  const isoDate = today.toISOString().split("T")[0];

  return `Ты AI-ассистент Red Petroleum встроенный в Bitrix24. Тебя зовут RedBot.
Ты помогаешь сотрудникам отдела ОЦП работать с задачами и проектами в Bitrix24.

СЕГОДНЯШНЯЯ ДАТА: ${todayStr} (${isoDate}).
Когда пользователь говорит "дедлайн пятница", "через неделю", "до конца месяца" и т.п. —
считай от сегодняшней даты (${isoDate}), а НЕ от даты твоего обучения. Если год не указан явно — год текущий.

У тебя есть инструменты для работы с Bitrix24 — используй их для получения реальных данных,
никогда не придумывай задачи, ID, статусы или ссылки самостоятельно.

СЛОВАРЬ ПРОЕКТОВ (название → group_id):
${Object.entries(PROJECTS).map(([key, p]) => `- ${key} → ${p.id} (${p.name})`).join("\n")}

Если пользователь упоминает проект по любому из этих названий — используй соответствующий group_id
в вызовах инструментов (list_tasks, get_project_summary, overdue_report, workload_report и т.д.).

ПАМЯТЬ ДИАЛОГА: Если в этом диалоге уже нашёл ID сотрудника — используй его без повторного поиска.
Если пользователь пишет "его задачи", "её задачи", "там" — подразумевается последний упомянутый человек/проект.

ДАТЫ НА РУССКОМ: Автоматически конвертируй в YYYY-MM-DD:
"сегодня" → текущая дата, "вчера" → -1 день, "эта неделя" → пн-вс текущей недели,
"прошлый месяц" → 1-е ... последнее число прошлого месяца, "май" → 2026-05-01/2026-05-31,
"июнь" → 2026-06-01/2026-06-30, "апрель" → 2026-04-01/2026-04-30.

ПРАВИЛА ВЫБОРА ИНСТРУМЕНТА — строго соблюдай:

"мои задачи" / "мои активные" / "что у меня" → employee_tasks(responsible_id=USER_ID)
"мои завершённые за [период]" → employee_tasks(responsible_id=USER_ID, status="done", date_from=..., date_to=...)
"мои завершённые в [проекте]" → employee_tasks(responsible_id=USER_ID, status="done", group_id=...)

"задачи в проекте X" / "что в [проекте]" (без "мои") → get_project_summary(group_id=X)
"все завершённые в проекте X" (без "мои") → get_project_summary(group_id=X, days_back=0)
"активные в проекте X" → list_tasks(group_id=X, status="all") с фильтром "!STATUS"=["5","7"]
"сколько задач в проекте X" → get_project_summary(group_id=X)

"просрочены" → overdue_report(group_id=X если указан проект)
"почти просрочены" / "горят" / "через 3 дня" → overdue_report(days_ahead=3, group_id=X)

НЕ ИСПОЛЬЗУЙ employee_tasks когда пользователь спрашивает про проект в целом (без "мои").
НЕ ПРИДУМЫВАЙ статистику, цифры или разбивку по датам если нет реальных данных из API.

КРИТИЧНО — ПРАВИЛА ЧЕСТНОСТИ (нарушение = дезинформация):
- ЗАПРЕЩЕНО придумывать, перефразировать или переименовывать названия задач.
- Копируй строки задач из инструмента ДОСЛОВНО: [ID] Название · Статус · Дедлайн | Ссылка
- Если инструмент вернул сводку (📊 Найдено N задач) — выводи её без изменений.
- Реальное количество = tasks.length из пагинации. Не используй поле total из API.
- Нельзя показывать задачу если её нет в ответе инструмента.
- Нельзя: "за май+июнь — 33 задачи" если "за июнь — 40 задач". Логику проверяй.
- Если не можешь получить имя сотрудника — пиши ID, не угадывай имя.
- Для "задачи где я постановщик" используй employee_tasks с параметром created_by.
- Если пользователь даёт ссылку вида /user/265/ — используй ID=265 напрямую в инструментах.

Для создания задач используй create_task. Если не хватает данных (например неясен исполнитель) —
сначала вызови find_user чтобы найти ID, или уточни у пользователя.

Для изменения статуса/приоритета/дедлайна/исполнителя/проекта/названия используй update_task —
он поддерживает все эти поля сразу, включая group_id (перенос между проектами).
СТАТУСЫ задач Bitrix24 (коды из API — подтверждены живыми тестами):
2 = 📋 Ждёт выполнения  — назначена, кнопка «Начать» не нажата
3 = 🔄 Выполняется      — исполнитель нажал «Начать», работа идёт
4 = 👀 Ждёт контроля   — исполнитель нажал «Завершить», задача отправлена на проверку постановщику.
    Постановщик видит «Принять» → статус 5, или «Вернуть в работу» → статус 3.
    Статус 4 появляется ТОЛЬКО если: постановщик ≠ исполнитель И постановщик не нажимал «Начать» И не стал наблюдателем.
    Если эти условия нарушены — «Завершить» даёт статус 5 напрямую.
5 = ✅ Завершена         — постановщик принял работу, задача закрыта (кнопка «Возобновить»)
6 = ⏸️ Отложена          — «Отложить»/«Приостановить» → статус 6; «Возобновить» → статус 3
7 = ❌ Отклонена
Активные задачи = статусы 2, 3, 4, 6. Завершённые = статус 5.
«Возобновить» из ЛЮБОГО статуса (5 или 6) → всегда возвращает к статусу 3 «Выполняется».

УДАЛЕНИЕ ЗАДАЧ: Bitrix24 удаляет задачи без возможности восстановления.
Поэтому для "удаления" используй restore_task (поставит статус "отложена" и пометку [АРХИВ] в названии) —
это безопасная альтернатива, задачу можно вернуть через update_task.
Используй delete_task (полное удаление) ТОЛЬКО если пользователь явно написал "удали навсегда"
или "точно удали без возврата".

Все инструменты возвращают ссылки на задачи (формат "| https://...") — ВСЕГДА включай эти ссылки
в свой ответ, чтобы пользователь мог кликнуть и открыть задачу.

Отвечай коротко, по делу, на русском языке. Используй эмодзи для структуры.
Если не понял запрос — попроси уточнить, не вызывай инструменты "на угад".`;
}

// ── Кэш профилей пользователей ──────────────────────────────────────────────
const USER_PROFILES = new Map(); // userId -> { name, lastName, position }

async function getUserProfile(userId) {
  if (USER_PROFILES.has(userId)) return USER_PROFILES.get(userId);
  try {
    const result = await bx("user.get", { ID: userId });
    const u = Array.isArray(result) ? result[0] : result;
    if (!u) return null;
    const profile = {
      name: u.NAME || "",
      lastName: u.LAST_NAME || "",
      position: u.WORK_POSITION || "",
    };
    USER_PROFILES.set(userId, profile);
    return profile;
  } catch (e) {
    console.error("getUserProfile error:", e.message);
    return null;
  }
}

// ── Express + SSE ──────────────────────────────────────────────────────────
const app = express();
const sessions = {};

// ── Bot endpoint ────────────────────────────────────────────────────────────
app.post("/bot", express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  res.status(200).send("OK");

  const body = req.body;
  console.log("🤖 Bot request:", JSON.stringify(body).slice(0, 500));

  const event = body.event || body.EVENT;
  console.log("📨 Event:", event);

  if (event !== "ONIMBOTMESSAGEADD") {
    console.log("⏭️ Skipping event:", event);
    return;
  }

  const data     = body.data || body.DATA || {};
  const params   = data.PARAMS || data;

  // BOT = { "7358": { BOT_ID: "7358", BOT_CODE: "..." } }
  const botRaw   = data.BOT;
  let botId;
  if (typeof botRaw === "object" && botRaw !== null) {
    const firstBot = Object.values(botRaw)[0];
    botId = firstBot?.BOT_ID || Object.keys(botRaw)[0];
  } else {
    botId = botRaw || data.BOT_ID || params.TO_USER_ID;
  }

  const dialogId = params.DIALOG_ID || data.DIALOG_ID;
  const userId   = params.FROM_USER_ID || params.USER_ID || data.USER_ID;
  const rawMessage = params.MESSAGE || data.MESSAGE || "";

  // Убираем упоминание бота из текста если есть
  const message = rawMessage.replace(/\[USER=\d+\][^\[]*\[\/USER\]/gi, "").trim();

  console.log(`💬 Message from ${userId}: "${message}" | botId:${botId} dialogId:${dialogId}`);

  if (!message || !dialogId || !botId) return;

  // Умная обработка групповых чатов: отвечаем без тега если это команда/вопрос
  const isPrivate  = String(dialogId).startsWith("U");
  const isGroupChat = String(dialogId).startsWith("chat");
  const isMentioned = rawMessage !== message; // был тег
  const isCommand  = /^(покажи|найди|сколько|кто|что|дай|создай|обнови|где|список|задачи|загрузка|просроченные|активные|завершённые|завершенные|отчёт|отчет|помоги|покажи|статус)/i.test(message);
  const isQuestion = message.includes("?");

  // В групповом чате — отвечаем только если: тег ИЛИ команда ИЛИ вопрос
  if (isGroupChat && !isMentioned && !isCommand && !isQuestion) {
    console.log("⏭️ Group message without command — skipping");
    return;
  }

  // Команда сброса памяти
  if (message.trim().toLowerCase() === "забудь всё" || message.trim().toLowerCase() === "забудь") {
    CONVERSATION_HISTORY.delete(dialogId);
    await bx("imbot.message.add", {
      BOT_ID: botId,
      CLIENT_ID: BOT_CLIENTS[botId] || "",
      DIALOG_ID: dialogId,
      MESSAGE: "🧹 Память очищена, начинаем с чистого листа!",
    });
    return;
  }

  try {
    const profile = await getUserProfile(userId);

    const userInfo = profile
      ? `\n\nПользователь который пишет тебе: ${profile.name} ${profile.lastName}${profile.position ? ` (${profile.position})` : ""}. ID:${userId}. Обращайся к нему по имени, если уместно. Если он просит "мои задачи" — используй этот ID как responsible_id.`
      : `\n\nID пользователя который пишет тебе: ${userId}.`;

    // Берём историю диалога + новое сообщение
    const history = getHistory(dialogId);
    let messages = [...history, { role: "user", content: message }];

    console.log("🧠 Calling Claude API with tools...");

    let finalAnswer = "";
    const MAX_ITERATIONS = 6;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system: getBotSystem() + userInfo,
        tools: ANTHROPIC_TOOLS,
        messages,
      });

      // Собираем текстовые части ответа
      const textParts = response.content.filter(b => b.type === "text").map(b => b.text);
      if (textParts.length) finalAnswer += (finalAnswer ? "\n" : "") + textParts.join("\n");

      if (response.stop_reason !== "tool_use") {
        break; // Claude закончил, больше тулов не вызывает
      }

      // Выполняем все запрошенные tool_use блоки
      const toolUses = response.content.filter(b => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const tu of toolUses) {
        console.log(`🛠️ Tool call: ${tu.name}`, JSON.stringify(tu.input));
        let resultText;
        try {
          const handler = TOOL_HANDLERS[tu.name];
          resultText = handler ? await handler(tu.input, userId) : `Инструмент ${tu.name} не найден`;
        } catch (e) {
          console.error(`Tool error (${tu.name}):`, e.message);
          resultText = `Ошибка при вызове ${tu.name}: ${e.message}`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
      }

      messages.push({ role: "user", content: toolResults });
    }

    const answer = finalAnswer || "Не могу ответить, попробуй снова.";
    console.log("✅ Final answer:", answer.slice(0, 150));

    // Сохраняем в историю только текстовый обмен (без tool_use деталей)
    addToHistory(dialogId, "user", message);
    addToHistory(dialogId, "assistant", answer);

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
        BOT_ID: botId,
        DIALOG_ID: dialogId,
        MESSAGE: "⚠️ Ошибка. Попробуй снова.",
      });
    } catch {}
  }
});

// ── SSE endpoint ──────────────────────────────────────────────────────────
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
  res.json({ status: "ok", service: "bitrix24-ocp-mcp", version: "6.2", tools: 19, bot: true, function_calling: true, memory: true, profiles: true, personal_webhooks: true })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bitrix24 OCP MCP v3.0 | 16 tools | port ${PORT}`));
