const { pool, buildUploadUrl } = require('../db');
const { describePhotoSearchPlan, interpretPhotoSearch } = require('./ai_photo_search');

const MAX_PAGE_SIZE = 200;
const MAX_QUERY_LEN = 160;

function escapeLikeToken(input) {
  return String(input || '').replace(/[#%_]/g, '#$&');
}

function uniqueStrings(input, limit = 12) {
  const seen = new Set();
  const result = [];
  (Array.isArray(input) ? input : []).forEach((value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 64);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || result.length >= limit) return;
    seen.add(key);
    result.push(text);
  });
  return result;
}

function tokenizeLiteralQuery(query) {
  return uniqueStrings(String(query || '')
    .toLowerCase()
    .replace(/[，。！？；、,!?;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean), 8);
}

function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return String(raw).split(/[;,，；]/).map((s) => s.trim()).filter(Boolean);
  }
}

function parseJsonObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function textMatch(term) {
  const like = `%${escapeLikeToken(String(term || '').toLowerCase())}%`;
  return {
    sql: `(
      LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(p.ocr_text, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(CAST(p.tags AS CHAR), '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(pts.name, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#'
      OR LOWER(COALESCE(u.student_no, '')) LIKE ? ESCAPE '#'
      OR EXISTS (
        SELECT 1
        FROM photo_faces pf_text
        INNER JOIN face_persons fp_text ON fp_text.id = pf_text.person_id
        WHERE pf_text.photo_id = p.id
          AND fp_text.organization_id = p.organization_id
          AND LOWER(COALESCE(fp_text.name, '')) LIKE ? ESCAPE '#'
      )
    )`,
    params: [like, like, like, like, like, like, like, like, like, like],
  };
}

function fieldGroupMatch(terms, sqlExpression) {
  const clauses = [];
  const params = [];
  uniqueStrings(terms, 6).forEach((term) => {
    clauses.push(`LOWER(COALESCE(${sqlExpression}, '')) LIKE ? ESCAPE '#'`);
    params.push(`%${escapeLikeToken(term.toLowerCase())}%`);
  });
  return clauses.length ? { sql: `(${clauses.join(' OR ')})`, params } : null;
}

async function findPeople(orgId, terms) {
  const candidates = uniqueStrings(terms, 12);
  if (!candidates.length) return [];
  const where = [orgId === null ? 'fp.organization_id IS NULL' : 'fp.organization_id = ?', "COALESCE(fp.name, '') <> ''"];
  const params = orgId === null ? [] : [orgId];
  const nameClauses = [];
  candidates.forEach((term) => {
    nameClauses.push("LOWER(fp.name) LIKE ? ESCAPE '#'");
    params.push(`%${escapeLikeToken(term.toLowerCase())}%`);
  });
  where.push(`(${nameClauses.join(' OR ')})`);
  try {
    const [rows] = await pool.query(
      `SELECT fp.id, fp.person_no AS personNo, fp.name,
              (SELECT COUNT(*) FROM photo_faces pfc WHERE pfc.person_id = fp.id) AS photoCount
       FROM face_persons fp
       WHERE ${where.join(' AND ')}
       ORDER BY photoCount DESC, fp.updated_at DESC
       LIMIT 40`,
      params
    );
    return (rows || []).map((row) => ({
      id: Number(row.id),
      personNo: row.personNo || null,
      name: String(row.name || '').trim(),
      photoCount: Number(row.photoCount) || 0,
    })).filter((row) => row.id && row.name);
  } catch (error) {
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR')) return [];
    throw error;
  }
}

function rowsMatchingPersonTerm(rows, term) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return [];
  const exact = rows.filter((row) => row.name.toLowerCase() === needle);
  if (exact.length) return exact;
  return rows.filter((row) => row.name.toLowerCase().includes(needle) || needle.includes(row.name.toLowerCase()));
}

