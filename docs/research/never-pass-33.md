# Why the 33 never-pass tasks fail

Step 1 of issue #16. Every task in `runs/ids-never-pass-33.txt` failed in r03, r07 and r08. This
classifies each one from its `runs/r08/results.json` mismatches, its `runs/r08/traces/<id>.jsonl`
trace, and the task's dataset folder, then proposes the smallest agent changes that fix whole
categories.

Golden workbooks were opened only to identify the failure class. No value read from a golden
appears here as a target, and none may enter `agent/`.

## Categories

| # | category | tasks | fixable by |
| --- | --- | --- | --- |
| 1 | wrong logic or wrong reading of the instruction | 17 | not in hours, except the process defects below |
| 2 | over-fill: a value written where the golden cell is empty | 4 | instructions |
| 3 | label text retyped from the instruction instead of copied from the workbook | 3 | instructions |
| 4 | output type: a number or date written where the golden holds a display string | 3 | instructions |
| 5 | VBA source pasted into the answer cells instead of applying its effect | 2 | instructions |
| 6 | LibreOffice recalculation gap | 2 | partly, tool |
| 7 | LibreOffice renames a sheet, so the grader's key lookup misses | 1 | not worth it |
| 8 | never submitted | 1 | instructions |

Two process defects cut across category 1 and are the reason it is not a dead end:

- **7 of the 33 never called `recalc_and_read`**: 118-50, 3002, 341-40, 534-26, 55427, 6239, 80-42.
  Over the whole r08 run, tasks that skipped it passed 18/24 (0.750) against 324/376 (0.862) for
  tasks that called it.
- **2 submitted with a non-empty `error_cells`**: 54590 (`#NAME?`), 56786 (`#DIV/0!`). The tool
  reported the error and the model submitted anyway. Across r08 this happened 4 times.

## Per task

