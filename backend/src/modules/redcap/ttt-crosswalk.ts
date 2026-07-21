/**
 * TtT identity crosswalk — DAG ↔ CHA_ID, keyed to canonical tracker hospital
 * names. Encoded from CPCQC's TtT_DAG_Crosswalk.csv and reconciled against the
 * live DAG inventory of BOTH projects.
 *
 * WHY a crosswalk (Luis's core design): the two REDCap projects spell some DAGs
 * differently for the same hospital (Littleton: hospital `advent_health_litt`
 * vs patient `littleton_adventis`), and the patient project is SHARED with
 * non-TtT hospitals — so DAG is not a safe cross-project key. The CHA_ID join is.
 *
 * ACTIVE-COHORT NOTE: which hospitals are scored is driven by the TRACKER's TtT
 * enrollment (same as every other sync), NOT the CSV's `Active_2026` flag — that
 * flag is inverted on two rows (it excludes Littleton, which does report hospital
 * data, and includes Good Samaritan, which has no 2026 data in either project).
 * This module is IDENTITY only.
 */

export interface TttHospital {
  chaId: number;
  /** Exact canonical hospital name in the tracker (for enrollment lookup). */
  trackerName: string;
  /** DAG in the monthly hospital project (null if the hospital never appears there). */
  hospitalDag: string | null;
  /** DAG(s) in the patient project — usually one; CHA 632 aggregates two. */
  patientDags: string[];
}

/**
 * Every CHA_ID'd TtT hospital (30). The tracker enrolls 24 of these for 2026;
 * the other 6 (Good Samaritan, Avista, Prowers, St. Vincent, Sterling, Vail) are
 * not TtT-active and simply won't resolve to a TtT enrollment — no special-casing
 * needed. Names verified against the tracker; DAGs against the live projects.
 */
