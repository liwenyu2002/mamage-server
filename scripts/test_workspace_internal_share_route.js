const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const jwt = require('jsonwebtoken');

if (!String(process.env.DB_NAME || '').endsWith('_workspace_test')) {
  throw new Error('Set DB_NAME to an isolated *_workspace_test database');
}
process.env.ORGANIZATION_UNITS_ACTIVE = '1';
process.env.UPLOAD_BASE_URL = 'https://mamage.test/api/image';
process.env.MEDIA_URL_SECRET = 'workspace-integration-test-secret';
process.env.MEDIA_URL_SIGNING = '1';

const { pool } = require('../db');
const { JWT_SECRET } = require('../config/keys');
const storage = require('../lib/cos_storage');
const sharesRouter = require('../routes/internal_shares');
const facesRouter = require('../routes/faces');
const copyWorker = require('../lib/organization_copy_worker');
const workspacesRouter = require('../routes/workspaces');
const favoritesRouter = require('../routes/user_favorites');
const projectsRouter = require('../routes/projects');
const photosRouter = require('../routes/photos');
const imageProxyRouter = require('../routes/image_proxy');
const { requireProjectAccess, requirePhotoAccess } = require('../lib/workspace_access');
const { buildMediaUrl, authorizeMediaKey } = require('../lib/media_access');
const { searchPhotos } = require('../lib/photo_search');