| id | type | cat | evidence |
| --- | --- | --- | --- |
| 118-50 | Sheet | 1 | C2 expected `TAVERING`, got `ABEARING`; both end in ING, so the grouping is right and the order inside the group is wrong. No `recalc_and_read` call. |
| 11842 | Cell | 1 | 94/96 correct; only O6 and O8 differ (0 vs 1, 1 vs 0). The two-rows-per-person half-day rule is applied to the wrong half. |
| 13284 | Cell | 1 | 15 of 25 answer cells still null at the last read; expected `Sonia`, `Mariza`, `Marcy` etc. The between-min-and-max condition rejects rows it should match (numeric vs text comparison of `Base!D`). |
| 146-49 | Sheet | 8 | Trace ends at step 8 with no `submit`; the model was still deliberating about whether G1 already held a pre-placed pair. Also swaps the columns: G holds the non-S word where the golden holds the S word. |
| 170-13 | Sheet | 1 | Sheet3!A2 expected the `U4_PackageDetailsForm` block, got the `U4_ComponentPropertyForm` block: the per-header blocks are emitted in the wrong order. 100 of 200 cells null. |
| 203-15 | Sheet | 3 | J1/K1/L1 expected `Transport Allowances`, `Other Allowances`, `Social Allowances`; wrote the singular forms from the instruction text. `Main!H4` in the init workbook is `Transport Allowances`. |
| 22-47 | Sheet | 7 | All 27 cells null. LibreOffice renames `sheet1` to `sheet1 -1` on any roundtrip of this workbook (reproduced on the untouched init and on the golden). The golden is not recalculated by the judge, so the gold key `('sheet1','F2')` never matches the pred key `('sheet1 -1','F2')`. The trace shows the model noticing the rename at step 9 and submitting anyway. |
| 230-16 | Sheet | 5 | A1 expected `data`, got `Sub CopySubstring()`. The model read "how can I create a macro" and wrote the macro's source into A1:A12. r03 performed the transformation instead and got 7/12. |
| 3002 | Cell | 1 | G7 expected `Single`, got `Multiple`, and G8/G9/G10 the reverse: the duplicate test uses the wrong key columns. No `recalc_and_read` call. |
| 32023 | Cell | 2 | B2 and B3 expected empty; the model filled them with `C78`. `Sheet1!A2` and `A3` hold no employee name, so those rows have no answer. 14/16 otherwise correct. |
| 341-40 | Sheet | 6 | 11913/11917. The 4 bad cells are untouched source values such as `31133.024999999998`, which come back from the judge's LibreOffice recalculation as `31133.025` and round to a different second decimal. The value is identical in the init and the golden, so nothing the agent writes changes it. |
| 398-14 | Sheet | 1 | E9 and F5/F8 expected `0.0`, got `"-"`. The instruction's "empty cells should show a hyphen" was applied to computed zeros as well as to empty cells. |
| 433-47 | Sheet | 1 | B2 expected 282, got 417, and B3 the reverse: the residual-balancing pass assigns rows in the wrong order. 69 of 189 cells null. |
| 43436 | Cell | 1 | K2 expected 1, got 2; I3 expected 3, got 4. The open/closed month boundary is inclusive on the wrong side. |
| 44017 | Cell | 1 | AD14 expected ~55198, got a single constant repeated across AD:AO, so the per-month phase-in never varies. 100 of 348 cells null. Wildly unstable across runs (0/348 in r07, 235/348 in r03). |
| 45738 | Cell | 1 | 479/480. Only L13 differs (expected 0, got 1160): one bond gets an interest payment on a date past its maturity. |
| 486-17 | Cell/Sheet | 4 | B2 expected the text `2021 01 20`, got a real datetime rendered `2021-01-20 00:00:00`. The instruction asks for a display format, so the answer is a string. |
| 49036 | Cell | 4 | B8 expected the string `66.67% WIN RATE`, got the number `0.666666666666667` with a percent number format. The grader reads cached values, so a number format is invisible. |
| 493-5 | Sheet | 1 | E7 and E8 expected -1399.024 and -1820, got 0: the wrong row pair was cleared. |
| 50486 | Cell | 3 | A2 expected `CHEP`, got `Chep`. The instruction spells it `Chep`; `Sheet1!C1` in the workbook spells it `CHEP`. |
| 51289 | Cell | 2 | A4, D4, E4, H4 expected empty; the model wrote `dog4`, `cat4`, `dog3`, `cat3`. Only the first and second largest of each animal get a label, the rest stay blank. |
| 51680 | Cell | 3 | G3 expected `Blue, Green , Red Purple`, got `Blue, Green, Red Purple`. `C1` in the workbook is `Green ` with a trailing space; the golden concatenates the header cells, the model retyped the words. In r07/r08 G5 also lost the case of `Red Purple`. |
| 524-31 | Sheet | 2 | E7, E8, E28, E29, E30 expected empty; the model wrote `misc` as a catch-all for descriptions with no matching shortened vendor. |
| 52964 | Cell | 1 | C2 expected 17, got -17. "Subtract the value in column Y from the value in column U" is U minus Y; the model computed Y minus U. |
| 534-26 | Sheet | 1 | I1:AQ1 expected empty (the stale-date columns are deleted); the workbook still holds the dates. No `recalc_and_read` call, and the instructions' step 6 check on row/column counts was not run. |
| 54590 | Cell | 6 | GK29 returned `#NAME?`. The `GO` column's cells are `INDEX('[1]May 2021'!...)` formulas against an external workbook that LibreOffice cannot resolve, so the SUMIFS over them errors. `recalc_and_read` flagged `HR !GK29` as an error cell at step 6 and the model submitted at step 9 anyway. |
| 55427 | Cell | 2 | B3 expected the literal `#N/A`, got 0, and B2 expected 2002, got 0: the lookup was wrapped in a zero fallback. The golden lets INDEX/MATCH's `#N/A` stand. No `recalc_and_read` call. |
| 55977 | Cell | 4 | C2 expected `Mon`, got `Monday` (r03 wrote a datetime). The golden is `TEXT(A2,"DDD")`; the model chose the long weekday name. |
| 56786 | Cell | 1 | The whole column is shifted one row: the value expected at C4 appears at C5, and C4 itself is `#DIV/0!`. The rolling 365-day window is anchored one row late. Submitted with `Sheet1!C4` in `error_cells`. |
| 56953 | Cell | 1 | Row 7 expected the second block's headers (`Power (kW)`, `Engine HS`, ...), got data values, so the second table's header row is missing; J2 also expected `Engine LS` and got `Engine`, a truncated copy of the source header. |
| 6239 | Cell | 1 | G2 expected 0.08, got 0.14: the three-way bucket lookup picks the wrong band. No `recalc_and_read` call. |
| 73-45 | Sheet | 5 | BD2 expected `Led,jumped well,urged,dominant win`, got `Sub HighlightPatterns()`. Same failure as 230-16: the macro source was written into the answer column. r03 attempted the transformation and got 53/307. |
| 80-42 | Sheet | 1 | A4000 onward expected the consolidated rows from the Jack/Henry/Richard sheets, got null: nothing was appended at the first blank row. 48013/95988. No `recalc_and_read` call. |

