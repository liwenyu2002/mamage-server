// Read-only, leave-one-photo-out evaluation on explicit human references, not automatic labels.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { pool } = require('../db');
const { selectReferences, referenceScore, normalize, pairKey } = require('../lib/face_feedback');
const { classifyIdentityMatch } = require('../lib/face_matching');
const { getOrgFaceClusterConfig } = require('../lib/face_cluster_config');

async function main() {
  try {
    const [rows] = await pool.query(`SELECT organization_id, person_id, photo_id, sample_kind,
      normalized_embedding, model_name, model_version FROM face_identity_feedback
      WHERE person_id IS NOT NULL AND normalized_embedding IS NOT NULL ORDER BY id`);
    const [events] = await pool.query('SELECT action, COUNT(*) AS count FROM face_feedback_events GROUP BY action');
    const [pairs] = await pool.query('SELECT organization_id, person_low_id, person_high_id FROM face_person_separations');
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.organization_id, row.model_name, row.model_version ?? null,
        normalize(row.normalized_embedding)?.length ?? null]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const report = [];
    for (const [group, samples] of groups) {
      const orgId = samples[0].organization_id;
      const { matchThreshold } = await getOrgFaceClusterConfig(orgId);
      const separations = new Set(pairs.filter((p) => p.organization_id === orgId)
        .map((p) => pairKey(p.person_low_id, p.person_high_id)));
      const metrics = { group, references: samples.length, explicit: 0, evaluated: 0, correct: 0,
        wrong: 0, abstained: 0, insufficientOtherPhotos: 0 };
      for (const sample of samples.filter((s) => s.sample_kind === 'explicit')) {
        metrics.explicit++;
        const query = normalize(sample.normalized_embedding);
        if (!query) continue;
        const byPerson = new Map();
        for (const candidate of samples) {
          if (candidate.photo_id === sample.photo_id) continue;
          if (!byPerson.has(candidate.person_id)) byPerson.set(candidate.person_id, []);
          byPerson.get(candidate.person_id).push(candidate);
        }
        if (!byPerson.has(sample.person_id)) { metrics.insufficientOtherPhotos++; continue; }
        const ranked = [...byPerson].map(([personId, references]) => ({
          personId, score: referenceScore(query, selectReferences(references)),
        })).sort((a, b) => b.score - a.score);
        metrics.evaluated++;
        const decision = classifyIdentityMatch(ranked, { threshold: matchThreshold, separations });
        if (!decision.best) metrics.abstained++;
        else if (decision.best.personId === sample.person_id) metrics.correct++;
        else metrics.wrong++;
      }
      report.push(metrics);
    }
    console.log(JSON.stringify({ events, separationPairs: pairs.length, groups: report,
      note: 'Reference-layer consistency on corrected samples only; not overall recognition accuracy.' }, null, 2));
  } finally { await pool.end(); }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { main };