function buildScoreParts(terms, matchedPeople) {
  const sql = [];
  const params = [];
  uniqueStrings(terms, 16).forEach((term, index) => {
    const escaped = escapeLikeToken(term.toLowerCase());
    const prefix = `${escaped}%`;
    const contain = `%${escaped}%`;
    const weight = index < 8 ? 1 : 0.65;
    sql.push(`CASE WHEN LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#' THEN ${Math.round(30 * weight)} ELSE 0 END`);
    params.push(prefix);
    sql.push(`CASE WHEN LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#' THEN ${Math.round(24 * weight)} ELSE 0 END`);
    params.push(prefix);
    sql.push(`CASE WHEN LOWER(COALESCE(pts.name, '')) LIKE ? ESCAPE '#' THEN ${Math.round(22 * weight)} ELSE 0 END`);
    params.push(prefix);
    sql.push(`CASE WHEN LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '#' THEN ${Math.round(16 * weight)} ELSE 0 END`);
    params.push(contain);
    sql.push(`CASE WHEN LOWER(COALESCE(CAST(p.tags AS CHAR), '')) LIKE ? ESCAPE '#' THEN ${Math.round(15 * weight)} ELSE 0 END`);
    params.push(contain);
    sql.push(`CASE WHEN LOWER(COALESCE(p.ocr_text, '')) LIKE ? ESCAPE '#' THEN ${Math.round(13 * weight)} ELSE 0 END`);
    params.push(contain);
    sql.push(`CASE WHEN LOWER(CONCAT_WS(' ', u.name, u.nickname, u.student_no)) LIKE ? ESCAPE '#' THEN ${Math.round(12 * weight)} ELSE 0 END`);
    params.push(contain);
    sql.push(`CASE WHEN EXISTS (
      SELECT 1
      FROM photo_faces pf_term
      INNER JOIN face_persons fp_term ON fp_term.id = pf_term.person_id
      WHERE pf_term.photo_id = p.id
        AND fp_term.organization_id = p.organization_id
        AND LOWER(COALESCE(fp_term.name, '')) LIKE ? ESCAPE '#'
    ) THEN ${Math.round(34 * weight)} ELSE 0 END`);
    params.push(contain);
  });
  if (matchedPeople.length) {
    const ids = matchedPeople.map((row) => Number(row.id)).filter(Boolean);
    if (ids.length) {
      sql.push(`CASE WHEN EXISTS (
        SELECT 1 FROM photo_faces pf_score
        WHERE pf_score.photo_id = p.id AND pf_score.person_id IN (?)
      ) THEN 48 ELSE 0 END`);
      params.push(ids);
    }
  }
  sql.push('(COALESCE(p.ai_score, 50) / 20)');
  return { sql: sql.join(' + '), params };
}

