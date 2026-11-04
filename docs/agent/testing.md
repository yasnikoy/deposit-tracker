# Testing

- Vitest for unit/domain tests (`pnpm test`); Playwright for e2e
  (`pnpm test:e2e`, own server on :3100, fresh `data-e2e/`) covering create
  B/L, send request, allocate refund, bulk reply.
- Test-first for `src/domain` and the receipt parser, especially the
  business-day engine and the allocation engine. Use the scenarios in
  ARCHITECTURE.md as test cases, e.g.:
  - A 3,000 + B 2,500 + C 1,500 USD open, refund 6,300 → no exact subset,
    FIFO suggests A + B + C 800 with a 700 difference.
  - Same case with a 700 statement deduction on C → exact subset A + B + C.
  - Overpayment → remainder stays unallocated on the refund.
  - Multiple exact combinations → ranked oldest-first, never auto-confirmed.
  - Search cap (30 oldest candidates / 500 ms) hit → result flagged incomplete.
  - Voided B/Ls and refunds are never allocation candidates.
  - Approved write-off closes a B/L; unapproved one does not.
  - Undo after the window, or of a confirmed allocation, is rejected.
  - Receipt description with zero, one or several B/L candidates.
  - Weekends from settings; half-day (arife) holidays per setting.