## Proposals

Ordered by the number of never-pass tasks each should move, and by how little each risks on the
tasks that already pass.

### 1. Make the pre-submit recalculation mandatory, in the tool, not only in the prose

Targets: the 7 tasks that never called `recalc_and_read` (118-50, 3002, 341-40, 534-26, 55427,
6239, 80-42) and the 2 that submitted over a reported error cell (54590, 56786). It also protects
every task in category 1 whose script silently wrote nothing, which is what 80-42 and 534-26 are.

`agent/instructions.md` already tells the model to call `recalc_and_read` at step 4 and to check
`error_cells` at step 5, and 24 of 400 r08 tasks skipped it anyway. Prose is not holding. Move the
check into `agent/tools/submit.ts`:

- Before copying the workbook out, `submit` runs the same recalc-and-read that
  `recalc_and_read` runs (extract the shared part of `agent/tools/recalc_and_read.ts` into a
  helper both tools call, so the two can never drift).
- If any answer cell holds an Excel error value, `submit` does **not** write the output and does
  **not** delete the sandbox. It returns a refusal naming the error cells and saying: fix the
  formula, or, if the error value is the intended answer for that cell, call `submit` again with
  `confirm_errors: true`.
- The `confirm_errors` escape hatch is required: 55427's golden legitimately holds `#N/A`, so a
  hard block would trade one failure for another.
- `submit` returns the read-back answer values alongside `{ ok: true }` so the model sees, in its
  own transcript, what the judge will see.

Cost: one extra LibreOffice run per task, on the submit path only. Risk to the control set: a task
that already passes has no error cells, so it takes the extra recalc and proceeds unchanged.

Pair it with one instructions.md edit, in the step 7 line:

> `submit` recalculates the workbook itself and refuses if any answer cell holds an Excel error.
> If it refuses, fix the cause; only pass `confirm_errors: true` when the instruction's own logic
> makes the error value the right answer for that cell, as with a lookup whose miss must show as
> `#N/A`.

### 2. Stop over-filling the answer range

Targets 32023, 51289, 524-31, 55427 (4 tasks), and it removes an instruction that is actively
causing them.

Step 5 of `agent/instructions.md` currently says:

> every cell in the answer range should be filled

That is false for the benchmark. The answer range routinely runs past the data, or covers rows the
instruction gives no value for, and the golden leaves those cells empty. Replace that clause with:

> every cell in the answer range should hold what the instruction implies for that cell, and that
> includes holding nothing. An answer range often runs past the data or covers rows the rule does
> not reach. Leave a cell empty when its source row is empty, when the instruction's condition does
> not hold for it, or when a lookup finds no match and the instruction does not name a fallback.
> Never invent a catch-all value ("misc", "other", 0) for the rows that do not match, and do not
> extend a pattern down past the last populated source row to fill the range.