export const TTT_HOSPITALS: TttHospital[] = [
  { chaId: 860, trackerName: 'AdventHealth Littleton', hospitalDag: 'advent_health_litt', patientDags: ['littleton_adventis'] },
  { chaId: 345, trackerName: 'Banner Fort Collins Medical Center', hospitalDag: 'banner_fort_collin', patientDags: ['banner_fort_collin'] },
  { chaId: 548, trackerName: 'Banner North Colorado Medical Center', hospitalDag: 'north_colorado_med', patientDags: ['north_colorado_med'] },
  { chaId: 524, trackerName: 'Boulder Community Health', hospitalDag: 'boulder_community', patientDags: ['boulder_community'] },
  { chaId: 412, trackerName: "Children's Hospital Colorado", hospitalDag: 'childrens_hospital', patientDags: ['childrens_hospital'] },
  { chaId: 428, trackerName: 'Denver Health Medical Center', hospitalDag: 'denver_health', patientDags: ['denver_health'] },
  { chaId: 432, trackerName: 'HCA HealthONE Aurora', hospitalDag: 'medical_center_of', patientDags: ['medical_center_of'] },
  { chaId: 472, trackerName: "HCA HealthONE Presbyterian St. Luke's", hospitalDag: 'presbyterianst_luk', patientDags: ['presbyterianst_luk'] },
  { chaId: 488, trackerName: 'HCA HealthONE Rose', hospitalDag: 'rose_medical_cente', patientDags: ['rose_medical_cente'] },
  { chaId: 302, trackerName: 'HCA HealthONE Sky Ridge', hospitalDag: 'hca_skyridge', patientDags: ['hca_skyridge'] },
  { chaId: 508, trackerName: 'HCA HealthONE Swedish', hospitalDag: 'swedish_medical_ce', patientDags: ['swedish_medical_ce'] },
  { chaId: 308, trackerName: 'Intermountain Health Good Samaritan Hospital', hospitalDag: 'good_samaritan', patientDags: ['good_samaritan'] },
  { chaId: 440, trackerName: 'Intermountain Health Lutheran Hospital', hospitalDag: 'lutheran_medical_c', patientDags: ['lutheran_medical_c'] },
  { chaId: 552, trackerName: 'Intermountain Health Platte Valley Hospital', hospitalDag: 'platte_valley_medi', patientDags: ['platte_valley_medi'] },
  { chaId: 500, trackerName: 'Intermountain Health Saint Joseph Hospital', hospitalDag: 'saint_joseph_hospi', patientDags: ['saint_joseph_hospi'] },
  { chaId: 768, trackerName: "Intermountain Health St. Mary's Regional Hospital", hospitalDag: 'st_marys_hospital', patientDags: ['st_marys_hospital'] },
  { chaId: 752, trackerName: 'Montrose Regional Health', hospitalDag: 'montrose_memorial', patientDags: ['montrose_memorial'] },
  { chaId: 684, trackerName: 'San Luis Valley Health', hospitalDag: 'san_luis_valley_he', patientDags: ['san_luis_valley_he'] },
  { chaId: 776, trackerName: 'Southwest Health System, Inc.', hospitalDag: 'southwest_health', patientDags: ['southwest_health'] },
  { chaId: 346, trackerName: 'UCHealth Highlands Ranch Hospital', hospitalDag: 'uc_health_highland', patientDags: ['uc_health_highland'] },
  { chaId: 502, trackerName: 'UCHealth Longs Peak Hospital', hospitalDag: 'uchealth_longs_pea', patientDags: ['uchealth_longs_pea'] },
  // CHA 632 aggregates UCHealth Memorial Central + North: two patient DAGs → one hospital.
  { chaId: 632, trackerName: 'UCHealth Memorial Hospital Central/UCHealth Memorial Hospital North', hospitalDag: 'uchealth_memorial', patientDags: ['uchealth_memorial', 'uchealth_memorialb'] },
  { chaId: 644, trackerName: 'UCHealth Parkview Medical Center', hospitalDag: 'parkview_medical_c', patientDags: ['parkview_medical_c'] },
  { chaId: 512, trackerName: 'UCHealth University of Colorado Hospital', hospitalDag: 'university_hospita', patientDags: ['university_hospita'] },
  { chaId: 868, trackerName: 'Valley View Hospital', hospitalDag: 'valley_view_hospit', patientDags: ['valley_view_hospit'] },
  // --- CHA_ID'd but NOT TtT-active for 2026 (no tracker TtT enrollment) ---
  { chaId: 300, trackerName: 'AdventHealth Avista', hospitalDag: 'advent_health_avis', patientDags: ['advent_health_avis'] },
  { chaId: 656, trackerName: 'Prowers Medical Center', hospitalDag: 'prowers_medical_ce', patientDags: ['prowers_medical_ce'] },
  { chaId: 772, trackerName: 'St. Vincent Health', hospitalDag: 'st_vincent_hospita', patientDags: ['st_vincent_hospita'] },
  { chaId: 588, trackerName: 'Sterling Regional MedCenter', hospitalDag: 'sterling_regional', patientDags: ['sterling_regional'] },
  { chaId: 780, trackerName: 'Vail Health', hospitalDag: 'vail_health', patientDags: [] },
];

/**
 * DAGs that appear in the (shared) REDCap projects but are NOT TtT hospitals —
 * Montana hospitals with no CHA_ID, other collaboratives sharing the patient
 * project, and REDCap's test group. Seeing these is EXPECTED (not a warning); a
 * DAG that's neither a TtT hospital nor here is genuinely unrecognized.
 */
export const TTT_NON_HOSPITAL_DAGS = new Set<string>([
  'holy_rosary',
  'st_james_hospital',
  'gunnison_valley_he',
  'medical_center_ofb',
  'parker_adventist',
  'st_francis_medical',
  'uc_health_greeley',
  'yampa_valley_medic',
  'test',
]);

// --- Derived lookups -------------------------------------------------------

/** Any DAG (either project) → CHA_ID. Includes the 632 alias patient DAG. */
export const DAG_TO_CHA_ID: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (const h of TTT_HOSPITALS) {
    if (h.hospitalDag) m.set(h.hospitalDag, h.chaId);
    for (const d of h.patientDags) m.set(d, h.chaId);
  }
  return m;
})();

export const CHA_ID_TO_HOSPITAL: Map<number, TttHospital> = new Map(TTT_HOSPITALS.map((h) => [h.chaId, h]));

/** Normalize a hospital name for matching (case + curly/straight apostrophes). */
export function normalizeHospitalName(name: string): string {
  return name.trim().toLowerCase().replace(/[‘’]/g, "'");
}
