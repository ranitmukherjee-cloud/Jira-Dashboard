// Business logic for the Daily Task Tracker.
const { getTasks, setTasks } = require('./trackerStore');

const PSE_ROWS = ['Ankith', 'Avani', 'Dhananjay', 'Karan', 'Surabhi', 'Utkarsh'];
const STATUSES = ['Open', 'In Progress', 'Done'];

function istDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A task is "visible" on a given day if it existed by then and either it's
// still open (so it carries forward every day until closed) or it was
// completed on exactly that day (a historical record for that day's view).
function isVisibleOnDay(task, day) {
  if (task.createdDate > day) return false;
  if (task.status === 'Done') return task.completedDate === day;
  return true;
}

function isOverdue(task, today = istDateString()) {
  return task.status !== 'Done' && !!task.dueDate && task.dueDate < today;
}

async function listTasks() {
  return getTasks();
}

async function createTask({ pse, dealName = '', status = 'Open', dueDate = null, flagApoorv = false, helpInSow = false, blocker = '' }) {
  if (!PSE_ROWS.includes(pse)) throw new Error(`Invalid PSE: ${pse}`);
  const now = new Date().toISOString();
  const task = {
    id: newId(),
    pse,
    dealName,
    status: STATUSES.includes(status) ? status : 'Open',
    dueDate,
    flagApoorv: !!flagApoorv,
    helpInSow: !!helpInSow,
    blocker,
    createdDate: istDateString(),
    completedDate: status === 'Done' ? istDateString() : null,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = await getTasks();
  tasks.push(task);
  await setTasks(tasks);
  return task;
}

async function updateTask(id, patch) {
  const tasks = await getTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error('Task not found');

  const prev = tasks[idx];
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };

  if (patch.status && patch.status !== prev.status) {
    next.completedDate = patch.status === 'Done' ? istDateString() : null;
  }

  tasks[idx] = next;
  await setTasks(tasks);
  return next;
}

async function deleteTask(id) {
  const tasks = await getTasks();
  const next = tasks.filter((t) => t.id !== id);
  await setTasks(next);
  return { deleted: tasks.length !== next.length };
}

module.exports = { PSE_ROWS, STATUSES, listTasks, createTask, updateTask, deleteTask, isVisibleOnDay, isOverdue, istDateString };
