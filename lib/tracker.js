// Business logic for the Daily Task Tracker.
const { getTasks, setTasks, getLeave, setLeave, getHolidays, setHolidays } = require('./trackerStore');

const PSE_ROWS = ['Ankith', 'Apoorv', 'Avani', 'Dhananjay', 'Karan', 'Ranit', 'Surabhi', 'Utkarsh'];
const STATUSES = ['Planned', 'In Progress', 'Done']; // was "Open"

function istDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
}

// Sat/Sun in the Indian calendar are non-working days: no tracking, no leave.
// Uses UTC on the bare YYYY-MM-DD so it's independent of server timezone.
function isWeekend(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

async function listLeave() {
  return getLeave();
}

async function setLeaveStatus(pse, date, onLeave) {
  if (!PSE_ROWS.includes(pse)) throw new Error(`Invalid PSE: ${pse}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Invalid date');
  if (isWeekend(date)) throw new Error('Weekends are non-working days — no leave to mark');
  const map = await getLeave();
  const key = `${pse}|${date}`;
  if (onLeave) map[key] = true;
  else delete map[key];
  await setLeave(map);
  return map;
}

async function listHolidays() {
  return getHolidays();
}

async function setHolidayStatus(date, isHoliday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Invalid date');
  const map = await getHolidays();
  if (isHoliday) map[date] = true;
  else delete map[date];
  await setHolidays(map);
  return map;
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A task is "visible" on a given day if it existed by then and either it's
// still open (so it carries forward every day until closed) or, once Done,
// the day is one of its reference points — when it started, when it was
// actually marked complete, and when it was due — so both the start and end
// dates keep a record even if someone closes it out early or late.
// Visibility is anchored on the editable Task Start Date (falls back to the
// creation date for legacy rows). A task recurs on every day from its start
// date onward; once Done it's pinned to its start, completion, and due days.
function taskStart(task) {
  return task.taskStartDate || task.createdDate;
}
function isVisibleOnDay(task, day) {
  const start = taskStart(task);
  // Always visible on the day it was actually planned/added, even for a
  // future-dated task whose Start Date hasn't arrived yet.
  if (day === task.createdDate) return true;
  if (start > day) return false;
  if (task.status === 'Done') {
    // Exactly 2 fixed pages once Done: Task Start Date and Due Date (the
    // actual completion day doesn't get its own page).
    return day === start || day === task.dueDate;
  }
  return true;
}

function isOverdue(task, today = istDateString()) {
  return task.status !== 'Done' && !!task.dueDate && task.dueDate < today;
}

async function listTasks() {
  return getTasks();
}

async function createTask({ pse, dealName = '', status = 'Planned', dueDate = null, taskStartDate = null, flagApoorv = false, helpInSow = false, blocker = '', remarks = '' }) {
  if (!PSE_ROWS.includes(pse)) throw new Error(`Invalid PSE: ${pse}`);
  const now = new Date().toISOString();
  const today = istDateString();
  const task = {
    id: newId(),
    pse,
    dealName,
    status: STATUSES.includes(status) ? status : 'Planned',
    dueDate,
    // Editable scheduling anchor — the day the task first appears; PSEs can
    // move it to shift the task onto a different day's page. Dates stay fully
    // flexible (no locked/committed date).
    taskStartDate: taskStartDate || today,
    flagApoorv: !!flagApoorv,
    // Whether Apoorv has acknowledged a task flagged for him (see
    // isFlaggedForApoorv in app.js) -- irrelevant until flagApoorv is true.
    apoorvSeen: false,
    helpInSow: !!helpInSow,
    blocker,
    remarks,
    createdDate: today,
    completedDate: status === 'Done' ? today : null,
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

module.exports = { PSE_ROWS, STATUSES, listTasks, createTask, updateTask, deleteTask, isVisibleOnDay, isOverdue, istDateString, isWeekend, listLeave, setLeaveStatus, listHolidays, setHolidayStatus };
