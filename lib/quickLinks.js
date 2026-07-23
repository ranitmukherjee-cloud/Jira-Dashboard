// Business logic for Quick Links. Seeds the store with the curated links on
// first access so nothing already shared gets lost when this switched from
// a static array to live, addable storage.
const { getLinks, setLinks } = require('./quickLinksStore');

const DEFAULT_LINKS = [
  { name: 'GoComet_PSV_Board_PSE_Process_Guide', url: 'https://docs.google.com/document/d/1vj_hQZ3ApDX_ZLUi3P-w0cHqSE0V1bojfoiiXLJHj9Q/edit?usp=sharing', group: 'Links' },
  { name: 'Feature Alignment Matrix', url: 'https://docs.google.com/spreadsheets/d/1jArAvGvCjucuPTK3ZrSDZpsLoTUv1C2RmS9tMmaOBLY/edit?usp=sharing', group: 'Links' },
  { name: 'Customer Feature and Guardrail', url: 'https://docs.google.com/spreadsheets/d/1IZ38WmjYlbBu7FCzOHVGsHFBj_r4AQ28gom6hmHuEH0/edit?usp=sharing', group: 'Links' },
  { name: 'Existing Clients and Modules List', url: 'https://docs.google.com/spreadsheets/d/1Z4ezXemkt7QZzFpjtrJnHJ45DbTI9EDWe_dnnu_1ZIQ/edit?usp=sharing', group: 'Links' },
  { name: 'Product Council Sheet', url: 'https://docs.google.com/spreadsheets/d/1JiSiBSP2GpMxUb6wG9LfcCr53wIo7Kf9s8udA2hSdKw/edit?usp=sharing', group: 'Links' },
  { name: 'Deck1_Training_Plan.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5EKSE7S9/deck1_training_plan.pdf', group: 'Solutions Team Decks' },
  { name: 'Deck2_Operational_Checklists.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5MKL2YRJ/deck2_operational_checklists.pdf', group: 'Solutions Team Decks' },
  { name: 'Deck3_Governance_Metrics.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5J1MTG3C/deck3_governance_metrics.pdf', group: 'Solutions Team Decks' },
  { name: 'KPI_Incentive_Framework_Presentation.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B52HNBADV/kpi_incentive_framework_presentation.pdf', group: 'Solutions Team Decks' },
  { name: 'Product Solutions Team Deck.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5J1N11UJ/product_solutions_team_deck.pdf', group: 'Solutions Team Decks' },
  { name: 'Operations (Ops) Repository Latest', url: 'https://docs.google.com/spreadsheets/d/1kXxI11KuE3CPJkFbD00mJhT7Q1E5fEmVdRcLaVvDUjA/edit?usp=sharing', group: 'Repository' },
];

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function listLinks() {
  let links = await getLinks();
  if (links === null) {
    links = DEFAULT_LINKS.map((l, i) => ({ id: newId(), order: i, ...l, createdAt: new Date().toISOString() }));
    await setLinks(links);
    return links;
  }
  // Backfill `order` for links stored before that field existed, so sorting
  // stays stable instead of shuffling on first load after this change.
  if (links.some((l) => l.order == null)) {
    links = links.map((l, i) => (l.order == null ? { ...l, order: i } : l));
    await setLinks(links);
  }
  return links;
}

async function addLink({ name, url, group }) {
  if (!name || !url) throw new Error('name and url are required');
  const links = await listLinks();
  const maxOrder = links.reduce((m, l) => Math.max(m, l.order ?? 0), -1);
  const link = { id: newId(), name, url, group: group || 'Links', order: maxOrder + 1, createdAt: new Date().toISOString() };
  links.push(link);
  await setLinks(links);
  return link;
}

async function updateLink(id, patch) {
  const links = await listLinks();
  const idx = links.findIndex((l) => l.id === id);
  if (idx === -1) throw new Error('Link not found');
  links[idx] = { ...links[idx], ...patch };
  await setLinks(links);
  return links[idx];
}

// Persists a new drag-and-drop order for one group; other groups' items are untouched.
async function reorderLinks(group, orderedIds) {
  const links = await listLinks();
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  const next = links.map((l) => (l.group === group && rank.has(l.id) ? { ...l, order: rank.get(l.id) } : l));
  await setLinks(next);
  return next;
}

async function deleteLink(id) {
  const links = await listLinks();
  const next = links.filter((l) => l.id !== id);
  await setLinks(next);
  return { deleted: links.length !== next.length };
}

module.exports = { listLinks, addLink, updateLink, reorderLinks, deleteLink };
