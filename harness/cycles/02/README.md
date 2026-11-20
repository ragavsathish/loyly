# Filed booking-core score for comparison

These are the unchanged checklist and `scores.json` filed by Pi production
cycle 06. They are carried forward so the legacy scoreboard can compare the
next whole-product cycle with the 11 booking-core items both cycles share.
This copies a **measurement**, not the generated candidate and not an
acceptance decision.

- Approved source/controller cut: `40101bb469eb0f1598c310e820bf8de21a051352`.
- Candidate SHA-256: `f80bdc5305a6f018c0fef84c84099001779ef9f6a8728b08c9591ca4220bd0dc`.
- Checklist SHA-256: `4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`.
- Score file SHA-256: `1d326f537a14329b83371401074c36dc3ff999d24a57b3258421e2ee3cdaf38a`.
- Filed result: 11/11. The raw grader left `01-011` pending; a fresh blind
  subagent's request was confirmed over HTTP and supplied its final pass.
- The original specialist panel failed and the original Pi cycle ended
  `passed:false`. A separately pinned reassessment passed three specialists
  and reported `ready-for-review`; it did not rewrite that audit.

The original raw evidence and score input remain under
`harness/pi-durable/scratch-production-cycle-06/` in the cycle checkout. The
source branch's `PRODUCTION-CANDIDATE.md` records the exact outcome. The
candidate still needs explicit acceptance, and the future full-product cycle
must report newly passing and newly failing shared items separately.