async function loadFaceNamesForPhotos(photoIds, orgId) {
  const ids = (photoIds || []).map(Number).filter(Boolean);
  if (!ids.length) return new Map();
  const params = [ids];
  let orgSql = 'pf.organization_id IS NULL';
  if (orgId !== null) {
    orgSql = 'pf.organization_id = ?';
    params.push(orgId);
  }
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT pf.photo_id AS photoId, fp.id AS personId, fp.name
       FROM photo_faces pf
       INNER JOIN face_persons fp ON fp.id = pf.person_id
       WHERE pf.photo_id IN (?) AND ${orgSql} AND COALESCE(fp.name, '') <> ''
       ORDER BY pf.photo_id ASC, fp.name ASC`,
      params
    );
    const map = new Map();
    (rows || []).forEach((row) => {
      const key = Number(row.photoId);
      if (!map.has(key)) map.set(key, []);
      const list = map.get(key);
      if (!list.some((person) => person.id === String(row.personId))) {
        list.push({ id: String(row.personId), name: String(row.name || '').trim() });
      }
    });
    return map;
  } catch (error) {
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR')) return new Map();
    throw error;
  }
}

async function searchPhotos(options = {}) {
  const query = String(options.q || '').trim().slice(0, MAX_QUERY_LEN);
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(options.pageSize) || 20)));
  const offset = (page - 1) * pageSize;
  const projectId = Number(options.projectId) > 0 ? Number(options.projectId) : null;
  const orgId = options.orgId === null ? null : Number(options.orgId);
  const interpreted = await interpretPhotoSearch(query, { enableAi: options.enableAi !== false });
  const plan = interpreted.plan;
  const literalTokens = tokenizeLiteralQuery(query);

  const personLookupTerms = uniqueStrings([
    ...plan.people,
    ...literalTokens.filter((term) => term.length <= 20),
    ...(literalTokens.length <= 1 && query.length <= 20 ? [query] : []),
  ], 12);
  const peopleRows = await findPeople(orgId, personLookupTerms);
  const explicitPersonTerms = plan.people.slice();
  if (!explicitPersonTerms.length) {
    literalTokens.forEach((term) => {
      if (peopleRows.some((row) => row.name.toLowerCase() === term.toLowerCase())) explicitPersonTerms.push(term);
    });
  }

  const personGroups = explicitPersonTerms.map((term) => rowsMatchingPersonTerm(peopleRows, term));
  const matchedPeople = [];
  personGroups.flat().forEach((person) => {
    if (!matchedPeople.some((row) => row.id === person.id)) matchedPeople.push(person);
  });
  const matchedNames = new Set(matchedPeople.map((row) => row.name.toLowerCase()));

  let mustTerms = uniqueStrings(plan.mustTerms, 8).filter((term) => !matchedNames.has(term.toLowerCase()));
  const shouldTerms = uniqueStrings(plan.shouldTerms, 12).filter((term) => !matchedNames.has(term.toLowerCase()));
  const hasStructuredFilter = plan.mediaType !== 'all'
    || plan.quality !== 'any'
    || plan.dateFrom
    || plan.dateTo
    || plan.projects.length
    || plan.timelineSections.length
    || plan.photographers.length
    || plan.excludeTerms.length;
  if (!mustTerms.length && !shouldTerms.length && !explicitPersonTerms.length && !hasStructuredFilter && query) {
    mustTerms = literalTokens.length ? literalTokens : [query];
  }

  const where = [];
  const whereParams = [];
  if (orgId === null || !Number.isFinite(orgId)) {
    where.push('p.organization_id IS NULL');
  } else {
    where.push('p.organization_id = ?');
    whereParams.push(orgId);
  }
  if (projectId) {
    where.push('p.project_id = ?');
    whereParams.push(projectId);
  }

  if (plan.mediaType === 'video') where.push("LOWER(COALESCE(p.type, '')) = 'video'");
  if (plan.mediaType === 'image') where.push("LOWER(COALESCE(p.type, '')) <> 'video'");
  if (plan.quality === 'recommended') {
    where.push(`((p.ai_score >= 75 OR CAST(p.tags AS CHAR) LIKE '%AI recommended%' OR CAST(p.tags AS CHAR) LIKE '%推荐%')
      AND CAST(COALESCE(p.tags, '[]') AS CHAR) NOT LIKE '%AI rejected%'
      AND CAST(COALESCE(p.tags, '[]') AS CHAR) NOT LIKE '%不推荐%')`);
  } else if (plan.quality === 'medium') {
    where.push("((p.ai_score >= 55 AND p.ai_score < 75) OR CAST(p.tags AS CHAR) LIKE '%AI medium%' OR CAST(p.tags AS CHAR) LIKE '%中等%')");
  } else if (plan.quality === 'rejected') {
    where.push("(p.ai_score < 55 OR CAST(p.tags AS CHAR) LIKE '%AI rejected%' OR CAST(p.tags AS CHAR) LIKE '%不推荐%')");
  }
  if (plan.dateFrom) {
    where.push('COALESCE(p.capture_time, DATE(p.created_at)) >= ?');
    whereParams.push(plan.dateFrom);
  }
  if (plan.dateTo) {
    where.push('COALESCE(p.capture_time, DATE(p.created_at)) <= ?');
    whereParams.push(plan.dateTo);
  }

  const projectMatch = fieldGroupMatch(plan.projects, 'pr.name');
  if (projectMatch) { where.push(projectMatch.sql); whereParams.push(...projectMatch.params); }
  const timelineMatch = fieldGroupMatch(plan.timelineSections, 'pts.name');
  if (timelineMatch) { where.push(timelineMatch.sql); whereParams.push(...timelineMatch.params); }
  const photographerMatch = fieldGroupMatch(plan.photographers, "CONCAT_WS(' ', u.name, u.nickname, u.student_no)");
  if (photographerMatch) { where.push(photographerMatch.sql); whereParams.push(...photographerMatch.params); }

  mustTerms.forEach((term) => {
    const match = textMatch(term);
    where.push(match.sql);
    whereParams.push(...match.params);
  });
  if (!mustTerms.length && shouldTerms.length && !explicitPersonTerms.length && !projectMatch && !timelineMatch && !photographerMatch) {
    const matches = shouldTerms.map((term) => textMatch(term));
    where.push(`(${matches.map((match) => match.sql).join(' OR ')})`);
    matches.forEach((match) => whereParams.push(...match.params));
  }
  plan.excludeTerms.forEach((term) => {
    const match = textMatch(term);
    where.push(`NOT ${match.sql}`);
    whereParams.push(...match.params);
  });

  if (explicitPersonTerms.length) {
    if (personGroups.some((group) => group.length === 0)) {
      where.push('1 = 0');
    } else if (plan.peopleMode === 'all') {
      personGroups.forEach((group) => {
        where.push('EXISTS (SELECT 1 FROM photo_faces pf_person WHERE pf_person.photo_id = p.id AND pf_person.person_id IN (?))');
        whereParams.push(group.map((row) => row.id));
      });
    } else {
      const ids = matchedPeople.map((row) => row.id);
      where.push('EXISTS (SELECT 1 FROM photo_faces pf_person WHERE pf_person.photo_id = p.id AND pf_person.person_id IN (?))');
      whereParams.push(ids);
    }
  }

  const baseFrom = `
    FROM photos p
    LEFT JOIN users u ON p.photographer_id = u.id
    LEFT JOIN projects pr ON p.project_id = pr.id
    LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
  `;
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, whereParams);
  const total = countRows && countRows[0] ? Number(countRows[0].total) || 0 : 0;

  const scoreTerms = uniqueStrings([...mustTerms, ...shouldTerms, ...plan.projects, ...plan.timelineSections, ...plan.photographers], 18);
  const score = buildScoreParts(scoreTerms, matchedPeople);
  const requestedSort = String(options.sort || '').toLowerCase();
  const sort = plan.sort !== 'relevance' ? plan.sort : (requestedSort === 'newest' ? 'newest' : 'relevance');
  const orderBy = sort === 'newest'
    ? 'ORDER BY p.created_at DESC, p.id DESC'
    : sort === 'quality'
      ? 'ORDER BY COALESCE(p.ai_score, 0) DESC, relevanceScore DESC, p.created_at DESC, p.id DESC'
      : 'ORDER BY relevanceScore DESC, COALESCE(p.ai_score, 0) DESC, p.created_at DESC, p.id DESC';

  const [rows] = await pool.query(
    `SELECT
       p.id, p.uuid, p.project_id AS projectId, pr.name AS projectName,
       p.timeline_section_id AS timelineSectionId, pts.name AS timelineSectionName,
       pts.section_time AS timelineSectionTime, p.url, p.thumb_url AS thumbUrl,
       p.playback_url AS playbackUrl, p.title, p.description, p.adjustments, p.tags,
       p.ocr_text AS ocrText, p.ai_status AS aiStatus, p.ai_error AS aiError,
       p.ai_started_at AS aiStartedAt, p.ai_finished_at AS aiFinishedAt,
       p.ai_score AS aiScore, p.ai_quality AS aiQuality, p.type,
       p.photographer_id AS photographerId,
       COALESCE(NULLIF(u.name, ''), NULLIF(u.nickname, '')) AS photographerName,
       p.capture_time AS captureTime, p.created_at AS createdAt, p.updated_at AS updatedAt,
       ${score.sql || '0'} AS relevanceScore
     ${baseFrom}
     ${whereSql}
     ${orderBy}
     LIMIT ? OFFSET ?`,
    [...score.params, ...whereParams, pageSize, offset]
  );

  const faceMap = await loadFaceNamesForPhotos((rows || []).map((row) => row.id), orgId);
  const list = (rows || []).map((row) => {
    const people = faceMap.get(Number(row.id)) || [];
    return {
      id: row.id,
      uuid: row.uuid,
      projectId: row.projectId,
      projectName: row.projectName || null,
      timelineSectionId: row.timelineSectionId || null,
      timelineSectionName: row.timelineSectionName || null,
      timelineSectionTime: row.timelineSectionTime || null,
      url: row.url ? buildUploadUrl(row.url) : null,
      thumbUrl: row.thumbUrl ? buildUploadUrl(row.thumbUrl) : null,
      playbackUrl: row.playbackUrl ? buildUploadUrl(row.playbackUrl) : null,
      playback_url: row.playbackUrl ? buildUploadUrl(row.playbackUrl) : null,
      title: row.title || null,
      description: row.description || null,
      adjustments: parseJsonObject(row.adjustments),
      tags: parseTags(row.tags),
      ocrText: row.ocrText || null,
      aiStatus: row.aiStatus || null,
      aiError: row.aiError || null,
      aiStartedAt: row.aiStartedAt || null,
      aiFinishedAt: row.aiFinishedAt || null,
      aiScore: row.aiScore === null || row.aiScore === undefined ? null : Number(row.aiScore),
      aiQuality: parseJsonObject(row.aiQuality),
      type: row.type,
      photographerId: row.photographerId || null,
      photographerName: row.photographerName || null,
      captureTime: row.captureTime || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevanceScore: Number(row.relevanceScore) || 0,
      faceNames: people.map((person) => person.name),
      personNames: people.map((person) => person.name),
      people,
    };
  });

  return {
    list,
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
    q: query,
    tokens: mustTerms,
    sort,
    search: {
      mode: interpreted.aiUsed ? 'ai' : 'enhanced',
      aiUsed: interpreted.aiUsed,
      cached: interpreted.cached,
      degraded: Boolean(interpreted.fallbackReason),
      plan: {
        mustTerms,
        shouldTerms,
        excludeTerms: plan.excludeTerms,
        people: matchedPeople.map((row) => row.name),
        peopleMode: plan.peopleMode,
        photographers: plan.photographers,
        projects: plan.projects,
        timelineSections: plan.timelineSections,
        mediaType: plan.mediaType,
        quality: plan.quality,
        dateFrom: plan.dateFrom,
        dateTo: plan.dateTo,
        sort,
      },
      chips: describePhotoSearchPlan({ ...plan, mustTerms }, matchedPeople),
      matchedPeople: matchedPeople.map((row) => ({
        id: String(row.id), name: row.name, photoCount: row.photoCount,
      })),
    },
  };
}

module.exports = {
  escapeLikeToken,
  searchPhotos,
  textMatch,
  tokenizeLiteralQuery,
};
