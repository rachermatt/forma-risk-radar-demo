/**
 * Stable, reviewable configuration for the first published risk model.
 * A configuration change requires a major definition version bump.
 */
export const RISK_DEFINITION_VERSION = "1.0.0" as const;
export const RISK_CONFIGURATION_ID = "frr-risk-config-1.0.0-7f1d9a" as const;

export const RISK_WEIGHTS = Object.freeze({
  constructionIqQuality: 0.25,
  highRiskDensity: 0.2,
  overdueDensity: 0.15,
  safetySignalDensity: 0.15,
  rfiHighShare: 0.1,
  persistenceOver30Days: 0.15,
});

export const EXPOSURE_WEIGHTS = Object.freeze({
  locations: 0.2,
  companies: 0.15,
  confirmedCost: 0.2,
  scheduleLinked: 0.15,
  criticalPathLinked: 0.2,
  projectsAffected: 0.1,
});

export const RISK_THRESHOLDS = Object.freeze({
  critical: 75,
  high: 55,
  medium: 30,
  minimumCoverage: 0.6,
  lowSample: 20,
  momentumChange: 3,
});

export const ATTENTION_POINTS = Object.freeze({
  CIQ_QUALITY_HIGH: 25,
  CIQ_QUALITY_MEDIUM: 10,
  CIQ_RFI_HIGH: 25,
  CIQ_COST_IMPACT_HIGH: 12,
  CIQ_COST_IMPACT_MEDIUM: 4,
  SAFETY_RISK_CATEGORISED: 15,
  SAFETY_RISK_OTHER: 6,
  SAFETY_HAZARD_PRESENT: 8,
  SAFETY_OBSERVATION_NEGATIVE: 6,
  OVERDUE: 12,
  UNASSIGNED: 8,
  NO_DUE_DATE: 5,
  STALE: 5,
  RFI_COST_IMPACT_YES: 8,
  RFI_COST_IMPACT_UNKNOWN: 3,
  RFI_SCHEDULE_IMPACT_YES: 8,
  RFI_SCHEDULE_IMPACT_UNKNOWN: 3,
  RFI_PRIORITY_HIGH: 6,
  SUBMITTAL_PROCUREMENT_BREACH: 15,
  SUBMITTAL_RESUBMISSION: 4,
  CLASH_LINKED: 5,
  SCHEDULE_LINKED: 6,
  CRITICAL_PATH_LINKED: 15,
  COST_EDGE: 10,
  RFI_EDGE: 4,
  USER_CREATED_EDGE_BONUS: 3,
  HOTSPOT_MEMBER: 6,
  RECURRING_SIGNATURE: 7,
  PROJECT_MOMENTUM_WORSENING: 5,
  CIQ_USER_OVERRIDE_DOWNGRADE: -10,
});

export const RISK_CONFIGURATION_SNAPSHOT = JSON.stringify({
  risk: RISK_WEIGHTS,
  exposure: EXPOSURE_WEIGHTS,
  thresholds: RISK_THRESHOLDS,
  attention: ATTENTION_POINTS,
});
