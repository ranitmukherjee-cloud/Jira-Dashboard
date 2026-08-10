// All Quick Links endpoints in ONE serverless function.
//
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and each
// file under api/ counts as one. This used to be five separate files
// (index, [id], reorder, groups, groups/[name]) which alone burned 5 of the
// 12 slots and pushed the project over the cap once the Fireflies endpoints
// were added — every build failed until they were merged back together.
//
// Dispatch mirrors the ?resource= pattern already used by api/tracker.js:
//   links   GET    /api/quicklinks
//           POST   /api/quicklinks
//           PATCH  /api/quicklinks?id=<id>
//           DELETE /api/quicklinks?id=<id>
//           POST   /api/quicklinks?resource=reorder      { group, ids[] }
//   groups  GET    /api/quicklinks?resource=groups
//           POST   /api/quicklinks?resource=groups       { name }
//           PATCH  /api/quicklinks?resource=groups&name=<name>  { name }
//           DELETE /api/quicklinks?resource=groups&name=<name>
const {
  listLinks, addLink, updateLink, reorderLinks, deleteLink,
  listGroups, createGroup, renameGroup, deleteGroup,
} = require('../lib/quickLinks');

module.exports = async (req, res) => {
  const { resource, id } = req.query;
  const method = req.method;
  const body = req.body || {};

  try {
    if (resource === 'groups') {
      // Already decoded by Express/Vercel — decoding again would throw on a
      // group name containing a literal "%" (e.g. "100% Uptime").
      const name = req.query.name || null;
      if (method === 'GET') return res.status(200).json(await listGroups());
      if (method === 'POST') return res.status(201).json(await createGroup(body.name));
      if (method === 'PATCH' || method === 'PUT') {
        if (!name) throw new Error('name query param is required');
        return res.status(200).json(await renameGroup(name, body.name));
      }
      if (method === 'DELETE') {
        if (!name) throw new Error('name query param is required');
        return res.status(200).json(await deleteGroup(name));
      }
      return res.status(405).json({ error: 'Use GET, POST, PATCH or DELETE' });
    }

    if (resource === 'reorder') {
      if (method !== 'POST') return res.status(405).json({ error: 'Use POST' });
      const { group, ids } = body;
      if (!group || !Array.isArray(ids)) throw new Error('group and ids[] are required');
      return res.status(200).json(await reorderLinks(group, ids));
    }

    // Default resource: the links themselves.
    if (method === 'GET') return res.status(200).json(await listLinks());
    if (method === 'POST') return res.status(201).json(await addLink(body));
    if (method === 'PATCH' || method === 'PUT') {
      if (!id) throw new Error('id query param is required');
      return res.status(200).json(await updateLink(id, body));
    }
    if (method === 'DELETE') {
      if (!id) throw new Error('id query param is required');
      return res.status(200).json(await deleteLink(id));
    }
    return res.status(405).json({ error: 'Use GET, POST, PATCH or DELETE' });
  } catch (err) {
    console.error('Quick Links API error:', err);
    return res.status(400).json({ error: err.message });
  }
};
