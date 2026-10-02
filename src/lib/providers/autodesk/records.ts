import type { RiskRecord, SourceRecordKind } from "../../canonical/types";
import type {
  CoverageResult,
  FormsProvider,
  IssuesProvider,
  ReviewsProvider,
  RfiProvider,
  ScheduleProvider,
  SubmittalsProvider,
} from "../contracts";

/**
 * Boundary implemented by the ingest/snapshot layer after Autodesk wire rows
 * have been mapped. Keeping it canonical prevents source DTOs escaping upward.
 */
export interface AutodeskCanonicalRecordSource {
  read(
    projectId: string,
    kinds: readonly SourceRecordKind[],
    source: "rest-or-extract" | "extract-only",
  ): Promise<CoverageResult<readonly RiskRecord[]>>;
}

export class AutodeskIssuesProvider implements IssuesProvider {
  readonly mode = "autodesk" as const;
  constructor(private readonly source: AutodeskCanonicalRecordSource) {}
  listIssues(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>> {
    return this.source.read(projectId, ["issue"], "rest-or-extract");
  }
}

export class AutodeskRfiProvider implements RfiProvider {
  readonly mode = "autodesk" as const;
  constructor(private readonly source: AutodeskCanonicalRecordSource) {}
  listRfis(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>> {
    return this.source.read(projectId, ["rfi"], "rest-or-extract");
  }
}

export class AutodeskFormsProvider implements FormsProvider {
  readonly mode = "autodesk" as const;
  constructor(private readonly source: AutodeskCanonicalRecordSource) {}
  listForms(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>> {
    return this.source.read(projectId, ["form"], "rest-or-extract");
  }
}

export class AutodeskReviewsProvider implements ReviewsProvider {
  readonly mode = "autodesk" as const;
  constructor(private readonly source: AutodeskCanonicalRecordSource) {}
  listReviews(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>> {
    return this.source.read(projectId, ["review"], "extract-only");
  }
}

export class AutodeskSubmittalsProvider implements SubmittalsProvider {
  readonly mode = "autodesk" as const;
  constructor(private readonly source: AutodeskCanonicalRecordSource) {}
  listSubmittals(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>> {
    return this.source.read(projectId, ["submittal"], "rest-or-extract");
  }
}

export class AutodeskScheduleProvider implements ScheduleProvider {
  readonly mode = "autodesk" as const;
  constructor(private readonly source: AutodeskCanonicalRecordSource) {}

  listActivitiesFromLatestExtract(
    projectId: string,
  ): Promise<CoverageResult<readonly RiskRecord[]>> {
    return this.source.read(projectId, ["schedule-activity"], "extract-only");
  }
}
