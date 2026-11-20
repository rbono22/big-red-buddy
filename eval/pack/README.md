# Auditable evaluation export

These files preserve the November 13, 2026 baseline. They are not a rerun of the revised application.

- `golden_cases.csv`: 20 inputs, complete source context, explicit expected outputs, trap types and 5/3/1 anchors.
- `outputs.csv`: exact historical model JSON answers (or the recorded error), raw latency/token metrics, original Radhika Sahani scores, and four explicitly empty teammate columns. `final_score_1to5` preserves the historical single-grader score, not an invented team consensus. Scoring is incomplete until the other teammates supply their actual ratings.
- `judge.csv`: 10 original Gemma 3 12B verdicts. Exact-match bits sum to the repeated numerator; agreement is numerator/denominator (7/10 = 0.70). Within one point is 8/10 = 0.80. Repeated summary fields are not extra cases. The disagreements are U-A2, S4 and S7; the judge endorsed the wrong location in U-A2, so agreement is not proof of correctness.
- `failures.csv`: three observed patterns, case IDs, fixes and verification requirements.
- `tier_comparison.csv`: same ten-case subset; latency includes the timeout; token means use successes only.
- `summary.json`: computed report figures. Round only at presentation, never change recorded answers or scores to fit a narrative.

Run `python3 scripts/export-eval-pack.py` from the repository to regenerate. Source records remain in `eval/cases.json`, `eval/documents` and `eval/results`. Missing teammate scores must be obtained from those people, not inferred or filled by a model. The fixed-document model evaluation did not exercise live retrieval, OCR, external delivery, concurrent load or the revised date-query implementation.
