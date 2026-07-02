import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "async_hooks";

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL;
const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;
if (!WEBHOOK) { console.error("❌ Нужна BITRIX_WEBHOOK_URL"); process.exit(1); }

// Личные вебхуки сотрудников — задачи будут создаваться от их имени
const USER_WEBHOOKS = {
  "3046": "https://crm.redpetroleum.kg/rest/3046/em7h2nchgw8zgnr4/", // Эрмек Русланов
};

// ── "Личность бота": per-event OAuth-токен из data.BOT[botId].access_token ──
// AsyncLocalStorage (не глобальная переменная!) — чтобы параллельные события
// от разных диалогов не путали токены друг друга между собой.
const botTokenStorage = new AsyncLocalStorage();

async function bx(method, params = {}, userId = null) {
  const botToken = botTokenStorage.getStore();

  if (botToken) {
    // Вызов от имени самого бота (OAuth-токен приложения на этот диалог)
    const res = await fetch(`https://crm.redpetroleum.kg/rest/${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, auth: botToken }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);
    return data.result;
  }

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

// countTasks — удалён (мёртвый код, используется getAllTasks)

// ── Fireflies GraphQL helper ─────────────────────────────────────────────────
async function fireflies(query, variables = {}) {
  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

// ── Resolve userId → имя сотрудника (сначала KNOWN_USERS, потом API) ─────────
async function getUserName(userId) {
  if (!userId || userId === "?") return `ID:${userId}`;
  const known = KNOWN_USERS[String(userId)];
  if (known) return known.name + " " + known.last;
  try {
    const profile = await getUserProfile(userId);
    if (profile?.name) {
      return `${profile.name}${profile.lastName ? " " + profile.lastName : ""}`;
    }
  } catch (e) { /* fallback */ }
  return `ID:${userId}`;
}

// ── Полный список сотрудников ОЦП (подтверждённые ID) ────────────────────────
const KNOWN_USERS = {
  "4":    { name:"Жалынбек",  last:"Адишев",        pos:"Проектный менеджер",   dept:"ОЦП" },
  "256":  { name:"Эрлан",     last:"Чодоев",         pos:"Специалист по данным", dept:"ОЦП" },
  "265":  { name:"Айтунук",   last:"Бактыбекова",    pos:"Бизнес-Аналитик IT",  dept:"ОЦП" },
  "276":  { name:"Урмат",     last:"Сагынбек уулу",  pos:"Руководитель ОЦП",    dept:"ОЦП" },
  "279":  { name:"Каныкей",   last:"Мамытканова",    pos:"Проектный менеджер",   dept:"ОЦП" },
  "321":  { name:"Адиляй",    last:"Сейдакматова",   pos:"Бизнес аналитик",      dept:"ОЦП" },
  "434":  { name:"Айжамал",   last:"Мадылбекова",    pos:"Проектный менеджер",   dept:"ОЦП" },
  "452":  { name:"Руслана",   last:"Комарова",       pos:"Data Scientist",       dept:"ОЦП" },
  "3046": { name:"Эрмек",     last:"Русланов",       pos:"Проект менеджер",      dept:"ОЦП" },
  "3047": { name:"Адилет",    last:"Сманкулов",      pos:"Дата-инженер",         dept:"ОЦП" },
  "3048": { name:"Арлен",     last:"Омурбеков",      pos:"Бизнес аналитик",      dept:"ОЦП" },
  "3136": { name:"Баяна",     last:"Поезбекова",     pos:"Бизнес-аналитик",      dept:"ОЦП" },
  "5006": { name:"Александр", last:"Крылов",         pos:"",                     dept:"ОЦП" },
  "7031": { name:"Айжан",     last:"Ташкулова",      pos:"Бизнес аналитик",      dept:"ОЦП" },
  "121":  { name:"Бакыт",     last:"Итигулов",       pos:"KG Solution (Red Pay)", dept:"RedPay" },
  "3323": { name:"Александр", last:"Логвинов",       pos:"",                      dept:"" },
};

// Lookup проектов по числовому ID — должен быть ПОСЛЕ объявления PROJECTS
// IDs всех сотрудников ОЦП для фильтрации
const OCP_IDS = Object.keys(KNOWN_USERS).map(Number);
// Пароль для удаления задач — меняй здесь
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || "1612";

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

// Lookup проектов по числовому ID (после объявления PROJECTS)
const PROJECTS_BY_ID = {};
Object.entries(PROJECTS).forEach(([key, val]) => {
  if (val && val.id) PROJECTS_BY_ID[val.id] = val.name || key;
});

const BITRIX_DOMAIN = "https://crm.redpetroleum.kg";

function taskLink(taskId, groupId) {
  if (groupId && groupId != 0 && groupId != "0") {
    return `${BITRIX_DOMAIN}/workgroups/group/${groupId}/tasks/task/view/${taskId}/`;
  }
  return `${BITRIX_DOMAIN}/tasks/task/view/${taskId}/`;
  // OLD: return `${BITRIX_DOMAIN}/company/personal/user/0/tasks/task/view/${taskId}/`;
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
  const status  = STATUS[String(t.status)] || STATUS[t.status] || "🔄 В работе";
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
    const name = PROJECTS_BY_ID[t.groupId]
      || (t.groupId ? `группа ${t.groupId}` : "личные");
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
    const { title, description, responsible_id, deadline, priority, checklist, group_id, created_by } = input;
    const fields = { TITLE: title };
    if (group_id)       fields.GROUP_ID      = group_id;
    if (description)    fields.DESCRIPTION   = description;
    if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;
    if (created_by)     fields.CREATED_BY    = created_by;
    if (deadline)       fields.DEADLINE      = deadline + "T23:59:00+06:00";
    if (priority)       fields.PRIORITY      = priority;

    let result;
    try {
      result = await bx("tasks.task.add", { fields }, userId);
    } catch(e) {
      return "📋ДОСЛОВНО:\n❌ Ошибка создания задачи: " + String(e.message || e);
    }

    const taskId = result?.task?.id || result?.id;
    if (!taskId) {
      return "📋ДОСЛОВНО:\n❌ Задача не создана — API не вернул ID. Ответ: " + JSON.stringify(result);
    }

    // Добавляем пункты чек-листа через правильный метод
    if (checklist?.length) {
      for (const item of checklist) {
        try {
          await bx("task.checklistitem.add", {
            TASKID: taskId,
            fields: { TITLE: String(item) }
          }, userId);
        } catch(e) {
          console.log("Checklist item error:", e.message);
        }
      }
    }

    const link = taskLink(taskId, fields.GROUP_ID);
    const known = responsible_id ? KNOWN_USERS[String(responsible_id)] : null;
    const respName = known ? known.name + " " + known.last : (responsible_id ? "ID:" + responsible_id : "ты");
    let text = "✅ Задача #" + taskId + " создана!\n";
    text += "Название: " + title + "\n";
    if (description) text += "Описание: добавлено\n";
    if (checklist?.length) text += "Чек-лист: " + checklist.length + " пунктов\n";
    text += "Исполнитель: " + respName + "\n";
    text += link;
    return "📋ДОСЛОВНО:\n" + text;
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
    const uid = created_by || responsible_id;
    const knownUser = uid && KNOWN_USERS[String(uid)];
    const userName = knownUser ? knownUser.name + " " + knownUser.last : await getUserName(uid);
    const who = created_by ? `постановщик ${userName}` : `${userName}`;
    const projName = group_id && PROJECTS[group_id] ? PROJECTS[group_id].name || `проект ${group_id}` : group_id ? `проект ${group_id}` : "";
    const projectInfo = projName ? ` | ${projName}` : "";
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
    return "📋ДОСЛОВНО:\n" + text;
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
    return "📋ДОСЛОВНО:\n" + "Задачи (" + tasks.length + "):\n" + lines;
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

  find_department: async (input, userId) => {
    const { name } = input;
    const search = (name || "").toLowerCase().trim();

    // 1. Ищем отдел по названию через department.get
    const depts = await bx("department.get", {}, userId);
    const deptList = Array.isArray(depts) ? depts : [];
    const matched = deptList.filter(d =>
      (d.NAME || "").toLowerCase().includes(search) || search.includes((d.NAME || "").toLowerCase())
    );
    if (!matched.length) {
      return `Отдел "${name}" не найден. Доступные отделы: ` +
        deptList.map(d => d.NAME).join(", ");
    }

    const deptIds = matched.map(d => d.ID);

    // 2. Ищем сотрудников этих отделов
    const users = await bx("user.get", {
      filter: { ACTIVE: true, UF_DEPARTMENT: deptIds },
      select: ["ID","NAME","LAST_NAME","WORK_POSITION","UF_DEPARTMENT"],
    }, userId);
    const userList = Array.isArray(users) ? users : [];

    const deptNames = matched.map(d => d.NAME).join(", ");
    if (!userList.length) {
      return `✅ Найден отдел: ${deptNames}. Сотрудников не найдено (возможно, распределение через UF_DEPARTMENT не заполнено).`;
    }

    return `✅ Отдел: ${deptNames}\n\nСотрудники (${userList.length}):\n\n` +
      userList.map(u => `ID:${u.ID} | ${u.NAME} ${u.LAST_NAME}${u.WORK_POSITION ? ` | ${u.WORK_POSITION}` : ""}`).join("\n");
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
    const { group_id, days_back = 0 } = input;
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
    await bx("task.checklistitem.add", {
      TASKID: task_id,
      fields: { TITLE: String(item) },
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
    return "📋ДОСЛОВНО:\n" + text;
  },

  // ── Удалить задачу с паролем ─────────────────────────────────────────────
  delete_task: async (input, userId) => {
    const { task_id, password } = input;
    const pwd = String(password || "").trim();
    if (pwd !== String(DELETE_PASSWORD)) {
      return "📋ДОСЛОВНО:\n❌ Неверный пароль. Удаление отменено.";
    }
    try {
      await bx("tasks.task.delete", { taskId: task_id }, userId);
      return "📋ДОСЛОВНО:\n✅ Задача #" + task_id + " удалена.";
    } catch(e) {
      return "📋ДОСЛОВНО:\n❌ Ошибка удаления задачи #" + task_id + ": " + String(e.message || e);
    }
  },

  // ── Завершить задачу ─────────────────────────────────────────────────────
  complete_task: async (input, userId) => {
    const { task_id } = input;
    try {
      await bx("tasks.task.complete", { taskId: task_id }, userId);
      return "📋ДОСЛОВНО:\n✅ Задача #" + task_id + " завершена!";
    } catch(e) {
      return "📋ДОСЛОВНО:\n❌ Не удалось завершить задачу #" + task_id + ": " + String(e.message || e);
    }
  },

  // ── Переназначить задачу ─────────────────────────────────────────────────
  assign_task: async (input, userId) => {
    const { task_id, responsible_id } = input;
    const known = KNOWN_USERS[String(responsible_id)];
    const name  = known ? known.name + " " + known.last : "ID:" + responsible_id;
    try {
      await bx("tasks.task.update", {
        taskId: task_id,
        fields: { RESPONSIBLE_ID: responsible_id }
      }, userId);
      return "📋ДОСЛОВНО:\n✅ Задача #" + task_id + " переназначена на " + name;
    } catch(e) {
      return "📋ДОСЛОВНО:\n❌ Ошибка переназначения: " + String(e.message || e);
    }
  },

  // ── Создать подзадачу ─────────────────────────────────────────────────────
  create_subtask: async (input, userId) => {
    const { parent_id, title, responsible_id, deadline } = input;
    const fields = {
      TITLE:          title,
      PARENT_ID:      parent_id,
      RESPONSIBLE_ID: responsible_id || userId,
    };
    if (deadline) fields.DEADLINE = deadline;
    const res = await bx("tasks.task.add", { fields }, userId);
    const id = res?.task?.id || res?.id || "?";
    const known = KNOWN_USERS[String(responsible_id)];
    const name  = known ? known.name : "исполнитель";
    return "📋ДОСЛОВНО:\n✅ Подзадача #" + id + " создана под задачей #" + parent_id + "\n" +
           "Название: " + title + "\n" +
           "Исполнитель: " + name;
  },

  // ── Личная сводка дня ─────────────────────────────────────────────────────
  get_my_summary: async (input, userId) => {
    const { responsible_id } = input;
    const now    = new Date();
    const today  = now.toISOString().split("T")[0];
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    const weekStart = monday.toISOString().split("T")[0];

    const [active, doneWeek] = await Promise.all([
      getAllTasks({ RESPONSIBLE_ID: responsible_id, "!STATUS": ["5","7"] },
        ["ID","STATUS","PRIORITY","DEADLINE"], {}, userId),
      getAllTasks({ RESPONSIBLE_ID: responsible_id, STATUS: "5", ">=CLOSED_DATE": weekStart },
        ["ID","STATUS"], {}, userId),
    ]);

    const overdue   = active.filter(t => t.deadline && new Date(t.deadline) < now);
    const dueToday  = active.filter(t => t.deadline && new Date(t.deadline).toDateString() === now.toDateString());
    const high      = active.filter(t => t.priority === "2");
    const known     = KNOWN_USERS[String(responsible_id)];
    const name      = known ? known.name : "Сотрудник";

    let text = "Сводка на сегодня — " + name + "\n" + "═".repeat(36) + "\n\n";
    text += "Активных задач: " + active.length + "\n";
    if (overdue.length)  text += "⚠️ Просрочено: " + overdue.length + "\n";
    if (dueToday.length) text += "🔥 Дедлайн сегодня: " + dueToday.length + "\n";
    if (high.length)     text += "🔴 Высокий приоритет: " + high.length + "\n";
    text += "✅ Закрыто за эту неделю: " + doneWeek.length + "\n";
    return "📋ДОСЛОВНО:\n" + text;
  },

  // ── Статистика ОЦП за период ─────────────────────────────────────────────
  get_ocp_stats: async (input, userId) => {
    const { date_from, date_to } = input;
    const results = await Promise.all(OCP_IDS.map(async id => {
      const done = await getAllTasks({
        RESPONSIBLE_ID: id, STATUS: "5",
        ">=CLOSED_DATE": date_from, "<=CLOSED_DATE": date_to || new Date().toISOString().split("T")[0],
      }, ["ID"], {}, userId);
      const known = KNOWN_USERS[String(id)];
      return { name: known ? known.name + " " + known.last : "ID:" + id, count: done.length };
    }));
    results.sort((a, b) => b.count - a.count);

    let text = "Статистика ОЦП " + date_from + " — " + (date_to || "сегодня") + "\n" + "═".repeat(40) + "\n\n";
    results.forEach(r => {
      if (r.count > 0) {
        const bar = "█".repeat(Math.min(r.count, 10));
        text += r.name + ": " + bar + " " + r.count + "\n";
      }
    });
    const total = results.reduce((s, r) => s + r.count, 0);
    text += "\nИтого закрыто: " + total + " задач";
    return "📋ДОСЛОВНО:\n" + text;
  },

  // ── Еженедельный отчёт ────────────────────────────────────────────────────
  get_weekly_report: async (input, userId) => {
    const now     = new Date();
    const monday  = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    const weekStart = monday.toISOString().split("T")[0];

    const [overdueAll, doneWeekAll] = await Promise.all([
      getAllTasks({ "!STATUS": ["5","7"], "<=DEADLINE": new Date().toISOString().split("T")[0] },
        ["ID","RESPONSIBLE_ID","TITLE","DEADLINE","GROUP_ID"], {}, userId),
      getAllTasks({ STATUS: "5", ">=CLOSED_DATE": weekStart },
        ["ID","RESPONSIBLE_ID"], {}, userId),
    ]);

    // Только ОЦП
    const ocpOverdue = overdueAll.filter(t => OCP_IDS.includes(Number(t.responsibleId)));
    const ocpDone    = doneWeekAll.filter(t => OCP_IDS.includes(Number(t.responsibleId)));

    const doneByUser = {};
    ocpDone.forEach(t => {
      const uid = String(t.responsibleId);
      doneByUser[uid] = (doneByUser[uid] || 0) + 1;
    });

    let text = "Еженедельный отчёт ОЦП\n" + "═".repeat(40) + "\n\n";
    text += "Закрыто с " + weekStart + ":\n";
    OCP_IDS.forEach(id => {
      const n = doneByUser[String(id)] || 0;
      if (n > 0) {
        const u = KNOWN_USERS[String(id)];
        text += (u ? u.name + " " + u.last : "ID:" + id) + ": " + n + " задач\n";
      }
    });

    if (ocpOverdue.length) {
      text += "\nПросрочено (" + ocpOverdue.length + "):\n";
      ocpOverdue.slice(0, 10).forEach(t => {
        text += fmtTask(t) + "\n";
      });
    }
    return "📋ДОСЛОВНО:\n" + text;
  },

  search_tasks: async (input, userId) => {
    const { query, group_id, responsible_id, status } = input;
    const filter = { "%TITLE": query };
    if (group_id)       filter.GROUP_ID = group_id;
    if (responsible_id) filter.RESPONSIBLE_ID = responsible_id;
    if (status === "active") filter["!STATUS"] = ["5","7"];
    if (status === "done")   filter.STATUS = "5";

    const tasks = await getAllTasks(filter,
      ["ID","TITLE","STATUS","PRIORITY","DEADLINE","GROUP_ID","RESPONSIBLE_ID"],
      { ACTIVITY_DATE: "DESC" }, userId);

    if (!tasks.length) return "📋ДОСЛОВНО:\nПо запросу «" + query + "» задач не найдено.";
    if (tasks.length > MAX_DISPLAY) return "📋ДОСЛОВНО:\n" + taskSummary(tasks);

    let text = "Найдено по «" + query + "» (" + tasks.length + " задач):\n";
    tasks.forEach(t => { text += fmtTask(t) + "\n"; });
    return "📋ДОСЛОВНО:\n" + text;
  },

  get_today_tasks: async (input, userId) => {
    const { responsible_id } = input;
    const today = new Date().toISOString().split("T")[0];
    const filter = {
      RESPONSIBLE_ID: responsible_id,
      "!STATUS": ["5","7"],
      "<=DEADLINE": today,
    };
    const tasks = await getAllTasks(filter,
      ["ID","TITLE","STATUS","PRIORITY","DEADLINE","GROUP_ID"],
      { DEADLINE: "ASC" }, userId);

    const name = KNOWN_USERS[String(responsible_id)]
      ? KNOWN_USERS[String(responsible_id)].name
      : "Сотрудник";

    if (!tasks.length) return "📋ДОСЛОВНО:\n" + name + " — сегодня нет просроченных или срочных задач. Всё в порядке!";

    const now = new Date();
    const overdue = tasks.filter(t => new Date(t.deadline) < now);
    const dueToday = tasks.filter(t => {
      const d = new Date(t.deadline);
      return d.toDateString() === now.toDateString();
    });

    let text = "Задачи на сегодня — " + name + " (" + tasks.length + " шт):\n\n";
    if (overdue.length) {
      text += "ПРОСРОЧЕНО (" + overdue.length + "):\n";
      overdue.forEach(t => { text += fmtTask(t) + "\n"; });
      text += "\n";
    }
    if (dueToday.length) {
      text += "ДЕДЛАЙН СЕГОДНЯ (" + dueToday.length + "):\n";
      dueToday.forEach(t => { text += fmtTask(t) + "\n"; });
    }
    return "📋ДОСЛОВНО:\n" + text;
  },

  workload_report: async (input, userId) => {
    const { group_id, ocp_only } = input;
    const filter = { "!STATUS": ["5","7"] };
    if (group_id) filter.GROUP_ID = group_id;

    const tasks = await getAllTasks(
      filter,
      ["ID","TITLE","STATUS","PRIORITY","RESPONSIBLE_ID","DEADLINE"],
      { ACTIVITY_DATE: "DESC" },
      userId
    );

    const now    = new Date();
    const byUser = {};

    tasks.forEach(t => {
      const uid = String(t.responsibleId || "?");
      // Фильтр: только ОЦП если запрошено
      if (ocp_only && !KNOWN_USERS[uid]) return;
      if (!byUser[uid]) byUser[uid] = { total: 0, high: 0, overdue: 0 };
      byUser[uid].total++;
      if (t.priority === "2") byUser[uid].high++;
      if (t.deadline && new Date(t.deadline) < now) byUser[uid].overdue++;
    });

    const sorted = Object.entries(byUser).sort((a, b) => b[1].total - a[1].total);

    // Имена из KNOWN_USERS — не вызываем API, не галлюцинируем
    const title = ocp_only ? "ЗАГРУЗКА ОЦП" : "ЗАГРУЗКА СОТРУДНИКОВ";
    let text = `📊 ${title} — сотрудников: ${sorted.length}\n${"═".repeat(44)}\n\n`;
    sorted.forEach(([uid, data]) => {
      const u = KNOWN_USERS[uid];
      const name = u ? u.name + " " + u.last : `ID:${uid}`;
      const pos  = u ? ` (${u.pos})` : "";
      const bar  = "█".repeat(Math.min(data.total, 10));
      text += `👤 ${name}${pos}: ${bar} ${data.total} задач`;
      if (data.overdue) text += ` | ⚠️${data.overdue} просрочено`;
      if (data.high)    text += ` | 🔴${data.high} высокий`;
      text += "\n";
    });
    return "📋ДОСЛОВНО:\n" + text;
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
    name: "find_department",
    description: "Найти отдел компании по названию (например 'маркетинг', 'ОЦП') и получить список сотрудников этого отдела с их ID. Используй когда спрашивают про 'отдел X', 'команда X', загрузку/задачи целого отдела.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
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
      properties: {
        group_id: { type: "number", description: "ID проекта (опционально)" },
        ocp_only: { type: "boolean", description: "true = только ОЦП" },
      },
    },
  },
  {
    name: "delete_task",
    description: "Удалить задачу. Требует пароль для подтверждения.",
    input_schema: { type: "object",
      properties: {
        task_id:  { type: "number", description: "ID задачи" },
        password: { type: "string", description: "Пароль подтверждения" },
      },
      required: ["task_id", "password"],
    },
  },
  {
    name: "complete_task",
    description: "Завершить задачу — перевести в статус Завершена.",
    input_schema: { type: "object",
      properties: { task_id: { type: "number", description: "ID задачи" } },
      required: ["task_id"],
    },
  },
  {
    name: "assign_task",
    description: "Переназначить задачу на другого исполнителя.",
    input_schema: { type: "object",
      properties: {
        task_id:        { type: "number", description: "ID задачи" },
        responsible_id: { type: "number", description: "ID нового исполнителя" },
      },
      required: ["task_id", "responsible_id"],
    },
  },
  {
    name: "create_subtask",
    description: "Создать подзадачу под существующей задачей.",
    input_schema: { type: "object",
      properties: {
        parent_id:      { type: "number", description: "ID родительской задачи" },
        title:          { type: "string", description: "Название подзадачи" },
        responsible_id: { type: "number", description: "ID исполнителя" },
        deadline:       { type: "string", description: "Дедлайн YYYY-MM-DD" },
      },
      required: ["parent_id", "title"],
    },
  },
  {
    name: "get_my_summary",
    description: "Личная сводка дня: активные задачи, просрочки, закрытые за неделю.",
    input_schema: { type: "object",
      properties: { responsible_id: { type: "number", description: "ID сотрудника" } },
      required: ["responsible_id"],
    },
  },
  {
    name: "get_ocp_stats",
    description: "Статистика ОЦП за период — кто сколько задач закрыл.",
    input_schema: { type: "object",
      properties: {
        date_from: { type: "string", description: "Дата от YYYY-MM-DD" },
        date_to:   { type: "string", description: "Дата до YYYY-MM-DD (опционально)" },
      },
      required: ["date_from"],
    },
  },
  {
    name: "get_weekly_report",
    description: "Еженедельный отчёт ОЦП — закрытые задачи и просрочки за текущую неделю.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "restore_task",
    description: "Мягкое удаление: архивировать задачу (статус отложена + метка [АРХИВ]) или восстановить из архива.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number", description: "ID задачи" },
        action:  { type: "string", enum: ["archive", "unarchive"], description: "archive = заархивировать, unarchive = восстановить" },
      },
      required: ["task_id", "action"],
    },
  },
  {
    name: "get_collab_chat",
    description: "Прочитать последние сообщения из чата коллаба/рабочей группы.",
    input_schema: {
      type: "object",
      properties: {
        group_id: { type: "number", description: "ID коллаба" },
        limit:    { type: "number", description: "Количество сообщений (по умолчанию 20)" },
      },
      required: ["group_id"],
    },
  },
  {
    name: "search_tasks",
    description: "Поиск задач по ключевому слову в названии.",
    input_schema: {
      type: "object",
      properties: {
        query:          { type: "string",  description: "Ключевое слово для поиска" },
        group_id:       { type: "number",  description: "Опционально — проект для поиска" },
        responsible_id: { type: "number",  description: "Опционально — фильтр по исполнителю" },
        status:         { type: "string",  enum: ["all","active","done"], description: "Фильтр по статусу" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_today_tasks",
    description: "Задачи на сегодня — дедлайн сегодня или уже просрочено.",
    input_schema: {
      type: "object",
      properties: {
        responsible_id: { type: "number", description: "ID исполнителя" },
      },
      required: ["responsible_id"],
    },
    cache_control: { type: "ephemeral" }, // кеш всех инструментов
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
    created_by:     z.number().optional().describe("ID постановщика (только при создании)"),
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
        await bx("task.checklistitem.add", {
          TASKID: taskId,
          fields: { TITLE: String(item) }
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
    // Делегируем в TOOL_HANDLERS — там пагинация и правильная логика
    const r = await TOOL_HANDLERS.manager_dashboard({ group_id });
    return { content: [{ type: "text", text: String(r) }] };
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
    const filter = {};
    if (responsible_id) filter.RESPONSIBLE_ID = responsible_id;
    if (created_by)     filter.CREATED_BY = created_by;
    if (status === "active") filter["!STATUS"] = ["5","7"];
    if (status === "done") {
      filter.STATUS = "5";
      if (date_from) filter[">=CLOSED_DATE"] = date_from;
      if (date_to)   filter["<=CLOSED_DATE"] = date_to;
    }
    if (group_id) filter.GROUP_ID = group_id;

    const select = ["ID","TITLE","STATUS","PRIORITY","DEADLINE","GROUP_ID"];
    if (status === "done") select.push("CLOSED_DATE");

    // Пагинация вместо одного запроса
    const tasks = await getAllTasks(filter, select,
      status === "done" ? { CLOSED_DATE: "DESC" } : { ACTIVITY_DATE: "DESC" }
    );

    if (!tasks.length) return { content: [{ type: "text", text: "Задач нет" }] };

    const now = new Date();
    const projectInfo = group_id ? ` | проект ID:${group_id}` : "";
    const dateInfo = (date_from || date_to)
      ? ` | с ${date_from || "начала"} по ${date_to || "сегодня"}`
      : "";
    const _uid10 = responsible_id || created_by;
    const _known10 = _uid10 && KNOWN_USERS[String(_uid10)];
    const _label10 = _known10 ? (_known10.name + " " + _known10.last) : (created_by ? `постановщик ID:${created_by}` : `ID:${responsible_id}`);
    let text = `👤 Задачи ${_label10}${projectInfo}${dateInfo} — всего: ${tasks.length}\n\n`;

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

// ── 9.5. Найти отдел и его сотрудников ─────────────────────────────────────
server.tool("find_department",
  "Найти отдел компании по названию (например 'маркетинг', 'ОЦП') и получить список сотрудников этого отдела с их ID.",
  { name: z.string().describe("Название отдела или его часть") },
  async ({ name }) => {
    const text = await TOOL_HANDLERS.find_department({ name });
    return { content: [{ type: "text", text }] };
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
    days_back: z.number().optional().describe("За сколько дней смотреть закрытые задачи (0 = за всё время, по умолчанию)"),
  },
  async ({ group_id, days_back = 0 }) => {
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
    await bx("task.checklistitem.add", {
      TASKID: task_id,
      fields: { TITLE: String(item) },
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
  "Загрузка каждого сотрудника — сколько задач, просрочки, приоритеты.",
  {
    group_id: z.number().optional().describe("ID проекта для фильтра"),
    ocp_only: z.boolean().optional().describe("true = только ОЦП"),
  },
  async ({ group_id, ocp_only }) => {
    const r = await TOOL_HANDLERS.workload_report({ group_id, ocp_only });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

// ── 17. Читать переписку в коллабе ────────────────────────────────────────
server.tool("delete_task",
  "Удалить задачу с подтверждением паролем.",
  { task_id: z.number(), password: z.string() },
  async ({ task_id, password }) => {
    const r = await TOOL_HANDLERS.delete_task({ task_id, password });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("complete_task",
  "Завершить задачу.",
  { task_id: z.number() },
  async ({ task_id }) => {
    const r = await TOOL_HANDLERS.complete_task({ task_id });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("assign_task",
  "Переназначить задачу на другого исполнителя.",
  { task_id: z.number(), responsible_id: z.number() },
  async ({ task_id, responsible_id }) => {
    const r = await TOOL_HANDLERS.assign_task({ task_id, responsible_id });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("create_subtask",
  "Создать подзадачу.",
  {
    parent_id:      z.number(),
    title:          z.string(),
    responsible_id: z.number().optional(),
    deadline:       z.string().optional(),
  },
  async ({ parent_id, title, responsible_id, deadline }) => {
    const r = await TOOL_HANDLERS.create_subtask({ parent_id, title, responsible_id, deadline });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("get_my_summary",
  "Личная сводка дня сотрудника.",
  { responsible_id: z.number() },
  async ({ responsible_id }) => {
    const r = await TOOL_HANDLERS.get_my_summary({ responsible_id });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("get_ocp_stats",
  "Статистика ОЦП за период.",
  { date_from: z.string(), date_to: z.string().optional() },
  async ({ date_from, date_to }) => {
    const r = await TOOL_HANDLERS.get_ocp_stats({ date_from, date_to });
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("get_weekly_report",
  "Еженедельный отчёт ОЦП.",
  {},
  async () => {
    const r = await TOOL_HANDLERS.get_weekly_report({});
    return { content: [{ type: "text", text: String(r) }] };
  }
);

server.tool("search_tasks",
  "Поиск задач по ключевому слову в названии.",
  {
    query:          z.string().describe("Ключевое слово для поиска"),
    group_id:       z.number().optional().describe("Опционально — проект"),
    responsible_id: z.number().optional().describe("Опционально — исполнитель"),
    status:         z.enum(["all","active","done"]).optional().describe("Фильтр по статусу"),
  },
  async ({ query, group_id, responsible_id, status }) => {
    const result = await TOOL_HANDLERS.search_tasks({ query, group_id, responsible_id, status });
    return { content: [{ type: "text", text: String(result) }] };
  }
);

server.tool("get_today_tasks",
  "Задачи на сегодня — дедлайн сегодня или просрочено.",
  {
    responsible_id: z.number().describe("ID исполнителя"),
  },
  async ({ responsible_id }) => {
    const result = await TOOL_HANDLERS.get_today_tasks({ responsible_id });
    return { content: [{ type: "text", text: String(result) }] };
  }
);

// ── Fireflies MCP Tools ──────────────────────────────────────────────────────

server.tool("fireflies_get_meetings",
  "Получить список последних совещаний из Fireflies.ai с датой и названием.",
  {
    limit: z.number().optional().describe("Количество последних совещаний (по умолчанию 5)"),
  },
  async ({ limit = 5 }) => {
    if (!FIREFLIES_API_KEY) return { content: [{ type: "text", text: "❌ FIREFLIES_API_KEY не настроен" }] };
    const data = await fireflies(`
      query($limit: Int) {
        transcripts(limit: $limit) {
          id
          title
          date
          duration
          participants
        }
      }
    `, { limit });
    const meetings = data.transcripts || [];
    if (!meetings.length) return { content: [{ type: "text", text: "Совещаний не найдено" }] };
    const lines = meetings.map((m, i) => {
      const date = m.date ? new Date(m.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
      const dur = m.duration ? `${Math.round(m.duration / 60)} мин` : "";
      return `${i + 1}. [${m.id}] ${m.title || "Без названия"} · ${date} ${dur}`;
    }).join("\n");
    return { content: [{ type: "text", text: `📅 Последние совещания:\n\n${lines}` }] };
  }
);

server.tool("fireflies_get_summary",
  "Получить саммари и список задач (action items) из совещания Fireflies.ai.",
  {
    meeting_id: z.string().optional().describe("ID совещания (если не указан — берётся последнее)"),
  },
  async ({ meeting_id }) => {
    if (!FIREFLIES_API_KEY) return { content: [{ type: "text", text: "❌ FIREFLIES_API_KEY не настроен" }] };

    let id = meeting_id;
    if (!id) {
      const list = await fireflies(`query { transcripts(limit: 1) { id title date } }`);
      const last = list.transcripts?.[0];
      if (!last) return { content: [{ type: "text", text: "Совещаний не найдено" }] };
      id = last.id;
    }

    const data = await fireflies(`
      query($id: String!) {
        transcript(id: $id) {
          id
          title
          date
          duration
          participants
          summary {
            overview
            action_items
            keywords
          }
        }
      }
    `, { id });

    const t = data.transcript;
    if (!t) return { content: [{ type: "text", text: "Совещание не найдено" }] };

    const date = t.date ? new Date(t.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    const dur = t.duration ? `${Math.round(t.duration / 60)} мин` : "";

    let text = `📋 Совещание: ${t.title || "Без названия"}\n`;
    text += `📅 Дата: ${date} ${dur}\n`;
    text += `👥 Участники: ${(t.participants || []).join(", ") || "—"}\n\n`;
    if (t.summary?.overview) text += `📝 Обзор:\n${t.summary.overview}\n\n`;
    if (t.summary?.action_items) text += `✅ Action Items:\n${t.summary.action_items}\n\n`;
    if (t.summary?.keywords?.length) text += `🔑 Ключевые темы: ${t.summary.keywords.join(", ")}\n`;
    text += `\n🆔 ID совещания: ${t.id}`;

    return { content: [{ type: "text", text }] };
  }
);

server.tool("fireflies_create_tasks",
  "Создать задачи в Bitrix24 на основе action items из совещания Fireflies.ai.",
  {
    meeting_id: z.string().optional().describe("ID совещания (если не указан — берётся последнее)"),
    group_id: z.number().optional().describe("ID проекта в Bitrix24 (если нужно привязать к проекту)"),
    responsible_id: z.number().optional().describe("ID исполнителя по умолчанию"),
  },
  async ({ meeting_id, group_id, responsible_id }) => {
    if (!FIREFLIES_API_KEY) return { content: [{ type: "text", text: "❌ FIREFLIES_API_KEY не настроен" }] };

    let id = meeting_id;
    if (!id) {
      const list = await fireflies(`query { transcripts(limit: 1) { id title date } }`);
      const last = list.transcripts?.[0];
      if (!last) return { content: [{ type: "text", text: "Совещаний не найдено" }] };
      id = last.id;
    }

    const data = await fireflies(`
      query($id: String!) {
        transcript(id: $id) {
          title
          date
          summary { action_items }
        }
      }
    `, { id });

    const t = data.transcript;
    if (!t?.summary?.action_items) return { content: [{ type: "text", text: "Action items не найдены в этом совещании" }] };

    const items = t.summary.action_items
      .split("\n")
      .map(s => s.replace(/^[-•*\d.]+\s*/, "").trim())
      .filter(s => s.length > 5);

    if (!items.length) return { content: [{ type: "text", text: "Не удалось распарсить action items" }] };

    const meetingTitle = t.title || "Совещание";
    const date = t.date ? new Date(t.date).toLocaleDateString("ru-RU") : "";
    const created = [];
    const errors = [];

    for (const item of items) {
      try {
        const params = {
          fields: {
            TITLE: item,
            DESCRIPTION: `Задача из совещания: ${meetingTitle} (${date})`,
            RESPONSIBLE_ID: responsible_id || 3046,
          }
        };
        if (group_id) params.fields.GROUP_ID = group_id;
        const result = await bx("tasks.task.add", params);
        const taskId = result?.task?.id || result?.id;
        if (taskId) {
          created.push(`✅ [${taskId}] ${item}`);
        } else {
          errors.push(`❌ ${item}`);
        }
      } catch (e) {
        errors.push(`❌ ${item}: ${e.message}`);
      }
    }

    let text = `📋 Совещание: ${meetingTitle}\n`;
    text += `🆕 Создано задач: ${created.length} из ${items.length}\n\n`;
    if (created.length) text += created.join("\n") + "\n";
    if (errors.length) text += "\nОшибки:\n" + errors.join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Bitrix24 get_collab_chat ──────────────────────────────────────────────────

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

// ── Bot Client IDs ─────────────────────────────────────────────────────────
const BOT_CLIENTS = {
  "7358": "9c6yjlcm53b4ixr0v32gbuqz79zgw5ud",
  "7360": "ugjk1pbwylqhngmj7abkxstdv3pc94lr",
  "7381": "qcv0l230bxtee7rr50z14a4sd5pthspu", // RedBot
};

// ── Память диалогов ─────────────────────────────────────────────────────────
const CONVERSATION_HISTORY = new Map(); // dialogId -> [{role, content}, ...]
const MAX_HISTORY = 6; // последние 6 сообщений (3 обмена)

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

ДАТЫ НА РУССКОМ — всегда конвертируй без уточнений:
"сегодня" = текущая дата | "вчера" = -1 день | "эта неделя" = пн-вс текущей недели
"прошлая неделя" = пн-вс прошлой недели | "этот месяц" = 1-е по сегодня текущего месяца
"апрель" = 2026-04-01/2026-04-30 | "май" = 2026-05-01/2026-05-31
"июнь" = 2026-06-01/2026-06-30 | "июль" = 2026-07-01/2026-07-31
Текущий год: 2026. При любом упоминании месяца — применяй фильтр date_from+date_to СРАЗУ.

ФОРМАТИРОВАНИЕ — Bitrix24 чат не рендерит markdown:
НЕ используй **жирный**, *курсив*, ### заголовки в ответах.
Используй только: эмодзи, дефисы, переносы строк.

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
ЗАПРЕЩЕНО называть любое число задач без вызова инструмента.
"за все время" / "за всё время" / "всего" = всегда days_back=0.
ЗАПРЕЩЕНО генерировать ссылки самостоятельно — используй ТОЛЬКО ссылки из ответа инструмента дословно.
КРИТИЧНО: Если имя сотрудника есть в KNOWN_USERS — используй его ID напрямую, ЗАПРЕЩЕНО вызывать find_user для известных сотрудников:
Айтунук=265, Адиляй=321, Жалынбек=4, Эрмек=3046, Каныкей=279, Арлен=3048,
Баяна=3136, Айжамал=434, Руслана=452, Эрлан=256, Урмат=276, Адилет=3047,
Александр Крылов=5006, Айжан=7031, Бакыт=121, Александр Логвинов=3323.
Александр Логвинов ID:3323 — гость-разработчик. Если его задачи вернулись пустыми — скажи "задачи не найдены", НЕ ищи другого Александра.
"завершённые в проекте X" БЕЗ слова "мои" = ВСЕГДА get_project_summary(group_id=X, days_back=0). ЗАПРЕЩЕНО использовать employee_tasks для запросов про проект без "мои".

КРИТИЧЕСКИ ВАЖНО — МАРКЕР ДОСЛОВНОГО ВЫВОДА:
Если ответ инструмента начинается с "📋ДОСЛОВНО:" — выведи ВСЁ после этого маркера
БЕЗ ЕДИНОГО ИЗМЕНЕНИЯ. Не перефразируй. Не улучшай. Не добавляй эмодзи. Просто скопируй.

KNOWN_USERS — реальные сотрудники ОЦП (их ID и имена точные):
Жалынбек Адишев=4, Эрлан Чодоев=256, Айтунук Бактыбекова=265, Урмат Сагынбек уулу=276,
Каныкей Мамытканова=279, Адиляй Сейдакматова=321, Айжамал Мадылбекова=434,
Руслана Комарова=452, Эрмек Русланов=3046, Адилет Сманкулов=3047,
Арлен Омурбеков=3048, Баяна Поезбекова=3136, Александр Крылов=5006, Айжан Ташкулова=7031.

Для запроса "загрузка ОЦП" или "нагрузка отдела" — используй workload_report с ocp_only=true.

КРИТИЧНО — ПРАВИЛА ЧЕСТНОСТИ (нарушение = дезинформация):
- ЗАПРЕЩЕНО придумывать, перефразировать или переименовывать названия задач.
ЗАПРЕЩЕНО вызывать complete_task автоматически после create_task.
ЗАПРЕЩЕНО менять постановщика задачи после создания — это невозможно в Bitrix24 API.
Постановщик задаётся только при создании через параметр created_by.
При создании НОВОЙ задачи — используй ТОЛЬКО то что пользователь явно указал сейчас.
Не переноси описание, чек-лист, исполнителя из предыдущих сообщений если пользователь не попросил.
- Копируй строки задач из инструмента ДОСЛОВНО: [ID] Название · Статус · Дедлайн | Ссылка
- Если инструмент вернул сводку (📊 Найдено N задач) — выводи её без изменений.
- Реальное количество = tasks.length из пагинации. Не используй поле total из API.
- Нельзя показывать задачу если её нет в ответе инструмента.
- Нельзя: "за май+июнь — 33 задачи" если "за июнь — 40 задач". Логику проверяй.
- Если не можешь получить имя сотрудника — пиши ID, не угадывай имя.
- Для "задачи где я постановщик" используй employee_tasks с параметром created_by.
- Если пользователь даёт ссылку вида /user/265/ — используй ID=265 напрямую в инструментах.
- Задачи других сотрудников (не Эрмек ID:3046 и не Жалынбек ID:4) могут показываться неточно — у них нет личных вебхуков. Честно предупреждай об этом.

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

  // BOT = { "7358": { BOT_ID: "7358", BOT_CODE: "...", AUTH_TOKEN: {...} } }
  const botRaw   = data.BOT;
  let botId, botAccessToken;
  if (typeof botRaw === "object" && botRaw !== null) {
    const firstBot = Object.values(botRaw)[0];
    botId = firstBot?.BOT_ID || Object.keys(botRaw)[0];
    // Bitrix может присылать токен по-разному в зависимости от версии события —
    // проверяем оба известных варианта поля.
    botAccessToken = firstBot?.access_token || firstBot?.AUTH_TOKEN?.access_token || null;
  } else {
    botId = botRaw || data.BOT_ID || params.TO_USER_ID;
  }
  if (botAccessToken) console.log("🔑 Bot access_token найден в событии");
  else console.log("⚠️ Bot access_token отсутствует в событии — используем вебхук как fallback");

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

  // Точка в начале — упрощённый вызов без @тега (. покажи мои задачи)
  const isDotCommand = message.startsWith(". ") || message === ".";
  const cleanMessage = isDotCommand ? message.slice(2).trim() : message;

  // В групповом чате — отвечаем только если: тег ИЛИ точка ИЛИ команда ИЛИ вопрос
  if (isGroupChat && !isMentioned && !isDotCommand && !isCommand && !isQuestion) {
    console.log("⏭️ Group message — skipping");
    return;
  }

  // Используем очищенное сообщение (без точки) для дальнейшей обработки
  const finalMessage = isDotCommand ? cleanMessage : message;

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
    let messages = [...history, { role: "user", content: finalMessage || message }];

    console.log("🧠 Calling Claude API with tools...");

    // Вычисляем системный промпт ОДИН РАЗ до цикла
    const staticSystem = getBotSystem(); // статичная часть — общая для всех пользователей
    const systemBlocks = [
      {
        type: "text",
        text: staticSystem,
        cache_control: { type: "ephemeral" }, // кешируется один раз для всех
      },
      {
        type: "text",
        text: userInfo, // динамичная часть — уникальна для каждого пользователя
      }
    ];

    let finalAnswer = "";
    const MAX_ITERATIONS = 5;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system: systemBlocks,
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
          resultText = handler
            ? await botTokenStorage.run(botAccessToken, () => handler(tu.input, userId))
            : `Инструмент ${tu.name} не найден`;
        } catch (e) {
          console.error(`Tool error (${tu.name}):`, e.message);
          resultText = `Ошибка при вызове ${tu.name}: ${e.message}`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
      }

      messages.push({ role: "user", content: toolResults });
    }

    const rawAnswer = finalAnswer || "Не могу ответить, попробуй снова.";
    // Убираем внутренний маркер перед отправкой пользователю
    const answer = rawAnswer.replace(/^📋ДОСЛОВНО:\n/m, "").trim();
    console.log("✅ Final answer:", answer.slice(0, 150));

    // Сохраняем в историю только текстовый обмен (без tool_use деталей)
    // Обрезаем длинные ответы чтобы не тащить списки задач в следующий запрос
    const historyAnswer = answer.length > 500 ? answer.slice(0, 500) + "...[список обрезан]" : answer;
    addToHistory(dialogId, "user", message);
    addToHistory(dialogId, "assistant", historyAnswer);

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

// ── OAuth stub для локального приложения Bitrix24 (временно, для теста im.dialog.messages.get) ─────
app.get("/bitrix/handler", (req, res) => res.status(200).send("OK"));
app.all("/bitrix/install", express.urlencoded({ extended: true }), express.json(), (req, res) => {
  console.log("🔑 BITRIX INSTALL query:", JSON.stringify(req.query));
  console.log("🔑 BITRIX INSTALL body:", JSON.stringify(req.body));
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bitrix24 OCP MCP v3.0 | 16 tools | port ${PORT}`));