And add to the "Writing the answer" section:

> Do not wrap a lookup in `IFERROR` or `IFNA` unless the instruction asks for a value when the
> lookup fails. If the source data makes the lookup miss, `#N/A` is the answer, and hiding it
> behind a 0 or a blank is a wrong answer.

Risk: low. The change only tells the model when to leave a cell alone; a task whose every answer
cell has a value is unaffected. The one thing to watch on the control set is a task where the
model now leaves a genuinely computable cell blank, so the 40-task control must include at least a
few dense full-range tasks.

### 3. Write what the grader reads: verbatim labels, real strings, no source code

Three small rules, 8 tasks between them (categories 3, 4 and 5). They share one root cause: the
model writes what the instruction's prose describes instead of what the cell has to contain.

Add a "Matching the workbook" block to `agent/instructions.md`:

> **Copy labels from the workbook, never retype them from the instruction.** When an answer cell
> holds a header, a name, a category or any other label that already exists somewhere in the
> workbook, copy that cell's value byte for byte, or reference the cell in a formula. The
> instruction paraphrases: it changes case, drops a plural, and never shows a trailing space. The
> grader compares strings exactly, so `Chep` fails against `CHEP`, `Transport Allowance` fails
> against `Transport Allowances`, and `Green` fails against `Green `. If you concatenate labels,
> build the string from the header cells rather than from typed literals.
>
> **Number formats are invisible to the grader.** It reads each cell's cached value, not how it is
> displayed. When the instruction describes how a result should *look* -- a date shown as
> `yyyy mm dd`, a percentage shown next to a word, a weekday shown as three letters -- the answer
> cell has to hold that text, built with `TEXT(...)` or written as a string. Applying a number
> format to a numeric cell changes nothing the grader can see. The reverse also holds: when the
> instruction asks for a date or a number, write a real datetime or a real number, not a string
> that looks like one.
>
> **Never write code or an explanation into the answer cells.** An instruction phrased as "how can
> I create a macro that..." or "I need a VBA code that..." is asking for the macro's *effect*.
> Apply the transformation to the workbook. VBA source, a formula written as text, or a prose
> answer in the answer cells is always wrong.

Ids this should fix: 50486, 203-15, 51680 (verbatim labels); 486-17, 49036, 55977 (display strings);
230-16, 73-45 (macro source). It should also help 56953, whose `Engine LS` header was truncated to
`Engine`.

Risk: the "never write code into cells" rule is the one to watch. Several tasks in the always-pass
set are phrased as macro requests and pass because the model already applies the effect, so the
rule states what those runs already do. The display-string rule is the riskier half: a task that
wants a real number could be pushed toward a string. The wording above ends with the reverse case
for exactly that reason, and the control set should include a couple of numeric-answer tasks.

## Not proposed

- **22-47** (category 7). LibreOffice renames `sheet1` to `sheet1 -1` on this workbook no matter
  who writes it, the judge recalculates our output but not the golden, so the sheet keys can never
  line up. The only lever is renaming the *other* sheet in the workbook so the collision goes away,
  which is a one-task hack against a rule we do not fully understand. Skip it.
- **341-40** (category 6). The four bad cells are source values the agent never touches; the
  judge's own LibreOffice pass drops their 17th significant digit and the rounded second decimal
  moves. A byte-perfect copy of the golden would fail the same four cells. Not fixable from the
  agent side.
- **54590** (category 6) is half fixable: proposal 1 stops the model submitting over the `#NAME?`,
  which forces it to notice that the external-workbook references cannot be recalculated and to
  compute the sum from the cached values instead. Whether it then does the right thing is a
  reasoning question, not a mechanical one.
- **Category 1's remaining 10 tasks** are ordinary reasoning failures on genuinely hard,
  ambiguous instructions (residual-balancing order in 433-47, phase-in schedules in 44017,
  month-boundary semantics in 43436). There is no shared wording that fixes them, and each is one
  task. Leave them.
