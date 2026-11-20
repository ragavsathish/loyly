// Project-neutral cycle decisions. Effects and evidence stay with the project adapter.
export function createLifecycle({ maxBuildAttempts = 3, assessments = [] } = {}) {
  if (!Number.isInteger(maxBuildAttempts) || maxBuildAttempts < 1
      || !Array.isArray(assessments) || new Set(assessments).size !== assessments.length
      || assessments.some((stage) => !/^[a-z][a-z0-9-]*$/.test(stage)))
    throw Error("invalid lifecycle policy");
  const afterGrade = assessments[0] ?? "score";
  function nextAssessment(stage) {
    const index = assessments.indexOf(stage);
    if (index < 0) throw Error(`unknown assessment stage: ${stage}`);
    return assessments[index + 1] ?? "score";
  }
  function afterBuild(attempt, outcome) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > maxBuildAttempts)
      throw Error("invalid build attempt");
    if (outcome?.status === "completed") return { phase: "gate", attempt };
    if (outcome?.result?.retryable && attempt < maxBuildAttempts)
      return { phase: "build", attempt: attempt + 1, retry: "builder",
        failureLog: outcome.result.failureLog, failureSha256: outcome.result.failureSha256 };
    return { terminal: true, reason: outcome?.result?.retryable
      ? "builder-attempts-exhausted" : "builder-attempt-failed",
      exhausted: Boolean(outcome?.result?.retryable), attempt };
  }
  function afterGate(attempt, outcome) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > maxBuildAttempts)
      throw Error("invalid gate attempt");
    if (outcome?.status !== "completed")
      return { terminal: true, reason: "gate-effect-failed", attempt };
    if (outcome.result?.passed) return { phase: "grading-room", attempt,
      candidateSha256: outcome.result.candidateSha256 };
    if (attempt < maxBuildAttempts)
      return { phase: "build", attempt: attempt + 1, retry: "gate",
        failureLog: outcome.result.log, failureSha256: outcome.result.logSha256 };
    return { terminal: true, reason: "gate-attempts-exhausted", exhausted: true, attempt };
  }
  function afterGradeResult(outcome) {
    return outcome?.status === "completed" ? { phase: afterGrade }
      : { terminal: true, reason: "grader-effect-or-verdict" };
  }
  function afterAssessment(stage, passed) {
    nextAssessment(stage); // Reject a stage from another project's lifecycle.
    return passed ? { phase: nextAssessment(stage) }
      : { terminal: true, reason: `${stage}-effect` };
  }
  return Object.freeze({ maxBuildAttempts, assessments: Object.freeze([...assessments]),
    afterBuild, afterGate, afterGrade: afterGradeResult, afterAssessment });
}