async function main() {
  const suffix = crypto.randomBytes(10).toString('hex');
  const ids = {};
  let server;
  storage.headObject = async () => ({ ContentLength: 100 });
  storage.copyObject = async (_source, destination) => ({ key: destination, size: 100 });
  storage.deleteObjects = async () => ({ deleted: [] });
  storage.isConfigured = () => true;
  storage.getObject = async () => ({ Body: Readable.from(Buffer.from('private-media-test')),
    ContentType: 'image/jpeg', ContentLength: 18 });
  try {
    const [rolePermission] = await pool.query(
      'INSERT INTO role_permissions (role, permission) VALUES (?, ?)', ['photographer', 'photos.view']);
    ids.rolePermission = rolePermission.insertId;
    const [aiPermission] = await pool.query(
      'INSERT INTO role_permissions (role, permission) VALUES (?, ?)', ['photographer', 'ai.generate']);
    ids.aiPermission = aiPermission.insertId;
    const [org] = await pool.query('INSERT INTO organizations (name, slug, code) VALUES (?, ?, ?)',
      ['Internal share test', `share-route-${suffix}`, `TEST-${suffix}`]);
    ids.org = org.insertId;
    process.env.DEMO_ORGANIZATION_ID = String(ids.org);
    const makeUnit = async (name) => {
      const [result] = await pool.query('INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
        [ids.org, `${name}-${suffix}`, name]);
      return result.insertId;
    };
    ids.sourceUnit = await makeUnit('source');
    ids.targetUnit = await makeUnit('target');
    const makeUser = async (name, unitId) => {
      const [result] = await pool.query(
        'INSERT INTO users (student_no, name, role, organization_id, active_unit_id) VALUES (?, ?, ?, ?, ?)',
        [`${name}-${suffix}`, name, 'photographer', ids.org, unitId]);
      return result.insertId;
    };
    ids.owner = await makeUser('owner', ids.sourceUnit);
    ids.recipient = await makeUser('recipient', ids.targetUnit);
    ids.peer = await makeUser('peer', ids.targetUnit);
    await pool.query('INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
      [ids.sourceUnit, ids.owner, 'manager', ids.targetUnit, ids.recipient, 'member',
        ids.targetUnit, ids.peer, 'member']);
    const [project] = await pool.query('INSERT INTO projects (uuid, name, organization_id, unit_id) VALUES (UUID(), ?, ?, ?)',
      ['Share source', ids.org, ids.sourceUnit]);
    ids.project = project.insertId;
    const [photo] = await pool.query(
      'INSERT INTO photos (uuid, project_id, organization_id, unit_id, url, thumb_url) VALUES (UUID(), ?, ?, ?, ?, ?)',
      [ids.project, ids.org, ids.sourceUnit, `/uploads/units/${ids.sourceUnit}/source.jpg`,
        `/uploads/units/${ids.sourceUnit}/source-thumb.jpg`]);
    ids.photo = photo.insertId;
    const [person] = await pool.query(
      'INSERT INTO face_persons (organization_id, person_no, name) VALUES (?, ?, ?)',
      [ids.org, 1, 'Scoped test person']);
    ids.person = person.insertId;
    const [face] = await pool.query(
      `INSERT INTO photo_faces (photo_id, project_id, organization_id, person_id, face_no,
        bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit, model_name, status)
       VALUES (?, ?, ?, ?, 1, 0.1, 0.1, 0.2, 0.2, 'ratio', 'test', 'confirmed')`,
      [ids.photo, ids.project, ids.org, ids.person]);
    ids.face = face.insertId;
    await pool.query(
      `INSERT INTO face_search_grants (organization_id, user_id, college_wide, granted_by)
       VALUES (?, ?, 1, ?), (?, ?, 1, ?)`,
      [ids.org, ids.recipient, ids.owner, ids.org, ids.peer, ids.owner]);
    const app = express();
    app.use(express.json());
    app.use('/api/internal-shares', sharesRouter);
    app.use('/api/workspaces', workspacesRouter);
    app.use('/api/favorites', favoritesRouter);
    app.use('/api/projects', projectsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/image', imageProxyRouter);
    app.use('/api', facesRouter);
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/internal-shares`;
    const health = await fetch(base.replace(/\/internal-shares$/, '/health'));
    assert.equal(health.status, 200);
    const token = (userId) => jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '5m' });
    const workspaceBase = base.replace(/\/internal-shares$/, '/workspaces');
    const demoAlbums = await fetch(base.replace(/\/internal-shares$/, '/projects?demo=1'));
    assert.deepEqual(await demoAlbums.json(), []);
    const demoProject = await fetch(base.replace(/\/internal-shares$/, `/projects/${ids.project}?demo=1`));
    assert.equal(demoProject.status, 404);
    const demoSearch = await fetch(base.replace(/\/internal-shares$/, '/photos/search?demo=1'));
    assert.equal(demoSearch.status, 200);
    assert.deepEqual((await demoSearch.json()).list, []);
    const available = await fetch(workspaceBase, {
      headers: { Authorization: `Bearer ${token(ids.owner)}` },
    });
    assert.equal(available.status, 200);
    const workspaceList = await available.json();
    assert.deepEqual(workspaceList.units.map((unit) => unit.id), [ids.sourceUnit]);
    assert.deepEqual(workspaceList.shareTargets.map((unit) => unit.id), [ids.sourceUnit, ids.targetUnit]);
    const albumList = await fetch(`${workspaceBase}/albums`, {
      headers: { Authorization: `Bearer ${token(ids.owner)}` },
    });
    assert.equal(albumList.status, 200);
    assert.deepEqual((await albumList.json()).map((album) => album.id), [ids.project]);
    const created = await fetch(base, {
      method: 'POST', headers: { Authorization: `Bearer ${token(ids.owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareType: 'album', mode: 'copy', projectId: ids.project,
        targetUnitId: ids.targetUnit, targetUserId: ids.recipient }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText.slice(0, 500));
    const share = JSON.parse(createdText);
    ids.share = share.id;
    ids.job = share.copyJobId;
    assert(ids.job);
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [rows] = await pool.query('SELECT * FROM organization_copy_jobs WHERE id = ?', [ids.job]);
      job = rows[0];
      if (job.status === 'ready' || job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(job.status, 'ready', job.error_code || 'copy timed out');
    const result = typeof job.result_json === 'string' ? JSON.parse(job.result_json) : job.result_json;
    ids.copiedProject = result.projectId;
    const received = await fetch(`${base}/received`, { headers: { Authorization: `Bearer ${token(ids.recipient)}` } });
    assert.equal(received.status, 200);
    const inbox = await received.json();
    assert.equal(inbox[0].id, ids.share);
    assert.equal(inbox[0].copyStatus, 'ready');
    assert.equal(inbox[0].sourceOrganizationName, 'Internal share test');
    assert.equal(inbox[0].sourceUnitName, 'source');
    assert.equal(inbox[0].sharedByName, 'owner');
    const peerInbox = await fetch(`${base}/received`, {
      headers: { Authorization: `Bearer ${token(ids.peer)}` },
    });
    assert.deepEqual(await peerInbox.json(), []);
    const peerAlbums = await fetch(`${workspaceBase}/albums`, {
      headers: { Authorization: `Bearer ${token(ids.peer)}` },
    });
    assert.deepEqual(await peerAlbums.json(), []);
    await assert.rejects(() => requireProjectAccess({ user: {
      id: ids.peer, role: 'photographer', organization_id: ids.org,
    }, get: () => undefined }, ids.copiedProject), (err) => err.status === 404);
    await assert.rejects(() => requirePhotoAccess({ user: {
      id: ids.peer, role: 'photographer', organization_id: ids.org,
    }, get: () => undefined }, result.photoIds[0]), (err) => err.status === 404);
    const [copiedRows] = await pool.query('SELECT url FROM photos WHERE id = ?', [result.photoIds[0]]);
    const copiedKey = storage.keyFromUrlOrPath(copiedRows[0].url);
    const peerMedia = buildMediaUrl(copiedRows[0].url, { userId: ids.peer, photoId: result.photoIds[0] });
    assert.equal(await authorizeMediaKey(copiedKey, new URL(peerMedia).searchParams.get('ma')), false);
    const recipientMedia = buildMediaUrl(copiedRows[0].url,
      { userId: ids.recipient, photoId: result.photoIds[0] });
    const mediaEndpoint = (url) => `${base.replace(/\/internal-shares$/, '')}${new URL(url).pathname.replace(/^\/api/, '')}${new URL(url).search}`;
    assert.equal((await fetch(mediaEndpoint(recipientMedia))).status, 200);
    assert.equal((await fetch(mediaEndpoint(peerMedia))).status, 403);
    assert.equal((await fetch(mediaEndpoint(recipientMedia).replace(/&ma=[^&]+/, ''))).status, 403);
    const searchOptions = { q: '', orgId: ids.org, unitId: ids.targetUnit,
      workspaceEnabled: true, faceSearchAllowed: false, enableAi: false };
    const recipientSearch = await searchPhotos({ ...searchOptions, userId: ids.recipient });
    assert(recipientSearch.list.some((photoItem) => Number(photoItem.id) === result.photoIds[0]));
    const peerSearch = await searchPhotos({ ...searchOptions, userId: ids.peer });
    assert(!peerSearch.list.some((photoItem) => Number(photoItem.id) === result.photoIds[0]));
    const recipientDetail = await fetch(`${base}/${ids.share}`, {
      headers: { Authorization: `Bearer ${token(ids.recipient)}` },
    });
    assert.equal(recipientDetail.status, 200);
    const copiedDetail = await recipientDetail.json();
    assert.equal(copiedDetail.projectId, ids.copiedProject);
    assert.equal(copiedDetail.sourceOrganizationName, 'Internal share test');
    assert.equal(copiedDetail.sourceUnitName, 'source');
    assert.equal(copiedDetail.sharedByName, 'owner');
    assert.equal(copiedDetail.photos.length, 1);
    assert.equal(copiedDetail.photos[0].projectId, ids.copiedProject);
    assert.notEqual(copiedDetail.photos[0].id, ids.photo);
    const sourceDetail = await fetch(`${base}/${ids.share}`, {
      headers: { Authorization: `Bearer ${token(ids.owner)}` },
    });
    assert.equal(sourceDetail.status, 200);
    assert.deepEqual((await sourceDetail.json()).photos, []);
    const apiBase = base.replace(/\/internal-shares$/, '');
    const faceHeaders = { Authorization: `Bearer ${token(ids.recipient)}` };
    const personPhotos = await fetch(`${apiBase}/persons/${ids.person}/photos`, { headers: faceHeaders });
    assert.equal(personPhotos.status, 200);
    const scopedPhotos = await personPhotos.json();
    assert.deepEqual(scopedPhotos.photos.map((photo) => Number(photo.id)), [result.photoIds[0]]);
    const personFaces = await fetch(`${apiBase}/faces?personId=${ids.person}`, { headers: faceHeaders });
    assert.equal(personFaces.status, 200);
    assert.deepEqual((await personFaces.json()).faces.map((faceItem) => Number(faceItem.photoId)),
      [result.photoIds[0]]);
    const foreignFace = await fetch(`${apiBase}/faces/${ids.face}`, { headers: faceHeaders });
    assert.equal(foreignFace.status, 404);
    const peerPersonPhotos = await fetch(`${apiBase}/persons/${ids.person}/photos`, {
      headers: { Authorization: `Bearer ${token(ids.peer)}` },
    });
    assert.deepEqual((await peerPersonPhotos.json()).photos, []);
    const liveShareResponse = await fetch(base, { method: 'POST',
      headers: { Authorization: `Bearer ${token(ids.owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareType: 'album', mode: 'read', projectId: ids.project,
        targetUnitId: ids.targetUnit }),
    });
    assert.equal(liveShareResponse.status, 201);
    ids.liveShare = (await liveShareResponse.json()).id;
    const [laterPhoto] = await pool.query(
      `INSERT INTO photos (uuid, project_id, organization_id, unit_id, url, thumb_url)
       VALUES (UUID(), ?, ?, ?, ?, ?)`,
      [ids.project, ids.org, ids.sourceUnit, `/uploads/units/${ids.sourceUnit}/later.jpg`,
        `/uploads/units/${ids.sourceUnit}/later-thumb.jpg`]);
    ids.laterPhoto = laterPhoto.insertId;
    const firstPage = await fetch(`${base}/${ids.liveShare}?limit=1`, { headers: faceHeaders });
    assert.equal(firstPage.status, 200);
    const firstPageData = await firstPage.json();
    assert.equal(firstPageData.total, 2);
    assert.equal(firstPageData.photos.length, 1);
    assert.equal(firstPageData.hasMore, true);
    const nextPage = await fetch(`${base}/${ids.liveShare}?limit=1&offset=1`, { headers: faceHeaders });
    const nextPageData = await nextPage.json();
    assert.equal(nextPageData.photos.length, 1);
    assert.equal(nextPageData.hasMore, false);
    assert.notEqual(nextPageData.photos[0].id, firstPageData.photos[0].id);
    await pool.query('INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES (?, ?, ?)',
      [ids.targetUnit, ids.owner, 'editor']);
    const favoriteUrl = `${apiBase}/favorites`;
    const favoriteHeaders = { Authorization: `Bearer ${token(ids.owner)}`,
      'Content-Type': 'application/json' };
    const saveFavorite = () => fetch(favoriteUrl, { method: 'POST', headers: favoriteHeaders,
      body: JSON.stringify({ kind: 'snippet', refKey: 'same-layout', payload: { blocks: [] } }) });
    assert.equal((await saveFavorite()).status, 201);
    await pool.query('UPDATE users SET active_unit_id = ? WHERE id = ?', [ids.targetUnit, ids.owner]);
    assert.equal((await saveFavorite()).status, 201);
    const targetFavorites = await fetch(favoriteUrl, { headers: favoriteHeaders });
    assert.equal((await targetFavorites.json()).favorites.length, 1);
    await pool.query('UPDATE users SET active_unit_id = ? WHERE id = ?', [ids.sourceUnit, ids.owner]);
    const sourceFavorites = await fetch(favoriteUrl, { headers: favoriteHeaders });
    assert.equal((await sourceFavorites.json()).favorites.length, 1);
    const originalWake = copyWorker.wake;
    copyWorker.wake = () => {};
    try {
      await pool.query("UPDATE organization_copy_jobs SET status = 'failed', error_code = 'TEMPORARY' WHERE id = ?", [ids.job]);
      const retry = await fetch(`${base}/${ids.share}/copy`, {
        method: 'POST', headers: { Authorization: `Bearer ${token(ids.recipient)}` },
      });
      assert.equal(retry.status, 202);
      assert.equal((await retry.json()).status, 'queued');
      const [[retried]] = await pool.query('SELECT status, error_code FROM organization_copy_jobs WHERE id = ?', [ids.job]);
      assert.equal(retried.status, 'queued');
      assert.equal(retried.error_code, null);
    } finally { copyWorker.wake = originalWake; }
    console.log('workspace internal share route integration: passed');
  } finally {
    delete process.env.DEMO_ORGANIZATION_ID;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (ids.copiedProject) {
      await pool.query('DELETE FROM photo_faces WHERE project_id = ?', [ids.copiedProject]);
      await pool.query('DELETE FROM photos WHERE project_id = ?', [ids.copiedProject]);
      await pool.query('DELETE FROM projects WHERE id = ?', [ids.copiedProject]);
    }
    if (ids.job) await pool.query('DELETE FROM organization_copy_jobs WHERE id = ?', [ids.job]);
    if (ids.liveShare) await pool.query('DELETE FROM internal_shares WHERE id = ?', [ids.liveShare]);
    if (ids.share) await pool.query('DELETE FROM internal_share_items WHERE share_id = ?', [ids.share]);
    if (ids.share) await pool.query('DELETE FROM internal_shares WHERE id = ?', [ids.share]);
    if (ids.face) await pool.query('DELETE FROM photo_faces WHERE id = ?', [ids.face]);
    if (ids.project) await pool.query('DELETE FROM photos WHERE project_id = ?', [ids.project]);
    if (ids.person) await pool.query('DELETE FROM face_persons WHERE id = ?', [ids.person]);
    if (ids.project) await pool.query('DELETE FROM projects WHERE id = ?', [ids.project]);
    if (ids.sourceUnit) await pool.query('DELETE FROM organization_unit_memberships WHERE unit_id = ?', [ids.sourceUnit]);
    if (ids.targetUnit) await pool.query('DELETE FROM organization_unit_memberships WHERE unit_id = ?', [ids.targetUnit]);
    if (ids.sourceUnit) await pool.query('DELETE FROM organization_units WHERE id = ?', [ids.sourceUnit]);
    if (ids.targetUnit) await pool.query('DELETE FROM organization_units WHERE id = ?', [ids.targetUnit]);
    if (ids.recipient) await pool.query('DELETE FROM face_search_grants WHERE user_id = ? AND organization_id = ?', [ids.recipient, ids.org]);
    if (ids.peer) await pool.query('DELETE FROM face_search_grants WHERE user_id = ? AND organization_id = ?', [ids.peer, ids.org]);
    if (ids.owner) await pool.query('DELETE FROM user_favorites WHERE user_id = ?', [ids.owner]);
    if (ids.owner) await pool.query('DELETE FROM users WHERE id = ?', [ids.owner]);
    if (ids.recipient) await pool.query('DELETE FROM users WHERE id = ?', [ids.recipient]);
    if (ids.peer) await pool.query('DELETE FROM users WHERE id = ?', [ids.peer]);
    if (ids.org) await pool.query('DELETE FROM organizations WHERE id = ?', [ids.org]);
    if (ids.rolePermission) await pool.query('DELETE FROM role_permissions WHERE id = ?', [ids.rolePermission]);
    if (ids.aiPermission) await pool.query('DELETE FROM role_permissions WHERE id = ?', [ids.aiPermission]);
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
